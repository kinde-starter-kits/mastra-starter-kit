import type {Itinerary} from '../schemas/itinerary';

/**
 * Treating a follow-up as a patch rather than a fresh request.
 *
 * Left to conversation memory alone, the agent produced a plan that was
 * *technically* new and *practically* identical: "make it more relaxed" came
 * back with the same stops at the same times. The history was there, but
 * nothing told the model that the previous itinerary was the thing being
 * edited, or what the edit was supposed to achieve.
 *
 * So a modification turn is given three things this module builds: the previous
 * plan as structured data, an instruction to return the whole revised plan, and
 * — where the request names a well-understood axis like pacing — a concrete
 * definition of what that axis means. Nothing here decides *what* the new plan
 * is; the model still does that, against the same tools and the same validator.
 */

/**
 * Verbs and phrasings that act on something already in the conversation.
 *
 * Kept conservative in the other direction from the save gate: a false positive
 * here only adds context the model may ignore, while a false negative returns
 * the weak behaviour this replaces.
 */
const MODIFICATION_PATTERNS: RegExp[] = [
  /\b(make|keep) (it|this|that|the (plan|day|itinerary))\b/i,
  /\b(more|less|fewer|shorter|longer|slower|faster|earlier|later|cheaper)\b/i,
  /\b(add|remove|drop|replace|swap|change|adjust|move|shift|extend|shorten|reorder)\b/i,
  /\b(instead|actually|rather)\b/i,
  /\b(start|finish|end) (later|earlier|at)\b/i,
  /\bi (don'?t|do not) (want|like)\b/i,
  /\bwithout the\b/i
];

/** Phrasings that start a fresh plan even though they mention changing things. */
const NEW_PLAN_PATTERNS: RegExp[] = [
  /\bplan (me|a|my)\b/i,
  /\bnew (plan|day|itinerary)\b/i,
  /\bwhat (have|did) i save\b/i,
  /\bshow me my saved\b/i
];

/** Questions are not edits: answering one must not rewrite the plan. */
const QUESTION_PATTERNS: RegExp[] = [
  /^(what|when|where|why|how|who|is|are|does|do|can|could|will|would|should)\b/i
];

export type RequestKind = 'new_plan' | 'follow_up_modification' | 'question';

/**
 * Classify a turn against the plan already in the conversation.
 *
 * Without a previous itinerary every request is a new plan — there is nothing
 * to modify, and inventing one is exactly what must not happen.
 */
export function classifyRequest(message: string, hasPreviousPlan: boolean): RequestKind {
  const text = String(message ?? '').trim();
  if (!text || !hasPreviousPlan) return 'new_plan';

  if (NEW_PLAN_PATTERNS.some(pattern => pattern.test(text))) return 'new_plan';

  const isQuestion = text.endsWith('?') || QUESTION_PATTERNS.some(p => p.test(text));
  const asksForChange = MODIFICATION_PATTERNS.some(pattern => pattern.test(text));

  // "Can you make it shorter?" is a request, not a question, so an explicit
  // change verb wins over the question shape.
  if (asksForChange) return 'follow_up_modification';
  if (isQuestion) return 'question';

  return 'new_plan';
}

/**
 * Concrete meanings for the axes people actually ask about.
 *
 * "More relaxed" is the one that failed in practice, because it means nothing
 * to a model without a definition — it rewrote the summary and left the day
 * alone. Each entry says what to change in terms the planner can act on, and
 * none of them fixes a number: the result still depends on the activities and
 * constraints that are available.
 */
const AXES: {match: RegExp; guidance: string}[] = [
  {
    match: /\b(relaxed|slower|calmer|easier|leisurely|less rushed|chill)\b/i,
    guidance:
      'Reduce the pacing pressure of the day. Prefer fewer stops, longer stays at the ones you keep, and larger gaps between them, so there is less travelling and less clock-watching. A relaxed day is not a shorter day — keep it within the requested window rather than ending early.'
  },
  {
    match: /\b(packed|busier|more to do|fuller|efficient)\b/i,
    guidance:
      'Increase what fits in the day without breaking opening hours or leaving no travel time between stops.'
  },
  {
    match: /\bstart(ing)? (later|after)\b|\blater start\b/i,
    guidance:
      'Move the first activity later while staying inside the requested part of the day and each place’s opening hours. Shift the rest so the day still flows.'
  },
  {
    match: /\bstart(ing)? earlier\b|\bearlier start\b/i,
    guidance:
      'Move the first activity earlier, but never before a place opens or before the requested part of the day begins.'
  },
  {
    match: /\b(fewer|less) (stops|activities|places)\b/i,
    guidance: 'Reduce the number of activities, keeping the ones that best match what was asked for.'
  },
  {
    match: /\b(more|add) (stops|activities|places)\b|\badd (lunch|dinner|breakfast|a meal|food)\b/i,
    guidance:
      'Add a suitable activity from find-activities and reschedule around it, keeping every existing stop unless it no longer fits.'
  },
  {
    match: /\b(outdoors?y?|outside|open air)\b/i,
    guidance:
      'Prefer outdoor activities where the forecast allows it. Do not build an all-outdoor day in severe weather — keep an indoor option and say why in the notes.'
  },
  {
    match: /\b(indoors?|suitable for rain|rain-?proof|dry)\b/i,
    guidance: 'Prefer activities whose weatherFit is good for the forecast, favouring indoor options.'
  },
  {
    /*
     * Cost is the one axis this dataset cannot serve.
     *
     * The activity records carry no price or cost band, and inventing one would
     * be the worst kind of plausible answer: confidently wrong about money.
     * Rather than quietly ignoring the request, the agent is told to say the
     * data is missing. Adding a real `costLevel` to the dataset would make this
     * supportable; until then it is not advertised as working.
     */
    match: /\b(cheaper|budget|affordable|low ?cost|expensive|price|cost)\b/i,
    guidance:
      'The activity data holds no cost or price information, so you cannot rank by cost. Do not guess prices, do not describe an activity as cheap or expensive, and do not silently ignore the request. Reply with a message saying that cost preferences are not available for this activity data, and offer what you can change instead — the pace, the timing, or the kinds of activity.'
  },
  {
    match: /\b(evening|night|morning|afternoon)\b/i,
    guidance:
      'Rebuild the day inside the newly requested part of the day, keeping activities that are open then.'
  }
];

function guidanceFor(message: string): string[] {
  return AXES.filter(axis => axis.match.test(message)).map(axis => axis.guidance);
}

/**
 * A compact, safe view of the plan being edited.
 *
 * Only itinerary fields appear. No request context, no resource id, no tool
 * arguments, no tool results — the itinerary is already the sanitised, validated
 * envelope, and nothing else is read.
 */
export function describePreviousPlan(itinerary: Itinerary): string {
  const activities = [...itinerary.activities]
    .sort((a, b) => a.order - b.order)
    .map(
      activity =>
        `${activity.order}. ${activity.startTime} for ${activity.durationMinutes} minutes — ` +
        `${activity.name} (${activity.category}, ${activity.location})` +
        `${activity.weatherDependent ? ' [weather-dependent]' : ''}`
    )
    .join('\n');

  return [
    `Destination: ${itinerary.destination}`,
    `Date: ${itinerary.date}`,
    `Forecast: ${itinerary.weather.summary}, ${itinerary.weather.precipitationChance}% chance of precipitation, ${Math.round(itinerary.weather.lowCelsius)}–${Math.round(itinerary.weather.highCelsius)}°C`,
    '',
    'Current schedule:',
    activities
  ].join('\n');
}

/**
 * The prompt for a modification turn.
 *
 * The rules are explicit because each one corresponds to something the agent
 * did wrong: describing a change instead of making it, asking permission to
 * proceed, and returning the original plan while claiming it had been revised.
 */
export function buildFollowUpPrompt(message: string, previous: Itinerary): string {
  const guidance = guidanceFor(message);

  return [
    'You are modifying an existing itinerary.',
    '',
    'The existing plan is:',
    describePreviousPlan(previous),
    '',
    `The traveller now says: "${message}"`,
    '',
    'Apply that instruction to the plan above:',
    '- Preserve every part of the plan the traveller did not ask you to change.',
    '- Apply the requested change concretely, so the new schedule is genuinely different in the way they asked for.',
    '- Return the complete revised itinerary, including the activities that stayed the same. The reply replaces the plan rather than amending it.',
    '- Do not describe how you would change it, and do not ask whether to proceed.',
    '- Do not return the plan unchanged unless the request genuinely has no possible effect on it.',
    '- Call find-activities again if the change needs activities you do not already have. Never invent one.',
    '- The revised plan must still satisfy every hard constraint: the requested part of the day, opening hours, closed days, the destination, the weather policy, and anything the traveller has said they dislike.',
    ...(guidance.length ? ['', 'What they are asking for, concretely:', ...guidance.map(line => `- ${line}`)] : []),
    '',
    /*
     * The last line, and the reason this prompt has one.
     *
     * Measured: roughly one follow-up in four came back as a numbered list in
     * prose with `finishReason: 'other'` and no object, and retrying the same
     * thread often failed again — the failures cluster rather than occurring
     * independently. Each prose reply is stored in the conversation, so history
     * accumulates evidence that prose is the expected format and the model
     * follows it. Restating the contract last, after all the planning guidance,
     * is what pulls it back.
     */
    'Reply with the itinerary response object itself, exactly as the response schema requires. Do not write the plan out as a numbered list, a paragraph, or any other prose form.'
  ].join('\n');
}

/** The nudge sent when a measurable request was not carried out. */
export function buildUnsatisfiedPrompt(message: string): string {
  return [
    `The itinerary you returned does not carry out "${message}". Look at what was asked for and change that specific thing.`,
    '',
    'Return the complete revised itinerary, still using only activities from find-activities and still respecting opening hours and the requested part of the day.',
    'If it genuinely cannot be done with the available activities, reply with a message explaining why.',
    '',
    'Reply with the itinerary response object itself, exactly as the response schema requires. Do not write the plan out as prose.'
  ].join('\n');
}

/** The nudge sent when the model returned a plan that did not actually change. */
export function buildUnchangedPrompt(message: string): string {
  return [
    `The itinerary you returned is identical to the previous one: the same activities, at the same times, for the same durations. That does not satisfy "${message}".`,
    '',
    'Return a genuinely different schedule that applies the requested change, still using only activities from find-activities and still respecting opening hours and the requested part of the day.',
    'If the change is truly impossible with the available activities, reply with a message explaining why instead of repeating the plan.',
    '',
    'Reply with the itinerary response object itself, exactly as the response schema requires. Do not write the plan out as prose.'
  ].join('\n');
}
