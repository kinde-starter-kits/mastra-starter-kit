import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {Mastra} from '@mastra/core/mastra';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  TEST_DOMAIN, TEST_AUDIENCE, mintToken, startTestTenant, stopTestTenant
} from './helpers/kinde-test-tenant.js';
import {authenticatedContext} from './helpers/authenticated-context.js';
import {scriptedModel, textStep, toolCallStep} from './helpers/scripted-model.js';
import {
  LAGOS_GEOCODING, forecast, installFetchMock, isGeocoding, json, restoreFetch
} from './helpers/open-meteo-mock.js';

const dbDir = mkdtempSync(join(tmpdir(), 'stream-'));
process.env.DATABASE_URL = `file:${join(dbDir, 's.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {planTripWorkflow} = await import('../src/mastra/workflows/plan-trip.js');
const {createTripAgent} = await import('../src/mastra/agents/trip-agent.js');
const {storage} = await import('../src/mastra/storage.js');
const {auth} = await import('../src/mastra/index.js');
const {asPlanEvent} = await import('../src/mastra/telemetry/plan-events.js');
const {runWithRequestModelKey} = await import('../src/mastra/lib/model-key.js');

const DATE = '2026-08-22';
const REQUEST = "Plan me an afternoon in Lagos tomorrow. I don't want anything too early.";

const VALID = {
  destination: 'Lagos', date: DATE, summary: 'An afternoon in Lagos.',
  weather: {summary: 'Light rain', highCelsius: 27, lowCelsius: 25, precipitationChance: 20, considerations: []},
  activities: [{
    order: 1, name: 'Nike Art Gallery', category: 'culture', startTime: '14:00',
    durationMinutes: 90, location: 'Lekki, Lagos',
    description: 'Five floors of Nigerian art.', weatherDependent: false
  }],
  notes: []
};

const INVALID = {
  ...VALID,
  activities: [{
    order: 1, name: 'Ndubuisi Kanu Park morning run', category: 'outdoor', startTime: '06:00',
    durationMinutes: 60, location: 'Lagos',
    description: 'A looped tarmac path.', weatherDependent: true
  }]
};

let realMastra: Awaited<typeof import('../src/mastra/index.js')>['mastra'];

beforeAll(async () => {
  await startTestTenant();
  ({mastra: realMastra} = await import('../src/mastra/index.js'));
});

afterAll(() => {
  stopTestTenant();
  restoreFetch();
  rmSync(dbDir, {recursive: true, force: true});
});

function mockWeather() {
  // Stub Open-Meteo only. Everything else — notably the JWKS the test tenant
  // serves — must still reach the fetch already in place, or token
  // verification fails and the request context arrives empty.
  const previousFetch = globalThis.fetch;
  installFetchMock(url => {
    if (isGeocoding(url)) return json(LAGOS_GEOCODING);
    if (url.startsWith('https://api.open-meteo.com/')) return json(forecast(DATE));
    return previousFetch(url);
  });
}

const envelope = (payload: unknown) => textStep(JSON.stringify(payload));

/** Run the workflow through its stream and collect our telemetry events. */
async function streamRun(steps: Parameters<typeof scriptedModel>[0], message = REQUEST) {
  const model = scriptedModel(steps);
  const mastra = new Mastra({
    storage,
    agents: {tripAgent: createTripAgent({model})},
    workflows: {planTripWorkflow},
    server: {auth},
    logger: false
  });

  const token = await mintToken({sub: 'kp:stream', orgCode: 'org_alpha', permissions: ['read:itinerary']});
  const {requestContext} = await authenticatedContext(realMastra, token);

  const run = await mastra.getWorkflow('planTripWorkflow').createRun();
  const stream = await run.stream({
    inputData: {message, threadId: `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`},
    requestContext
  } as never);

  const events: ReturnType<typeof asPlanEvent>[] = [];
  const raw: unknown[] = [];

  for await (const chunk of (stream as unknown as {fullStream: AsyncIterable<Record<string, unknown>>}).fullStream) {
    raw.push(chunk);
    const payload = (chunk?.payload ?? {}) as {output?: unknown};
    const event = asPlanEvent(payload.output);
    if (event) events.push(event);
  }

  return {events: events.filter(Boolean), raw, types: events.map(e => e!.type)};
}

describe('successful run emits a real lifecycle', () => {
  it('reports start, stages, tools, validation and completion in order', async () => {
    mockWeather();
    const {events, types} = await streamRun([
      toolCallStep('get-weather', {location: 'Lagos', date: DATE}),
      toolCallStep('find-activities', {location: 'Lagos', date: DATE}),
      textStep('Here is your plan.'),
      envelope({kind: 'itinerary', itinerary: VALID})
    ]);

    expect(types[0]).toBe('run_started');
    expect(types).toContain('stage_started');
    expect(types).toContain('tool_started');
    expect(types).toContain('tool_completed');
    expect(types).toContain('validation_completed');
    expect(types.at(-1)).toBe('run_completed');

    // Tools really ran, in the order the agent called them.
    const tools = events.filter(e => e!.type === 'tool_started').map(e => (e as {tool: string}).tool);
    expect(tools).toEqual(['get-weather', 'find-activities']);
  }, 60000);

  it('carries safe summaries from the real tools', async () => {
    mockWeather();
    const {events} = await streamRun([
      toolCallStep('get-weather', {location: 'Lagos', date: DATE}),
      toolCallStep('find-activities', {location: 'Lagos', date: DATE}),
      textStep('Plan.'),
      envelope({kind: 'itinerary', itinerary: VALID})
    ]);

    const weather = events.find(e => e!.type === 'tool_completed' && (e as {tool: string}).tool === 'get-weather') as
      {weather?: {location: string; date: string}; durationMs: number} | undefined;
    expect(weather?.weather?.location).toBe('Lagos');
    expect(weather?.weather?.date).toBe(DATE);
    expect(weather?.durationMs).toBeGreaterThanOrEqual(0);

    const activities = events.find(e => e!.type === 'tool_completed' && (e as {tool: string}).tool === 'find-activities') as
      {activities?: {considered: number}} | undefined;
    expect(activities?.activities?.considered).toBeGreaterThan(0);
  }, 60000);

  it('validation reports success with no issues', async () => {
    mockWeather();
    const {events} = await streamRun([
      textStep('Plan.'),
      envelope({kind: 'itinerary', itinerary: VALID})
    ]);

    const validation = events.find(e => e!.type === 'validation_completed') as
      {valid: boolean; issueCount: number} | undefined;
    expect(validation?.valid).toBe(true);
    expect(validation?.issueCount).toBe(0);
  }, 60000);
});

describe('correction is visible when it actually happens', () => {
  it('emits validation failure, correction, then success', async () => {
    mockWeather();
    const {types, events} = await streamRun([
      textStep('First attempt.'),
      envelope({kind: 'itinerary', itinerary: INVALID}),
      textStep('Corrected.'),
      envelope({kind: 'itinerary', itinerary: VALID})
    ]);

    const validations = events.filter(e => e!.type === 'validation_completed') as
      {valid: boolean; issueCount: number; issueCodes: string[]}[];

    expect(validations.length).toBeGreaterThanOrEqual(2);
    expect(validations[0]?.valid).toBe(false);
    expect(validations[0]?.issueCodes).toContain('time_window_violation');
    expect(types).toContain('correction_started');
    expect(validations.at(-1)?.valid).toBe(true);
    expect(types.at(-1)).toBe('run_completed');
  }, 60000);

  it('does not emit correction when the first plan is valid', async () => {
    mockWeather();
    const {types} = await streamRun([
      textStep('Plan.'),
      envelope({kind: 'itinerary', itinerary: VALID})
    ]);
    expect(types).not.toContain('correction_started');
  }, 60000);
});

describe('failure', () => {
  it('emits run_failed with a category when the plan stays invalid', async () => {
    mockWeather();
    const {types, events} = await streamRun([
      textStep('a'), envelope({kind: 'itinerary', itinerary: INVALID}),
      textStep('b'), envelope({kind: 'itinerary', itinerary: INVALID})
    ]);

    expect(types).toContain('run_failed');
    const failure = events.find(e => e!.type === 'run_failed') as {category: string} | undefined;
    expect(failure?.category).toBe('itinerary_invalid');
  }, 60000);
});

describe('no secret ever reaches the stream', () => {
  it('emits nothing containing a BYOK key, token or header', async () => {
    mockWeather();
    const KEY = 'sk-stream-leak-probe-1234567890';

    const captured = await runWithRequestModelKey(KEY, async () =>
      streamRun([
        toolCallStep('get-weather', {location: 'Lagos', date: DATE}),
        toolCallStep('find-activities', {location: 'Lagos', date: DATE}),
        textStep('Plan.'),
        envelope({kind: 'itinerary', itinerary: VALID})
      ])
    );

    const serialisedEvents = JSON.stringify(captured.events);
    expect(serialisedEvents).not.toContain(KEY);
    expect(serialisedEvents).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialisedEvents).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\./);
    expect(serialisedEvents.toLowerCase()).not.toContain('authorization');
    expect(serialisedEvents.toLowerCase()).not.toContain('x-openai-api-key');

    // And nothing anywhere in the raw stream either.
    expect(JSON.stringify(captured.raw)).not.toContain(KEY);
  }, 60000);

  it('emits no prompt text or model reasoning in telemetry events', async () => {
    mockWeather();
    const {events} = await streamRun([
      textStep('Plan.'), envelope({kind: 'itinerary', itinerary: VALID})
    ]);

    const serialised = JSON.stringify(events).toLowerCase();
    expect(serialised).not.toContain('day-trip planner');
    expect(serialised).not.toContain(REQUEST.toLowerCase().slice(0, 20));
  }, 60000);
});
