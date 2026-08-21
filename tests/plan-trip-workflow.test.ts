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

const dbDir = mkdtempSync(join(tmpdir(), 'mastra-workflow-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'workflow.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {planTripWorkflow, PlanTripInputSchema} = await import(
  '../src/mastra/workflows/plan-trip.js'
);
const {createTripAgent} = await import('../src/mastra/agents/trip-agent.js');
const {AgentResponseSchema} = await import('../src/mastra/schemas/agent-response.js');
const {ItinerarySchema} = await import('../src/mastra/schemas/itinerary.js');
const {storage} = await import('../src/mastra/storage.js');
const {auth} = await import('../src/mastra/index.js');
const {PERMISSIONS} = await import('../src/mastra/lib/kinde.js');
const {saveItinerary} = await import('../src/mastra/tools/save-itinerary.js');

const READ = PERMISSIONS.readItinerary;
const CREATE = PERMISSIONS.createItinerary;
const ORG = 'org_alpha';

let realMastra: Awaited<typeof import('../src/mastra/index.js')>['mastra'];

beforeAll(async () => {
  await startTestTenant();
  ({mastra: realMastra} = await import('../src/mastra/index.js'));
});

afterAll(() => {
  stopTestTenant();
  rmSync(dbDir, {recursive: true, force: true});
});

/**
 * A Mastra instance wired exactly like the real one, except the agent's model
 * is scripted. The agent itself is the real `createTripAgent` — real
 * instructions, real tools, real memory — so the workflow exercises the
 * genuine path without needing an API key.
 */
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

async function contextFor(claims: {sub: string; permissions?: string[]}) {
  const token = await mintToken({orgCode: ORG, ...claims});
  const {requestContext} = await authenticatedContext(realMastra, token);
  return requestContext;
}

const ITINERARY = {
  destination: 'Lagos',
  date: '2026-08-22',
  summary: 'An easy afternoon built around the forecast.',
  weather: {
    summary: 'Moderate drizzle',
    highCelsius: 27.2,
    lowCelsius: 24.8,
    precipitationChance: 100,
    considerations: ['Indoor stop scheduled for the wettest hours']
  },
  activities: [
    {
      order: 1,
      name: 'Nike Art Gallery',
      category: 'culture',
      startTime: '14:00',
      durationMinutes: 90,
      location: 'Lekki, Lagos',
      description: 'Browse five floors of Nigerian art.',
      weatherDependent: false
    }
  ],
  notes: ['Carry a light rain jacket']
};

const envelope = (payload: unknown) => textStep(JSON.stringify(payload));

let threadCounter = 0;

/** Start the workflow the way a server route would. */
async function runWorkflow(
  steps: Parameters<typeof scriptedModel>[0],
  message: string,
  requestContext: Awaited<ReturnType<typeof contextFor>>,
  threadId?: string
) {
  const {model, mastra} = harness(steps);
  threadCounter += 1;

  const run = await mastra.getWorkflow('planTripWorkflow').createRun();
  const result = await run.start({
    inputData: {message, threadId: threadId ?? `wf-thread-${threadCounter}`},
    requestContext
  });

  return {model, result, mastra};
}

/** The workflow's returned AgentResponse, whatever the run wrapper shape. */
function outputOf(result: {status?: string; result?: unknown}) {
  return result.result as Record<string, unknown> | undefined;
}

describe('registration and input', () => {
  it('is registered with the Mastra instance', () => {
    const workflow = realMastra.getWorkflow('planTripWorkflow');
    expect(workflow).toBeDefined();
    expect(workflow.id).toBe('plan-trip');
  });

  it('accepts a valid message and threadId', () => {
    const parsed = PlanTripInputSchema.safeParse({
      message: 'Plan me an afternoon in Lagos tomorrow.',
      threadId: 'thread-1'
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects empty input', () => {
    expect(PlanTripInputSchema.safeParse({message: '   ', threadId: 't'}).success).toBe(false);
    expect(PlanTripInputSchema.safeParse({message: 'hi', threadId: ''}).success).toBe(false);
  });

  it('has no identity fields in its input contract', () => {
    const parsed = PlanTripInputSchema.parse({
      message: 'hi',
      threadId: 't',
      sub: 'kp:attacker',
      orgCode: 'org_evil',
      resourceId: 'org_evil:kp:attacker',
      permissions: [CREATE]
    } as never);

    expect(parsed).toEqual({message: 'hi', threadId: 't'});
    expect(parsed).not.toHaveProperty('sub');
    expect(parsed).not.toHaveProperty('orgCode');
    expect(parsed).not.toHaveProperty('resourceId');
    expect(parsed).not.toHaveProperty('permissions');
  });
});

describe('response pass-through', () => {
  it('returns an itinerary response unchanged', async () => {
    const context = await contextFor({sub: 'kp:planner', permissions: [READ]});
    const {result} = await runWorkflow(
      [envelope({kind: 'itinerary', itinerary: ITINERARY}), envelope({kind: 'itinerary', itinerary: ITINERARY})],
      'Plan me an afternoon in Lagos tomorrow.',
      context
    );

    const output = outputOf(result);
    expect(AgentResponseSchema.safeParse(output).success).toBe(true);
    expect(output?.kind).toBe('itinerary');
    expect(ItinerarySchema.safeParse(output?.itinerary).success).toBe(true);
    expect((output?.itinerary as {destination: string}).destination).toBe('Lagos');
  });

  it('returns a saved-list response unchanged', async () => {
    const context = await contextFor({sub: 'kp:wf_saved', permissions: [READ, CREATE]});
    const saved = await saveItinerary({itinerary: ITINERARY} as never, {requestContext: context});

    const record = {
      id: saved.itineraryId,
      itinerary: ITINERARY,
      sub: 'kp:wf_saved',
      orgCode: ORG,
      resourceId: `${ORG}:kp:wf_saved`,
      createdAt: saved.savedAt,
      updatedAt: saved.savedAt
    };

    const {result} = await runWorkflow(
      [
        toolCallStep('list-itineraries', {limit: 10}),
        textStep('Here is what you saved.'),
        envelope({kind: 'saved-list', itineraries: [record]})
      ],
      'Show me my saved itineraries.',
      context
    );

    const output = outputOf(result);
    expect(AgentResponseSchema.safeParse(output).success).toBe(true);
    expect(output?.kind).toBe('saved-list');
    expect((output?.itineraries as {id: string}[])[0]?.id).toBe(saved.itineraryId);
  });

  it('returns a message response unchanged', async () => {
    const context = await contextFor({sub: 'kp:chatter', permissions: [READ]});
    const {result} = await runWorkflow(
      [
        envelope({kind: 'message', message: 'I plan single days out.'}),
        envelope({kind: 'message', message: 'I plan single days out.'})
      ],
      'What can you do?',
      context
    );

    const output = outputOf(result);
    expect(AgentResponseSchema.safeParse(output).success).toBe(true);
    expect(output?.kind).toBe('message');
    expect(output?.message).toBe('I plan single days out.');
  });
});

describe('the workflow invokes the real agent and its tools', () => {
  it('runs the agent, so its instructions and tools are in play', async () => {
    const context = await contextFor({sub: 'kp:realagent', permissions: [READ]});
    const {model} = await runWorkflow(
      [envelope({kind: 'message', message: 'ok'}), envelope({kind: 'message', message: 'ok'})],
      'Hello.',
      context
    );

    const firstTurn = model.scriptedCalls[0];
    // The agent's own system prompt and its four tools reached the model.
    expect(JSON.stringify(firstTurn?.prompt)).toContain('day-trip planner');
    // Four agent tools plus updateWorkingMemory, which Mastra adds when memory
    // is active — so this also proves working memory survived the workflow hop.
    expect(firstTurn?.tools.map(t => t.name).sort()).toEqual([
      'find-activities',
      'get-weather',
      'list-itineraries',
      'save-itinerary',
      'updateWorkingMemory'
    ]);
  });

  it('carries a permission denial through from the real tool', async () => {
    const context = await contextFor({sub: 'kp:wf_denied', permissions: [READ]});
    const {model, result} = await runWorkflow(
      [
        toolCallStep('save-itinerary', {itinerary: ITINERARY}),
        textStep('Denied.'),
        envelope({kind: 'message', message: `You need "${CREATE}" to save itineraries.`})
      ],
      'Save this itinerary.',
      context
    );

    // The real save-itinerary tool ran and refused.
    const seen = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(seen).toContain('permission_denied');
    expect(seen).not.toContain('"saved":true');

    const output = outputOf(result);
    expect(output?.kind).toBe('message');
    expect(output?.message).toContain(CREATE);
  });
});

describe('authenticated context and memory identity', () => {
  it('passes the authenticated request context through to the agent', async () => {
    const context = await contextFor({sub: 'kp:ctx_user', permissions: [READ, CREATE]});

    // save-itinerary can only succeed if the verified identity survived the hop
    // from run.start() into the agent's tool execution.
    const {model} = await runWorkflow(
      [
        toolCallStep('save-itinerary', {itinerary: ITINERARY}),
        textStep('Saved.'),
        envelope({kind: 'message', message: 'Saved.'})
      ],
      'Save this itinerary.',
      context
    );

    const seen = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(seen).toContain('"saved":true');
    expect(seen).toContain(`"orgCode":"${ORG}"`);
  });

  it('derives the memory resource from Kinde auth, not from workflow input', async () => {
    const context = await contextFor({sub: 'kp:thread_user', permissions: [READ]});
    const threadId = 'wf-explicit-thread';

    await runWorkflow(
      [envelope({kind: 'message', message: 'Noted.'}), envelope({kind: 'message', message: 'Noted.'})],
      'I am vegetarian.',
      context,
      threadId
    );

    const {tripMemory} = await import('../src/mastra/memory.js');
    const thread = await tripMemory.getThreadById({threadId});

    // The caller chose the thread; the resource came from the token.
    expect(thread?.id).toBe(threadId);
    expect(thread?.resourceId).toBe(`${ORG}:kp:thread_user`);
  });

  it('keeps two users on separate memory resources for the same workflow', async () => {
    const alice = await contextFor({sub: 'kp:wf_alice', permissions: [READ]});
    const bob = await contextFor({sub: 'kp:wf_bob', permissions: [READ]});

    await runWorkflow(
      [envelope({kind: 'message', message: 'ok'}), envelope({kind: 'message', message: 'ok'})],
      'hi',
      alice,
      'wf-alice-thread'
    );
    await runWorkflow(
      [envelope({kind: 'message', message: 'ok'}), envelope({kind: 'message', message: 'ok'})],
      'hi',
      bob,
      'wf-bob-thread'
    );

    const {tripMemory} = await import('../src/mastra/memory.js');
    const aliceThread = await tripMemory.getThreadById({threadId: 'wf-alice-thread'});
    const bobThread = await tripMemory.getThreadById({threadId: 'wf-bob-thread'});

    expect(aliceThread?.resourceId).toBe(`${ORG}:kp:wf_alice`);
    expect(bobThread?.resourceId).toBe(`${ORG}:kp:wf_bob`);
    expect(aliceThread?.resourceId).not.toBe(bobThread?.resourceId);
  });
});
