/**
 * Resolving whatever the traveller typed into a real place on earth.
 *
 * The starter kit plans days anywhere, so there is no list of supported cities
 * to check against. A location is whatever a geocoder can find, and a location
 * that cannot be found is reported as exactly that — never as "unsupported".
 *
 * Two providers are used, both worldwide and both free of any credential, which
 * keeps the project clone-and-run and leaves no key that could leak:
 *
 * - Open-Meteo geocoding answers first. It is fast, returns structured fields
 *   including country code and population, and already backs the weather tool.
 * - Nominatim (OpenStreetMap) answers when Open-Meteo finds nothing. It handles
 *   colloquial input that a gazetteer lookup misses — "SF" resolves to San
 *   Francisco here and nowhere else.
 *
 * Between the two sits one general rewrite rather than a table of cities. Place
 * names that are commonly typed as a single word ("Portharcourt") are split
 * after a known place-name prefix, which fixes that class of input worldwide:
 * Newyork, Sanfrancisco, Santamonica, Saintpetersburg. No city is named in the
 * code, so a city cannot be privileged by it.
 */

export type ResolvedLocation = {
  city: string;
  country: string;
  countryCode: string;
  latitude: number;
  longitude: number;
  displayName: string;
};

/**
 * Raised when every gazetteer was unreachable.
 *
 * Distinct from `LocationNotFoundError` on purpose: a provider outage is not
 * evidence that a place does not exist, and telling a traveller their city
 * cannot be found because a server was down would be a lie.
 */
export class LocationLookupError extends Error {
  readonly code = 'location_lookup_failed';
  constructor(readonly cause?: unknown) {
    super('The location service could not be reached.');
    this.name = 'LocationLookupError';
  }
}

/** Raised when no provider could place the query. Never says "unsupported". */
export class LocationNotFoundError extends Error {
  readonly code = 'location_not_found';
  constructor(readonly query: string) {
    super(
      `I could not find a place called "${query}". Check the spelling, or try including the country.`
    );
    this.name = 'LocationNotFoundError';
  }
}

const OPEN_METEO_GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/**
 * Nominatim asks for a descriptive agent so it can contact heavy users.
 * Identifying the project is a condition of its acceptable-use policy.
 */
const USER_AGENT = 'plan-my-day-starter-kit/0.1 (+https://github.com/kinde-starter-kits)';

/**
 * Word-beginnings that are frequently run together with the rest of the name.
 *
 * This is a linguistic rule about how place names are written, not a list of
 * places: it applies to any city whose name starts with one of these, in any
 * country, including ones nobody here has heard of.
 */
const NAME_PREFIXES = [
  'port', 'new', 'san', 'santa', 'santo', 'saint', 'st', 'fort', 'los', 'las',
  'el', 'la', 'le', 'rio', 'sao', 'ho', 'mont', 'cape', 'north', 'south',
  'east', 'west', 'great', 'little', 'upper', 'lower'
];

function clean(query: string): string {
  return String(query ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Candidate spellings to try, most faithful first.
 *
 * The original is always tried first so a correctly spelled name is never
 * rewritten into something else.
 */
export function spellingCandidates(query: string): string[] {
  const base = clean(query);
  if (!base) return [];

  const candidates = [base];
  const single = base.toLowerCase();

  // Only a single run-together token can benefit from splitting.
  if (!single.includes(' ') && single.length >= 7) {
    for (const prefix of NAME_PREFIXES) {
      if (single.startsWith(prefix) && single.length > prefix.length + 2) {
        candidates.push(`${base.slice(0, prefix.length)} ${base.slice(prefix.length)}`);
      }
    }
  }

  return [...new Set(candidates)];
}

type OpenMeteoResult = {
  name?: unknown;
  country?: unknown;
  country_code?: unknown;
  admin1?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  population?: unknown;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    headers: {Accept: 'application/json', 'User-Agent': USER_AGENT}
  });
  if (!response.ok) throw new Error(`Location lookup failed with status ${response.status}.`);
  return response.json();
}

/**
 * Pick one place when a gazetteer returns several.
 *
 * A bare city name almost always means the largest place with that name, so
 * population decides. An exact name match still beats a partial one, which
 * keeps "Lagos" in Nigeria rather than Portugal when both are returned.
 */
function pickBest(results: OpenMeteoResult[], query: string): OpenMeteoResult | undefined {
  const wanted = query.trim().toLowerCase();

  return [...results].sort((a, b) => {
    const exactA = String(a.name ?? '').toLowerCase() === wanted ? 1 : 0;
    const exactB = String(b.name ?? '').toLowerCase() === wanted ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;

    const popA = isFiniteNumber(a.population) ? a.population : 0;
    const popB = isFiniteNumber(b.population) ? b.population : 0;
    return popB - popA;
  })[0];
}

async function viaOpenMeteo(query: string, signal?: AbortSignal): Promise<ResolvedLocation | undefined> {
  const url = `${OPEN_METEO_GEOCODING}?name=${encodeURIComponent(query)}&count=10&language=en&format=json`;
  const payload = (await fetchJson(url, signal)) as {results?: OpenMeteoResult[]};

  const usable = (payload?.results ?? []).filter(
    result => isFiniteNumber(result?.latitude) && isFiniteNumber(result?.longitude)
  );
  const best = pickBest(usable, query);
  if (!best) return undefined;

  const city = String(best.name ?? query);
  const country = String(best.country ?? '');
  const region = best.admin1 ? String(best.admin1) : '';

  return {
    city,
    country,
    countryCode: String(best.country_code ?? '').toUpperCase(),
    latitude: best.latitude as number,
    longitude: best.longitude as number,
    displayName: [city, region, country].filter(Boolean).join(', ')
  };
}

type NominatimResult = {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  name?: unknown;
  address?: {country?: unknown; country_code?: unknown; state?: unknown} & Record<string, unknown>;
};

async function viaNominatim(query: string, signal?: AbortSignal): Promise<ResolvedLocation | undefined> {
  const url =
    `${NOMINATIM}?format=jsonv2&limit=1&addressdetails=1&featureType=city&q=${encodeURIComponent(query)}`;
  const results = (await fetchJson(url, signal)) as NominatimResult[];

  const first = Array.isArray(results) ? results[0] : undefined;
  if (!first) return undefined;

  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return undefined;

  const display = String(first.display_name ?? '');
  const city = String(first.name ?? display.split(',')[0] ?? query).trim();

  return {
    city,
    country: String(first.address?.country ?? ''),
    countryCode: String(first.address?.country_code ?? '').toUpperCase(),
    latitude,
    longitude,
    displayName: display || city
  };
}

/**
 * Resolve a traveller's words into one place.
 *
 * Each spelling candidate is tried against both providers before moving on, so
 * a name that only one of them knows still resolves. A provider that errors is
 * skipped rather than failing the request — one gazetteer being unreachable
 * should not make every location unfindable.
 */
export async function resolveLocation(
  query: string,
  signal?: AbortSignal
): Promise<ResolvedLocation> {
  const candidates = spellingCandidates(query);
  if (candidates.length === 0) throw new LocationNotFoundError(String(query ?? ''));

  let anyProviderAnswered = false;
  let lastFailure: unknown;

  for (const candidate of candidates) {
    for (const lookup of [viaOpenMeteo, viaNominatim]) {
      try {
        const found = await lookup(candidate, signal);
        anyProviderAnswered = true;
        if (found) return found;
      } catch (error) {
        // Try the next provider rather than failing the whole request.
        lastFailure = error;
      }
    }
  }

  // Nothing answered at all, so the place may well exist and simply could not
  // be looked up. Say that, rather than blaming the traveller's spelling.
  if (!anyProviderAnswered) throw new LocationLookupError(lastFailure);

  throw new LocationNotFoundError(clean(query));
}
