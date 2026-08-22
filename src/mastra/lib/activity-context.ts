import type {RankableActivity} from '../tools/find-activities';

/**
 * What was genuinely offered to the planner for a city, so the plan can be
 * checked against it.
 *
 * The validator used to ask "is this activity in the seeded dataset?", which
 * only worked while the world was two cities. It now asks "was this activity
 * one of the places discovery actually returned?" — a question that holds
 * anywhere, and still rejects a venue the model invented.
 *
 * Deliberately a small in-memory map rather than a table. It holds the current
 * request's candidates for the length of a run; it is not a place database, it
 * is not persisted, and losing it costs nothing but a re-query. Raw provider
 * responses never enter it — only the normalised fields the planner and the
 * validator use.
 */

/** Only the fields validation and planning need. No provider payloads. */
export type KnownActivity = {
  name: string;
  location: string;
  category: RankableActivity['category'];
  durationMinutes: number;
  weatherDependent: boolean;
  suitableWeather: RankableActivity['suitableWeather'];
  availability?: RankableActivity['availability'];
  tags: string[];
};

/**
 * How many cities are remembered at once.
 *
 * A serverless instance handles a handful of conversations, so this only needs
 * to outlive one run. The cap exists so a long-lived instance cannot grow
 * without bound.
 */
const MAX_CITIES = 24;

const byCity = new Map<string, KnownActivity[]>();

function key(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Strip anything that is not needed for validation before storing it. */
function toKnown(activity: RankableActivity): KnownActivity {
  return {
    name: activity.name,
    location: activity.location,
    category: activity.category,
    durationMinutes: activity.durationMinutes,
    weatherDependent: activity.weatherDependent,
    suitableWeather: activity.suitableWeather,
    availability: activity.availability,
    tags: activity.tags
  };
}

/** Record what discovery offered for a city. */
export function rememberDiscovered(city: string, activities: readonly RankableActivity[]): void {
  if (!city || activities.length === 0) return;

  // Oldest entry falls out first, so the map stays bounded.
  if (byCity.size >= MAX_CITIES && !byCity.has(key(city))) {
    const oldest = byCity.keys().next().value;
    if (oldest !== undefined) byCity.delete(oldest);
  }

  byCity.set(key(city), activities.map(toKnown));
}

/** Everything known to be real in a city for the current run. */
export function knownActivitiesFor(city: string): KnownActivity[] {
  return byCity.get(key(city)) ?? [];
}

/**
 * Find the record a planned activity claims to be.
 *
 * Matching is by name within the city, which is how a plan refers to a place.
 * Returns nothing when the city was never searched, so a caller can tell
 * "not offered" apart from "nothing known".
 */
export function findKnownActivity(city: string, name: string): KnownActivity | undefined {
  const wanted = key(name);
  return knownActivitiesFor(city).find(activity => key(activity.name) === wanted);
}

/** True once discovery has run for this city in this process. */
export function hasKnownActivities(city: string): boolean {
  return knownActivitiesFor(city).length > 0;
}

/** Test helper: forget everything, so one test cannot leak into another. */
export function clearKnownActivities(): void {
  byCity.clear();
}
