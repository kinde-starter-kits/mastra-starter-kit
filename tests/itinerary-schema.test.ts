import {describe, it, expect} from 'vitest';
import {z} from 'zod';

import {
  ACTIVITY_CATEGORIES,
  ActivitySchema,
  ItinerarySchema,
  WeatherOutlookSchema,
  type Activity,
  type Itinerary
} from '../src/mastra/schemas/itinerary.js';

function activity(overrides: Partial<Activity> = {}): unknown {
  return {
    order: 1,
    name: 'Lekki Conservation Centre canopy walk',
    category: 'nature',
    startTime: '14:30',
    durationMinutes: 120,
    location: 'Lekki, Lagos',
    description: 'Walk the canopy bridge and loop the reserve trails before the afternoon heat.',
    weatherDependent: true,
    ...overrides
  };
}

function itinerary(overrides: Record<string, unknown> = {}): unknown {
  return {
    destination: 'Lagos',
    date: '2026-08-21',
    summary: 'A relaxed afternoon outdoors, with an indoor fallback if the showers arrive.',
    weather: {
      summary: 'Warm and humid with a chance of afternoon showers',
      highCelsius: 31,
      lowCelsius: 24,
      precipitationChance: 40,
      considerations: ['Outdoor activities scheduled before the 4pm shower window']
    },
    activities: [activity(), activity({order: 2, startTime: '17:00', category: 'food'})],
    notes: ['Carry cash for the market stalls'],
    ...overrides
  };
}

describe('ItinerarySchema — valid input', () => {
  it('accepts a complete itinerary', () => {
    const result = ItinerarySchema.safeParse(itinerary());
    expect(result.success).toBe(true);
  });

  it('exposes a typed, directly usable structure', () => {
    const parsed: Itinerary = ItinerarySchema.parse(itinerary());

    // The UI renders from these without parsing free-form text.
    expect(parsed.destination).toBe('Lagos');
    expect(parsed.weather.precipitationChance).toBe(40);
    expect(parsed.activities).toHaveLength(2);

    const [first] = parsed.activities;
    expect(first.order).toBe(1);
    expect(first.startTime).toBe('14:30');
    expect(first.durationMinutes).toBe(120);
    expect(first.weatherDependent).toBe(true);
    expect(ACTIVITY_CATEGORIES).toContain(first.category);
  });

  it('trims surrounding whitespace on text fields', () => {
    const parsed = ItinerarySchema.parse(itinerary({destination: '  Lagos  '}));
    expect(parsed.destination).toBe('Lagos');
  });

  it('accepts empty considerations and notes arrays', () => {
    const result = ItinerarySchema.safeParse(
      itinerary({
        notes: [],
        weather: {
          summary: 'Clear all day',
          highCelsius: 28,
          lowCelsius: 21,
          precipitationChance: 0,
          considerations: []
        }
      })
    );
    expect(result.success).toBe(true);
  });
});

describe('ItinerarySchema — required fields', () => {
  it.each(['destination', 'date', 'summary', 'weather', 'activities', 'notes'])(
    'rejects an itinerary missing %s',
    field => {
      const input = itinerary() as Record<string, unknown>;
      delete input[field];

      const result = ItinerarySchema.safeParse(input);
      expect(result.success).toBe(false);
    }
  );

  it('rejects an empty destination', () => {
    expect(ItinerarySchema.safeParse(itinerary({destination: '   '})).success).toBe(false);
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    for (const date of ['21/08/2026', '2026-8-21', 'tomorrow', '2026-02-30']) {
      expect(ItinerarySchema.safeParse(itinerary({date})).success).toBe(false);
    }
  });

  it('requires at least one activity', () => {
    expect(ItinerarySchema.safeParse(itinerary({activities: []})).success).toBe(false);
  });

  it('rejects more activities than a single day can hold', () => {
    const tooMany = Array.from({length: 9}, (_unused, index) => activity({order: index + 1}));
    expect(ItinerarySchema.safeParse(itinerary({activities: tooMany})).success).toBe(false);
  });
});

describe('ActivitySchema — invalid activity data', () => {
  it('rejects a start time that is not HH:MM', () => {
    for (const startTime of ['2:30pm', '9:30', '14:30:00', '25:00', 'afternoon']) {
      expect(ActivitySchema.safeParse(activity({startTime})).success).toBe(false);
    }
  });

  it('accepts a valid 24-hour start time', () => {
    for (const startTime of ['00:00', '09:05', '23:59']) {
      expect(ActivitySchema.safeParse(activity({startTime})).success).toBe(true);
    }
  });

  it('rejects an unknown category', () => {
    expect(ActivitySchema.safeParse(activity({category: 'spelunking' as never})).success).toBe(
      false
    );
  });

  it('rejects an order below 1 or non-integer', () => {
    expect(ActivitySchema.safeParse(activity({order: 0})).success).toBe(false);
    expect(ActivitySchema.safeParse(activity({order: 1.5})).success).toBe(false);
  });

  it('rejects a duration outside the allowed range', () => {
    expect(ActivitySchema.safeParse(activity({durationMinutes: 5})).success).toBe(false);
    expect(ActivitySchema.safeParse(activity({durationMinutes: 900})).success).toBe(false);
  });

  it('rejects a non-boolean weatherDependent', () => {
    expect(ActivitySchema.safeParse(activity({weatherDependent: 'yes' as never})).success).toBe(
      false
    );
  });

  it('rejects an empty name or description', () => {
    expect(ActivitySchema.safeParse(activity({name: '  '})).success).toBe(false);
    expect(ActivitySchema.safeParse(activity({description: ''})).success).toBe(false);
  });

  it('surfaces the offending activity index in the error path', () => {
    const result = ItinerarySchema.safeParse(
      itinerary({activities: [activity(), activity({order: 2, startTime: 'noon'})]})
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['activities', 1, 'startTime']);
  });
});

describe('cross-field rules', () => {
  it('rejects duplicate activity ordering', () => {
    const result = ItinerarySchema.safeParse(
      itinerary({activities: [activity({order: 1}), activity({order: 1})]})
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain('unique order');
  });

  it('rejects a low temperature above the high', () => {
    const result = WeatherOutlookSchema.safeParse({
      summary: 'Confused',
      highCelsius: 20,
      lowCelsius: 30,
      precipitationChance: 10,
      considerations: []
    });

    expect(result.success).toBe(false);
  });

  it('rejects a precipitation chance outside 0-100', () => {
    const bad = {
      summary: 'Rain',
      highCelsius: 25,
      lowCelsius: 20,
      precipitationChance: 120,
      considerations: []
    };
    expect(WeatherOutlookSchema.safeParse(bad).success).toBe(false);
  });
});

describe('structured-output readiness', () => {
  it('converts to JSON Schema so it can be handed to a model', () => {
    const jsonSchema = z.toJSONSchema(ItinerarySchema, {io: 'output'}) as {
      required?: string[];
      properties?: Record<string, {description?: string}>;
    };

    // Every top-level field is required — models do best with no optionals.
    expect(jsonSchema.required).toEqual([
      'destination',
      'date',
      'summary',
      'weather',
      'activities',
      'notes'
    ]);

    // Descriptions survive the conversion; they are the model's instructions.
    expect(jsonSchema.properties?.date?.description).toContain('YYYY-MM-DD');
  });
});
