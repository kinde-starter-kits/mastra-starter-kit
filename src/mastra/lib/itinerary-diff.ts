import type {Itinerary} from '../schemas/itinerary';

/**
 * Comparing two versions of a plan.
 *
 * A follow-up that returns the plan it was given is a failure wearing a success
 * costume: the run completes, validation passes, and the user is told their
 * request was carried out when nothing moved. So "did this actually change?" is
 * answered here, deterministically, from the two structured itineraries — never
 * by asking the model whether it changed anything.
 *
 * The same comparison produces the change summary the UI shows, which means the
 * summary can only ever describe differences that genuinely exist.
 *
 * Dependency-free on purpose: the browser imports it, and nothing server-side
 * should follow it into the bundle.
 */

export type ActivityShape = Itinerary['activities'][number];

/** Minutes since midnight, or null when the time is unparseable. */
export function minutesOf(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function ordered(itinerary: Itinerary): ActivityShape[] {
  return [...itinerary.activities].sort((a, b) => a.order - b.order);
}

/**
 * The scheduling facts a pacing change would move.
 *
 * Name, category and location are excluded deliberately: swapping one gallery
 * for another is a real change, but it is captured by the name list below
 * rather than by the shape of the day.
 */
export type PlanShape = {
  count: number;
  names: string[];
  startTimes: (number | null)[];
  durations: number[];
  totalMinutes: number;
  /** Idle minutes between the end of one activity and the start of the next. */
  gaps: number[];
  firstStart: number | null;
  lastEnd: number | null;
};

export function shapeOf(itinerary: Itinerary): PlanShape {
  const activities = ordered(itinerary);
  const startTimes = activities.map(activity => minutesOf(activity.startTime));
  const durations = activities.map(activity => activity.durationMinutes);

  const gaps: number[] = [];
  for (let index = 1; index < activities.length; index += 1) {
    const previousStart = startTimes[index - 1];
    const start = startTimes[index];
    if (previousStart === null || start === null) continue;
    gaps.push(start - (previousStart + durations[index - 1]));
  }

  const lastStart = startTimes[startTimes.length - 1];
  const lastDuration = durations[durations.length - 1];

  return {
    count: activities.length,
    names: activities.map(activity => activity.name),
    startTimes,
    durations,
    totalMinutes: durations.reduce((total, value) => total + value, 0),
    gaps,
    firstStart: startTimes[0] ?? null,
    lastEnd: lastStart === null || lastStart === undefined ? null : lastStart + lastDuration
  };
}

/**
 * Two plans that would look the same to the person who asked for a change.
 *
 * Summary prose is ignored on purpose. A model that rewrites the summary while
 * leaving every activity, time and duration untouched has not changed the plan,
 * and treating that as success is exactly the failure this guards.
 */
export function materiallyIdentical(previous: Itinerary, next: Itinerary): boolean {
  const a = shapeOf(previous);
  const b = shapeOf(next);

  return (
    a.count === b.count &&
    a.names.join('|') === b.names.join('|') &&
    a.startTimes.join('|') === b.startTimes.join('|') &&
    a.durations.join('|') === b.durations.join('|')
  );
}

/**
 * What changed, in the user's terms.
 *
 * Every line is derived from the two structures. When nothing can be stated
 * confidently the list is empty and the UI shows no summary at all, rather than
 * a vague reassurance that something was updated.
 */
export function describeChanges(previous: Itinerary, next: Itinerary): string[] {
  if (materiallyIdentical(previous, next)) return [];

  const a = shapeOf(previous);
  const b = shapeOf(next);
  const changes: string[] = [];

  if (b.count < a.count) {
    changes.push(`Fewer stops (${a.count} → ${b.count})`);
  } else if (b.count > a.count) {
    changes.push(`More stops (${a.count} → ${b.count})`);
  }

  const removed = a.names.filter(name => !b.names.includes(name));
  const added = b.names.filter(name => !a.names.includes(name));
  for (const name of removed.slice(0, 2)) changes.push(`Removed ${name}`);
  for (const name of added.slice(0, 2)) changes.push(`Added ${name}`);

  // Only mention a shifted start when the set of stops is otherwise stable;
  // "starts later" is confusing when the first activity is a different one.
  if (
    a.firstStart !== null &&
    b.firstStart !== null &&
    a.firstStart !== b.firstStart &&
    a.names[0] === b.names[0]
  ) {
    const later = b.firstStart > a.firstStart;
    changes.push(`Starts ${later ? 'later' : 'earlier'} (${format(a.firstStart)} → ${format(b.firstStart)})`);
  }

  // A stop kept by name whose length moved is the clearest signal of pacing.
  for (const name of b.names) {
    const before = a.names.indexOf(name);
    const after = b.names.indexOf(name);
    if (before === -1) continue;

    const wasMinutes = a.durations[before];
    const nowMinutes = b.durations[after];
    if (wasMinutes === nowMinutes) continue;

    changes.push(
      `${nowMinutes > wasMinutes ? 'Longer' : 'Shorter'} at ${name} (${duration(wasMinutes)} → ${duration(nowMinutes)})`
    );
    if (changes.length >= 5) break;
  }

  const averageGapBefore = average(a.gaps);
  const averageGapAfter = average(b.gaps);
  if (
    averageGapBefore !== null &&
    averageGapAfter !== null &&
    averageGapAfter - averageGapBefore >= 15
  ) {
    changes.push('More breathing room between stops');
  }

  return changes.slice(0, 5);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function format(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function duration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

/**
 * Did the change the user named actually happen?
 *
 * `materiallyIdentical` only asks whether *anything* moved, which is not the
 * same question. Observed live: "give me fewer stops" returned a plan with the
 * same two stops and a shorter first one. Something changed, so the unchanged
 * guard stayed quiet, and the user was shown a plan that ignored what they
 * asked for.
 *
 * Only requests with a measurable direction are checked. "More relaxed" and
 * "suitable for the rain" have no single number to compare, so they return
 * `undefined` and are left to the model and the validator — inventing a metric
 * for them would reject good plans.
 */
export type AxisCheck = 'satisfied' | 'unsatisfied' | undefined;

export function satisfiesRequest(
  message: string,
  previous: Itinerary,
  next: Itinerary
): AxisCheck {
  const text = String(message ?? '').toLowerCase();
  const before = shapeOf(previous);
  const after = shapeOf(next);

  if (/\b(fewer|less|reduce|drop|remove)\b/.test(text) && /\b(stop|stops|activit|place)/.test(text)) {
    // Nothing to remove is not a failure to remove.
    if (before.count <= 1) return undefined;
    return after.count < before.count ? 'satisfied' : 'unsatisfied';
  }

  if (/\b(add|more|another|extra)\b/.test(text) && /\b(stop|stops|activit|place|lunch|dinner|meal)/.test(text)) {
    return after.count > before.count ? 'satisfied' : 'unsatisfied';
  }

  if (/\bstart(ing)?\s+later\b|\blater start\b/.test(text)) {
    if (before.firstStart === null || after.firstStart === null) return undefined;
    return after.firstStart > before.firstStart ? 'satisfied' : 'unsatisfied';
  }

  if (/\bstart(ing)?\s+earlier\b|\bearlier start\b/.test(text)) {
    if (before.firstStart === null || after.firstStart === null) return undefined;
    return after.firstStart < before.firstStart ? 'satisfied' : 'unsatisfied';
  }

  return undefined;
}
