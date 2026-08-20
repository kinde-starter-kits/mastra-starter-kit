import {describe, it, expect, afterEach} from 'vitest';

import {
  WeatherToolError,
  buildConsiderations,
  WeatherOutputSchema,
  getWeatherTool,
  getWeatherWithValidation,
  selectBestLocation,
  type WeatherOutput
} from '../src/mastra/tools/get-weather.js';
import {
  LAGOS_GEOCODING,
  forecast,
  installFetchMock,
  isForecast,
  isGeocoding,
  json,
  restoreFetch
} from './helpers/open-meteo-mock.js';

const DATE = '2026-08-22';

/** Invoke the tool the way Mastra does: validated input, execution context. */
function run(input: {location: string; date: string}): Promise<WeatherOutput> {
  return getWeatherTool.execute!(input as never, {} as never) as Promise<WeatherOutput>;
}

/** Same call, untyped — for the paths where Mastra returns a validation error. */
function runUnchecked(input: {location: string; date: string}): Promise<{
  error?: boolean;
  message?: string;
}> {
  return getWeatherTool.execute!(input as never, {} as never) as Promise<{
    error?: boolean;
    message?: string;
  }>;
}

/** Await a call that is expected to reject, returning the typed error. */
async function runExpectingError(input: {
  location: string;
  date: string;
}): Promise<WeatherToolError> {
  const error = await run(input).then(
    () => null,
    (caught: unknown) => caught as WeatherToolError
  );
  if (!error) throw new Error('Expected the weather tool to throw, but it resolved.');
  return error;
}

/** Bypass Mastra's input validation to exercise the tool's own guard. */
function rawExecute(input: {location: string; date: string}) {
  return getWeatherWithValidation(input as never, {} as never);
}

/** Happy-path routing: geocoding then forecast. */
function mockHappyPath(overrides?: Parameters<typeof forecast>[1]) {
  const urls: string[] = [];
  installFetchMock(url => {
    urls.push(url);
    if (isGeocoding(url)) return json(LAGOS_GEOCODING);
    if (isForecast(url)) return json(forecast(DATE, overrides));
    throw new Error(`Unexpected URL: ${url}`);
  });
  return urls;
}

afterEach(() => {
  restoreFetch();
});

describe('get-weather — success', () => {
  it('resolves a location and returns structured weather', async () => {
    mockHappyPath();
    const result = await run({location: 'Lagos', date: DATE});

    expect(result).toEqual({
      location: {
        name: 'Lagos',
        country: 'Nigeria',
        latitude: 6.45407,
        longitude: 3.39467,
        timezone: 'Africa/Lagos'
      },
      date: DATE,
      summary: 'Moderate drizzle',
      highCelsius: 27.2,
      lowCelsius: 24.8,
      precipitationChance: 100,
      considerations: [expect.stringContaining('Rain is likely')]
    });
  });

  it('calls geocoding first, then the forecast for the resolved coordinates', async () => {
    const urls = mockHappyPath();
    await run({location: 'Lagos', date: DATE});

    expect(urls).toHaveLength(2);
    expect(isGeocoding(urls[0]!)).toBe(true);
    expect(urls[0]).toContain('name=Lagos');

    expect(isForecast(urls[1]!)).toBe(true);
    expect(urls[1]).toContain('latitude=6.45407');
    expect(urls[1]).toContain('longitude=3.39467');
    expect(urls[1]).toContain(`start_date=${DATE}`);
    expect(urls[1]).toContain(`end_date=${DATE}`);
  });

  it('asks Open-Meteo to resolve the local timezone rather than assuming UTC', async () => {
    const urls = mockHappyPath();
    await run({location: 'Lagos', date: DATE});

    expect(urls[1]).toContain('timezone=auto');
  });

  it('prefers the timezone reported for the forecast coordinates', async () => {
    mockHappyPath({timezone: 'Africa/Lagos'});
    const result = await run({location: 'Lagos', date: DATE});

    expect(result.location.timezone).toBe('Africa/Lagos');
  });

  it('passes a comma-qualified location straight through', async () => {
    const urls = mockHappyPath();
    await run({location: 'Lagos, Nigeria', date: DATE});

    expect(urls[0]).toContain(encodeURIComponent('Lagos, Nigeria'));
  });

  it('treats a null precipitation probability as zero', async () => {
    mockHappyPath({precipitation: null, weatherCode: 0, high: 24, low: 18});
    const result = await run({location: 'Lagos', date: DATE});

    expect(result.precipitationChance).toBe(0);
    expect(result.summary).toBe('Clear sky');
  });

  it('produces output that satisfies the declared output schema', async () => {
    mockHappyPath();
    const result = await run({location: 'Lagos', date: DATE});

    expect(WeatherOutputSchema.safeParse(result).success).toBe(true);
  });
});

describe('get-weather — location selection', () => {
  it('picks the largest exact-name match deterministically', () => {
    const best = selectBestLocation(LAGOS_GEOCODING.results, 'Lagos');
    expect(best?.country).toBe('Nigeria');
  });

  it('prefers an exact name over a larger partial match', () => {
    const best = selectBestLocation(
      [
        {id: 1, name: 'Lagos Island', latitude: 1, longitude: 1, population: 20_000_000},
        {id: 2, name: 'Lagos', latitude: 2, longitude: 2, population: 100}
      ],
      'Lagos'
    );
    expect(best?.name).toBe('Lagos');
  });

  it('matches names ignoring accents', () => {
    const best = selectBestLocation(
      [
        {id: 1, name: 'Lagos Island', latitude: 1, longitude: 1, population: 999},
        {id: 2, name: 'Lagós', latitude: 2, longitude: 2, population: 10}
      ],
      'Lagos'
    );
    expect(best?.name).toBe('Lagós');
  });

  it('breaks population ties on the lowest id, so results never reorder', () => {
    const best = selectBestLocation(
      [
        {id: 77, name: 'Springfield', latitude: 1, longitude: 1},
        {id: 12, name: 'Springfield', latitude: 2, longitude: 2}
      ],
      'Springfield'
    );
    expect(best?.id).toBe(12);
  });

  it('ignores the country qualifier when judging an exact match', () => {
    const best = selectBestLocation(LAGOS_GEOCODING.results, 'Lagos, Portugal');
    // Both entries are named "Lagos", so population still decides.
    expect(best?.country).toBe('Nigeria');
  });
});

describe('get-weather — location not found', () => {
  it('throws when Open-Meteo omits the results key', async () => {
    installFetchMock(url => {
      if (isGeocoding(url)) return json({generationtime_ms: 0.5});
      throw new Error('forecast should not be called');
    });

    await expect(run({location: 'Nowherest', date: DATE})).rejects.toMatchObject({
      code: 'location_not_found'
    });
  });

  it('throws when results is an empty array', async () => {
    installFetchMock(() => json({results: []}));

    await expect(run({location: 'Nowherest', date: DATE})).rejects.toBeInstanceOf(WeatherToolError);
  });

  it('does not fall back to default weather', async () => {
    installFetchMock(url => {
      if (isForecast(url)) throw new Error('must not request a forecast');
      return json({});
    });

    await expect(run({location: 'Nowherest', date: DATE})).rejects.toThrow(/Could not find a place/);
  });

  it('rejects results missing usable coordinates', async () => {
    installFetchMock(() => json({results: [{id: 1, name: 'Broken', country: 'X'}]}));

    await expect(run({location: 'Broken', date: DATE})).rejects.toMatchObject({
      code: 'location_not_found'
    });
  });
});

describe('get-weather — invalid input', () => {
  /**
   * Mastra validates against `inputSchema` before `execute` runs and returns a
   * structured validation error rather than throwing. That is deliberate on
   * Mastra's part: the error goes back to the model, which can correct its
   * arguments and retry instead of failing the whole run.
   *
   * The guarantee that matters here is that bad input costs nothing upstream —
   * no geocoding call, no forecast call.
   */
  function mockRejectingAllCalls() {
    let calls = 0;
    installFetchMock(() => {
      calls += 1;
      throw new Error('no request should be made');
    });
    return () => calls;
  }

  it('rejects an empty location and makes no network call', async () => {
    const callCount = mockRejectingAllCalls();

    const result = await runUnchecked({location: '   ', date: DATE});

    expect(result.error).toBe(true);
    expect(result.message).toContain('location');
    expect(callCount()).toBe(0);
  });

  it.each(['22/08/2026', '2026-8-22', 'tomorrow', '2026-02-30'])(
    'rejects the malformed date %s and makes no network call',
    async date => {
      const callCount = mockRejectingAllCalls();

      const result = await runUnchecked({location: 'Lagos', date});

      expect(result.error).toBe(true);
      expect(result.message).toContain('date');
      expect(callCount()).toBe(0);
    }
  );

  it('validates defensively when execute is called directly, bypassing Mastra', async () => {
    const callCount = mockRejectingAllCalls();

    // The plan-trip workflow will call this logic directly, so the tool does
    // not rely solely on Mastra's pre-validation.
    await expect(rawExecute({location: 'Lagos', date: 'tomorrow'})).rejects.toMatchObject({
      code: 'invalid_input'
    });
    expect(callCount()).toBe(0);
  });
});

describe('get-weather — upstream failures', () => {
  it('surfaces a non-OK geocoding response', async () => {
    installFetchMock(() => json({error: true}, 500));

    await expect(run({location: 'Lagos', date: DATE})).rejects.toMatchObject({
      code: 'upstream_error'
    });
  });

  it('surfaces a non-OK forecast response without leaking the payload', async () => {
    installFetchMock(url => {
      if (isGeocoding(url)) return json(LAGOS_GEOCODING);
      return json({error: true, internal: 'stack trace here'}, 503);
    });

    const error = await runExpectingError({location: 'Lagos', date: DATE});
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('503');
    expect(error.message).not.toContain('stack trace');
  });

  it('reports a network failure clearly', async () => {
    installFetchMock(() => {
      throw new TypeError('fetch failed');
    });

    await expect(run({location: 'Lagos', date: DATE})).rejects.toMatchObject({
      code: 'network_error'
    });
  });

  it('reports a timeout as a network error', async () => {
    installFetchMock(() => {
      const error = new Error('The operation timed out');
      error.name = 'TimeoutError';
      throw error;
    });

    await expect(run({location: 'Lagos', date: DATE})).rejects.toThrow(/did not respond within/);
  });

  it('reports invalid JSON from upstream', async () => {
    installFetchMock(
      () => new Response('<html>not json</html>', {status: 200, headers: {'content-type': 'text/html'}})
    );

    await expect(run({location: 'Lagos', date: DATE})).rejects.toMatchObject({
      code: 'unexpected_response'
    });
  });
});

describe('get-weather — malformed forecast data', () => {
  it('rejects a response with no daily block', async () => {
    installFetchMock(url => (isGeocoding(url) ? json(LAGOS_GEOCODING) : json({timezone: 'UTC'})));

    await expect(run({location: 'Lagos', date: DATE})).rejects.toMatchObject({
      code: 'unexpected_response'
    });
  });

  it('rejects a forecast row missing temperatures', async () => {
    installFetchMock(url =>
      isGeocoding(url)
        ? json(LAGOS_GEOCODING)
        : json({
            timezone: 'Africa/Lagos',
            daily: {time: [DATE], weather_code: [1], precipitation_probability_max: [10]}
          })
    );

    await expect(run({location: 'Lagos', date: DATE})).rejects.toThrow(/incomplete forecast/);
  });
});

describe('get-weather — date outside forecast range', () => {
  it('surfaces the allowed range reported by Open-Meteo', async () => {
    installFetchMock(url =>
      isGeocoding(url)
        ? json(LAGOS_GEOCODING)
        : json(
            {
              error: true,
              reason: "Parameter 'start_date' is out of allowed range from 2026-05-19 to 2026-09-04"
            },
            400
          )
    );

    const error = await runExpectingError({location: 'Lagos', date: '2027-12-01'});
    expect(error.code).toBe('date_out_of_range');
    expect(error.message).toContain('2026-09-04');
  });

  it('fails rather than substituting a different day it was given', async () => {
    installFetchMock(url =>
      isGeocoding(url) ? json(LAGOS_GEOCODING) : json(forecast('2026-08-23'))
    );

    const error = await runExpectingError({location: 'Lagos', date: DATE});
    expect(error.code).toBe('date_out_of_range');
    expect(error.message).toContain(DATE);
  });
});

describe('buildConsiderations', () => {
  it('flags likely rain', () => {
    const notes = buildConsiderations({
      highCelsius: 25,
      lowCelsius: 20,
      precipitationChance: 80,
      weatherCode: 63
    });
    expect(notes[0]).toContain('Rain is likely');
  });

  it('flags thunderstorms ahead of plain rain', () => {
    const notes = buildConsiderations({
      highCelsius: 25,
      lowCelsius: 20,
      precipitationChance: 90,
      weatherCode: 95
    });
    expect(notes[0]).toContain('Thunderstorms');
  });

  it('flags heat', () => {
    const notes = buildConsiderations({
      highCelsius: 36,
      lowCelsius: 26,
      precipitationChance: 0,
      weatherCode: 0
    });
    expect(notes.join(' ')).toContain('36°C');
  });

  it('always returns at least one note', () => {
    const notes = buildConsiderations({
      highCelsius: 22,
      lowCelsius: 15,
      precipitationChance: 5,
      weatherCode: 1
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('settled');
  });

  it('never exceeds the itinerary schema cap of four', () => {
    const notes = buildConsiderations({
      highCelsius: 40,
      lowCelsius: -5,
      precipitationChance: 100,
      weatherCode: 99
    });
    expect(notes.length).toBeLessThanOrEqual(4);
  });
});
