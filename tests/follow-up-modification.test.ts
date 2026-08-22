import {describe, expect, it} from 'vitest';

import {
  classifyRequest,
  buildFollowUpPrompt,
  buildUnchangedPrompt,
  buildUnsatisfiedPrompt,
  describePreviousPlan
} from '../src/mastra/lib/follow-up';
import {
  describeChanges,
  materiallyIdentical,
  minutesOf,
  satisfiesRequest,
  shapeOf
} from '../src/mastra/lib/itinerary-diff';

/**
 * Follow-ups that actually change the plan.
 *
 * The failure these guard was observed by hand: "make it more relaxed" returned
 * a valid itinerary with the same stops, at the same times, for the same
 * durations, and a reworded summary. The run succeeded and the plan had not
 * moved. Three things are tested here — that such a turn is recognised as an
 * edit, that the previous plan reaches the model as data, and that an unchanged
 * result is detected rather than reported as success.
 */

const BASE = {
  destination: 'Lagos',
  date: '2026-08-22',
  summary: 'An afternoon in Lagos.',
  weather: {
    summary: 'Light rain showers',
    highCelsius: 27,
    lowCelsius: 25,
    precipitationChance: 100,
    considerations: []
  },
  activities: [
    {
      order: 1,
      name: 'Jara Beach',
      startTime: '13:00',
      durationMinutes: 120,
      category: 'outdoor',
      location: 'Lagos coastline',
      description: 'Calm coastline.',
      weatherDependent: true
    },
    {
      order: 2,
      name: 'Terra Kulture',
      startTime: '15:30',
      durationMinutes: 120,
      category: 'culture',
      location: 'Victoria Island',
      description: 'Arts centre.',
      weatherDependent: false
    }
  ],
  notes: []
} as never as import('../src/mastra/schemas/itinerary').Itinerary;

/** The plan the same request should produce: fewer transitions, longer stays. */
const RELAXED = {
  ...BASE,
  activities: [
    {...BASE.activities[0], startTime: '13:00', durationMinutes: 180},
    {...BASE.activities[1], startTime: '16:45', durationMinutes: 90}
  ]
} as never as import('../src/mastra/schemas/itinerary').Itinerary;

describe('recognising a modification', () => {
  it.each([
    'Make it more relaxed',
    'Start later',
    'Give me fewer stops',
    'Remove the beach',
    'Make it suitable for rain',
    'Add lunch',
    'Make it more outdoorsy',
    'Make it cheaper',
    'Change the second activity',
    'Actually, make it an evening plan',
    'Keep the beach but make the day slower',
    "I don't want that",
    'Can you make this cheaper?'
  ])('treats %j as an edit of the existing plan', message => {
    expect(classifyRequest(message, true)).toBe('follow_up_modification');
  });

  it('treats a question as a question, so answering it never rewrites the plan', () => {
    expect(classifyRequest("What's the weather like now?", true)).toBe('question');
    expect(classifyRequest('Where is Terra Kulture?', true)).toBe('question');
  });

  it('treats an explicit new request as a new plan', () => {
    expect(classifyRequest('Plan me an afternoon in Lisbon tomorrow.', true)).toBe('new_plan');
    expect(classifyRequest('Show me my saved itineraries.', true)).toBe('new_plan');
  });

  it('cannot modify what does not exist yet', () => {
    // With no previous plan there is nothing to edit, and inventing one is the
    // behaviour that must not happen.
    expect(classifyRequest('Make it more relaxed', false)).toBe('new_plan');
  });
});

describe('the prompt a modification gets', () => {
  const prompt = buildFollowUpPrompt('Make it more relaxed', BASE);

  it('hands over the previous plan as data', () => {
    expect(prompt).toContain('Jara Beach');
    expect(prompt).toContain('13:00');
    expect(prompt).toContain('Terra Kulture');
    expect(prompt).toContain('Lagos');
  });

  it('says what the requested change concretely means', () => {
    expect(prompt).toMatch(/fewer stops, longer stays/i);
    expect(prompt).toMatch(/larger gaps/i);
  });

  it('forbids the three things the agent actually did wrong', () => {
    expect(prompt).toMatch(/do not describe how you would change it/i);
    expect(prompt).toMatch(/do not ask whether to proceed/i);
    expect(prompt).toMatch(/do not return the plan unchanged/i);
  });

  it('keeps every hard constraint in force', () => {
    expect(prompt).toMatch(/opening hours/i);
    expect(prompt).toMatch(/weather policy/i);
    expect(prompt).toMatch(/never invent one/i);
  });

  it('gives a different definition for a different axis', () => {
    expect(buildFollowUpPrompt('Start later', BASE)).toMatch(/move the first activity later/i);
    expect(buildFollowUpPrompt('Add lunch', BASE)).toMatch(/add a suitable activity/i);
    expect(buildFollowUpPrompt('Make it more outdoorsy', BASE)).toMatch(/prefer outdoor/i);
    expect(buildFollowUpPrompt('Make it suitable for rain', BASE)).toMatch(/weatherFit/i);
    expect(buildFollowUpPrompt('Give me fewer stops', BASE)).toMatch(/reduce the number/i);
  });

  it('carries no identity, credential or tool internals', () => {
    const text = `${prompt}\n${describePreviousPlan(BASE)}`;
    expect(text).not.toMatch(/sk-|Bearer|resourceId|org_|mastra__|toolCallId/);
  });
});

describe('detecting a plan that did not change', () => {
  it('reads a plan that came back identical', () => {
    expect(materiallyIdentical(BASE, BASE)).toBe(true);
  });

  it('ignores a reworded summary, which is what the model actually did', () => {
    const reworded = {...BASE, summary: 'A wonderfully relaxed afternoon in Lagos.'};
    expect(materiallyIdentical(BASE, reworded as never)).toBe(true);
  });

  it('sees a genuine pacing change', () => {
    expect(materiallyIdentical(BASE, RELAXED)).toBe(false);
  });

  it.each([
    ['a dropped stop', {...BASE, activities: [BASE.activities[0]]}],
    [
      'a later start',
      {...BASE, activities: [{...BASE.activities[0], startTime: '15:00'}, BASE.activities[1]]}
    ],
    [
      'a longer stay',
      {...BASE, activities: [{...BASE.activities[0], durationMinutes: 240}, BASE.activities[1]]}
    ],
    [
      'a replaced activity',
      {...BASE, activities: [{...BASE.activities[0], name: 'Lekki Conservation Centre'}, BASE.activities[1]]}
    ]
  ])('sees %s as a real change', (_label, next) => {
    expect(materiallyIdentical(BASE, next as never)).toBe(false);
  });
});

describe('the change summary', () => {
  it('says nothing when nothing changed', () => {
    expect(describeChanges(BASE, BASE)).toEqual([]);
  });

  it('describes a relaxed day in the terms that were asked for', () => {
    const changes = describeChanges(BASE, RELAXED);

    expect(changes.join(' ')).toMatch(/longer at jara beach/i);
    expect(changes.join(' ')).toMatch(/shorter at terra kulture/i);
    expect(changes.join(' ')).toMatch(/breathing room/i);
  });

  it('counts stops when the plan gets shorter', () => {
    const fewer = {...BASE, activities: [BASE.activities[0]]};
    expect(describeChanges(BASE, fewer as never).join(' ')).toMatch(/fewer stops \(2 → 1\)/i);
  });

  it('names what was removed and what replaced it', () => {
    const swapped = {
      ...BASE,
      activities: [{...BASE.activities[0], name: 'Lekki Conservation Centre'}, BASE.activities[1]]
    };
    const changes = describeChanges(BASE, swapped as never).join(' ');

    expect(changes).toMatch(/removed jara beach/i);
    expect(changes).toMatch(/added lekki conservation centre/i);
  });

  it('reports a later start only when the first stop is the same one', () => {
    const later = {
      ...BASE,
      activities: [{...BASE.activities[0], startTime: '15:00'}, BASE.activities[1]]
    };
    expect(describeChanges(BASE, later as never).join(' ')).toMatch(/starts later \(13:00 → 15:00\)/i);

    // A different opening stop is a swap, not a shifted start.
    const swapped = {
      ...BASE,
      activities: [{...BASE.activities[0], name: 'Somewhere else', startTime: '15:00'}, BASE.activities[1]]
    };
    expect(describeChanges(BASE, swapped as never).join(' ')).not.toMatch(/starts later/i);
  });

  it('stays short enough to read at a glance', () => {
    expect(describeChanges(BASE, RELAXED).length).toBeLessThanOrEqual(5);
  });

  it('asks the model for nothing — the nudge names the failure precisely', () => {
    const nudge = buildUnchangedPrompt('Make it more relaxed');
    expect(nudge).toMatch(/identical to the previous one/i);
    expect(nudge).toMatch(/same times/i);
    expect(nudge).toMatch(/Make it more relaxed/);
  });
});

describe('reading a schedule', () => {
  it('parses times and rejects nonsense', () => {
    expect(minutesOf('13:00')).toBe(780);
    expect(minutesOf('09:30')).toBe(570);
    expect(minutesOf('25:00')).toBeNull();
    expect(minutesOf('nonsense')).toBeNull();
  });

  it('measures the gaps a relaxed day is supposed to open up', () => {
    // 13:00 + 2h -> 15:00, next starts 15:30, so a 30 minute gap.
    expect(shapeOf(BASE).gaps).toEqual([30]);
    // 13:00 + 3h -> 16:00, next starts 16:45, so 45 minutes.
    expect(shapeOf(RELAXED).gaps).toEqual([45]);
  });

  it('reads the shape in schedule order, not array order', () => {
    const reversed = {...BASE, activities: [BASE.activities[1], BASE.activities[0]]};
    expect(shapeOf(reversed as never).names).toEqual(['Jara Beach', 'Terra Kulture']);
  });
});

/**
 * The measured structured-output failure.
 *
 * Against the live model, 7 of 24 turns (29%) came back with
 * `finishReason: 'other'` and no object, having written the plan out as a
 * numbered list instead of emitting the schema. New plans never failed — only
 * turns modifying an existing plan did.
 *
 * Retrying alone took it to 11%: the failures cluster rather than occurring
 * independently, because every prose reply is stored in the conversation and
 * history accumulates evidence that prose is the expected shape. Restating the
 * output contract as the final line of the prompt, and keeping a bounded retry
 * behind it, measured 36 of 36 turns succeeding across two samples.
 */
describe('holding the model to the response contract', () => {
  const prompt = buildFollowUpPrompt('Make it more relaxed', BASE);

  it('ends by restating the output contract, after the planning guidance', () => {
    const formatLine = /reply with the itinerary response object itself/i;
    expect(prompt).toMatch(formatLine);

    // Position matters: it has to survive everything above it.
    const lines = prompt.trim().split('\n');
    expect(lines[lines.length - 1]).toMatch(formatLine);
  });

  it('names the prose shapes the model actually produced', () => {
    expect(prompt).toMatch(/numbered list/i);
    expect(prompt).toMatch(/prose/i);
  });

  it('applies to every modification axis, not just pacing', () => {
    for (const message of ['Start later', 'Give me fewer stops', 'Add lunch']) {
      expect(buildFollowUpPrompt(message, BASE)).toMatch(
        /reply with the itinerary response object itself/i
      );
    }
  });
});

describe('cost, which this dataset cannot answer', () => {
  it('tells the agent to say so rather than invent prices', () => {
    const prompt = buildFollowUpPrompt('Can you make it cheaper?', BASE);

    expect(prompt).toMatch(/no cost or price information/i);
    expect(prompt).toMatch(/do not guess prices/i);
    expect(prompt).toMatch(/cost preferences are not available/i);
  });

  it('still recognises the request rather than ignoring it', () => {
    expect(classifyRequest('Can you make it cheaper?', true)).toBe('follow_up_modification');
    expect(classifyRequest('Is there a cheaper option?', true)).toBe('follow_up_modification');
  });

  it('offers what can actually be changed instead', () => {
    expect(buildFollowUpPrompt('Make it cheaper', BASE)).toMatch(
      /the pace, the timing, or the kinds of activity/i
    );
  });
});

describe('classifying the cases that must not be confused', () => {
  it.each([
    ["What's the weather tomorrow?", 'question'],
    ['Would you recommend the beach?', 'question'],
    ['Where is Terra Kulture?', 'question'],
    ['Make the plan more relaxed.', 'follow_up_modification'],
    ['Can you add lunch?', 'follow_up_modification'],
    ['Actually, make it an evening plan.', 'follow_up_modification']
  ])('reads %j as %s', (message, expected) => {
    expect(classifyRequest(message, true)).toBe(expected);
  });
});

/**
 * Checking that the requested change actually happened.
 *
 * Observed live: "give me fewer stops" returned the same two stops with a
 * shorter first one. Something had changed, so the unchanged guard stayed
 * quiet, and a plan that ignored the request was presented as if it had carried
 * it out. Requests with a measurable direction are now checked against it.
 */
describe('did the named change happen', () => {
  const FEWER = {...BASE, activities: [BASE.activities[0]]} as never as typeof BASE;
  const SHORTER_ONLY = {
    ...BASE,
    activities: [{...BASE.activities[0], durationMinutes: 60}, BASE.activities[1]]
  } as never as typeof BASE;

  it('sees fewer stops when a stop was dropped', () => {
    expect(satisfiesRequest('Give me fewer stops', BASE, FEWER)).toBe('satisfied');
  });

  it('catches the live failure: a changed plan with the same number of stops', () => {
    expect(satisfiesRequest('Give me fewer stops', BASE, SHORTER_ONLY)).toBe('unsatisfied');
    // The unchanged guard alone would not have caught it.
    expect(materiallyIdentical(BASE, SHORTER_ONLY)).toBe(false);
  });

  it('does not demand a reduction that is impossible', () => {
    // One stop cannot become fewer without becoming no plan at all.
    expect(satisfiesRequest('Give me fewer stops', FEWER, FEWER)).toBeUndefined();
  });

  it('checks an added stop', () => {
    const more = {
      ...BASE,
      activities: [...BASE.activities, {...BASE.activities[0], order: 3, name: 'Dinner at Yellow Chilli'}]
    } as never as typeof BASE;

    expect(satisfiesRequest('Add lunch', BASE, more)).toBe('satisfied');
    expect(satisfiesRequest('Add lunch', BASE, BASE)).toBe('unsatisfied');
  });

  it('checks the direction of a start-time request', () => {
    const later = {
      ...BASE,
      activities: [{...BASE.activities[0], startTime: '15:00'}, BASE.activities[1]]
    } as never as typeof BASE;

    expect(satisfiesRequest('Start later', BASE, later)).toBe('satisfied');
    expect(satisfiesRequest('Start later', later, BASE)).toBe('unsatisfied');
    expect(satisfiesRequest('Start earlier', later, BASE)).toBe('satisfied');
  });

  it('stays out of the way for requests with no single measure', () => {
    // Inventing a metric for these would reject good plans.
    for (const message of [
      'Make it more relaxed',
      'Make it suitable for the rain',
      'Make it more outdoorsy',
      'Change the second activity'
    ]) {
      expect(satisfiesRequest(message, BASE, RELAXED), message).toBeUndefined();
    }
  });

  it('names the missed request when nudging', () => {
    const nudge = buildUnsatisfiedPrompt('Give me fewer stops');

    expect(nudge).toMatch(/does not carry out "Give me fewer stops"/i);
    expect(nudge).toMatch(/reply with the itinerary response object itself/i);
  });
});
