import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Mastra} from '@mastra/core/mastra';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  TEST_DOMAIN,
  TEST_AUDIENCE,
  mintToken,
  startTestTenant,
  stopTestTenant
} from './helpers/kinde-test-tenant.js';
import {authenticatedContext} from './helpers/authenticated-context.js';
import {scriptedModel, textStep, toolCallStep} from './helpers/scripted-model.js';

/**
 * Short follow-ups resolve against the conversation.
 *
 * The failure these guard was measured, not guessed. Against the live model,
 * three of ten short follow-ups came back with `finishReason: 'other'` and no
 * object, and every failing turn had produced prose ending in a question —
 * "Shall I prepare the detailed itinerary?", "Would you like me to provide the
 * detailed itinerary?". The agent was treating a modification request as a
 * proposal step instead of doing the work, so structured output had no object
 * to build. The fix is in the instructions, not the schema and not retries.
 *
 * A scripted model cannot prove the model's wording changed. What it does
 * prove, and what these tests assert, is the plumbing that has to be right for
 * the instruction fix to matter: the previous plan really is in the prompt on a
 * follow-up turn, it really is absent on a fresh thread, the envelope stays
 * valid, validation still runs, and a follow-up cannot save.
 */

const dbDir = mkdtempSync(join(tmpdir(), 'mastra-followup-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'followup.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {planTripWorkflow} = await import('../src/mastra/workflows/plan-trip.js');
const {createTripAgent, buildInstructions} = await import('../src/mastra/agents/trip-agent.js');
const {AgentResponseSchema} = await import('../src/mastra/schemas/agent-response.js');
const {storage} = await import('../src/mastra/storage.js');
const {auth} = await import('../src/mastra/index.js');
const {PERMISSIONS} = await import('../src/mastra/lib/kinde.js');

const ORG = 'org_followup';
let realMastra: Awaited<typeof import('../src/mastra/index.js')>['mastra'];

beforeAll(async () => {
  await startTestTenant();
  ({mastra: realMastra} = await import('../src/mastra/index.js'));
});

afterAll(() => {
  stopTestTenant();
  rmSync(dbDir, {recursive: true, force: true});
});

async function contextFor(sub: string, permissions = [PERMISSIONS.readItinerary, PERMISSIONS.createItinerary]) {
  const token = await mintToken({orgCode: ORG, sub, permissions});
  const {requestContext} = await authenticatedContext(realMastra, token);
  return requestContext;
}

const FIRST_PLAN = {
  destination: 'Lagos',
  date: '2026-08-22',
  summary: 'A full afternoon in Lagos.',
  weather: {
    summary: 'Moderate drizzle',
    highCelsius: 27.2,
    lowCelsius: 24.8,
    precipitationChance: 40,
    considerations: []
  },
  activities: [
    {
      order: 1,
      name: 'Nike Art Gallery',
      category: 'culture',
      startTime: '13:00',
      durationMinutes: 90,
      location: 'Lagos',
      description: 'Browse five floors of Nigerian art.',
      weatherDependent: false
    },
    {
      order: 2,
      name: 'Terra Kulture arts centre',
      category: 'culture',
      startTime: '15:00',
      durationMinutes: 60,
      location: 'Lagos',
      description: 'Bookshop, gallery and theatre under one roof.',
      weatherDependent: false
    }
  ],
  notes: []
};

/** The same plan, relaxed: one stop removed and a later start. */
const RELAXED_PLAN = {
  ...FIRST_PLAN,
  summary: 'A relaxed afternoon in Lagos with a single stop.',
  activities: [{...FIRST_PLAN.activities[0], startTime: '15:00'}]
};

/** A revision that breaks the requested afternoon window. */
const TOO_EARLY_PLAN = {
  ...FIRST_PLAN,
  summary: 'A morning start.',
  activities: [{...FIRST_PLAN.activities[0], startTime: '07:00'}]
};

const envelope = (payload: unknown) => textStep(JSON.stringify(payload));

function harness(steps: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(steps);
  const mastra = new Mastra({
    storage,
    agents: {tripAgent: createTripAgent({model})},
    workflows: {planTripWorkflow},
    server: {auth},
    logger: false
  });
  return {model, mastra};
}

async function runWorkflow(
  steps: Parameters<typeof scriptedModel>[0],
  message: string,
  requestContext: Awaited<ReturnType<typeof contextFor>>,
  threadId: string
) {
  const {model, mastra} = harness(steps);
  const run = await mastra.getWorkflow('planTripWorkflow').createRun();
  const result = await run.start({inputData: {message, threadId}, requestContext});
  return {model, result};
}

function outputOf(result: unknown) {
  const value = result as {status?: string; result?: unknown; error?: unknown};
  if (value.status !== 'success') {
    throw new Error(`workflow ${value.status}: ${JSON.stringify(value.error ?? {})}`);
  }
  return value.result as {kind: string; itinerary?: typeof FIRST_PLAN};
}

/** Everything the scripted model was sent, as one searchable string. */
function promptText(model: {scriptedCalls: {prompt: unknown}[]}, turn = 0): string {
  return JSON.stringify(model.scriptedCalls[turn]?.prompt ?? '');
}

const PLAN_REQUEST = 'Plan me an afternoon in Lagos tomorrow.';

describe('the agent is told how to handle follow-ups', () => {
  const instructions = buildInstructions();

  it('tells the agent a short request refers to the plan already in the conversation', () => {
    expect(instructions).toMatch(/make it more relaxed/i);
    expect(instructions).toMatch(/refers to the plan already in this conversation/i);
  });

  it('forbids asking permission to produce a plan it can already build', () => {
    // This is the exact behaviour that produced `finishReason: 'other'`.
    expect(instructions).toMatch(/shall i prepare the itinerary/i);
    expect(instructions).toMatch(/never ask the user to repeat the destination/i);
  });

  it('tells the agent to return the whole revised plan, not a diff', () => {
    expect(instructions).toMatch(/repeat every activity that is staying/i);
  });

  it('still forbids inventing context that was never discussed', () => {
    expect(instructions).toMatch(/never invent a destination, a date or a plan/i);
  });
});

describe('a short follow-up on an existing thread', () => {
  it('carries the previous plan into the follow-up prompt', async () => {
    const context = await contextFor('kp:carry');
    const thread = 'thread-carry';

    await runWorkflow(
      [
        toolCallStep('get-weather', {location: 'Lagos', date: '2026-08-22'}),
        toolCallStep('find-activities', {location: 'Lagos', date: '2026-08-22'}),
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN}),
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN})
      ],
      PLAN_REQUEST,
      context,
      thread
    );

    const {model} = await runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN})
      ],
      'Make it more relaxed.',
      context,
      thread
    );

    // The previous itinerary is genuinely available to the model, so it never
    // needs the user to restate the destination, the date or the plan.
    const prompt = promptText(model);
    expect(prompt).toContain('Nike Art Gallery');
    expect(prompt).toContain('Lagos');
    expect(prompt).toContain('Make it more relaxed.');
  });

  it('modifies the existing itinerary and returns the whole plan', async () => {
    const context = await contextFor('kp:modify');
    const thread = 'thread-modify';

    await runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN}),
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN})
      ],
      PLAN_REQUEST,
      context,
      thread
    );

    const {result} = await runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN})
      ],
      'Make it more relaxed.',
      context,
      thread
    );

    const output = outputOf(result);
    expect(output.kind).toBe('itinerary');
    expect(output.itinerary?.activities).toHaveLength(1);
    expect(output.itinerary?.activities[0].startTime).toBe('15:00');
    // Still the same trip — the follow-up revised it rather than starting over.
    expect(output.itinerary?.destination).toBe('Lagos');
  });

  it('returns a valid AgentResponse envelope', async () => {
    const context = await contextFor('kp:envelope');
    const thread = 'thread-envelope';

    await runWorkflow(
      [envelope({kind: 'itinerary', itinerary: FIRST_PLAN}), envelope({kind: 'itinerary', itinerary: FIRST_PLAN})],
      PLAN_REQUEST,
      context,
      thread
    );

    const {result} = await runWorkflow(
      [envelope({kind: 'itinerary', itinerary: RELAXED_PLAN}), envelope({kind: 'itinerary', itinerary: RELAXED_PLAN})],
      'Start later.',
      context,
      thread
    );

    expect(() => AgentResponseSchema.parse(outputOf(result))).not.toThrow();
  });

  it('still validates the revised plan', async () => {
    const context = await contextFor('kp:validate');
    const thread = 'thread-validate';

    await runWorkflow(
      [envelope({kind: 'itinerary', itinerary: FIRST_PLAN}), envelope({kind: 'itinerary', itinerary: FIRST_PLAN})],
      PLAN_REQUEST,
      context,
      thread
    );

    // Every turn returns a plan that starts at 07:00, which the afternoon
    // request forbids. Resolving follow-ups must not become a way around the
    // validator, so this run has to fail rather than return the bad plan.
    const {result} = await runWorkflow(
      Array.from({length: 6}, () => envelope({kind: 'itinerary', itinerary: TOO_EARLY_PLAN})),
      'Start earlier, I want the afternoon plan moved.',
      context,
      thread
    );

    expect((result as {status?: string}).status).not.toBe('success');
  });

  it('does not save just because the plan was revised', async () => {
    const context = await contextFor('kp:nosave');
    const thread = 'thread-nosave';

    await runWorkflow(
      [envelope({kind: 'itinerary', itinerary: FIRST_PLAN}), envelope({kind: 'itinerary', itinerary: FIRST_PLAN})],
      PLAN_REQUEST,
      context,
      thread
    );

    // The model tries to save unprompted, exactly as the live agent did.
    const {model, result} = await runWorkflow(
      [
        toolCallStep('save-itinerary', {itinerary: RELAXED_PLAN}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN})
      ],
      'Make it more relaxed.',
      context,
      thread
    );

    expect(outputOf(result).kind).toBe('itinerary');
    // The refusal, not a save, is what came back from the tool.
    const afterTool = promptText(model, 1);
    expect(afterTool).toContain('not_requested');
    expect(afterTool).not.toContain('"saved":true');
  });
});

describe('a short request on a thread with no plan', () => {
  it('has no itinerary in context to copy', async () => {
    const context = await contextFor('kp:empty');

    const {model, result} = await runWorkflow(
      [
        envelope({
          kind: 'message',
          message: 'Which day and destination should I plan?',
          permissionDenied: false,
          requiredPermission: null
        }),
        envelope({
          kind: 'message',
          message: 'Which day and destination should I plan?',
          permissionDenied: false,
          requiredPermission: null
        })
      ],
      'Make it more relaxed.',
      context,
      'thread-empty'
    );

    // Nothing to resolve against: the model is not handed a prior plan, so a
    // plan in the reply could only have been invented.
    const prompt = promptText(model);
    expect(prompt).not.toContain('Nike Art Gallery');
    expect(prompt).not.toContain('Freedom Park');

    const output = outputOf(result);
    expect(output.kind).toBe('message');
    expect(output.itinerary).toBeUndefined();
  });

  it('asks for what is missing rather than inventing a destination', async () => {
    const context = await contextFor('kp:ask');

    const {result} = await runWorkflow(
      [
        envelope({
          kind: 'message',
          message: 'I do not have a plan yet — where and when would you like to go?',
          permissionDenied: false,
          requiredPermission: null
        }),
        envelope({
          kind: 'message',
          message: 'I do not have a plan yet — where and when would you like to go?',
          permissionDenied: false,
          requiredPermission: null
        })
      ],
      'Remove the second stop.',
      context,
      'thread-ask'
    );

    const output = outputOf(result) as {kind: string; message?: string};
    expect(output.kind).toBe('message');
    expect(output.message).toMatch(/where and when/i);
  });
});

/**
 * The measured failure: a follow-up that changed nothing.
 *
 * "Make it more relaxed" produced a valid itinerary with the same stops, at the
 * same times, for the same durations. The run reported success. These drive the
 * whole workflow with a scripted model to prove the guard now catches it, that
 * the previous plan reaches the model as data, and that none of it bypasses the
 * validator.
 */
describe('a follow-up that does not change the plan', () => {
  /** The same schedule the previous turn produced, with different prose. */
  const REWORDED = {...FIRST_PLAN, summary: 'A wonderfully relaxed afternoon in Lagos.'};

  async function seedPlan(context: Awaited<ReturnType<typeof contextFor>>, thread: string) {
    return runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN}),
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN})
      ],
      'Plan me an afternoon in Lagos tomorrow.',
      context,
      thread
    );
  }

  it('hands the previous plan to the model as structured data', async () => {
    const context = await contextFor('kp:handover');
    const thread = 'thread-handover';
    await seedPlan(context, thread);

    const {model} = await runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN})
      ],
      'Make it more relaxed',
      context,
      thread
    );

    const prompt = promptText(model);
    // Not merely present in history: named as the plan being edited.
    expect(prompt).toContain('You are modifying an existing itinerary');
    expect(prompt).toContain('Nike Art Gallery');
    expect(prompt).toContain('13:00');
    expect(prompt).toMatch(/fewer stops, longer stays/i);
  });

  it('fails rather than claiming a change it did not make', async () => {
    const context = await contextFor('kp:unchanged');
    const thread = 'thread-unchanged';
    await seedPlan(context, thread);

    // Every turn returns the same schedule, only reworded.
    const {result} = await runWorkflow(
      Array.from({length: 6}, () => envelope({kind: 'itinerary', itinerary: REWORDED})),
      'Make it more relaxed',
      context,
      thread
    );

    expect((result as {status?: string}).status).not.toBe('success');
    expect(JSON.stringify((result as {error?: unknown}).error ?? {})).toMatch(
      /could not change the plan/i
    );
  });

  it('accepts a genuine change on the second attempt', async () => {
    const context = await contextFor('kp:secondtry');
    const thread = 'thread-secondtry';
    await seedPlan(context, thread);

    // Identical first, then a real revision — one nudge, never a loop.
    const {result} = await runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: REWORDED}),
        envelope({kind: 'itinerary', itinerary: REWORDED}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN}),
        envelope({kind: 'itinerary', itinerary: RELAXED_PLAN})
      ],
      'Make it more relaxed',
      context,
      thread
    );

    const output = outputOf(result);
    expect(output.kind).toBe('itinerary');
    expect(output.itinerary?.activities).toHaveLength(1);
  });

  it('nudges only once, so an unchanged plan cannot loop', async () => {
    const context = await contextFor('kp:noloop');
    const thread = 'thread-noloop';
    await seedPlan(context, thread);

    const {model} = await runWorkflow(
      Array.from({length: 8}, () => envelope({kind: 'itinerary', itinerary: REWORDED})),
      'Make it more relaxed',
      context,
      thread
    );

    const nudges = model.scriptedCalls.filter(call =>
      JSON.stringify(call.prompt).includes('identical to the previous one')
    );
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges.length).toBeLessThanOrEqual(2);
  });

  it('still validates the revised plan', async () => {
    const context = await contextFor('kp:followupvalid');
    const thread = 'thread-followupvalid';
    await runWorkflow(
      [
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN}),
        envelope({kind: 'itinerary', itinerary: FIRST_PLAN})
      ],
      'Plan me an afternoon in Lagos tomorrow.',
      context,
      thread
    );

    // A revision that breaks the requested window must not slip through just
    // because it is different from the plan before it.
    const {result} = await runWorkflow(
      Array.from({length: 8}, () => envelope({kind: 'itinerary', itinerary: TOO_EARLY_PLAN})),
      'Make it more relaxed, and keep it in the afternoon',
      context,
      thread
    );

    expect((result as {status?: string}).status).not.toBe('success');
  });

  it('does not rewrite the plan when the traveller asked a question', async () => {
    const context = await contextFor('kp:question');
    const thread = 'thread-question';
    await seedPlan(context, thread);

    const {model, result} = await runWorkflow(
      [
        envelope({
          kind: 'message',
          message: 'It is light rain showers, with a 40% chance of rain.',
          permissionDenied: false,
          requiredPermission: null
        }),
        envelope({
          kind: 'message',
          message: 'It is light rain showers, with a 40% chance of rain.',
          permissionDenied: false,
          requiredPermission: null
        })
      ],
      "What's the weather like?",
      context,
      thread
    );

    // A question is answered, not treated as an edit.
    expect(promptText(model)).not.toContain('You are modifying an existing itinerary');
    expect(outputOf(result).kind).toBe('message');
  });
});
