import type {ResolvedLocation} from './geocoding';

/**
 * Finding real places to visit, anywhere.
 *
 * The provider is the OpenStreetMap Overpass API. It was chosen over the
 * commercial place APIs for two reasons that matter to a starter kit rather
 * than for convenience:
 *
 * - Coverage is genuinely worldwide, because OpenStreetMap is one map of the
 *   whole planet rather than a market-by-market rollout. Measured before this
 *   was written: London 59 named places, San Francisco 58, Tokyo 55, Lagos 55,
 *   Port Harcourt 9 — sparse, but real, and no city is special-cased.
 * - It needs no credential, so cloning the repository is enough to run it and
 *   there is no key that can leak into a bundle, a log or a trace.
 *
 * The cost is data quality that varies by region: opening hours, websites and
 * accessibility tags are common in Europe and North America and rare elsewhere.
 * Every field below is therefore optional and is reported only when the map
 * actually carries it. Nothing here fills a gap with a guess.
 */

/** Where a place came from. Kept for provenance, never fabricated. */
export type DiscoveredActivity = {
  name: string;
  description?: string;
  latitude: number;
  longitude: number;
  category: string;
  tags: string[];
  indoor: boolean;
  address?: string;
  openingHours?: string;
  sourceUrl?: string;
  website?: string;
  wheelchairAccessible?: boolean;
  dietary?: string[];
  priceLevel?: string;
};

export class PlaceDiscoveryError extends Error {
  readonly code = 'place_discovery_failed';
  constructor(message: string) {
    super(message);
    this.name = 'PlaceDiscoveryError';
  }
}

/**
 * Overpass mirrors. The first that answers wins.
 *
 * The public instances are rate limited and occasionally busy, so a second is
 * tried before giving up. Both serve the same OpenStreetMap data.
 */
/** Identifies the project to Overpass, which refuses anonymous clients. */
const USER_AGENT = 'plan-my-day-starter-kit/0.1 (+https://github.com/kinde-starter-kits)';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

/**
 * What counts as somewhere to spend part of a day.
 *
 * Deliberately an allow-list of visitable places. A plain "has a tourism tag"
 * query returns mostly accommodation — in Port Harcourt, 160 of 186 results
 * were apartments and hotels, which are places to sleep, not things to do.
 */
type PlaceKind = {
  /** OSM key and value pattern that selects this kind of place. */
  selector: string;
  category: string;
  indoor: boolean;
  tags: string[];
};

const PLACE_KINDS: PlaceKind[] = [
  {selector: 'tourism~"^(museum|gallery)$"', category: 'culture', indoor: true, tags: ['culture', 'indoor']},
  {selector: 'tourism~"^(attraction|artwork|viewpoint)$"', category: 'culture', indoor: false, tags: ['sightseeing']},
  {selector: 'tourism~"^(zoo|theme_park|aquarium)$"', category: 'entertainment', indoor: false, tags: ['family']},
  {selector: 'amenity~"^(theatre|cinema|arts_centre)$"', category: 'entertainment', indoor: true, tags: ['culture', 'indoor']},
  {selector: 'amenity~"^(restaurant|fast_food)$"', category: 'food', indoor: true, tags: ['food']},
  {selector: 'amenity~"^(cafe|ice_cream)$"', category: 'food', indoor: true, tags: ['food', 'relaxed']},
  {selector: 'amenity="marketplace"', category: 'shopping', indoor: false, tags: ['market', 'local']},
  {selector: 'leisure~"^(park|garden|nature_reserve)$"', category: 'nature', indoor: false, tags: ['outdoor', 'relaxed']},
  {selector: 'leisure~"^(beach_resort|water_park)$"', category: 'outdoor', indoor: false, tags: ['outdoor', 'water']},
  {selector: 'natural="beach"', category: 'outdoor', indoor: false, tags: ['outdoor', 'beach']},
  {selector: 'leisure~"^(sports_centre|fitness_centre)$"', category: 'wellness', indoor: true, tags: ['active', 'indoor']},
  {selector: 'leisure="spa"', category: 'wellness', indoor: true, tags: ['wellness', 'relaxed', 'indoor']},
  {selector: 'amenity="spa"', category: 'wellness', indoor: true, tags: ['wellness', 'relaxed', 'indoor']},
  {selector: 'shop="mall"', category: 'shopping', indoor: true, tags: ['shopping', 'indoor']},
  {selector: 'historic~"^(monument|memorial|castle|ruins|archaeological_site)$"', category: 'culture', indoor: false, tags: ['history', 'sightseeing']}
];

/** Radii tried in order, so a sparse city still yields something real. */
const SEARCH_RADII_METRES = [5000, 12000, 25000];

/**
 * One clause per OpenStreetMap key rather than one per place kind.
 *
 * The first version emitted sixty clauses, which Overpass answered with
 * timeouts and 500s — London came back empty. Grouping the values of each key
 * into a single regular expression asks the same question in about a tenth of
 * the work, and the answer is classified locally from the tags.
 */
function buildQuery(location: ResolvedLocation, radius: number, kinds: PlaceKind[]): string {
  const {latitude, longitude} = location;

  const byKey = new Map<string, Set<string>>();
  for (const kind of kinds) {
    const [key, rest] = kind.selector.split(/[~=]/, 2);
    const values = (rest ?? '').trim().replace(/^"|"$/g, '').replace(/^\^\(|\)\$$/g, '');
    const set = byKey.get(key.trim()) ?? new Set<string>();
    for (const value of values.split('|')) if (value) set.add(value);
    byKey.set(key.trim(), set);
  }

  const clauses = [...byKey.entries()]
    .flatMap(([key, values]) => {
      const selector = `[${key}~"^(${[...values].join('|')})$"]`;
      return [
        `node(around:${radius},${latitude},${longitude})${selector};`,
        `way(around:${radius},${latitude},${longitude})${selector};`
      ];
    })
    .join('\n  ');

  return `[out:json][timeout:25];\n(\n  ${clauses}\n);\nout center 250;`;
}

type OverpassElement = {
  lat?: number;
  lon?: number;
  center?: {lat?: number; lon?: number};
  tags?: Record<string, string>;
};

/** The kind whose selector this element satisfies, for category and indoor-ness. */
function classify(tags: Record<string, string>): PlaceKind | undefined {
  const matches = (kind: PlaceKind): boolean => {
    const [key, rest] = kind.selector.split(/[~=]/, 2);
    const value = tags[key.trim()];
    if (!value) return false;

    const pattern = rest?.trim().replace(/^"|"$/g, '');
    if (!pattern) return true;
    if (kind.selector.includes('~')) return new RegExp(pattern).test(value);
    return value === pattern;
  };

  return PLACE_KINDS.find(matches);
}

/** Dietary facts OpenStreetMap actually records, read only where present. */
function dietaryOf(tags: Record<string, string>): string[] | undefined {
  const diets = Object.entries(tags)
    .filter(([key, value]) => key.startsWith('diet:') && (value === 'yes' || value === 'only'))
    .map(([key]) => key.slice('diet:'.length));

  return diets.length ? diets : undefined;
}

function addressOf(tags: Record<string, string>): string | undefined {
  const parts = [
    [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' '),
    tags['addr:suburb'] ?? tags['addr:district'],
    tags['addr:city']
  ].filter(Boolean);

  return parts.length ? parts.join(', ') : undefined;
}

function toActivity(element: OverpassElement): DiscoveredActivity | undefined {
  const tags = element.tags ?? {};
  const name = tags.name?.trim();
  if (!name) return undefined;

  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return undefined;

  const kind = classify(tags);
  if (!kind) return undefined;

  const cuisine = tags.cuisine
    ? tags.cuisine.split(';').map(value => value.trim()).filter(Boolean)
    : [];

  // `indoor` follows the kind, except where the map says otherwise.
  const indoor = tags.indoor === 'yes' ? true : tags.outdoor === 'yes' ? false : kind.indoor;

  return {
    name,
    description: tags.description?.trim() || undefined,
    latitude,
    longitude,
    category: kind.category,
    tags: [...new Set([...kind.tags, ...cuisine])],
    indoor,
    address: addressOf(tags),
    openingHours: tags.opening_hours?.trim() || undefined,
    website: tags.website?.trim() || tags['contact:website']?.trim() || undefined,
    wheelchairAccessible:
      tags.wheelchair === 'yes' ? true : tags.wheelchair === 'no' ? false : undefined,
    dietary: dietaryOf(tags),
    priceLevel: undefined
  };
}

/**
 * How long one Overpass attempt may take.
 *
 * The server's own `[timeout:25]` governs its query planner, not the socket, so
 * a stalled connection could otherwise hang until the function was killed. This
 * fails the attempt while there is still budget to try the other mirror.
 */
const ATTEMPT_TIMEOUT_MS = 22_000;

async function runQuery(query: string, signal?: AbortSignal): Promise<OverpassElement[]> {
  let lastError: unknown;

  // Overpass answers 429 and 504 when busy, and occasionally 500 under load.
  // One short pause and a second mirror is enough in practice.
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // Caller cancellation and the attempt bound both abort the request.
        const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
        const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

        const response = await fetch(endpoint, {
          method: 'POST',
          signal: attemptSignal,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            /*
             * Overpass answers 406 without a descriptive agent, and its
             * acceptable-use policy asks heavy users to be identifiable.
             */
            'User-Agent': USER_AGENT
          },
          body: new URLSearchParams({data: query}).toString()
        });

        if (response.ok) {
          const payload = (await response.json()) as {elements?: OverpassElement[]};
          return payload?.elements ?? [];
        }

        lastError = new Error(`Place lookup failed with status ${response.status}.`);
        if (![429, 500, 502, 503, 504].includes(response.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw new PlaceDiscoveryError(
    `Could not reach the place directory. ${lastError instanceof Error ? lastError.message : ''}`.trim()
  );
}

/**
 * Find real places near a resolved location.
 *
 * The search widens rather than giving up: a tight radius keeps a dense city
 * walkable, and a sparse one falls back to a wider area until enough genuine
 * places exist. It never invents a place to fill the gap — returning few
 * results, or none, is the honest answer when the map holds nothing.
 */
export async function discoverActivities(input: {
  location: ResolvedLocation;
  /** Categories the request implies. Empty means every kind of place. */
  categories?: string[];
  /** Stop widening once this many distinct places are found. */
  minimum?: number;
  signal?: AbortSignal;
}): Promise<DiscoveredActivity[]> {
  const {location, categories = [], minimum = 12, signal} = input;

  const wanted = categories.length
    ? PLACE_KINDS.filter(kind => categories.includes(kind.category))
    : PLACE_KINDS;

  // A category filter that matches nothing would search for nothing.
  const kinds = wanted.length ? wanted : PLACE_KINDS;

  let found: DiscoveredActivity[] = [];

  for (const radius of SEARCH_RADII_METRES) {
    const elements = await runQuery(buildQuery(location, radius, kinds), signal);

    const seen = new Set<string>();
    found = elements
      .map(toActivity)
      .filter((activity): activity is DiscoveredActivity => Boolean(activity))
      .filter(activity => {
        const key = activity.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

    if (found.length >= minimum) break;
  }

  return found;
}
