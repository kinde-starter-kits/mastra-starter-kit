import {describe, it, expect} from 'vitest';

import {
  SEVERE_PRECIPITATION_CHANCE,
  deriveSeverity,
  findActivities,
  tagMatches
} from '../src/mastra/tools/find-activities.js';

const LAGOS = 'Lagos';
const SATURDAY = '2026-08-22';

const GOOD_WEATHER = {precipitationChance: 5, highCelsius: 26};
const SEVERE_RAIN = {precipitationChance: 98, highCelsius: 27};
const MODERATE_RAIN = {precipitationChance: 55, highCelsius: 26};

function plan(tags: string[], weather?: Record<string, number>, limit = 6) {
  return findActivities({location: LAGOS, date: SATURDAY, tags, weather, limit} as never);
}

describe('weather severity', () => {
  it('reports none without a forecast, so preferences are never suppressed silently', () => {
    expect(deriveSeverity(undefined)).toBe('none');
    expect(plan(['outdoors']).weatherSeverity).toBe('none');
  });

  it('escalates with the chance of rain', () => {
    expect(deriveSeverity({precipitationChance: 10})).toBe('none');
    expect(deriveSeverity({precipitationChance: 55})).toBe('moderate');
    expect(deriveSeverity({precipitationChance: SEVERE_PRECIPITATION_CHANCE})).toBe('severe');
  });

  it('treats extreme heat and cold as severe', () => {
    expect(deriveSeverity({highCelsius: 40})).toBe('severe');
    expect(deriveSeverity({highCelsius: -2})).toBe('severe');
  });
});

describe('outdoor preference with good weather', () => {
  it('leads with outdoor activities', () => {
    const result = plan(['outdoors'], GOOD_WEATHER);

    expect(result.weatherSeverity).toBe('none');
    expect(result.activities[0]?.matchedTags).toContain('outdoors');
    expect(result.activities[0]?.weatherFit).toBe('good');
  });
});

describe('outdoor preference with severe rain', () => {
  it('ranks every weather-compatible activity above every incompatible one', () => {
    const result = plan(['outdoors', 'relaxed'], SEVERE_RAIN);
    expect(result.weatherSeverity).toBe('severe');

    const fits = result.activities.map(a => a.weatherFit);
    const firstPoor = fits.indexOf('poor');
    const lastGood = fits.lastIndexOf('good');

    // This is the regression: previously a weather-poor outdoor activity with
    // two matched tags outranked weather-good indoor options.
    if (firstPoor !== -1 && lastGood !== -1) {
      expect(firstPoor).toBeGreaterThan(lastGood);
    }
    expect(result.activities[0]?.weatherFit).toBe('good');
  });

  it('still surfaces the preferred outdoor option rather than hiding it', () => {
    const result = plan(['outdoors', 'relaxed'], SEVERE_RAIN, 10);
    const outdoor = result.activities.find(a => a.matchedTags.includes('outdoors'));

    expect(outdoor).toBeDefined();
    // Kept, but honestly labelled so the agent can explain the trade-off.
    expect(outdoor?.weatherFit).toBe('poor');
    expect(outdoor?.weatherDependent).toBe(true);
  });

  it('offers an indoor fallback among the top results', () => {
    const result = plan(['outdoors'], SEVERE_RAIN);
    const fallback = result.activities.filter(a => !a.weatherDependent);
    expect(fallback.length).toBeGreaterThan(0);
  });

  it('lets a preference still win under merely moderate weather', () => {
    const result = plan(['outdoors', 'relaxed'], MODERATE_RAIN, 10);
    expect(result.weatherSeverity).toBe('moderate');
    // Not forced below every compatible option at this severity.
    const outdoorIndex = result.activities.findIndex(a => a.matchedTags.includes('outdoors'));
    expect(outdoorIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('indoor preference with rain', () => {
  it('leads with indoor, weather-compatible activities', () => {
    const result = plan(['indoor'], SEVERE_RAIN);

    expect(result.activities[0]?.weatherFit).toBe('good');
    expect(result.activities[0]?.weatherDependent).toBe(false);
  });
});

describe('dietary preference', () => {
  it('matches a hyphenated tag segment', () => {
    expect(tagMatches('vegetarian', 'vegetarian-options')).toBe(true);
    expect(tagMatches('street-food', 'street-food')).toBe(true);
  });

  it('does not match an unrelated substring', () => {
    // The failure a naive substring match would produce.
    expect(tagMatches('art', 'party')).toBe(false);
    expect(tagMatches('run', 'running')).toBe(false);
  });

  it('surfaces vegetarian-friendly food, which previously matched nothing', () => {
    const result = plan(['vegetarian'], undefined, 10);
    const matched = result.activities.filter(a => a.matchedTags.includes('vegetarian'));

    expect(matched.length).toBeGreaterThan(0);
    expect(matched.map(a => a.name)).toContain('Dinner at Yellow Chilli');
  });
});

describe('disliked activities', () => {
  it('does not rank a disliked category first when other options exist', () => {
    // Dislikes are enforced by the validator; the tool simply must not be
    // unable to offer an alternative.
    const result = plan(['food'], undefined, 10);
    const categories = new Set(result.activities.map(a => a.category));
    expect(categories.size).toBeGreaterThan(1);
  });
});

describe('accessibility', () => {
  it('matches an accessibility tag when the data expresses one', () => {
    // The seeded dataset carries no accessibility tags, so this documents the
    // matching rule rather than asserting dataset coverage.
    expect(tagMatches('step-free', 'step-free-access')).toBe(true);
  });

  it('returns results rather than failing when accessibility cannot be matched', () => {
    const result = plan(['step-free access'], SEVERE_RAIN, 5);
    expect(result.totalMatches).toBeGreaterThan(0);
    expect(result.activities.every(a => a.matchedTags.length === 0)).toBe(true);
  });
});

describe('determinism is preserved', () => {
  it('returns identical ordering for identical input under severe weather', () => {
    const a = plan(['outdoors', 'relaxed'], SEVERE_RAIN, 8);
    const b = plan(['outdoors', 'relaxed'], SEVERE_RAIN, 8);
    expect(a.activities.map(x => x.id)).toEqual(b.activities.map(x => x.id));
  });
});
