import {createTool} from '@mastra/core/tools';
import {z} from 'zod';

import {ActivityCategorySchema} from '../schemas/itinerary';

/**
 * Candidate activity lookup over a small curated dataset.
 *
 * This tool is deliberately dumb: it filters and ranks, and never calls a
 * model. The trip agent does the reasoning, so this tool's job is to hand it
 * reliable, deterministic candidate data — the same query always returns the
 * same list in the same order.
 *
 * It also makes no network calls. A real deployment would swap the seeded data
 * below for a database or a places API; nothing else in the tool would change.
 * Location resolution stays with `get-weather`, which already owns it.
 */

/** Coarse weather buckets the dataset is tagged against. */
export const WEATHER_CONDITIONS = ['wet', 'hot', 'cold', 'mild'] as const;
export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Thresholds that turn a forecast into a bucket. Tuned once, applied everywhere. */
const WET_PRECIPITATION_CHANCE = 50;
const HOT_CELSIUS = 32;
const COLD_CELSIUS = 8;

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// ---------------------------------------------------------------------------
// Seeded demo data
//
// Hand-written sample data for the starter kit — real places, approximate
// details, not maintained or verified. Enough breadth to show category, tag,
// and weather filtering working, and deliberately not more.
// ---------------------------------------------------------------------------

export type SeededActivity = {
  id: string;
  name: string;
  /** City the activity is in. Matched case- and accent-insensitively. */
  location: string;
  category: z.infer<typeof ActivityCategorySchema>;
  description: string;
  /** Kept within ItinerarySchema's 15-600 minute bounds so it can pass straight through. */
  durationMinutes: number;
  /** True when poor weather would spoil it. Maps 1:1 to ItinerarySchema. */
  weatherDependent: boolean;
  /** Conditions this activity is genuinely good in. */
  suitableWeather: WeatherCondition[];
  availability: {
    days: Weekday[];
    opensAt: string;
    closesAt: string;
  };
  tags: string[];
};

export const SEEDED_ACTIVITIES: readonly SeededActivity[] = [
  // --- Lagos ---------------------------------------------------------------
  {
    id: 'lagos-lekki-conservation',
    name: 'Lekki Conservation Centre canopy walk',
    location: 'Lagos',
    category: 'nature',
    description:
      'Cross one of Africa’s longest canopy walkways above the mangroves, with monkeys and birdlife along the boardwalk trails.',
    durationMinutes: 120,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '08:30', closesAt: '17:00'},
    tags: ['outdoors', 'wildlife', 'walking', 'family-friendly', 'photography']
  },
  {
    id: 'lagos-nike-art',
    name: 'Nike Art Gallery',
    location: 'Lagos',
    category: 'culture',
    description:
      'Five floors of Nigerian painting, sculpture and textiles in Lekki, with the owner often on hand to talk through the collection.',
    durationMinutes: 90,
    weatherDependent: false,
    suitableWeather: ['wet', 'hot', 'cold', 'mild'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '09:00', closesAt: '18:00'},
    tags: ['art', 'indoor', 'local-craft', 'free', 'rainy-day']
  },
  {
    id: 'lagos-terra-kulture',
    name: 'Terra Kulture arts centre',
    location: 'Lagos',
    category: 'indoor',
    description:
      'Bookshop, gallery and theatre under one roof on Victoria Island, with a restaurant serving Nigerian classics.',
    durationMinutes: 120,
    weatherDependent: false,
    suitableWeather: ['wet', 'hot', 'cold', 'mild'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '10:00', closesAt: '20:00'},
    tags: ['art', 'theatre', 'books', 'indoor', 'rainy-day']
  },
  {
    id: 'lagos-jara-beach',
    name: 'Jara Beach afternoon',
    location: 'Lagos',
    category: 'outdoor',
    description:
      'A calm stretch of Lagos coastline with loungers, shade and grilled food, reachable by a short boat ride.',
    durationMinutes: 240,
    weatherDependent: true,
    suitableWeather: ['hot', 'mild'],
    availability: {days: ['fri', 'sat', 'sun'], opensAt: '09:00', closesAt: '18:00'},
    tags: ['beach', 'outdoors', 'swimming', 'relaxed', 'sunset']
  },
  {
    id: 'lagos-new-afrika-shrine',
    name: 'New Afrika Shrine',
    location: 'Lagos',
    category: 'nightlife',
    description:
      'The Kuti family’s Afrobeat venue in Ikeja — live brass, deep grooves and street food, busiest late in the evening.',
    durationMinutes: 180,
    weatherDependent: false,
    suitableWeather: ['wet', 'hot', 'cold', 'mild'],
    availability: {days: ['thu', 'fri', 'sat', 'sun'], opensAt: '19:00', closesAt: '23:59'},
    tags: ['music', 'live-music', 'afrobeat', 'evening', 'local-favourite']
  },
  {
    id: 'lagos-lekki-market',
    name: 'Lekki Arts and Crafts Market',
    location: 'Lagos',
    category: 'shopping',
    description:
      'Rows of stalls selling carvings, beads, fabric and paintings. Haggling expected; bring cash.',
    durationMinutes: 90,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '09:00', closesAt: '18:30'},
    tags: ['shopping', 'local-craft', 'souvenirs', 'markets', 'budget']
  },
  {
    id: 'lagos-yellow-chilli',
    name: 'Dinner at Yellow Chilli',
    location: 'Lagos',
    category: 'food',
    description:
      'Modern Nigerian cooking — jollof, egusi and grilled fish — in a relaxed Victoria Island dining room.',
    durationMinutes: 90,
    weatherDependent: false,
    suitableWeather: ['wet', 'hot', 'cold', 'mild'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '12:00', closesAt: '22:00'},
    tags: ['restaurant', 'local-cuisine', 'dinner', 'indoor', 'vegetarian-options']
  },
  {
    id: 'lagos-jhalobia-gardens',
    name: 'Jhalobia Recreation Park and Gardens',
    location: 'Lagos',
    category: 'wellness',
    description:
      'Quiet landscaped gardens near the airport, good for a slow walk, a picnic, or simply getting away from traffic noise.',
    durationMinutes: 120,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '08:00', closesAt: '18:00'},
    tags: ['gardens', 'quiet', 'relaxed', 'outdoors', 'picnic']
  },
  {
    id: 'lagos-freedom-park',
    name: 'Freedom Park evening',
    location: 'Lagos',
    category: 'culture',
    description:
      'A colonial-era prison turned cultural park on Lagos Island, hosting concerts, poetry nights and open-air food stalls.',
    durationMinutes: 150,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '10:00', closesAt: '22:00'},
    tags: ['history', 'live-music', 'evening', 'outdoors', 'food-stalls']
  },
  {
    id: 'lagos-ndubuisi-kanu-park',
    name: 'Ndubuisi Kanu Park morning run',
    location: 'Lagos',
    category: 'outdoor',
    description:
      'A looped tarmac path in Alausa that fills with runners and walkers early, before the heat sets in.',
    durationMinutes: 60,
    weatherDependent: true,
    suitableWeather: ['mild'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '06:00', closesAt: '19:00'},
    tags: ['running', 'exercise', 'early-morning', 'outdoors', 'free']
  },
  {
    id: 'lagos-spa-victoria-island',
    name: 'Spa afternoon on Victoria Island',
    location: 'Lagos',
    category: 'wellness',
    description:
      'A quiet hotel spa offering massages and steam rooms — a reliable option when the weather rules out the coast.',
    durationMinutes: 120,
    weatherDependent: false,
    suitableWeather: ['wet', 'hot', 'cold', 'mild'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '10:00', closesAt: '20:00'},
    tags: ['spa', 'relaxed', 'indoor', 'rainy-day', 'quiet']
  },
  {
    id: 'lagos-food-tour-balogun',
    name: 'Balogun Market street food walk',
    location: 'Lagos',
    category: 'food',
    description:
      'Graze through suya, puff-puff and roasted plantain while weaving the busiest market on Lagos Island.',
    durationMinutes: 150,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], opensAt: '09:00', closesAt: '17:00'},
    tags: ['street-food', 'markets', 'walking', 'local-cuisine', 'budget']
  },

  // --- Lisbon --------------------------------------------------------------
  {
    id: 'lisbon-tram-28',
    name: 'Tram 28 through Alfama',
    location: 'Lisbon',
    category: 'culture',
    description:
      'The classic yellow tram climbing through Alfama and Graca. Board early to get a window seat.',
    durationMinutes: 60,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '06:00', closesAt: '22:30'},
    tags: ['sightseeing', 'history', 'iconic', 'rainy-day']
  },
  {
    id: 'lisbon-time-out-market',
    name: 'Time Out Market lunch',
    location: 'Lisbon',
    category: 'food',
    description:
      'A covered hall of stalls from well-known Lisbon chefs — seafood, pastries and petiscos at shared tables.',
    durationMinutes: 90,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '10:00', closesAt: '00:00'},
    tags: ['food-hall', 'lunch', 'indoor', 'seafood', 'vegetarian-options']
  },
  {
    id: 'lisbon-miradouro-senhora',
    name: 'Miradouro da Senhora do Monte at sunset',
    location: 'Lisbon',
    category: 'outdoor',
    description:
      'The highest viewpoint in the city, looking across the castle and the river. Busy but worth the climb.',
    durationMinutes: 45,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '07:00', closesAt: '23:00'},
    tags: ['viewpoint', 'sunset', 'outdoors', 'photography', 'free']
  },
  {
    id: 'lisbon-gulbenkian',
    name: 'Calouste Gulbenkian Museum',
    location: 'Lisbon',
    category: 'indoor',
    description:
      'A compact, superbly curated collection from Egyptian antiquities to Lalique glass, set in its own gardens.',
    durationMinutes: 150,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['mon', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '10:00', closesAt: '18:00'},
    tags: ['museum', 'art', 'indoor', 'rainy-day', 'quiet']
  },
  {
    id: 'lisbon-pink-street',
    name: 'Pink Street bars',
    location: 'Lisbon',
    category: 'nightlife',
    description:
      'A short pedestrian strip of bars in Cais do Sodre that fills up well after midnight.',
    durationMinutes: 180,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['thu', 'fri', 'sat'], opensAt: '21:00', closesAt: '23:59'},
    tags: ['bars', 'evening', 'live-music', 'social']
  },
  {
    id: 'lisbon-feira-da-ladra',
    name: 'Feira da Ladra flea market',
    location: 'Lisbon',
    category: 'shopping',
    description:
      'Lisbon’s long-running open-air flea market — tiles, records, and a lot of browsing.',
    durationMinutes: 90,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['tue', 'sat'], opensAt: '09:00', closesAt: '18:00'},
    tags: ['markets', 'shopping', 'antiques', 'outdoors', 'budget']
  },

  // --- Cape Town -----------------------------------------------------------
  {
    id: 'capetown-table-mountain',
    name: 'Table Mountain cableway',
    location: 'Cape Town',
    category: 'nature',
    description:
      'A rotating cable car to the plateau, with short walks along the top. Closes in high wind or low cloud.',
    durationMinutes: 180,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '08:00', closesAt: '19:00'},
    tags: ['viewpoint', 'hiking', 'outdoors', 'iconic', 'photography']
  },
  {
    id: 'capetown-zeitz-mocaa',
    name: 'Zeitz MOCAA',
    location: 'Cape Town',
    category: 'culture',
    description:
      'Contemporary African art inside a converted grain silo at the waterfront, worth it for the atrium alone.',
    durationMinutes: 120,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '10:00', closesAt: '18:00'},
    tags: ['museum', 'art', 'indoor', 'architecture', 'rainy-day']
  },
  {
    id: 'capetown-boulders-beach',
    name: 'Boulders Beach penguin colony',
    location: 'Cape Town',
    category: 'nature',
    description:
      'Boardwalks over a sheltered cove where African penguins nest within a few metres of the path.',
    durationMinutes: 120,
    weatherDependent: true,
    suitableWeather: ['mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '08:00', closesAt: '17:30'},
    tags: ['wildlife', 'beach', 'outdoors', 'family-friendly', 'photography']
  },
  {
    id: 'capetown-kloof-street',
    name: 'Kloof Street dinner',
    location: 'Cape Town',
    category: 'food',
    description:
      'A strip of small restaurants and wine bars below the mountain, strong on seasonal Cape cooking.',
    durationMinutes: 120,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '12:00', closesAt: '23:00'},
    tags: ['restaurant', 'wine', 'dinner', 'indoor', 'vegetarian-options']
  },
  {
    id: 'capetown-sea-point-pool',
    name: 'Sea Point Pavilion swim',
    location: 'Cape Town',
    category: 'wellness',
    description:
      'Open-air saltwater pools on the promenade, cold but bracing, with the Atlantic right alongside.',
    durationMinutes: 90,
    weatherDependent: true,
    suitableWeather: ['hot', 'mild'],
    availability: {days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], opensAt: '07:00', closesAt: '18:00'},
    tags: ['swimming', 'exercise', 'outdoors', 'relaxed', 'budget']
  },
  {
    id: 'capetown-old-biscuit-mill',
    name: 'Old Biscuit Mill market',
    location: 'Cape Town',
    category: 'shopping',
    description:
      'Saturday-only design and food market in Woodstock, packed by mid-morning.',
    durationMinutes: 120,
    weatherDependent: false,
    suitableWeather: ['wet', 'cold', 'mild', 'hot'],
    availability: {days: ['sat'], opensAt: '09:00', closesAt: '15:00'},
    tags: ['markets', 'shopping', 'street-food', 'local-craft', 'design']
  }
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const WeatherContextSchema = z
  .object({
    precipitationChance: z
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe('Chance of precipitation, 0-100. Pass the value from get-weather.'),
    highCelsius: z.number().optional().describe('Daily high in Celsius, from get-weather.'),
    lowCelsius: z.number().optional().describe('Daily low in Celsius, from get-weather.')
  })
  .describe(
    'Optional forecast context. Call get-weather first and pass its numbers through; activities that suit the conditions rank higher.'
  );

export const FindActivitiesInputSchema = z.object({
  location: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe('City to search, for example "Lagos". A trailing country is ignored.'),

  category: ActivityCategorySchema.optional().describe(
    'Restrict results to one category. Omit to search all categories.'
  ),

  tags: z
    .array(z.string().trim().min(1).max(40))
    .max(8)
    .optional()
    .describe(
      'Traveller preferences, for example ["outdoors", "relaxed"]. Matching activities rank higher; non-matching ones are still returned.'
    ),

  weather: WeatherContextSchema.optional(),

  date: z.iso
    .date()
    .optional()
    .describe('Day of the visit as YYYY-MM-DD. When given, activities closed that weekday are excluded.'),

  limit: z
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Maximum results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`)
});

export const ActivityCandidateSchema = z
  .object({
    id: z.string().describe('Stable identifier for this activity.'),
    name: z.string().describe('Activity name, ready to use as the itinerary activity name.'),
    location: z.string().describe('City the activity is in.'),
    category: ActivityCategorySchema,
    description: z.string().describe('What the visitor will do there.'),
    durationMinutes: z
      .int()
      .min(15)
      .max(600)
      .describe('Approximate time to allow, within the itinerary schema bounds.'),
    weatherDependent: z
      .boolean()
      .describe('True when poor weather would spoil it. Copy straight into the itinerary.'),
    suitableWeather: z
      .array(z.enum(WEATHER_CONDITIONS))
      .describe('Conditions this activity is good in.'),
    availability: z
      .object({
        days: z.array(z.enum(WEEKDAYS)).describe('Weekdays it is open.'),
        opensAt: z.iso.time({precision: -1}),
        closesAt: z.iso.time({precision: -1})
      })
      .describe('When it is open, so the agent can schedule it at a sensible time.'),
    tags: z.array(z.string()).describe('Descriptive tags used for preference matching.'),
    weatherFit: z
      .enum(['good', 'poor', 'unknown'])
      .describe(
        'How well it suits the supplied forecast. "unknown" when no weather context was given.'
      ),
    matchedTags: z.array(z.string()).describe('Which of the requested tags this activity matched.')
  })
  .describe('One candidate activity, shaped so the agent can lift it into an itinerary directly.');

export const FindActivitiesOutputSchema = z
  .object({
    location: z.string().describe('The location that was searched.'),
    condition: z
      .enum([...WEATHER_CONDITIONS, 'unknown'])
      .describe('The weather bucket derived from the supplied forecast, if any.'),
    totalMatches: z
      .int()
      .min(0)
      .describe('How many activities matched the filters before the limit was applied.'),
    activities: z.array(ActivityCandidateSchema).describe('Ranked candidates, best first.')
  })
  .describe('Candidate activities for one place, ranked but not yet scheduled.');

export type FindActivitiesInput = z.input<typeof FindActivitiesInputSchema>;
export type FindActivitiesOutput = z.infer<typeof FindActivitiesOutputSchema>;
export type ActivityCandidate = z.infer<typeof ActivityCandidateSchema>;

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Match a query against a dataset city.
 *
 * The agent may pass the name `get-weather` resolved ("Lagos") or whatever the
 * user typed ("lagos, nigeria"), so the country qualifier is dropped and the
 * comparison is case- and accent-insensitive. Substring matching in either
 * direction covers "Cape Town" vs "cape town" style variation without pulling
 * in a geocoder — that stays `get-weather`'s job.
 */
export function locationMatches(activityLocation: string, query: string): boolean {
  const city = normalize(activityLocation);
  const wanted = normalize(query.split(',')[0] ?? query);
  if (!wanted) return false;
  return city === wanted || city.includes(wanted) || wanted.includes(city);
}

/**
 * Reduce a forecast to one bucket, in priority order: rain first (it rules out
 * the most), then temperature extremes, otherwise mild. Returns 'unknown' when
 * no usable weather context was supplied.
 */
export function deriveCondition(
  weather: z.infer<typeof WeatherContextSchema> | undefined
): WeatherCondition | 'unknown' {
  if (!weather) return 'unknown';
  const {precipitationChance, highCelsius} = weather;

  if (precipitationChance !== undefined && precipitationChance >= WET_PRECIPITATION_CHANCE) {
    return 'wet';
  }
  if (highCelsius !== undefined && highCelsius >= HOT_CELSIUS) return 'hot';
  if (highCelsius !== undefined && highCelsius <= COLD_CELSIUS) return 'cold';
  if (precipitationChance === undefined && highCelsius === undefined) return 'unknown';
  return 'mild';
}

/** Map an ISO date to a weekday key, in UTC so the result never shifts with the host timezone. */
export function weekdayFor(date: string): Weekday {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return WEEKDAYS[day]!;
}

/**
 * Score an activity for ranking. Higher is better.
 *
 *   +3  per matched preference tag  — the strongest signal, it is what the user asked for
 *   +2  the activity suits the forecast bucket
 *   -4  weather-dependent and the forecast does not suit it
 *
 * Poorly-suited activities are demoted rather than removed, so a wet day still
 * returns options and the agent decides. `weatherFit` on each result makes the
 * reason visible.
 */
export function scoreActivity(
  activity: SeededActivity,
  condition: WeatherCondition | 'unknown',
  requestedTags: string[]
): {score: number; matchedTags: string[]; weatherFit: 'good' | 'poor' | 'unknown'} {
  const activityTags = new Set(activity.tags.map(normalize));
  const matchedTags = requestedTags.filter(tag => activityTags.has(normalize(tag)));

  let score = matchedTags.length * 3;
  let weatherFit: 'good' | 'poor' | 'unknown' = 'unknown';

  if (condition !== 'unknown') {
    const suits = activity.suitableWeather.includes(condition);
    if (suits) {
      score += 2;
      weatherFit = 'good';
    } else {
      weatherFit = 'poor';
      if (activity.weatherDependent) score -= 4;
    }
  }

  return {score, matchedTags, weatherFit};
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/**
 * Implementation, exported so the future `plan-trip` workflow can call it
 * without going through the agent. Pure and synchronous: no network, no model.
 */
export function findActivities(input: FindActivitiesInput): FindActivitiesOutput {
  const parsed = FindActivitiesInputSchema.parse(input);
  const {location, category, tags = [], weather, date, limit} = parsed;

  const condition = deriveCondition(weather);
  const weekday = date ? weekdayFor(date) : undefined;

  const matches = SEEDED_ACTIVITIES.filter(activity => {
    if (!locationMatches(activity.location, location)) return false;
    if (category && activity.category !== category) return false;
    if (weekday && !activity.availability.days.includes(weekday)) return false;
    return true;
  });

  const ranked = matches
    .map(activity => ({activity, ...scoreActivity(activity, condition, tags)}))
    .sort((a, b) => {
      // Deterministic ordering: score, then name, then id. Name before id keeps
      // the output predictable to a human reading it; id guarantees totality.
      if (b.score !== a.score) return b.score - a.score;
      const byName = a.activity.name.localeCompare(b.activity.name, 'en');
      if (byName !== 0) return byName;
      return a.activity.id.localeCompare(b.activity.id, 'en');
    });

  return {
    location,
    condition,
    totalMatches: ranked.length,
    activities: ranked.slice(0, limit).map(({activity, matchedTags, weatherFit}) => ({
      id: activity.id,
      name: activity.name,
      location: activity.location,
      category: activity.category,
      description: activity.description,
      durationMinutes: activity.durationMinutes,
      weatherDependent: activity.weatherDependent,
      suitableWeather: activity.suitableWeather,
      availability: activity.availability,
      tags: activity.tags,
      weatherFit,
      matchedTags
    }))
  };
}

export const findActivitiesTool = createTool({
  id: 'find-activities',
  description:
    'Find candidate activities in a city from a curated list. Call get-weather first and pass the forecast in, so activities that suit the conditions rank higher. Returns ranked candidates to choose from, not a finished plan.',
  inputSchema: FindActivitiesInputSchema,
  outputSchema: FindActivitiesOutputSchema,
  execute: async input => findActivities(input)
});
