import type {DiscoveredActivity} from './places';
import type {ResolvedLocation} from './geocoding';
import type {SeededActivity, WeatherCondition, Weekday} from '../tools/find-activities';

/**
 * Turning a place on the map into a candidate the planner can rank.
 *
 * The ranking, the weather policy and the preference hierarchy already work,
 * and they work on one shape. Rather than rewrite them for a second source,
 * discovered places are adapted into that shape, so a place found in Tokyo is
 * scored by exactly the same rules as a seeded one in Lagos.
 *
 * The line this module holds is between fact and assumption. Everything the map
 * records — name, position, category, opening hours, website, accessibility,
 * dietary tags — is carried across untouched, and absent fields stay absent.
 * The one value that cannot come from the map is how long somebody spends
 * there, because OpenStreetMap does not record visit duration. That is a
 * planning assumption per category, marked as such below, and never presented
 * as a fact about the venue.
 */

/** Categories the itinerary schema understands. */
type ItineraryCategory = SeededActivity['category'];

const CATEGORY_MAP: Record<string, ItineraryCategory> = {
  culture: 'culture',
  entertainment: 'culture',
  food: 'food',
  nature: 'nature',
  outdoor: 'outdoor',
  shopping: 'shopping',
  wellness: 'wellness'
};

/**
 * How long a visit typically takes, by category.
 *
 * A planning assumption, not provider data. It exists because the itinerary
 * schema needs a duration to build a schedule, and no map records one. The
 * values are conservative so a plan is not packed tighter than a real day.
 */
const TYPICAL_MINUTES: Record<ItineraryCategory, number> = {
  culture: 90,
  food: 75,
  nature: 75,
  outdoor: 90,
  shopping: 60,
  wellness: 90,
  indoor: 75,
  nightlife: 120
};

/** Weather a place is genuinely good in, inferred from whether it has a roof. */
function suitableWeatherFor(indoor: boolean): WeatherCondition[] {
  // Indoors is comfortable in anything; outdoors is not.
  return indoor ? ['wet', 'hot', 'cold', 'mild'] : ['mild', 'hot'];
}

const ALL_DAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * OpenStreetMap writes weekdays as two letters; the planner uses three.
 * Indexed by the same order as `ALL_DAYS` so a span maps straight across.
 */
const OSM_DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

function dayIndex(code: string): number {
  return OSM_DAYS.indexOf(code.toLowerCase());
}

/**
 * Read an OpenStreetMap `opening_hours` value, if it is one we can trust.
 *
 * The syntax is expressive enough to describe seasonal and public-holiday
 * rules, and misreading it would be worse than not reading it: the planner
 * would state a venue is open when it is not. Only the plain and unambiguous
 * forms are interpreted. Anything else is treated as unknown hours, which the
 * validator handles without either inventing or rejecting.
 */
export function parseOpeningHours(
  value: string | undefined
): {days: Weekday[]; opensAt: string; closesAt: string} | undefined {
  const text = value?.trim();
  if (!text) return undefined;

  // Open at all times.
  if (/^24\/7$/i.test(text)) {
    return {days: [...ALL_DAYS], opensAt: '00:00', closesAt: '23:59'};
  }

  // A single "HH:MM-HH:MM" range, optionally prefixed by a simple day span.
  const simple = /^(?:([A-Za-z]{2})(?:\s*-\s*([A-Za-z]{2}))?\s+)?(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(
    text
  );
  if (!simple) return undefined;

  const [, fromDay, toDay, opensAt, closesAt] = simple;
  const pad = (time: string) => (time.length === 4 ? `0${time}` : time);

  let days = [...ALL_DAYS];
  if (fromDay) {
    const start = dayIndex(fromDay);
    if (start === -1) return undefined;

    if (toDay) {
      const end = dayIndex(toDay);
      if (end === -1) return undefined;
      days = [];
      for (let index = start; ; index = (index + 1) % ALL_DAYS.length) {
        days.push(ALL_DAYS[index]);
        if (index === end) break;
      }
    } else {
      days = [ALL_DAYS[start]];
    }
  }

  return {days, opensAt: pad(opensAt), closesAt: pad(closesAt)};
}

/**
 * A discovered place, in the shape the planner already ranks.
 *
 * `availability` is omitted when the map does not say, rather than filled with
 * a plausible default. Downstream, unknown hours mean the venue is neither
 * claimed open nor discarded.
 */
export type DiscoveredCandidate = Omit<SeededActivity, 'availability'> & {
  availability?: SeededActivity['availability'];
  /** Where the fact came from, kept for provenance. */
  sourceUrl?: string;
  /** True when the map recorded step-free access. Absent means unrecorded. */
  wheelchairAccessible?: boolean;
  dietary?: string[];
};

/** A stable id from the place itself, so the same venue keeps the same id. */
function idFor(place: DiscoveredActivity): string {
  const slug = place.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

  return `osm-${slug}-${place.latitude.toFixed(3)}-${place.longitude.toFixed(3)}`;
}

/**
 * A short factual line about the place.
 *
 * Composed only from what the map recorded. When there is no description and no
 * address, the category and city are all that can honestly be said.
 */
function describe(place: DiscoveredActivity, location: ResolvedLocation): string {
  if (place.description) return place.description;

  const where = place.address ?? location.city;
  const kind = place.category === 'food' ? 'Place to eat' : `${place.category} spot`;
  const sentence = `${kind} in ${where}.`;

  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function toCandidate(
  place: DiscoveredActivity,
  location: ResolvedLocation
): DiscoveredCandidate {
  const category = CATEGORY_MAP[place.category] ?? (place.indoor ? 'indoor' : 'outdoor');

  return {
    id: idFor(place),
    name: place.name,
    location: location.city,
    category,
    description: describe(place, location),
    durationMinutes: TYPICAL_MINUTES[category],
    weatherDependent: !place.indoor,
    suitableWeather: suitableWeatherFor(place.indoor),
    availability: parseOpeningHours(place.openingHours),
    tags: place.tags,
    sourceUrl: place.website ?? place.sourceUrl,
    wheelchairAccessible: place.wheelchairAccessible,
    dietary: place.dietary
  };
}

/** Adapt a whole discovery result, dropping nothing and inventing nothing. */
export function toCandidates(
  places: DiscoveredActivity[],
  location: ResolvedLocation
): DiscoveredCandidate[] {
  return places.map(place => toCandidate(place, location));
}
