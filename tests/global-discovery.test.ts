import {describe, expect, it, vi, afterEach} from 'vitest';

import {
  LocationNotFoundError,
  resolveLocation,
  spellingCandidates
} from '../src/mastra/lib/geocoding';
import {discoverActivities, PlaceDiscoveryError} from '../src/mastra/lib/places';
import {parseOpeningHours, toCandidate, toCandidates} from '../src/mastra/lib/discovered-activities';
import {
  categoriesForRequest,
  findActivities,
  findActivitiesGlobal
} from '../src/mastra/tools/find-activities';
import {
  clearKnownActivities,
  findKnownActivity,
  knownActivitiesFor,
  rememberDiscovered
} from '../src/mastra/lib/activity-context';
import {
  parsePlanningConstraints,
  validateItinerary
} from '../src/mastra/lib/itinerary-validator';

/**
 * Planning anywhere.
 *
 * The starter kit no longer has a list of supported cities, so these tests hold
 * two lines. A location is whatever a geocoder can find, and an activity is
 * whatever the map actually records — never a plausible invention.
 *
 * Both providers are stubbed at the `fetch` boundary, so the real query
 * construction, provider fallback, classification and adaptation all run.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const LONDON = {
  city: 'London',
  country: 'United Kingdom',
  countryCode: 'GB',
  latitude: 51.5074,
  longitude: -0.1278,
  displayName: 'London, England, United Kingdom'
};

/** Stub both gazetteers, so provider fallback is exercised rather than mocked away. */
function stubGeocoder(handler: (url: string) => unknown | undefined) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = handler(url);
    if (body === undefined) {
      return new Response(JSON.stringify({results: []}), {status: 200});
    }
    return new Response(JSON.stringify(body), {status: 200});
  }) as typeof fetch;
}

const openMeteoHit = (name: string, country = 'United Kingdom', code = 'GB') => ({
  results: [
    {name, country, country_code: code, latitude: 51.5, longitude: -0.12, population: 9000000}
  ]
});

describe('resolving an arbitrary location', () => {
  it.each([
    ['London', 'London'],
    ['Tokyo', 'Tokyo'],
    ['Nairobi', 'Nairobi'],
    ['São Paulo', 'São Paulo']
  ])('resolves %s through the primary gazetteer', async (query, expected) => {
    stubGeocoder(url => (url.includes('open-meteo') ? openMeteoHit(expected) : undefined));

    const place = await resolveLocation(query);
    expect(place.city).toBe(expected);
    expect(place.latitude).toBeCloseTo(51.5);
  });

  it('falls back to the second gazetteer when the first knows nothing', async () => {
    // "SF" is the case a plain gazetteer misses and a search index resolves.
    stubGeocoder(url =>
      url.includes('open-meteo')
        ? {results: []}
        : [
            {
              lat: '37.7793',
              lon: '-122.4193',
              name: 'San Francisco',
              display_name: 'San Francisco, California, United States',
              address: {country: 'United States', country_code: 'us'}
            }
          ]
    );

    const place = await resolveLocation('SF');
    expect(place.city).toBe('San Francisco');
    expect(place.countryCode).toBe('US');
  });

  it('splits a run-together place name without naming any city', () => {
    // A rule about how place names are written, not a table of places.
    expect(spellingCandidates('Portharcourt')).toContain('Port harcourt');
    expect(spellingCandidates('Newyork')).toContain('New york');
    expect(spellingCandidates('Sanfrancisco')).toContain('San francisco');
    // A correctly spelled name is never rewritten away from itself.
    expect(spellingCandidates('London')[0]).toBe('London');
  });

  it('resolves Portharcourt and Port Harcourt to the same place', async () => {
    stubGeocoder(url => {
      if (!url.includes('open-meteo')) return [];
      // The gazetteer only knows the spaced spelling, as the real one does.
      return url.includes('Port%20harcourt') || url.includes('Port+harcourt')
        ? {
            results: [
              {
                name: 'Port Harcourt',
                country: 'Nigeria',
                country_code: 'NG',
                latitude: 4.7774,
                longitude: 7.0134,
                population: 1000000
              }
            ]
          }
        : {results: []};
    });

    const spaced = await resolveLocation('Port harcourt');
    const joined = await resolveLocation('Portharcourt');

    expect(joined.city).toBe('Port Harcourt');
    expect(joined.latitude).toBe(spaced.latitude);
    expect(joined.longitude).toBe(spaced.longitude);
  });

  it('reports an unfindable place as unfindable, never as unsupported', async () => {
    stubGeocoder(url => (url.includes('open-meteo') ? {results: []} : []));

    await expect(resolveLocation('Nowherecityxyz')).rejects.toBeInstanceOf(LocationNotFoundError);
    await expect(resolveLocation('Nowherecityxyz')).rejects.toThrow(/could not find a place/i);
    await expect(resolveLocation('Nowherecityxyz')).rejects.not.toThrow(/unsupported|not supported/i);
  });

  it('survives one gazetteer being unreachable', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('open-meteo')) throw new Error('network down');
      return new Response(
        JSON.stringify([
          {
            lat: '35.68',
            lon: '139.69',
            name: 'Tokyo',
            display_name: 'Tokyo, Japan',
            address: {country: 'Japan', country_code: 'jp'}
          }
        ]),
        {status: 200}
      );
    }) as typeof fetch;

    const place = await resolveLocation('Tokyo');
    expect(place.city).toBe('Tokyo');
  });
});

/** One Overpass element, in the shape the API really returns. */
const element = (tags: Record<string, string>, lat = 51.5, lon = -0.12) => ({lat, lon, tags});

function stubOverpass(elements: unknown[], status = 200) {
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify({elements}), {status})
  ) as typeof fetch;
}

describe('discovering places anywhere', () => {
  it('returns only what the map recorded', async () => {
    stubOverpass([
      element({
        name: 'British Museum',
        tourism: 'museum',
        opening_hours: 'Mo-Su 10:00-17:00',
        website: 'https://example.org/bm',
        wheelchair: 'yes',
        'addr:street': 'Great Russell Street',
        'addr:city': 'London'
      })
    ]);

    const [place] = await discoverActivities({location: LONDON, minimum: 1});

    expect(place.name).toBe('British Museum');
    expect(place.category).toBe('culture');
    expect(place.indoor).toBe(true);
    expect(place.openingHours).toBe('Mo-Su 10:00-17:00');
    expect(place.website).toBe('https://example.org/bm');
    expect(place.wheelchairAccessible).toBe(true);
    expect(place.address).toContain('Great Russell Street');
  });

  it('leaves unrecorded fields absent rather than guessing', async () => {
    stubOverpass([element({name: 'Quiet Park', leisure: 'park'})]);

    const [place] = await discoverActivities({location: LONDON, minimum: 1});

    expect(place.openingHours).toBeUndefined();
    expect(place.website).toBeUndefined();
    expect(place.wheelchairAccessible).toBeUndefined();
    expect(place.dietary).toBeUndefined();
    expect(place.address).toBeUndefined();
  });

  it('classifies indoor and outdoor from the map', async () => {
    stubOverpass([
      element({name: 'City Gallery', tourism: 'gallery'}),
      element({name: 'Riverside Park', leisure: 'park'}),
      element({name: 'Sunset Beach', natural: 'beach'})
    ]);

    const places = await discoverActivities({location: LONDON, minimum: 3});
    const byName = Object.fromEntries(places.map(p => [p.name, p]));

    expect(byName['City Gallery'].indoor).toBe(true);
    expect(byName['Riverside Park'].indoor).toBe(false);
    expect(byName['Sunset Beach'].indoor).toBe(false);
  });

  it('reads dietary tags the map actually carries', async () => {
    stubOverpass([
      element({name: 'Green Kitchen', amenity: 'restaurant', 'diet:vegetarian': 'yes', 'diet:vegan': 'only'}),
      element({name: 'Plain Diner', amenity: 'restaurant'})
    ]);

    const places = await discoverActivities({location: LONDON, minimum: 2});
    const byName = Object.fromEntries(places.map(p => [p.name, p]));

    expect(byName['Green Kitchen'].dietary).toEqual(['vegetarian', 'vegan']);
    expect(byName['Plain Diner'].dietary).toBeUndefined();
  });

  it('skips places with no name, which cannot be put in a plan', async () => {
    stubOverpass([element({tourism: 'museum'}), element({name: 'Named Museum', tourism: 'museum'})]);

    const places = await discoverActivities({location: LONDON, minimum: 1});
    expect(places.map(p => p.name)).toEqual(['Named Museum']);
  });

  it('does not return accommodation, which is not something to do', async () => {
    stubOverpass([
      element({name: 'Grand Hotel', tourism: 'hotel'}),
      element({name: 'Cosy Apartment', tourism: 'apartment'}),
      element({name: 'Real Museum', tourism: 'museum'})
    ]);

    const places = await discoverActivities({location: LONDON, minimum: 1});
    expect(places.map(p => p.name)).toEqual(['Real Museum']);
  });

  it('reports a provider failure instead of inventing places', async () => {
    globalThis.fetch = vi.fn(async () => new Response('busy', {status: 429})) as typeof fetch;

    await expect(discoverActivities({location: LONDON, minimum: 1})).rejects.toBeInstanceOf(
      PlaceDiscoveryError
    );
  });

  it('returns an empty result when the map holds nothing, rather than filling it', async () => {
    stubOverpass([]);
    await expect(discoverActivities({location: LONDON, minimum: 5})).resolves.toEqual([]);
  });

  it('carries no provider credential, because the provider needs none', async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = vi.fn(async (_i: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({elements: []}), {status: 200});
    }) as typeof fetch;

    await discoverActivities({location: LONDON, minimum: 1});

    const serialised = JSON.stringify(seen);
    expect(serialised).not.toMatch(/api[_-]?key|authorization|token|secret/i);
  });
});

describe('adapting a place into a plannable candidate', () => {
  const place = {
    name: 'Tate Modern',
    latitude: 51.5076,
    longitude: -0.0994,
    category: 'culture',
    tags: ['culture', 'indoor'],
    indoor: true,
    openingHours: 'Mo-Su 10:00-18:00',
    website: 'https://example.org/tate',
    wheelchairAccessible: true
  };

  it('keeps every recorded fact, including provenance', () => {
    const candidate = toCandidate(place as never, LONDON);

    expect(candidate.name).toBe('Tate Modern');
    expect(candidate.location).toBe('London');
    expect(candidate.category).toBe('culture');
    expect(candidate.weatherDependent).toBe(false);
    expect(candidate.sourceUrl).toBe('https://example.org/tate');
    expect(candidate.wheelchairAccessible).toBe(true);
    expect(candidate.availability?.opensAt).toBe('10:00');
    expect(candidate.availability?.closesAt).toBe('18:00');
    // "Mo-Su" is every day; the span is walked from its start, so compare the
    // set rather than the order.
    expect(new Set(candidate.availability?.days)).toEqual(
      new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
    );
  });

  it('leaves opening hours unknown rather than inventing a schedule', () => {
    const candidate = toCandidate({...place, openingHours: undefined} as never, LONDON);
    expect(candidate.availability).toBeUndefined();
  });

  it('treats an opening-hours syntax it cannot safely read as unknown', () => {
    // Misreading these would claim a venue is open when it is closed.
    for (const value of ['Mo-Fr 09:00-12:00,13:00-17:00', 'sunrise-sunset', 'Apr-Oct 10:00-18:00']) {
      expect(parseOpeningHours(value)).toBeUndefined();
    }
  });

  it('reads the plain forms it can trust', () => {
    expect(parseOpeningHours('24/7')?.opensAt).toBe('00:00');
    expect(parseOpeningHours('Mo-Fr 09:00-17:00')?.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
    expect(parseOpeningHours('9:00-17:00')?.opensAt).toBe('09:00');
  });

  it('marks an outdoor place weather-dependent and an indoor one not', () => {
    const outdoor = toCandidate({...place, indoor: false, category: 'nature'} as never, LONDON);

    expect(outdoor.weatherDependent).toBe(true);
    expect(outdoor.suitableWeather).not.toContain('wet');
    expect(toCandidate(place as never, LONDON).suitableWeather).toContain('wet');
  });

  it('gives the same place the same id every time', () => {
    expect(toCandidate(place as never, LONDON).id).toBe(toCandidate(place as never, LONDON).id);
  });

  it('describes a place only from what was recorded', () => {
    const described = toCandidate({...place, description: 'A modern art gallery.'} as never, LONDON);
    expect(described.description).toBe('A modern art gallery.');

    // With nothing recorded, the sentence states the category and the city and
    // claims nothing else about the venue.
    const bare = toCandidate({...place, description: undefined, address: undefined} as never, LONDON);
    expect(bare.description).toMatch(/London/);
    expect(bare.description.length).toBeLessThan(60);
  });

  it('adapts a whole result set without dropping or adding entries', () => {
    const candidates = toCandidates([place, {...place, name: 'Second Place'}] as never, LONDON);
    expect(candidates.map(c => c.name)).toEqual(['Tate Modern', 'Second Place']);
  });
});

/**
 * The production planning path.
 *
 * These drive `findActivitiesGlobal` with both providers stubbed at the fetch
 * boundary, so location resolution, discovery, adaptation and the existing
 * ranking all run for real. The point is that no city is special: the same code
 * answers for London and for a town nobody has curated.
 */
describe('planning from discovered places', () => {
  /** Answer the gazetteer with `city`, and Overpass with `elements`. */
  function stubWorld(city: string, elements: unknown[]) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('geocoding-api') || url.includes('nominatim')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                name: city,
                country: 'Testland',
                country_code: 'TL',
                latitude: 10,
                longitude: 20,
                population: 5000000
              }
            ]
          }),
          {status: 200}
        );
      }
      return new Response(JSON.stringify({elements}), {status: 200});
    }) as typeof fetch;
  }

  const museum = (name: string) => ({lat: 10, lon: 20, tags: {name, tourism: 'museum'}});
  const park = (name: string) => ({lat: 10, lon: 20, tags: {name, leisure: 'park'}});

  /** Production discovers; the suite otherwise pins the seeded fixtures. */
  async function discovering<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.ACTIVITY_SOURCE;
    delete process.env.ACTIVITY_SOURCE;
    try {
      return await fn();
    } finally {
      if (previous === undefined) delete process.env.ACTIVITY_SOURCE;
      else process.env.ACTIVITY_SOURCE = previous;
    }
  }

  it.each(['London', 'San Francisco', 'Lagos', 'Port Harcourt', 'Tokyo', 'Reykjavik'])(
    'plans %s through the one global path',
    async city => {
      clearKnownActivities();
      stubWorld(city, [museum(`${city} Museum`), park(`${city} Park`)]);

      const result = await discovering(() => findActivitiesGlobal({location: city}));

      expect(result.location).toBe(city);
      expect(result.activities.map(a => a.name)).toContain(`${city} Museum`);
    }
  );

  it('records what was offered so the plan can be checked against it', async () => {
    clearKnownActivities();
    stubWorld('Lisbon', [museum('Museu do Azulejo')]);

    await discovering(() => findActivitiesGlobal({location: 'Lisbon'}));

    expect(findKnownActivity('Lisbon', 'Museu do Azulejo')).toBeDefined();
    expect(findKnownActivity('Lisbon', 'A Place Nobody Offered')).toBeUndefined();
  });

  it('stores no provider payload, only the fields planning needs', async () => {
    clearKnownActivities();
    stubWorld('Oslo', [
      {lat: 10, lon: 20, tags: {name: 'Munch', tourism: 'museum', 'source:ref': 'internal-123'}}
    ]);

    await discovering(() => findActivitiesGlobal({location: 'Oslo'}));
    const stored = JSON.stringify(knownActivitiesFor('Oslo'));

    expect(stored).toContain('Munch');
    expect(stored).not.toContain('internal-123');
    expect(stored).not.toMatch(/elements|overpass|osm_id/i);
  });

  it('keeps the seeded fixtures working for offline runs', () => {
    const seeded = findActivities({location: 'Lagos'});
    expect(seeded.activities.length).toBeGreaterThan(0);
  });

  it('narrows the search to what the request is about', () => {
    expect(categoriesForRequest({tags: ['outdoor']})).toEqual(
      expect.arrayContaining(['outdoor', 'nature'])
    );
    expect(categoriesForRequest({tags: ['vegetarian', 'dinner']})).toContain('food');
    expect(categoriesForRequest({category: 'culture'})).toEqual(
      expect.arrayContaining(['culture', 'entertainment'])
    );
    expect(categoriesForRequest({severity: 'severe'})).toEqual(
      expect.arrayContaining(['culture', 'food'])
    );
    // Nothing recognisable leaves the search wide rather than guessing narrow.
    expect(categoriesForRequest({tags: ['bananas']})).toEqual([]);
  });

  it('keeps outdoor places out of the top spot in severe weather', async () => {
    clearKnownActivities();
    stubWorld('Bergen', [museum('Indoor Museum'), park('Exposed Park')]);

    const result = await discovering(() =>
      findActivitiesGlobal({
        location: 'Bergen',
        tags: ['outdoor'],
        weather: {precipitationChance: 95, highCelsius: 12, lowCelsius: 8}
      })
    );

    expect(result.weatherSeverity).toBe('severe');
    // A stated preference must not outrank safety.
    expect(result.activities[0].name).toBe('Indoor Museum');
  });

  it('reports an unfindable city as unfindable, not unsupported', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('nominatim')
        ? new Response(JSON.stringify([]), {status: 200})
        : new Response(JSON.stringify({results: []}), {status: 200})
    ) as typeof fetch;

    await expect(
      discovering(() => findActivitiesGlobal({location: 'Qzxwv'}))
    ).rejects.toBeInstanceOf(LocationNotFoundError);
  });
});

/**
 * Validating a plan built from places nobody curated.
 *
 * The validator used to ask whether an activity appeared in the shipped
 * dataset, which only worked while the world was two cities. It now asks
 * whether a search actually returned it — a question that holds anywhere, and
 * still catches a venue the model invented.
 */
describe('validating a plan built from discovered places', () => {
  const discovered = [
    {
      id: 'osm-a',
      name: 'Harbour Museum',
      location: 'Testville',
      category: 'culture',
      description: 'A museum.',
      durationMinutes: 90,
      weatherDependent: false,
      suitableWeather: ['wet', 'hot', 'cold', 'mild'],
      availability: {
        days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
        opensAt: '10:00',
        closesAt: '18:00'
      },
      tags: ['culture']
    },
    {
      // Hours unknown, as much of the world's map data is.
      id: 'osm-b',
      name: 'Old Market',
      location: 'Testville',
      category: 'shopping',
      description: 'A market.',
      durationMinutes: 60,
      weatherDependent: true,
      suitableWeather: ['mild', 'hot'],
      availability: undefined,
      tags: ['market']
    }
  ];

  const plan = (activities: unknown[]) => ({
    destination: 'Testville',
    date: '2026-08-22',
    summary: 'An afternoon.',
    weather: {
      summary: 'Sunny',
      highCelsius: 24,
      lowCelsius: 18,
      precipitationChance: 5,
      considerations: []
    },
    activities,
    notes: []
  });

  const activity = (over: Record<string, unknown> = {}) => ({
    order: 1,
    name: 'Harbour Museum',
    category: 'culture',
    startTime: '13:00',
    durationMinutes: 90,
    location: 'Testville',
    description: 'A museum in Testville.',
    weatherDependent: false,
    ...over
  });

  const check = (activities: unknown[], request = 'Plan an afternoon in Testville.') =>
    validateItinerary({
      itinerary: plan(activities) as never,
      constraints: parsePlanningConstraints(request)
    }).issues.map(issue => issue.code);

  it('accepts a plan made only of places that were offered', () => {
    clearKnownActivities();
    rememberDiscovered('Testville', discovered as never);

    expect(check([activity()])).not.toContain('unknown_activity');
  });

  it('still catches a place nobody offered', () => {
    clearKnownActivities();
    rememberDiscovered('Testville', discovered as never);

    expect(check([activity({name: 'Invented Rooftop Bar'})])).toContain('unknown_activity');
  });

  it('enforces opening hours when the map recorded them', () => {
    clearKnownActivities();
    rememberDiscovered('Testville', discovered as never);

    expect(check([activity({startTime: '19:00'})], 'Plan an evening in Testville.')).toContain(
      'outside_opening_hours'
    );
  });

  it('treats unknown hours as unknown, neither open nor disqualifying', () => {
    clearKnownActivities();
    rememberDiscovered('Testville', discovered as never);

    const codes = check([
      activity({
        name: 'Old Market',
        category: 'shopping',
        weatherDependent: true,
        durationMinutes: 60
      })
    ]);

    expect(codes).not.toContain('unknown_activity');
    expect(codes).not.toContain('outside_opening_hours');
    expect(codes).not.toContain('closed_on_day');
  });

  it('still catches a destination mismatch', () => {
    clearKnownActivities();
    rememberDiscovered('Testville', [{...discovered[0], location: 'Elsewhere'}] as never);

    expect(check([activity()])).toContain('destination_mismatch');
  });

  it('still works from the seeded fixtures, so offline runs are unaffected', () => {
    clearKnownActivities();

    const codes = validateItinerary({
      itinerary: {
        destination: 'Lagos',
        date: '2026-08-22',
        summary: 'An afternoon.',
        weather: {
          summary: 'Sunny',
          highCelsius: 30,
          lowCelsius: 24,
          precipitationChance: 5,
          considerations: []
        },
        activities: [
          {
            order: 1,
            name: 'Nike Art Gallery',
            category: 'culture',
            startTime: '13:00',
            durationMinutes: 90,
            location: 'Lagos',
            description: 'Art.',
            weatherDependent: false
          }
        ],
        notes: []
      } as never,
      constraints: parsePlanningConstraints('Plan an afternoon in Lagos.')
    }).issues.map(issue => issue.code);

    expect(codes).not.toContain('unknown_activity');
  });
});

/**
 * The two faults the first production run exposed.
 *
 * A live San Francisco request failed with "unable to access weather and
 * activity information", and a live Portharcourt request failed with "could not
 * find Portharcourt" — even though both worked when the modules were driven
 * directly. Two separate causes, both regressed here.
 */
describe('faults found in production', () => {
  it('gives the deployed function enough time for a slow map query', async () => {
    /*
     * Measured against the live server: San Francisco takes about 20 seconds
     * and London about 13, because a dense city matches many places. On the
     * default serverless budget the function was killed part-way through, so
     * every tool in the run reported failure at once.
     */
    // Read the configuration rather than booting Mastra, which needs a tenant.
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/mastra/index.ts', import.meta.url), 'utf8')
    );

    expect(source).toMatch(/new VercelDeployer\(\{[\s\S]*maxDuration:\s*60/);
  });

  it('bounds a single map attempt so one stall cannot consume the budget', async () => {
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/mastra/lib/places.ts', import.meta.url), 'utf8')
    );

    // The server's own query timeout governs its planner, not the socket.
    expect(source).toMatch(/AbortSignal\.timeout/);
    expect(source).toMatch(/ATTEMPT_TIMEOUT_MS/);
  });

  it('resolves a location the same way for weather as for activities', async () => {
    /*
     * The forecast tool used to geocode privately, so "Portharcourt" resolved
     * for the activity search and not for the weather, and the run failed on a
     * spelling one half of the system understood.
     */
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/mastra/tools/get-weather.ts', import.meta.url), 'utf8')
    );

    expect(source).toMatch(/resolveLocation/);
  });

  it('calls a provider outage an outage, not an unknown place', async () => {
    // Saying "no such city" because a server was down would be a lie.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const {LocationLookupError} = await import('../src/mastra/lib/geocoding');
    await expect(resolveLocation('London')).rejects.toBeInstanceOf(LocationLookupError);
  });

  it('still calls an unknown place unknown when providers answer', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('nominatim')
        ? new Response(JSON.stringify([]), {status: 200})
        : new Response(JSON.stringify({results: []}), {status: 200})
    ) as typeof fetch;

    await expect(resolveLocation('Qzxwvplace')).rejects.toBeInstanceOf(LocationNotFoundError);
  });
});
