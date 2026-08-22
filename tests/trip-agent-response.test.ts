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
import {
  LAGOS_GEOCODING,
  forecast,
  installFetchMock,
  isForecast,
  isGeocoding,
  json,
  restoreFetch
} from './helpers/open-meteo-mock.js';

const dbDir = mkdtempSync(join(tmpdir(), 'mastra-response-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'response.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {createTripAgent} = await import('../src/mastra/agents/trip-agent.js');
const {AgentResponseSchema, ItineraryResponseSchema, SavedListResponseSchema, MessageResponseSchema} =
  await import('../src/mastra/schemas/agent-response.js');
const {ItinerarySchema} = await import('../src/mastra/schemas/itinerary.js');
const {PERMISSIONS} = await import('../src/mastra/lib/kinde.js');
const {saveItinerary: saveItineraryRaw} = await import('../src/mastra/tools/save-itinerary.js');
const {runWithSaveIntent} = await import('../src/mastra/lib/save-intent.js');

/*
 * Saving now also requires explicit user intent (src/mastra/lib/save-intent.ts).
 * That gate has its own suite in tests/save-intent.test.ts; these tests are
 * about what happens once the user has asked, so intent is established here.
 */
const saveItinerary: typeof saveItineraryRaw = (...args) =>
  runWithSaveIntent('Save this itinerary.', () => saveItineraryRaw(...args));

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

async function contextFor(claims: {sub: string; permissions?: string[]}) {
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

let threadCounter = 0;

/** Run the agent with a scripted script, returning the parsed envelope. */
async function run(
  steps: Parameters<typeof scriptedModel>[0],
  prompt: string,
  requestContext?: Awaited<ReturnType<typeof contextFor>>
) {
  const model = scriptedModel(steps);
  const agent = createTripAgent({model});
  threadCounter += 1;

  // Memory needs a resource, and the only legitimate source is an
  // authenticated token — so every run here is authenticated, as in production.
  const context = requestContext ?? (await contextFor({sub: 'kp:default', permissions: [READ]}));

  // The workflow runs every agent turn inside a save-intent scope derived from
  // the user's own message; doing the same here keeps the tool path identical.
  const result = await runWithSaveIntent(prompt, () =>
    agent.generate(prompt, {
      requestContext: context,
      memory: {thread: `thread-${threadCounter}`}
    } as never)
  );

  return {model, result};
}

/** The final structuring turn emits the envelope. */
const envelope = (payload: unknown) => textStep(JSON.stringify(payload));

describe('schema shape', () => {
  it('is a discriminated union over kind', () => {
    expect(ItineraryResponseSchema.safeParse({kind: 'itinerary', itinerary: ITINERARY}).success).toBe(true);
    expect(SavedListResponseSchema.safeParse({kind: 'saved-list', itineraries: []}).success).toBe(true);
    expect(MessageResponseSchema.safeParse({kind: 'message', message: 'hi'}).success).toBe(true);
  });

  it('rejects a payload that does not match its kind', () => {
    expect(AgentResponseSchema.safeParse({kind: 'itinerary', itineraries: []}).success).toBe(false);
    expect(AgentResponseSchema.safeParse({kind: 'saved-list', itinerary: ITINERARY}).success).toBe(false);
    expect(AgentResponseSchema.safeParse({kind: 'nonsense', message: 'x'}).success).toBe(false);
  });
});

describe('planning request', () => {
  it("produces kind 'itinerary' with a schema-valid payload", async () => {
    const {result} = await run(
      [envelope({kind: 'itinerary', itinerary: ITINERARY}), envelope({kind: 'itinerary', itinerary: ITINERARY})],
      'Plan me an afternoon in Lagos tomorrow.'
    );

    expect(AgentResponseSchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.kind).toBe('itinerary');

    const itinerary = result.object?.kind === 'itinerary' ? result.object.itinerary : undefined;
    expect(ItinerarySchema.safeParse(itinerary).success).toBe(true);
    expect(itinerary?.destination).toBe('Lagos');
  });

  it('still runs weather then activities before answering', async () => {
    // Stub Open-Meteo only; delegate everything else (notably the JWKS the test
    // tenant serves) to the fetch already in place, so no live call is made.
    const previousFetch = globalThis.fetch;
    installFetchMock(url => {
      if (isGeocoding(url)) return json(LAGOS_GEOCODING);
      if (isForecast(url)) return json(forecast('2026-08-22'));
      return previousFetch(url);
    });

    const {model, result} = await run(
      [
        toolCallStep('get-weather', {location: 'Lagos', date: '2026-08-22'}),
        toolCallStep('find-activities', {
          location: 'Lagos',
          date: '2026-08-22',
          weather: {precipitationChance: 100, highCelsius: 27.2}
        }),
        textStep('Here is your afternoon.'),
        envelope({kind: 'itinerary', itinerary: ITINERARY})
      ],
      'Plan me an afternoon in Lagos tomorrow.'
    );

    const toolNames = (result.toolCalls ?? []).map(call => call.payload.toolName);
    expect(toolNames).toEqual(['get-weather', 'find-activities']);
    expect(result.object?.kind).toBe('itinerary');

    // The real tools ran and their output reached the model.
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('Africa/Lagos');
    expect(JSON.stringify(model.doGenerateCalls[2]?.prompt)).toContain('Nike Art Gallery');

    restoreFetch();
  });
});

describe('saved itinerary request', () => {
  it("produces kind 'saved-list' carrying the tool's actual records", async () => {
    const context = await contextFor({sub: 'kp:has_saved', permissions: [READ, CREATE]});
    const saved = await saveItinerary({itinerary: ITINERARY} as never, {requestContext: context});
    expect(saved.saved).toBe(true);

    const record = {
      id: saved.itineraryId,
      itinerary: ITINERARY,
      sub: 'kp:has_saved',
      orgCode: ORG,
      resourceId: `${ORG}:kp:has_saved`,
      createdAt: saved.savedAt,
      updatedAt: saved.savedAt
    };

    const {model, result} = await run(
      [
        toolCallStep('list-itineraries', {limit: 10}),
        textStep('Here is what you saved.'),
        envelope({kind: 'saved-list', itineraries: [record]})
      ],
      'Show me my saved itineraries.',
      context
    );

    expect(AgentResponseSchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.kind).toBe('saved-list');

    const listed = result.object?.kind === 'saved-list' ? result.object.itineraries : [];
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.itineraryId);
    // The id came from the tool, not the model's imagination.
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain(saved.itineraryId!);
  });

  it("produces a valid empty 'saved-list' when nothing is saved", async () => {
    const context = await contextFor({sub: 'kp:nothing_saved', permissions: [READ]});

    const {model, result} = await run(
      [
        toolCallStep('list-itineraries', {limit: 10}),
        textStep('You have none yet.'),
        envelope({kind: 'saved-list', itineraries: []})
      ],
      'Show me my saved itineraries.',
      context
    );

    expect(AgentResponseSchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.kind).toBe('saved-list');
    expect(result.object?.kind === 'saved-list' && result.object.itineraries).toEqual([]);
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('"count":0');
  });

  it('never receives another user\'s records to fabricate from', async () => {
    const owner = await contextFor({sub: 'kp:owner2', permissions: [READ, CREATE]});
    const other = await contextFor({sub: 'kp:other2', permissions: [READ]});

    const ownerSaved = await saveItinerary({itinerary: ITINERARY} as never, {
      requestContext: owner
    });

    const {model} = await run(
      [
        toolCallStep('list-itineraries', {limit: 50}),
        textStep('You have none.'),
        envelope({kind: 'saved-list', itineraries: []})
      ],
      'Show me my saved itineraries.',
      other
    );

    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).not.toContain(ownerSaved.itineraryId!);
  });
});

describe('save request', () => {
  it("produces kind 'message' confirming a successful save", async () => {
    const context = await contextFor({sub: 'kp:can_save', permissions: [READ, CREATE]});

    const {model, result} = await run(
      [
        toolCallStep('save-itinerary', {itinerary: ITINERARY}),
        textStep('Saved.'),
        envelope({kind: 'message', message: 'Saved your afternoon in Lagos.'})
      ],
      'Save this itinerary.',
      context
    );

    expect(result.object?.kind).toBe('message');
    expect(JSON.stringify(model.doGenerateCalls[1]?.prompt)).toContain('"saved":true');
  });

  it("produces kind 'message' explaining a permission denial", async () => {
    const context = await contextFor({sub: 'kp:cannot_save', permissions: [READ]});

    const {model, result} = await run(
      [
        toolCallStep('save-itinerary', {itinerary: ITINERARY}),
        textStep('Denied.'),
        envelope({
          kind: 'message',
          message: `You do not have permission to save itineraries. This requires "${CREATE}".`
        })
      ],
      'Save this itinerary.',
      context
    );

    expect(result.object?.kind).toBe('message');
    const message = result.object?.kind === 'message' ? result.object.message : '';
    expect(message).toContain(CREATE);

    // The model saw a refusal, and no success signal it could misread.
    const seen = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(seen).toContain('permission_denied');
    expect(seen).not.toContain('"saved":true');
  });

  it('carries the structured denial flag through to the response', async () => {
    const context = await contextFor({sub: 'kp:flagged', permissions: [READ]});

    const {result} = await run(
      [
        toolCallStep('save-itinerary', {itinerary: ITINERARY}),
        textStep('Denied.'),
        envelope({
          kind: 'message',
          message: 'You do not have permission to save itineraries.',
          permissionDenied: true,
          requiredPermission: CREATE
        })
      ],
      'Save this itinerary.',
      context
    );

    expect(AgentResponseSchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.kind).toBe('message');
    if (result.object?.kind !== 'message') throw new Error('expected a message');
    expect(result.object.permissionDenied).toBe(true);
    expect(result.object.requiredPermission).toBe(CREATE);
  });

  it('defaults the denial fields when the agent omits them', async () => {
    const context = await contextFor({sub: 'kp:nodefault', permissions: [READ]});

    const {result} = await run(
      [
        envelope({kind: 'message', message: 'Hello.'}),
        envelope({kind: 'message', message: 'Hello.'})
      ],
      'Hi.',
      context
    );

    if (result.object?.kind !== 'message') throw new Error('expected a message');
    expect(result.object.permissionDenied).toBe(false);
    expect(result.object.requiredPermission).toBeNull();
  });

  it('a denied save is not reported as an itinerary', async () => {
    const context = await contextFor({sub: 'kp:denied2', permissions: [READ]});

    const {result} = await run(
      [
        toolCallStep('save-itinerary', {itinerary: ITINERARY}),
        textStep('Denied.'),
        envelope({kind: 'message', message: 'Permission denied.'})
      ],
      'Save this itinerary.',
      context
    );

    expect(result.object?.kind).not.toBe('itinerary');
    expect(result.object?.kind).not.toBe('saved-list');
  });
});

describe('general request', () => {
  it("produces kind 'message'", async () => {
    const {result} = await run(
      [
        envelope({kind: 'message', message: 'I plan single days out. Where would you like to go?'}),
        envelope({kind: 'message', message: 'I plan single days out. Where would you like to go?'})
      ],
      'What can you do?'
    );

    expect(AgentResponseSchema.safeParse(result.object).success).toBe(true);
    expect(result.object?.kind).toBe('message');
  });
});

describe('memory still works with the envelope', () => {
  it('derives the resource from the token and keeps threads separate', async () => {
    const context = await contextFor({sub: 'kp:mem_user', permissions: [READ]});

    // No `resource` is passed; Mastra derives it via mapUserToResourceId.
    const first = await run(
      [envelope({kind: 'message', message: 'Noted.'}), envelope({kind: 'message', message: 'Noted.'})],
      'I am vegetarian.',
      context
    );
    expect(first.result.object?.kind).toBe('message');

    const {tripMemory} = await import('../src/mastra/memory.js');
    const thread = await tripMemory.getThreadById({threadId: `thread-${threadCounter}`});
    expect(thread?.resourceId).toBe(`${ORG}:kp:mem_user`);
  });
});
