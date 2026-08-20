import {z} from 'zod';

/**
 * The shape of an itinerary produced by the trip agent.
 *
 * This is the single source of truth for the generated plan. The agent is
 * given it as `structuredOutput`, so the model fills these fields directly
 * instead of writing prose someone later has to parse, and the UI can render
 * an itinerary card straight from the parsed object.
 *
 * Two consequences shape the design:
 *
 * 1. Every `.describe()` reaches the model as a JSON Schema description, so
 *    the descriptions here are instructions, not just documentation.
 * 2. Constraints the model cannot see (`.refine()`) still run at parse time.
 *    They are used sparingly — only for things that are unambiguously wrong —
 *    because an over-strict schema turns a good plan into a failed request.
 */

/** Broad activity kinds, used for card iconography and filtering. */
export const ACTIVITY_CATEGORIES = [
  'outdoor',
  'indoor',
  'food',
  'culture',
  'nature',
  'nightlife',
  'shopping',
  'wellness'
] as const;

export const ActivityCategorySchema = z
  .enum(ACTIVITY_CATEGORIES)
  .describe('The kind of activity, used to group and illustrate it in the UI.');

export const ActivitySchema = z
  .object({
    order: z
      .int()
      .min(1)
      .describe('Position in the day, starting at 1. Must be unique within the itinerary.'),

    name: z.string().trim().min(1).max(120).describe('Short name of the activity.'),

    category: ActivityCategorySchema,

    // Start time plus duration, deliberately not an end time: one way to
    // express a slot means the model cannot contradict itself.
    startTime: z.iso
      .time({precision: -1})
      .describe('24-hour local start time as HH:MM, for example "14:30".'),

    durationMinutes: z
      .int()
      .min(15)
      .max(600)
      .describe('How long to allow for the activity, in minutes.'),

    location: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .describe('Where it happens — a neighbourhood, venue, or address.'),

    description: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe('One or two sentences on what the visitor will do and why it suits them.'),

    weatherDependent: z
      .boolean()
      .describe('True when bad weather would spoil this activity, so the UI can flag it.')
  })
  .describe('A single scheduled item in the day.');

export const WeatherOutlookSchema = z
  .object({
    summary: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('Plain-language forecast for the day, for example "Warm with afternoon showers".'),

    highCelsius: z.number().min(-60).max(60).describe('Forecast high temperature in Celsius.'),

    lowCelsius: z.number().min(-60).max(60).describe('Forecast low temperature in Celsius.'),

    precipitationChance: z
      .int()
      .min(0)
      .max(100)
      .describe('Chance of precipitation as a percentage from 0 to 100.'),

    considerations: z
      .array(z.string().trim().min(1).max(200))
      .max(4)
      .describe(
        'How the forecast shaped the plan, for example "Indoor option scheduled for the 3pm shower".'
      )
  })
  .refine(weather => weather.lowCelsius <= weather.highCelsius, {
    message: 'lowCelsius must not exceed highCelsius',
    path: ['lowCelsius']
  })
  .describe('The forecast the plan was built around.');

export const ItinerarySchema = z
  .object({
    destination: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .describe('City or area the plan covers, for example "Lagos".'),

    date: z.iso.date().describe('The day being planned, as YYYY-MM-DD.'),

    summary: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .describe('Two or three sentences describing the shape of the day.'),

    weather: WeatherOutlookSchema,

    activities: z
      .array(ActivitySchema)
      .min(1)
      .max(8)
      .describe('The scheduled activities, in chronological order.'),

    notes: z
      .array(z.string().trim().min(1).max(200))
      .max(5)
      .describe(
        'Practical tips that are not tied to one activity, for example "Carry cash for the market".'
      )
  })
  .refine(
    itinerary => {
      const orders = itinerary.activities.map(activity => activity.order);
      return new Set(orders).size === orders.length;
    },
    {
      message: 'Each activity must have a unique order',
      path: ['activities']
    }
  )
  .describe('A structured plan for one day in one place.');

export type Activity = z.infer<typeof ActivitySchema>;
export type ActivityCategory = z.infer<typeof ActivityCategorySchema>;
export type WeatherOutlook = z.infer<typeof WeatherOutlookSchema>;
export type Itinerary = z.infer<typeof ItinerarySchema>;
