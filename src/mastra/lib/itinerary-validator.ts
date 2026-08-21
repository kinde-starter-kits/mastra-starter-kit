import type {Itinerary} from '../schemas/itinerary';
import type {TravelPreferences} from '../memory';
import {SEEDED_ACTIVITIES, locationMatches, weekdayFor, type SeededActivity} from '../tools/find-activities';

/**
 * Deterministic checks applied to a generated itinerary before the application
 * accepts it.
 *
 * A language model will occasionally produce a plan that contradicts the
 * request — a 06:00 start for an afternoon, an activity that is closed that
 * day, or a place that is not in the dataset. Prompt wording reduces this but
 * does not remove it, so the plan is checked against facts the application
 * already holds: the seeded activity records, the forecast, and the
 * constraints stated in the request.
 *
 * The validator only checks what the domain model can support. It does not
 * invent travel times, because the application has no travel-time data.
 */

export type ValidationIssueCode =
  | 'time_window_violation'
  | 'start_too_early'
  | 'out_of_order'
  | 'overlap'
  | 'closed_on_day'
  | 'outside_opening_hours'
  | 'unknown_activity'
  | 'destination_mismatch'
  | 'weather_flag_mismatch'
  | 'severe_weather_unmitigated'
  | 'disliked_activity'
  | 'exceeds_requested_window';

export type ValidationIssue = {
  code: ValidationIssueCode;
  /** The offending activity, identified by name where one applies. */
  activityId?: string;
  message: string;
};

export type ValidationResult = {valid: boolean; issues: ValidationIssue[]};

/** A named part of the day, in minutes from midnight. */
export type TimeWindow = {label: string; startMinutes: number; endMinutes: number};

/**
 * Documented boundaries for the parts of the day this app recognises.
 * They are conventions, not universal truths, so they live here in one place
 * rather than being restated across the prompt and the checks.
 */
export const TIME_WINDOWS: Record<'morning' | 'afternoon' | 'evening', TimeWindow> = {
  morning: {label: 'morning', startMinutes: 6 * 60, endMinutes: 12 * 60},
  afternoon: {label: 'afternoon', startMinutes: 12 * 60, endMinutes: 18 * 60},
  evening: {label: 'evening', startMinutes: 17 * 60, endMinutes: 23 * 60}
};

/** "Nothing too early" has to mean something specific to be checkable. */
export const NOT_TOO_EARLY_MINUTES = 10 * 60;

export type PlanningConstraints = {
  window?: TimeWindow;
  /** No activity may start before this. */
  earliestStartMinutes?: number;
  /** The whole plan must fit inside this many minutes. */
  maxTotalMinutes?: number;
};

export function toMinutes(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function toClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Read schedule constraints out of the request.
 *
 * This covers the phrasings the demo actually uses. Anything it cannot read is
 * simply left unconstrained, so an unrecognised phrase never causes a false
 * rejection — the validator only enforces what it is confident about.
 */
export function parsePlanningConstraints(message: string): PlanningConstraints {
  const text = message.toLowerCase();
  const constraints: PlanningConstraints = {};

  if (/\bmorning\b/.test(text)) constraints.window = TIME_WINDOWS.morning;
  if (/\bafternoon\b/.test(text)) constraints.window = TIME_WINDOWS.afternoon;
  if (/\bevening\b|\bnight\b/.test(text)) constraints.window = TIME_WINDOWS.evening;

  /*
   * "too early" is only ever used to rule an early start out — "nothing too
   * early", "don't want anything too early", "not too early" — so the phrase
   * alone is a reliable signal. Matching on it directly avoids trying to
   * enumerate every negation, which missed contractions such as "don't".
   */
  if (/\btoo early\b/.test(text) || /\bno early start/.test(text)) {
    constraints.earliestStartMinutes = NOT_TOO_EARLY_MINUTES;
  }

  // "after 2pm", "from 14:00", "start at 3 pm"
  const after = /\b(?:after|from|starting at|start at|no earlier than)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (after) {
    let hour = Number(after[1]);
    const minute = Number(after[2] ?? 0);
    const meridiem = after[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    const minutes = hour * 60 + minute;
    constraints.earliestStartMinutes = Math.max(constraints.earliestStartMinutes ?? 0, minutes);
  }

  // "I have three hours", "for 2 hours"
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8
  };
  const duration = /\b(?:i have|for|about|around)\s+(\d+|one|two|three|four|five|six|seven|eight)\s*(hour|hr)s?\b/.exec(text);
  if (duration) {
    const raw = duration[1]!;
    const hours = Number.isNaN(Number(raw)) ? words[raw] : Number(raw);
    if (hours) constraints.maxTotalMinutes = hours * 60;
  }

  return constraints;
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Find the dataset record an itinerary activity claims to be. */
export function findSeededActivity(name: string): SeededActivity | undefined {
  const wanted = normalize(name);
  return SEEDED_ACTIVITIES.find(activity => normalize(activity.name) === wanted);
}

export type ValidateInput = {
  itinerary: Itinerary;
  constraints: PlanningConstraints;
  /** The forecast the plan was built around, when one is available. */
  weather?: {precipitationChance?: number};
  preferences?: TravelPreferences;
};

/** Severe enough that an all-outdoor plan is a planning error, not a choice. */
export const SEVERE_PRECIPITATION = 70;

export function validateItinerary(input: ValidateInput): ValidationResult {
  const {itinerary, constraints, preferences} = input;
  const issues: ValidationIssue[] = [];
  const add = (code: ValidationIssueCode, message: string, activityId?: string) =>
    issues.push(activityId ? {code, activityId, message} : {code, message});

  const ordered = [...itinerary.activities].sort((a, b) => a.order - b.order);
  const weekday = weekdayFor(itinerary.date);

  let previousEnd: number | undefined;
  let previousName: string | undefined;
  let earliestStart = Number.POSITIVE_INFINITY;
  let latestEnd = Number.NEGATIVE_INFINITY;

  for (const activity of ordered) {
    const start = toMinutes(activity.startTime);
    if (Number.isNaN(start)) continue;
    const end = start + activity.durationMinutes;

    earliestStart = Math.min(earliestStart, start);
    latestEnd = Math.max(latestEnd, end);

    // 1. Time window and explicit constraints.
    if (constraints.window) {
      const {label, startMinutes, endMinutes} = constraints.window;
      if (start < startMinutes || start >= endMinutes) {
        add(
          'time_window_violation',
          `${activity.startTime} is outside the requested ${label} window (${toClock(startMinutes)}–${toClock(endMinutes)}).`,
          activity.name
        );
      }
    }
    if (constraints.earliestStartMinutes !== undefined && start < constraints.earliestStartMinutes) {
      add(
        'start_too_early',
        `${activity.startTime} starts before the requested earliest start of ${toClock(constraints.earliestStartMinutes)}.`,
        activity.name
      );
    }

    // 2 and 3. Ordering and overlap.
    if (previousEnd !== undefined) {
      if (start < previousEnd) {
        add(
          'overlap',
          `${activity.name} at ${activity.startTime} overlaps ${previousName}, which runs until ${toClock(previousEnd)}.`,
          activity.name
        );
      }
    }
    previousEnd = end;
    previousName = activity.name;

    // 5. Provenance: the activity must exist in the dataset.
    const seeded = findSeededActivity(activity.name);
    if (!seeded) {
      add(
        'unknown_activity',
        `${activity.name} was not returned by the activity search and cannot be verified.`,
        activity.name
      );
      continue;
    }

    // 6. Destination consistency.
    if (!locationMatches(seeded.location, itinerary.destination)) {
      add(
        'destination_mismatch',
        `${activity.name} is in ${seeded.location}, not ${itinerary.destination}.`,
        activity.name
      );
    }

    // 4. Opening hours and day of week.
    if (!seeded.availability.days.includes(weekday)) {
      add('closed_on_day', `${activity.name} is not open on ${weekday}.`, activity.name);
    }
    const opens = toMinutes(seeded.availability.opensAt);
    const closes = toMinutes(seeded.availability.closesAt);
    if (start < opens || end > closes) {
      add(
        'outside_opening_hours',
        `${activity.name} is scheduled ${activity.startTime}–${toClock(end)} but opens ${seeded.availability.opensAt} and closes ${seeded.availability.closesAt}.`,
        activity.name
      );
    }

    // 7. The weather-dependence flag must match the dataset.
    if (activity.weatherDependent !== seeded.weatherDependent) {
      add(
        'weather_flag_mismatch',
        `${activity.name} is marked weatherDependent=${activity.weatherDependent} but the activity data says ${seeded.weatherDependent}.`,
        activity.name
      );
    }

    // 8. Stated dislikes.
    const dislikes = (preferences?.dislikes ?? []).map(normalize);
    if (dislikes.length > 0) {
      const haystack = [seeded.category, ...seeded.tags, seeded.name].map(normalize);
      const hit = dislikes.find(dislike => haystack.some(value => value.includes(dislike)));
      if (hit) {
        add('disliked_activity', `${activity.name} matches a stated dislike (${hit}).`, activity.name);
      }
    }
  }

  // 2. Strict chronological ordering by declared order.
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = toMinutes(ordered[i - 1]!.startTime);
    const current = toMinutes(ordered[i]!.startTime);
    if (!Number.isNaN(previous) && !Number.isNaN(current) && current < previous) {
      add(
        'out_of_order',
        `${ordered[i]!.name} is ordered after ${ordered[i - 1]!.name} but starts earlier.`,
        ordered[i]!.name
      );
    }
  }

  // 7. Severe weather must be mitigated somewhere in the plan.
  const precipitation = input.weather?.precipitationChance ?? itinerary.weather.precipitationChance;
  if (
    precipitation >= SEVERE_PRECIPITATION &&
    ordered.length > 0 &&
    ordered.every(activity => activity.weatherDependent)
  ) {
    add(
      'severe_weather_unmitigated',
      `Every activity is weather-dependent but precipitation is ${precipitation}%. Include at least one option that rain does not spoil.`
    );
  }

  // 9. The plan must fit the requested period.
  if (
    constraints.maxTotalMinutes !== undefined &&
    Number.isFinite(earliestStart) &&
    Number.isFinite(latestEnd) &&
    latestEnd - earliestStart > constraints.maxTotalMinutes
  ) {
    add(
      'exceeds_requested_window',
      `The plan spans ${latestEnd - earliestStart} minutes but ${constraints.maxTotalMinutes} were requested.`
    );
  }
  if (constraints.window && Number.isFinite(latestEnd) && latestEnd > constraints.window.endMinutes) {
    add(
      'exceeds_requested_window',
      `The plan runs until ${toClock(latestEnd)}, past the end of the requested ${constraints.window.label}.`
    );
  }

  return {valid: issues.length === 0, issues};
}

/**
 * Turn validation issues into correction instructions for one regeneration
 * attempt. Deliberately states the rule that was broken rather than dictating
 * a specific replacement, so the model still does the planning.
 */
export function buildCorrectionPrompt(issues: ValidationIssue[]): string {
  const lines = issues.map(issue => `- ${issue.message}`).join('\n');
  return [
    'The plan you produced does not satisfy the request. Fix these problems and return a corrected itinerary:',
    lines,
    'Keep everything that was already correct. Use only activities returned by find-activities, and respect their opening hours.'
  ].join('\n\n');
}
