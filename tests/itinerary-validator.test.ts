import {describe, it, expect} from 'vitest';

import {
  NOT_TOO_EARLY_MINUTES,
  TIME_WINDOWS,
  buildCorrectionPrompt,
  findSeededActivity,
  parsePlanningConstraints,
  toClock,
  toMinutes,
  validateItinerary
} from '../src/mastra/lib/itinerary-validator.js';
import type {Itinerary} from '../src/mastra/schemas/itinerary.js';

/** 2026-08-22 is a Saturday; every Lagos activity used below is open then. */
const SATURDAY = '2026-08-22';

/** Real dataset records, so provenance and opening hours are genuine. */
const GALLERY = 'Nike Art Gallery';          // culture, indoor, 09:00–18:00, all week
const DINNER = 'Dinner at Yellow Chilli';    // food, indoor, 12:00–22:00, all week
const BEACH = 'Jara Beach afternoon';        // outdoor, weatherDependent, Fri–Sun 09:00–18:00
const PARK_RUN = 'Ndubuisi Kanu Park morning run'; // outdoor, weatherDependent, 06:00–19:00

function activity(name: string, order: number, startTime: string, overrides: Record<string, unknown> = {}) {
  const seeded = findSeededActivity(name)!;
  return {
    order,
    name,
    category: seeded.category,
    startTime,
    durationMinutes: seeded.durationMinutes,
    location: `${seeded.location}`,
    description: seeded.description.slice(0, 200),
    weatherDependent: seeded.weatherDependent,
    ...overrides
  };
}

function itinerary(activities: unknown[], overrides: Record<string, unknown> = {}): Itinerary {
  return {
    destination: 'Lagos',
    date: SATURDAY,
    summary: 'A test plan.',
    weather: {
      summary: 'Light rain',
      highCelsius: 27,
      lowCelsius: 25,
      precipitationChance: 20,
      considerations: []
    },
    activities,
    notes: [],
    ...overrides
  } as Itinerary;
}

describe('parsing constraints from the request', () => {
  it('reads the afternoon window', () => {
    expect(parsePlanningConstraints('Plan me an afternoon in Lagos').window).toEqual(
      TIME_WINDOWS.afternoon
    );
  });

  it('reads morning and evening windows', () => {
    expect(parsePlanningConstraints('a morning in Lisbon').window).toEqual(TIME_WINDOWS.morning);
    expect(parsePlanningConstraints('an evening out').window).toEqual(TIME_WINDOWS.evening);
  });

  it('reads "nothing too early"', () => {
    const c = parsePlanningConstraints("I don't want anything too early");
    expect(c.earliestStartMinutes).toBe(NOT_TOO_EARLY_MINUTES);
  });

  it('reads an explicit start time', () => {
    expect(parsePlanningConstraints('start at 3 pm').earliestStartMinutes).toBe(15 * 60);
    expect(parsePlanningConstraints('after 14:30').earliestStartMinutes).toBe(14 * 60 + 30);
  });

  it('reads a duration limit', () => {
    expect(parsePlanningConstraints('I have three hours').maxTotalMinutes).toBe(180);
    expect(parsePlanningConstraints('for 2 hours').maxTotalMinutes).toBe(120);
  });

  it('leaves unrecognised phrasing unconstrained rather than guessing', () => {
    expect(parsePlanningConstraints('surprise me')).toEqual({});
  });

  it('converts between clock strings and minutes', () => {
    expect(toMinutes('14:30')).toBe(870);
    expect(toClock(870)).toBe('14:30');
    expect(Number.isNaN(toMinutes('2pm'))).toBe(true);
  });
});

describe('time window enforcement', () => {
  it('rejects the 06:00 activity from the reported bug', () => {
    const constraints = parsePlanningConstraints(
      "Plan me an afternoon in Lagos tomorrow. I like outdoor activities and don't want anything too early."
    );
    const result = validateItinerary({
      itinerary: itinerary([activity(PARK_RUN, 1, '06:00'), activity(BEACH, 2, '14:00')]),
      constraints
    });

    expect(result.valid).toBe(false);
    expect(result.issues.map(i => i.code)).toContain('time_window_violation');
    expect(result.issues.map(i => i.code)).toContain('start_too_early');
    expect(result.issues.some(i => i.activityId === PARK_RUN)).toBe(true);
  });

  it('accepts an afternoon plan starting at 14:00', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '14:00')]),
      constraints: parsePlanningConstraints('Plan me an afternoon in Lagos')
    });
    expect(result.valid).toBe(true);
  });

  it('rejects an afternoon activity that starts in the evening', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(DINNER, 1, '20:00')]),
      constraints: parsePlanningConstraints('Plan me an afternoon in Lagos')
    });
    expect(result.issues.map(i => i.code)).toContain('time_window_violation');
  });

  it('enforces an explicit earliest start', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '13:00')]),
      constraints: parsePlanningConstraints('an afternoon, start at 3 pm')
    });
    expect(result.issues.map(i => i.code)).toContain('start_too_early');
  });

  it('rejects a plan that runs past the requested window', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(DINNER, 1, '17:30')]), // 90 min -> 19:00
      constraints: parsePlanningConstraints('Plan me an afternoon in Lagos')
    });
    expect(result.issues.map(i => i.code)).toContain('exceeds_requested_window');
  });

  it('rejects a plan longer than the requested duration', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '12:00'), activity(DINNER, 2, '16:00')]),
      constraints: parsePlanningConstraints('I have two hours')
    });
    expect(result.issues.map(i => i.code)).toContain('exceeds_requested_window');
  });
});

describe('schedule integrity', () => {
  it('rejects overlapping activities', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '13:00'), activity(DINNER, 2, '14:00')]),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('overlap');
  });

  it('accepts back-to-back activities that do not overlap', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '13:00'), activity(DINNER, 2, '14:30')]),
      constraints: {}
    });
    expect(result.valid).toBe(true);
  });

  it('rejects activities ordered out of chronological sequence', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(DINNER, 1, '16:00'), activity(GALLERY, 2, '13:00')]),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('out_of_order');
  });
});

describe('activity facts', () => {
  it('rejects an invented activity', () => {
    const result = validateItinerary({
      itinerary: itinerary([
        {
          order: 1, name: 'The Invented Rooftop Bar', category: 'nightlife',
          startTime: '14:00', durationMinutes: 90, location: 'Lagos',
          description: 'Does not exist.', weatherDependent: false
        }
      ]),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('unknown_activity');
  });

  it('rejects an activity from another city', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity('Tram 28 through Alfama', 1, '14:00')]),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('destination_mismatch');
  });

  it('rejects a schedule outside opening hours', () => {
    // The gallery closes at 18:00; a 17:30 start with 90 minutes runs past it.
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '17:30')]),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('outside_opening_hours');
  });

  it('rejects an activity closed on that weekday', () => {
    // Jara Beach opens Fri-Sun; 2026-08-24 is a Monday.
    const result = validateItinerary({
      itinerary: itinerary([activity(BEACH, 1, '14:00')], {date: '2026-08-24'}),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('closed_on_day');
  });

  it('rejects a mislabelled weather-dependence flag', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(BEACH, 1, '14:00', {weatherDependent: false})]),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('weather_flag_mismatch');
  });
});

describe('weather and preferences', () => {
  it('rejects an all-outdoor plan in severe rain', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(BEACH, 1, '14:00')], {
        weather: {summary: 'Heavy rain', highCelsius: 27, lowCelsius: 25, precipitationChance: 98, considerations: []}
      }),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).toContain('severe_weather_unmitigated');
  });

  it('accepts severe rain when an indoor option is included', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '13:00'), activity(BEACH, 2, '15:00')], {
        weather: {summary: 'Heavy rain', highCelsius: 27, lowCelsius: 25, precipitationChance: 98, considerations: []}
      }),
      constraints: {}
    });
    expect(result.issues.map(i => i.code)).not.toContain('severe_weather_unmitigated');
  });

  it('rejects an activity the traveller said they dislike', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '14:00')]),
      constraints: {},
      preferences: {dislikes: ['art']}
    });
    expect(result.issues.map(i => i.code)).toContain('disliked_activity');
  });

  it('ignores dislikes that do not match', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '14:00')]),
      constraints: {},
      preferences: {dislikes: ['nightlife']}
    });
    expect(result.valid).toBe(true);
  });
});

describe('a fully valid plan', () => {
  it('passes every check', () => {
    const result = validateItinerary({
      itinerary: itinerary([activity(GALLERY, 1, '13:00'), activity(DINNER, 2, '15:00')]),
      constraints: parsePlanningConstraints(
        "Plan me an afternoon in Lagos tomorrow. I don't want anything too early."
      )
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('correction prompt', () => {
  it('states the broken rules without dictating a replacement', () => {
    const prompt = buildCorrectionPrompt([
      {code: 'time_window_violation', activityId: PARK_RUN, message: '06:00 is outside the requested afternoon window (12:00–18:00).'}
    ]);

    expect(prompt).toContain('06:00 is outside the requested afternoon window');
    expect(prompt).toContain('find-activities');
    expect(prompt).not.toMatch(/replace .* with .*specific/i);
  });
});
