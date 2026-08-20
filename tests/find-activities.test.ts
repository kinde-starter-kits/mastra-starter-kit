import {describe, it, expect} from 'vitest';

import {ACTIVITY_CATEGORIES} from '../src/mastra/schemas/itinerary.js';
import {
  FindActivitiesOutputSchema,
  SEEDED_ACTIVITIES,
  deriveCondition,
  findActivities,
  findActivitiesTool,
  locationMatches,
  weekdayFor
} from '../src/mastra/tools/find-activities.js';

/** A Saturday — every seeded activity that opens at weekends is available. */
const SATURDAY = '2026-08-22';

describe('seeded dataset', () => {
  it('is small enough to stay readable', () => {
    expect(SEEDED_ACTIVITIES.length).toBeGreaterThan(15);
    expect(SEEDED_ACTIVITIES.length).toBeLessThan(40);
  });

  it('covers every itinerary category', () => {
    const present = new Set(SEEDED_ACTIVITIES.map(activity => activity.category));
    for (const category of ACTIVITY_CATEGORIES) {
      expect(present.has(category)).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = SEEDED_ACTIVITIES.map(activity => activity.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps durations within the itinerary schema bounds', () => {
    for (const activity of SEEDED_ACTIVITIES) {
      expect(activity.durationMinutes).toBeGreaterThanOrEqual(15);
      expect(activity.durationMinutes).toBeLessThanOrEqual(600);
      expect(Number.isInteger(activity.durationMinutes)).toBe(true);
    }
  });

  it('gives every activity opening days and at least one tag', () => {
    for (const activity of SEEDED_ACTIVITIES) {
      expect(activity.availability.days.length).toBeGreaterThan(0);
      expect(activity.tags.length).toBeGreaterThan(0);
      expect(activity.suitableWeather.length).toBeGreaterThan(0);
    }
  });
});

describe('basic search', () => {
  it('returns candidates for a known city', () => {
    const result = findActivities({location: 'Lagos'});

    expect(result.location).toBe('Lagos');
    expect(result.activities.length).toBeGreaterThan(0);
    expect(result.totalMatches).toBeGreaterThanOrEqual(result.activities.length);
  });

  it('reports condition "unknown" when no weather context is supplied', () => {
    expect(findActivities({location: 'Lagos'}).condition).toBe('unknown');
    expect(findActivities({location: 'Lagos'}).activities[0]?.weatherFit).toBe('unknown');
  });

  it('produces output matching the declared schema', () => {
    const result = findActivities({
      location: 'Lagos',
      weather: {precipitationChance: 80, highCelsius: 27},
      tags: ['outdoors']
    });

    expect(FindActivitiesOutputSchema.safeParse(result).success).toBe(true);
  });

  it('returns the fields the itinerary needs on every candidate', () => {
    const [candidate] = findActivities({location: 'Lagos'}).activities;

    expect(candidate).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      location: expect.any(String),
      category: expect.any(String),
      description: expect.any(String),
      durationMinutes: expect.any(Number),
      weatherDependent: expect.any(Boolean),
      tags: expect.any(Array),
      matchedTags: expect.any(Array)
    });
    expect(candidate!.availability.opensAt).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('location filtering', () => {
  it('only returns activities in the requested city', () => {
    const result = findActivities({location: 'Lisbon', limit: 10});

    expect(result.activities.length).toBeGreaterThan(0);
    for (const activity of result.activities) {
      expect(activity.location).toBe('Lisbon');
    }
  });

  it('matches case-insensitively', () => {
    expect(findActivities({location: 'lagos'}).totalMatches).toBe(
      findActivities({location: 'Lagos'}).totalMatches
    );
  });

  it('ignores a trailing country qualifier', () => {
    expect(findActivities({location: 'Lagos, Nigeria'}).totalMatches).toBe(
      findActivities({location: 'Lagos'}).totalMatches
    );
  });

  it('matches a multi-word city regardless of case', () => {
    expect(findActivities({location: 'cape town'}).totalMatches).toBeGreaterThan(0);
  });

  it('exposes the matching rule directly', () => {
    expect(locationMatches('Cape Town', 'cape town')).toBe(true);
    expect(locationMatches('Lagos', 'Lagos, Nigeria')).toBe(true);
    expect(locationMatches('Lisbon', 'Lagos')).toBe(false);
    expect(locationMatches('Lagos', '   ')).toBe(false);
  });
});

describe('category filtering', () => {
  it('restricts results to the requested category', () => {
    const result = findActivities({location: 'Lagos', category: 'food', limit: 10});

    expect(result.activities.length).toBeGreaterThan(0);
    for (const activity of result.activities) {
      expect(activity.category).toBe('food');
    }
  });

  it('narrows the match count compared with an unfiltered search', () => {
    const all = findActivities({location: 'Lagos', limit: 10}).totalMatches;
    const nightlife = findActivities({location: 'Lagos', category: 'nightlife', limit: 10})
      .totalMatches;

    expect(nightlife).toBeGreaterThan(0);
    expect(nightlife).toBeLessThan(all);
  });
});

describe('tag and preference filtering', () => {
  it('ranks activities matching the requested tags first', () => {
    const result = findActivities({location: 'Lagos', tags: ['spa'], limit: 10});

    expect(result.activities[0]?.matchedTags).toContain('spa');
  });

  it('reports which tags matched', () => {
    const result = findActivities({location: 'Lagos', tags: ['outdoors', 'wildlife'], limit: 10});
    const canopy = result.activities.find(a => a.id === 'lagos-lekki-conservation');

    expect(canopy?.matchedTags.sort()).toEqual(['outdoors', 'wildlife']);
  });

  it('matches tags case-insensitively', () => {
    const upper = findActivities({location: 'Lagos', tags: ['OUTDOORS'], limit: 10});
    const lower = findActivities({location: 'Lagos', tags: ['outdoors'], limit: 10});

    expect(upper.activities.map(a => a.id)).toEqual(lower.activities.map(a => a.id));
  });

  it('still returns non-matching activities rather than filtering them out', () => {
    const withTag = findActivities({location: 'Lagos', tags: ['spa'], limit: 10});
    const withoutTag = findActivities({location: 'Lagos', limit: 10});

    expect(withTag.totalMatches).toBe(withoutTag.totalMatches);
  });

  it('ignores tags that match nothing', () => {
    const result = findActivities({location: 'Lagos', tags: ['underwater-basket-weaving']});

    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.activities.every(a => a.matchedTags.length === 0)).toBe(true);
  });
});

describe('weather suitability', () => {
  it('derives the condition bucket from a forecast', () => {
    expect(deriveCondition({precipitationChance: 90, highCelsius: 27})).toBe('wet');
    expect(deriveCondition({precipitationChance: 10, highCelsius: 35})).toBe('hot');
    expect(deriveCondition({precipitationChance: 10, highCelsius: 4})).toBe('cold');
    expect(deriveCondition({precipitationChance: 10, highCelsius: 22})).toBe('mild');
    expect(deriveCondition(undefined)).toBe('unknown');
    expect(deriveCondition({})).toBe('unknown');
  });

  it('treats rain as decisive even in warm weather', () => {
    expect(deriveCondition({precipitationChance: 70, highCelsius: 34})).toBe('wet');
  });

  it('demotes weather-dependent activities on a wet day', () => {
    const wet = findActivities({
      location: 'Lagos',
      weather: {precipitationChance: 95, highCelsius: 26},
      limit: 10
    });

    expect(wet.condition).toBe('wet');
    // The top pick should be something rain does not spoil.
    expect(wet.activities[0]?.weatherDependent).toBe(false);
    expect(wet.activities[0]?.weatherFit).toBe('good');

    // The beach should still be offered, but ranked below the indoor options.
    const beachIndex = wet.activities.findIndex(a => a.id === 'lagos-jara-beach');
    expect(beachIndex).toBeGreaterThan(0);
    expect(wet.activities[beachIndex]?.weatherFit).toBe('poor');
  });

  it('promotes outdoor activities on a mild dry day', () => {
    const mild = findActivities({
      location: 'Lagos',
      weather: {precipitationChance: 5, highCelsius: 24},
      tags: ['outdoors'],
      limit: 10
    });

    expect(mild.condition).toBe('mild');
    expect(mild.activities[0]?.weatherFit).toBe('good');
    expect(mild.activities[0]?.matchedTags).toContain('outdoors');
  });

  it('labels fit as unknown when weather is omitted', () => {
    const result = findActivities({location: 'Lagos', limit: 10});
    expect(result.activities.every(a => a.weatherFit === 'unknown')).toBe(true);
  });
});

describe('availability by date', () => {
  it('maps an ISO date to a weekday in UTC', () => {
    expect(weekdayFor('2026-08-22')).toBe('sat');
    expect(weekdayFor('2026-08-24')).toBe('mon');
  });

  it('excludes activities closed on the requested weekday', () => {
    // The Old Biscuit Mill market is Saturday-only.
    const saturday = findActivities({location: 'Cape Town', date: SATURDAY, limit: 10});
    const monday = findActivities({location: 'Cape Town', date: '2026-08-24', limit: 10});

    expect(saturday.activities.some(a => a.id === 'capetown-old-biscuit-mill')).toBe(true);
    expect(monday.activities.some(a => a.id === 'capetown-old-biscuit-mill')).toBe(false);
  });

  it('returns every candidate when no date is given', () => {
    const undated = findActivities({location: 'Cape Town', limit: 10});
    const monday = findActivities({location: 'Cape Town', date: '2026-08-24', limit: 10});

    expect(undated.totalMatches).toBeGreaterThan(monday.totalMatches);
  });
});

describe('result limiting', () => {
  it('defaults to five results', () => {
    expect(findActivities({location: 'Lagos'}).activities).toHaveLength(5);
  });

  it('honours an explicit limit', () => {
    expect(findActivities({location: 'Lagos', limit: 2}).activities).toHaveLength(2);
  });

  it('reports the full match count even when truncated', () => {
    const result = findActivities({location: 'Lagos', limit: 2});

    expect(result.activities).toHaveLength(2);
    expect(result.totalMatches).toBeGreaterThan(2);
  });

  it('returns everything when the limit exceeds the matches', () => {
    const result = findActivities({location: 'Lisbon', limit: 10});
    expect(result.activities).toHaveLength(result.totalMatches);
  });
});

describe('deterministic ordering', () => {
  it('returns identical results for identical queries', () => {
    const query = {
      location: 'Lagos',
      weather: {precipitationChance: 60, highCelsius: 29},
      tags: ['indoor', 'art'],
      limit: 6
    };

    const first = findActivities({...query});
    const second = findActivities({...query});

    expect(first).toEqual(second);
  });

  it('does not depend on the order of the requested tags', () => {
    const a = findActivities({location: 'Lagos', tags: ['art', 'indoor'], limit: 10});
    const b = findActivities({location: 'Lagos', tags: ['indoor', 'art'], limit: 10});

    expect(a.activities.map(x => x.id)).toEqual(b.activities.map(x => x.id));
  });

  it('breaks score ties alphabetically by name', () => {
    // With no tags and no weather every Lisbon activity scores zero, so the
    // ordering is purely the documented alphabetical tie-break.
    const names = findActivities({location: 'Lisbon', limit: 10}).activities.map(a => a.name);

    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y, 'en')));
  });
});

describe('no matches', () => {
  it('returns an empty list for an unknown city', () => {
    const result = findActivities({location: 'Atlantis'});

    expect(result.activities).toEqual([]);
    expect(result.totalMatches).toBe(0);
    expect(result.location).toBe('Atlantis');
  });

  it('returns an empty list when the category is absent from that city', () => {
    const result = findActivities({location: 'Lisbon', category: 'wellness', limit: 10});

    expect(result.totalMatches).toBe(0);
  });

  it('still satisfies the output schema when empty', () => {
    expect(FindActivitiesOutputSchema.safeParse(findActivities({location: 'Atlantis'})).success).toBe(
      true
    );
  });
});

describe('invalid input', () => {
  it('rejects an empty location', () => {
    expect(() => findActivities({location: '   '})).toThrow();
  });

  it('rejects an unknown category', () => {
    expect(() => findActivities({location: 'Lagos', category: 'spelunking' as never})).toThrow();
  });

  it('rejects a malformed date', () => {
    expect(() => findActivities({location: 'Lagos', date: '22/08/2026'})).toThrow();
  });

  it('rejects a limit outside the supported range', () => {
    expect(() => findActivities({location: 'Lagos', limit: 0})).toThrow();
    expect(() => findActivities({location: 'Lagos', limit: 99})).toThrow();
  });

  it('returns a validation error through the Mastra tool wrapper', async () => {
    const result = (await findActivitiesTool.execute!({location: ''} as never, {} as never)) as {
      error?: boolean;
    };

    expect(result.error).toBe(true);
  });
});

describe('tool wrapper', () => {
  it('produces the same result as the exported function', async () => {
    const direct = findActivities({location: 'Lagos', limit: 3});
    const viaTool = await findActivitiesTool.execute!(
      {location: 'Lagos', limit: 3} as never,
      {} as never
    );

    expect(viaTool).toEqual(direct);
  });
});
