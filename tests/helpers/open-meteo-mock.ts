/**
 * Routes Open-Meteo calls to canned responses.
 *
 * The tool is exercised through the real `fetch` code path — only the network
 * is replaced — so URL construction, HTTP status handling, and JSON parsing
 * are all still under test. Nothing here touches the live service.
 */
export type MockResponder = (url: string) => Response | Promise<Response> | never;

let originalFetch: typeof globalThis.fetch | undefined;

export function installFetchMock(responder: MockResponder): void {
  originalFetch ??= globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return responder(url);
  }) as typeof globalThis.fetch;
}

export function restoreFetch(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'}
  });
}

export const LAGOS_GEOCODING = {
  results: [
    {
      id: 2332459,
      name: 'Lagos',
      latitude: 6.45407,
      longitude: 3.39467,
      timezone: 'Africa/Lagos',
      country: 'Nigeria',
      population: 15388000
    },
    {
      id: 2267226,
      name: 'Lagos',
      latitude: 37.10202,
      longitude: -8.67422,
      timezone: 'Europe/Lisbon',
      country: 'Portugal',
      population: 33494
    }
  ]
};

export function forecast(
  date: string,
  overrides: {
    weatherCode?: number;
    high?: number;
    low?: number;
    precipitation?: number | null;
    timezone?: string;
  } = {}
) {
  return {
    timezone: overrides.timezone ?? 'Africa/Lagos',
    daily: {
      time: [date],
      weather_code: [overrides.weatherCode ?? 53],
      temperature_2m_max: [overrides.high ?? 27.2],
      temperature_2m_min: [overrides.low ?? 24.8],
      precipitation_probability_max: [
        overrides.precipitation === undefined ? 100 : overrides.precipitation
      ]
    }
  };
}

export function isGeocoding(url: string): boolean {
  return url.startsWith('https://geocoding-api.open-meteo.com/v1/search');
}

export function isForecast(url: string): boolean {
  return url.startsWith('https://api.open-meteo.com/v1/forecast');
}
