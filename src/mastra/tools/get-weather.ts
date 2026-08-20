import {createTool} from '@mastra/core/tools';
import {z} from 'zod';

/**
 * Weather lookup backed by Open-Meteo.
 *
 * Open-Meteo is used because it needs no API key and no account, so this
 * starter kit stays clone-and-run. Two calls are involved: geocoding the
 * place name to coordinates, then fetching the daily forecast for those
 * coordinates.
 *
 * The tool returns a small application-level shape rather than the upstream
 * payload, so the agent (and any future UI) is insulated from Open-Meteo's
 * response format.
 */

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Upper bound on each upstream call, so a hung request cannot stall an agent run. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Considerations are capped to stay within `ItinerarySchema.weather.considerations`. */
const MAX_CONSIDERATIONS = 4;

export type WeatherErrorCode =
  | 'invalid_input'
  | 'location_not_found'
  | 'date_out_of_range'
  | 'upstream_error'
  | 'network_error'
  | 'unexpected_response';

/**
 * A failure the agent can reason about and a developer can act on.
 *
 * Messages describe what went wrong and what to do about it; they never carry
 * raw upstream payloads. The one exception is Open-Meteo's `reason` string for
 * an out-of-range date, which states the available range and is the single
 * most useful thing to pass through.
 */
export class WeatherToolError extends Error {
  constructor(
    readonly code: WeatherErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WeatherToolError';
  }
}

export const WeatherInputSchema = z.object({
  location: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      'City or place name. A country may be added after a comma to disambiguate, for example "Lagos, Nigeria".'
    ),
  date: z.iso.date().describe('The day to forecast, as YYYY-MM-DD.')
});

export const ResolvedLocationSchema = z
  .object({
    name: z.string().describe('Canonical place name as resolved by Open-Meteo.'),
    country: z.string().describe('Country the resolved place is in.'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    timezone: z.string().describe('IANA timezone of the resolved place, for example "Africa/Lagos".')
  })
  .describe('Which place the name actually resolved to, so the agent can say so if it is ambiguous.');

export const WeatherOutputSchema = z
  .object({
    location: ResolvedLocationSchema,

    date: z.iso.date().describe('The forecast day, echoed back as confirmation.'),

    summary: z
      .string()
      .min(1)
      .max(200)
      .describe('Plain-language conditions, for example "Moderate drizzle".'),

    highCelsius: z.number().describe('Daily maximum temperature in Celsius.'),

    lowCelsius: z.number().describe('Daily minimum temperature in Celsius.'),

    precipitationChance: z
      .int()
      .min(0)
      .max(100)
      .describe('Maximum chance of precipitation during the day, 0-100.'),

    considerations: z
      .array(z.string().min(1).max(200))
      .max(MAX_CONSIDERATIONS)
      .describe('Planning advice derived from the forecast, ready to use when building a plan.')
  })
  .describe('Daily weather for one place on one date.');

export type WeatherInput = z.infer<typeof WeatherInputSchema>;
export type WeatherOutput = z.infer<typeof WeatherOutputSchema>;
export type ResolvedLocation = z.infer<typeof ResolvedLocationSchema>;

/**
 * WMO weather interpretation codes, which is what Open-Meteo reports.
 * Only the codes Open-Meteo actually emits are listed.
 */
const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Heavy drizzle',
  56: 'Light freezing drizzle',
  57: 'Heavy freezing drizzle',
  61: 'Light rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Light snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail'
};

function describeWeatherCode(code: number): string {
  return WMO_DESCRIPTIONS[code] ?? 'Mixed conditions';
}

type GeocodingResult = {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  country?: string;
  population?: number;
  id: number;
};

/**
 * Pick one place when Open-Meteo returns several.
 *
 * Open-Meteo returns matches in its own relevance order, which is not stable
 * enough to rely on, and "Lagos" alone matches five places. The rules below
 * are applied in order and always produce the same answer for the same input:
 *
 *   1. Exact name match beats a partial one, compared case- and
 *      accent-insensitively ("Lagos" beats "Lagos Island", "Lagos" == "Lagós").
 *   2. Then the largest population, since a bare city name almost always means
 *      the well-known one. Missing population counts as zero.
 *   3. Then the lowest Open-Meteo id, purely so ties never reorder between runs.
 *
 * The chosen place is returned to the agent in `location`, so an ambiguous
 * request can be confirmed with the user rather than silently assumed.
 */
export function selectBestLocation(
  results: GeocodingResult[],
  query: string
): GeocodingResult | undefined {
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim();

  // Compare against the part before any comma, since "Lagos, Nigeria" should
  // still count as an exact match on "Lagos".
  const target = normalize(query.split(',')[0] ?? query);

  return [...results].sort((a, b) => {
    const exactA = normalize(a.name) === target ? 1 : 0;
    const exactB = normalize(b.name) === target ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const populationA = a.population ?? 0;
    const populationB = b.population ?? 0;
    if (populationA !== populationB) return populationB - populationA;

    return a.id - b.id;
  })[0];
}

/** Fetch JSON with a hard timeout, mapping transport failures to a typed error. */
async function fetchJson(url: string, abortSignal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {signal});
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new WeatherToolError(
        'network_error',
        `Weather service did not respond within ${REQUEST_TIMEOUT_MS / 1000}s. Try again.`
      );
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new WeatherToolError('network_error', 'Weather lookup was cancelled.');
    }
    throw new WeatherToolError(
      'network_error',
      'Could not reach the weather service. Check network connectivity.'
    );
  }

  if (!response.ok) {
    // Open-Meteo reports an unavailable date as a 400 whose `reason` names the
    // supported window. That range is genuinely useful, so it is passed on.
    const reason = await readReason(response);
    if (response.status === 400 && reason && /out of allowed range/i.test(reason)) {
      throw new WeatherToolError('date_out_of_range', reason);
    }
    throw new WeatherToolError(
      'upstream_error',
      `Weather service returned HTTP ${response.status}.`
    );
  }

  try {
    return await response.json();
  } catch {
    throw new WeatherToolError('unexpected_response', 'Weather service returned invalid JSON.');
  }
}

async function readReason(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {reason?: unknown};
    return typeof body.reason === 'string' ? body.reason : undefined;
  } catch {
    return undefined;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Turn the forecast into short, actionable planning notes. */
export function buildConsiderations(input: {
  highCelsius: number;
  lowCelsius: number;
  precipitationChance: number;
  weatherCode: number;
}): string[] {
  const considerations: string[] = [];
  const {highCelsius, lowCelsius, precipitationChance, weatherCode} = input;

  if (weatherCode >= 95) {
    considerations.push('Thunderstorms are forecast — keep outdoor plans short and flexible.');
  } else if (precipitationChance >= 70) {
    considerations.push(
      `Rain is likely (${precipitationChance}% chance) — pair each outdoor stop with an indoor fallback.`
    );
  } else if (precipitationChance >= 30) {
    considerations.push(
      `Showers are possible (${precipitationChance}% chance) — worth packing a light rain jacket.`
    );
  }

  if (highCelsius >= 32) {
    considerations.push(
      `It peaks at ${Math.round(highCelsius)}°C — avoid strenuous outdoor activity in the early afternoon.`
    );
  } else if (highCelsius <= 8) {
    considerations.push(
      `It stays cold, topping out at ${Math.round(highCelsius)}°C — favour indoor stops.`
    );
  }

  if (lowCelsius <= 5 && highCelsius > 8) {
    considerations.push(
      `It drops to ${Math.round(lowCelsius)}°C — plan a warm layer for early and late in the day.`
    );
  }

  if (weatherCode === 45 || weatherCode === 48) {
    considerations.push('Fog is expected — viewpoints and scenic routes may not be worth the trip.');
  }

  if (considerations.length === 0) {
    considerations.push('Conditions look settled — outdoor activities should go ahead as planned.');
  }

  return considerations.slice(0, MAX_CONSIDERATIONS);
}

async function geocode(location: string, abortSignal?: AbortSignal): Promise<GeocodingResult> {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(location)}&count=10&language=en&format=json`;
  const payload = (await fetchJson(url, abortSignal)) as {results?: unknown};

  // Open-Meteo omits `results` entirely when nothing matches.
  const results = Array.isArray(payload.results) ? (payload.results as GeocodingResult[]) : [];
  const usable = results.filter(
    result => isFiniteNumber(result?.latitude) && isFiniteNumber(result?.longitude)
  );

  if (usable.length === 0) {
    throw new WeatherToolError(
      'location_not_found',
      `Could not find a place called "${location}". Try a different spelling, or add a country, for example "Lagos, Nigeria".`
    );
  }

  const best = selectBestLocation(usable, location);
  if (!best) {
    throw new WeatherToolError('location_not_found', `Could not resolve "${location}".`);
  }
  return best;
}

/**
 * The tool's implementation, exported so the future `plan-trip` workflow can
 * call it directly without going through the agent.
 *
 * Note on validation: when invoked through Mastra, `inputSchema` is checked
 * before this function runs, and Mastra returns a structured validation error
 * to the model rather than throwing — so the model can correct its arguments
 * and retry. The guard below therefore only fires on direct invocation, but it
 * keeps the contract identical either way: bad input never reaches the network.
 */
export async function getWeatherWithValidation(
  input: WeatherInput,
  context?: {abortSignal?: AbortSignal}
): Promise<WeatherOutput> {
  const parsed = WeatherInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WeatherToolError(
      'invalid_input',
      `Invalid weather request: ${issue?.path.join('.') || 'input'} — ${issue?.message ?? 'failed validation'}.`
    );
  }
  const {location, date} = parsed.data;
  const abortSignal = context?.abortSignal;

  const place = await geocode(location, abortSignal);

  // `timezone=auto` makes Open-Meteo resolve the local timezone for these
  // coordinates and return `daily.time` as local calendar dates, so the
  // requested date means the same day the traveller experiences — not a
  // UTC day that may straddle two local days.
  const forecastUrl =
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&timezone=auto&start_date=${date}&end_date=${date}`;

  const payload = (await fetchJson(forecastUrl, abortSignal)) as {
    timezone?: unknown;
    daily?: {
      time?: unknown;
      weather_code?: unknown;
      temperature_2m_max?: unknown;
      temperature_2m_min?: unknown;
      precipitation_probability_max?: unknown;
    };
  };

  const daily = payload.daily;
  if (!daily || !Array.isArray(daily.time)) {
    throw new WeatherToolError(
      'unexpected_response',
      'Weather service response did not include daily forecast data.'
    );
  }

  // Never silently substitute a different day: only accept the row whose
  // local date is exactly the one that was asked for.
  const index = daily.time.indexOf(date);
  if (index === -1) {
    throw new WeatherToolError(
      'date_out_of_range',
      `No forecast is available for ${date} in ${place.name}. The requested date is outside the available forecast range.`
    );
  }

  const highCelsius = asNumberAt(daily.temperature_2m_max, index);
  const lowCelsius = asNumberAt(daily.temperature_2m_min, index);
  const weatherCode = asNumberAt(daily.weather_code, index);
  const rawPrecipitation = asNumberAt(daily.precipitation_probability_max, index);

  if (highCelsius === undefined || lowCelsius === undefined || weatherCode === undefined) {
    throw new WeatherToolError(
      'unexpected_response',
      `Weather service returned an incomplete forecast for ${date}.`
    );
  }

  // Open-Meteo returns null for precipitation probability on some models and
  // date ranges; treat a missing value as no expected precipitation.
  const precipitationChance = Math.round(Math.min(100, Math.max(0, rawPrecipitation ?? 0)));

  return {
    location: {
      name: place.name,
      country: place.country ?? 'Unknown',
      latitude: place.latitude,
      longitude: place.longitude,
      timezone: (typeof payload.timezone === 'string' ? payload.timezone : place.timezone) ?? 'UTC'
    },
    date,
    summary: describeWeatherCode(weatherCode),
    highCelsius,
    lowCelsius,
    precipitationChance,
    considerations: buildConsiderations({
      highCelsius,
      lowCelsius,
      precipitationChance,
      weatherCode
    })
  };
}

export const getWeatherTool = createTool({
  id: 'get-weather',
  description:
    'Get the daily weather forecast for a place on a specific date. Use this before suggesting outdoor activities so the plan matches the conditions.',
  inputSchema: WeatherInputSchema,
  outputSchema: WeatherOutputSchema,
  execute: async (input, context) => getWeatherWithValidation(input, context)
});

function asNumberAt(values: unknown, index: number): number | undefined {
  if (!Array.isArray(values)) return undefined;
  const value = values[index];
  return isFiniteNumber(value) ? value : undefined;
}
