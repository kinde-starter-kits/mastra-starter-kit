import {describe, it, expect, beforeAll, afterAll} from 'vitest';
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

// Real database, real auth pipeline, real tools. Only the model is scripted.
const dbDir = mkdtempSync(join(tmpdir(), 'mastra-agent-persist-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'agent.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {createTripAgent} = await import('../src/mastra/agents/trip-agent.js');
const {PERMISSIONS} = await import('../src/mastra/lib/kinde.js');
const {saveItinerary} = await import('../src/mastra/tools/save-itinerary.js');

const READ = PERMISSIONS.readItinerary;
const CREATE = PERMISSIONS.createItinerary;
const ORG = 'org_alpha';

let mastra: Awaited<typeof import('../src/mastra/index.js')>['mastra'];

beforeAll(async () => {
  await startTestTenant();
  ({mastra} = await import('../src/mastra/index.js'));
});

afterAll(() => {
  stopTestTenant();
  rmSync(dbDir, {recursive: true, force: true});
});

async function contextFor(claims: {sub: string; orgCode?: string; permissions?: string[]}) {
  const token = await mintToken({orgCode: ORG, ...claims});
  const {requestContext} = await authenticatedContext(mastra, token);
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

/** Run the agent through one tool call, then a reply. */
let threadCounter = 0;

async function runWithTool(
  requestContext: Awaited<ReturnType<typeof contextFor>>,
  toolName: string,
  args: unknown,
  reply: string,
  prompt: string
) {
  const model = scriptedModel([
    toolCallStep(toolName, args),
    textStep(reply),
    textStep(JSON.stringify({kind: 'message', message: reply}))
  ]);
  const agent = createTripAgent({model});

  // With memory attached, a thread is required. The *resource* is not passed:
  // Mastra derives it from the authenticated request context via
  // mapUserToResourceId, which is exactly the property we want exercised.
  threadCounter += 1;
  const result = await agent.generate(prompt, {
    requestContext,
    memory: {thread: `thread-${threadCounter}`}
  } as never);

  return {model, result};
}

/** What the model saw on the turn after the tool ran. */
function promptAfterToolCall(model: {doGenerateCalls: {prompt?: unknown}[]}) {
  return JSON.stringify(model.doGenerateCalls[1]?.prompt ?? '');
}

describe('agent exposes the persistence tools', () => {
  it('offers save-itinerary and list-itineraries to the model', async () => {
    const context = await contextFor({sub: 'kp:offer', permissions: [READ, CREATE]});
    const {model} = await runWithTool(
      context,
      'list-itineraries',
      {limit: 10},
      'You have none yet.',
      'Show me my saved itineraries.'
    );

    const offered = (model.doGenerateCalls[0]?.tools ?? []).map((t: {name: string}) => t.name);
    expect(offered).toContain('save-itinerary');
    expect(offered).toContain('list-itineraries');
  });
});

describe('save through the agent', () => {
  it('reaches the model as a success when the user has create:itinerary', async () => {
    const context = await contextFor({sub: 'kp:saver', permissions: [READ, CREATE]});

    const {model, result} = await runWithTool(
      context,
      'save-itinerary',
      {itinerary: ITINERARY},
      'Saved your afternoon in Lagos.',
      'Save this itinerary.'
    );

    const toolResult = (result.toolResults ?? []).find(
      entry => entry.payload.toolName === 'save-itinerary'
    );
    expect(toolResult?.payload.result).toMatchObject({saved: true, reason: 'saved'});

    // The success, including the new id, is what the model sees next.
    expect(promptAfterToolCall(model)).toContain('"saved":true');
  });

  it('reaches the model as a refusal when the user lacks create:itinerary', async () => {
    const context = await contextFor({sub: 'kp:reader', permissions: [READ]});

    const {model, result} = await runWithTool(
      context,
      'save-itinerary',
      {itinerary: ITINERARY},
      'You do not have permission to save itineraries.',
      'Save this itinerary.'
    );

    const toolResult = (result.toolResults ?? []).find(
      entry => entry.payload.toolName === 'save-itinerary'
    );
    expect(toolResult?.payload.result).toMatchObject({
      saved: false,
      reason: 'permission_denied',
      requiredPermission: CREATE
    });

    const seen = promptAfterToolCall(model);
    expect(seen).toContain('"saved":false');
    expect(seen).toContain('permission_denied');
    expect(seen).toContain(CREATE);
  });

  it('does not persist anything when the save was denied', async () => {
    const denied = await contextFor({sub: 'kp:denied', permissions: [READ]});

    await runWithTool(
      denied,
      'save-itinerary',
      {itinerary: ITINERARY},
      'You lack permission.',
      'Save this itinerary.'
    );

    // Read back with a permitted context for the same identity.
    const reader = await contextFor({sub: 'kp:denied', permissions: [READ]});
    const {listItineraries} = await import('../src/mastra/tools/list-itineraries.js');
    const listed = await listItineraries({limit: 50} as never, {requestContext: reader});

    expect(listed.count).toBe(0);
  });

  it('gives the model no success signal it could mistake for a save', async () => {
    const context = await contextFor({sub: 'kp:nofalse', permissions: [READ]});
    const {model} = await runWithTool(
      context,
      'save-itinerary',
      {itinerary: ITINERARY},
      'Denied.',
      'Save this itinerary.'
    );

    const seen = promptAfterToolCall(model);
    expect(seen).not.toContain('"saved":true');
    expect(seen).toContain('"itineraryId":null');
  });
});

describe('list through the agent', () => {
  it('returns the user\'s own saved itineraries to the model', async () => {
    const context = await contextFor({sub: 'kp:lister', permissions: [READ, CREATE]});

    const saved = await saveItinerary({itinerary: ITINERARY} as never, {requestContext: context});
    expect(saved.saved).toBe(true);

    const {model, result} = await runWithTool(
      context,
      'list-itineraries',
      {limit: 10},
      'Here is your saved plan.',
      'Show me my saved itineraries.'
    );

    const toolResult = (result.toolResults ?? []).find(
      entry => entry.payload.toolName === 'list-itineraries'
    );
    expect(toolResult?.payload.result).toMatchObject({authorized: true, reason: 'ok'});

    const seen = promptAfterToolCall(model);
    expect(seen).toContain(saved.itineraryId!);
    expect(seen).toContain('Nike Art Gallery');
  });

  it('reaches the model as a refusal when the user lacks read:itinerary', async () => {
    const context = await contextFor({sub: 'kp:noread', permissions: [CREATE]});

    const {model, result} = await runWithTool(
      context,
      'list-itineraries',
      {limit: 10},
      'You do not have permission to view saved itineraries.',
      'Show me my saved itineraries.'
    );

    const toolResult = (result.toolResults ?? []).find(
      entry => entry.payload.toolName === 'list-itineraries'
    );
    expect(toolResult?.payload.result).toMatchObject({
      authorized: false,
      reason: 'permission_denied',
      requiredPermission: READ
    });

    const seen = promptAfterToolCall(model);
    expect(seen).toContain('"authorized":false');
    // No records leak through the refusal, so nothing can be paraphrased.
    expect(seen).toContain('"itineraries":[]');
  });

  it('does not leak another user\'s itineraries through the agent', async () => {
    const owner = await contextFor({sub: 'kp:owner', permissions: [READ, CREATE]});
    const other = await contextFor({sub: 'kp:other', permissions: [READ, CREATE]});

    const ownerSaved = await saveItinerary({itinerary: ITINERARY} as never, {
      requestContext: owner
    });

    const {model} = await runWithTool(
      other,
      'list-itineraries',
      {limit: 50},
      'You have none.',
      'Show me my saved itineraries.'
    );

    expect(promptAfterToolCall(model)).not.toContain(ownerSaved.itineraryId!);
  });
});

describe('agent instructions cover the persistence rules', () => {
  it('tells the agent not to auto-save and not to invent saved plans', async () => {
    const agent = createTripAgent({model: scriptedModel([textStep('ok')])});
    const text = JSON.stringify(await agent.getInstructions());

    expect(text).toContain('save-itinerary');
    expect(text).toContain('list-itineraries');
    expect(text).toMatch(/never invent a saved itinerary/i);
    expect(text).toMatch(/Planning never saves/i);
    expect(text).toMatch(/never say an itinerary was saved unless the tool reported success/i);
  });
});
