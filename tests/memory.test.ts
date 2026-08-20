import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {LibSQLStore} from '@mastra/libsql';
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
import {createTestServer, type TestApp} from './helpers/test-server.js';

// A real on-disk LibSQL file, so working memory genuinely round-trips through
// storage rather than being held in process. Set before any src import.
const dbDir = mkdtempSync(join(tmpdir(), 'mastra-memory-test-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'memory.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {tripAgent} = await import('../src/mastra/agents/trip-agent.js');
const {tripMemory, travelPreferencesSchema} = await import('../src/mastra/memory.js');
const {resourceIdForUser} = await import('../src/mastra/lib/kinde.js');

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'kp:user_alice';
const BOB = 'kp:user_bob';

const resourceOf = (orgCode: string, sub: string) => `${orgCode}:${sub}`;

let app: TestApp;

beforeAll(async () => {
  await startTestTenant();
  const {mastra} = await import('../src/mastra/index.js');
  app = createTestServer(mastra);
});

afterAll(() => {
  stopTestTenant();
  rmSync(dbDir, {recursive: true, force: true});
});

/** Read the server's view of an authenticated identity. */
async function identityFor(claims: {sub?: string; orgCode?: string}, headers: Record<string, string> = {}) {
  const token = await mintToken(claims);
  const res = await app.request('/me', {
    headers: {authorization: `Bearer ${token}`, ...headers}
  });
  return res.json() as Promise<{sub: string | null; orgCode: string | null; resourceId: string | null}>;
}

/** Write preferences for a resource, through a thread belonging to it. */
async function rememberPreferences(resourceId: string, threadId: string, preferences: unknown) {
  await tripMemory.createThread({resourceId, threadId});
  await tripMemory.updateWorkingMemory({
    threadId,
    resourceId,
    workingMemory: JSON.stringify(preferences)
  });
}

async function recallPreferences(resourceId: string, threadId: string) {
  await tripMemory.createThread({resourceId, threadId});
  const raw = await tripMemory.getWorkingMemory({threadId, resourceId});
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe('memory configuration', () => {
  it('is attached to the trip agent', async () => {
    const memory = await tripAgent.getMemory();
    expect(memory).toBeDefined();
    expect(memory).toBe(tripMemory);
  });

  it('uses LibSQL storage', () => {
    // The same store the Mastra instance uses — one database, no second system.
    expect(tripMemory.storage).toBeInstanceOf(LibSQLStore);
  });

  it('enables working memory scoped to the resource, not the thread', () => {
    const config = (tripMemory as unknown as {threadConfig: Record<string, any>}).threadConfig;

    expect(config.workingMemory.enabled).toBe(true);
    expect(config.workingMemory.scope).toBe('resource');
    expect(config.workingMemory.schema).toBe(travelPreferencesSchema);
  });

  it('keeps conversation history bounded', () => {
    const config = (tripMemory as unknown as {threadConfig: Record<string, any>}).threadConfig;
    expect(config.lastMessages).toBe(20);
  });

  it('does not enable semantic recall', () => {
    const config = (tripMemory as unknown as {threadConfig: Record<string, any>}).threadConfig;
    expect(config.semanticRecall === false || config.semanticRecall === undefined).toBe(true);
  });

  it('exposes a working memory template built from the schema', async () => {
    const template = await tripMemory.getWorkingMemoryTemplate({});
    expect(template).not.toBeNull();
    expect(template?.format).toBe('json');
  });
});

describe('working memory schema', () => {
  it('accepts realistic travel preferences', () => {
    const result = travelPreferencesSchema.safeParse({
      dietary: ['vegetarian'],
      likes: ['outdoor'],
      dislikes: ['museums'],
      preferredStartTime: 'late-morning',
      pace: 'relaxed'
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty object, so a new traveller starts blank', () => {
    expect(travelPreferencesSchema.safeParse({}).success).toBe(true);
  });

  it('rejects values outside the allowed sets', () => {
    expect(
      travelPreferencesSchema.safeParse({preferredStartTime: 'whenever'}).success
    ).toBe(false);
    expect(travelPreferencesSchema.safeParse({pace: 'frantic'}).success).toBe(false);
  });

  it('is a closed set of trip fields, so unrelated detail cannot be stored', () => {
    const parsed = travelPreferencesSchema.parse({
      likes: ['outdoor'],
      passportNumber: '123456789',
      notes: 'anything at all'
    } as never);

    expect(parsed).toEqual({likes: ['outdoor']});
    expect(parsed).not.toHaveProperty('passportNumber');
    expect(parsed).not.toHaveProperty('notes');
  });
});

describe('resource identity from the authenticated token', () => {
  it('derives the resource id from org_code and sub', async () => {
    const identity = await identityFor({sub: ALICE, orgCode: ORG_A});
    expect(identity.resourceId).toBe(resourceOf(ORG_A, ALICE));
  });

  it('gives two different users different resource ids', async () => {
    const alice = await identityFor({sub: ALICE, orgCode: ORG_A});
    const bob = await identityFor({sub: BOB, orgCode: ORG_A});

    expect(alice.resourceId).not.toBe(bob.resourceId);
  });

  it('gives the same user in another organization a different resource id', async () => {
    const inA = await identityFor({sub: ALICE, orgCode: ORG_A});
    const inB = await identityFor({sub: ALICE, orgCode: ORG_B});

    expect(inA.resourceId).toBe(resourceOf(ORG_A, ALICE));
    expect(inB.resourceId).toBe(resourceOf(ORG_B, ALICE));
    expect(inA.resourceId).not.toBe(inB.resourceId);
  });

  it('returns the same resource id across separate requests, so a conversation can continue', async () => {
    const first = await identityFor({sub: ALICE, orgCode: ORG_A});
    const second = await identityFor({sub: ALICE, orgCode: ORG_A});

    expect(first.resourceId).toBe(second.resourceId);
  });

  it('ignores a client-supplied resource id', async () => {
    const identity = await identityFor(
      {sub: ALICE, orgCode: ORG_A},
      {
        'x-test-request-context': JSON.stringify({
          mastra__resourceId: resourceOf(ORG_B, BOB),
          resourceId: resourceOf(ORG_B, BOB)
        })
      }
    );

    expect(identity.resourceId).toBe(resourceOf(ORG_A, ALICE));
    expect(identity.resourceId).not.toContain(BOB);
  });

  it('matches the pure derivation helper', () => {
    expect(resourceIdForUser({sub: ALICE, org_code: ORG_A} as never)).toBe(
      resourceOf(ORG_A, ALICE)
    );
  });
});

describe('memory isolation between resources', () => {
  it('keeps two users in the same organization separate', async () => {
    const aliceResource = resourceOf(ORG_A, ALICE);
    const bobResource = resourceOf(ORG_A, BOB);

    await rememberPreferences(aliceResource, 'thread-alice-1', {dietary: ['vegetarian']});
    await rememberPreferences(bobResource, 'thread-bob-1', {dietary: ['pescatarian']});

    expect((await recallPreferences(aliceResource, 'thread-alice-1'))?.dietary).toEqual([
      'vegetarian'
    ]);
    expect((await recallPreferences(bobResource, 'thread-bob-1'))?.dietary).toEqual([
      'pescatarian'
    ]);
  });

  it('keeps the same person separate across organizations', async () => {
    const inA = resourceOf(ORG_A, ALICE);
    const inB = resourceOf(ORG_B, ALICE);

    await rememberPreferences(inB, 'thread-alice-orgb', {dislikes: ['museums']});

    const fromA = await recallPreferences(inA, 'thread-alice-1');
    // Org A only ever recorded a dietary preference, never this dislike.
    expect(fromA?.dislikes).toBeUndefined();

    const fromB = await recallPreferences(inB, 'thread-alice-orgb');
    expect(fromB?.dislikes).toEqual(['museums']);
  });
});

describe('threads and preference persistence', () => {
  it('carries preferences from one conversation into the next for the same resource', async () => {
    const resourceId = resourceOf(ORG_A, 'kp:user_carla');

    // Conversation one: the traveller mentions a standing preference.
    await rememberPreferences(resourceId, 'carla-thread-1', {
      dietary: ['vegetarian'],
      preferredStartTime: 'late-morning'
    });

    // A brand new conversation, same authenticated person.
    const recalled = await recallPreferences(resourceId, 'carla-thread-2');

    expect(recalled?.dietary).toEqual(['vegetarian']);
    expect(recalled?.preferredStartTime).toBe('late-morning');
  });

  it('stores one preference document per resource, shared by every thread', async () => {
    const resourceId = resourceOf(ORG_A, 'kp:user_dan');

    await rememberPreferences(resourceId, 'dan-thread-1', {dietary: ['vegan']});

    // Written from a different thread, read back from a third — one document.
    await rememberPreferences(resourceId, 'dan-thread-2', {
      dietary: ['vegan'],
      dislikes: ['museums']
    });

    const recalled = await recallPreferences(resourceId, 'dan-thread-3');
    expect(recalled?.dietary).toEqual(['vegan']);
    expect(recalled?.dislikes).toEqual(['museums']);
  });

  it('replaces the document on a direct write, so callers must send the full state', async () => {
    // NOTE: the merge semantics described for schema-based working memory are
    // applied by the agent's updateWorkingMemory *tool*, which deep-merges
    // before writing. The raw Memory API used here overwrites. Anything
    // calling this method directly must read-modify-write.
    const resourceId = resourceOf(ORG_A, 'kp:user_gita');

    await rememberPreferences(resourceId, 'gita-thread-1', {
      dietary: ['vegetarian'],
      pace: 'relaxed'
    });
    await rememberPreferences(resourceId, 'gita-thread-1', {dislikes: ['museums']});

    const recalled = await recallPreferences(resourceId, 'gita-thread-1');
    expect(recalled?.dislikes).toEqual(['museums']);
    expect(recalled?.dietary).toBeUndefined();
  });

  it('keeps message history separate per thread under one resource', async () => {
    const resourceId = resourceOf(ORG_A, 'kp:user_erin');

    await tripMemory.createThread({resourceId, threadId: 'erin-thread-1'});
    await tripMemory.createThread({resourceId, threadId: 'erin-thread-2'});

    await tripMemory.saveMessages({
      messages: [
        {
          id: 'msg-1',
          threadId: 'erin-thread-1',
          resourceId,
          role: 'user',
          content: {format: 2, parts: [{type: 'text', text: 'Plan me a day in Lisbon.'}]},
          createdAt: new Date()
        }
      ] as never
    });

    const threadOne = await tripMemory.recall({threadId: 'erin-thread-1', resourceId} as never);
    const threadTwo = await tripMemory.recall({threadId: 'erin-thread-2', resourceId} as never);

    expect(threadOne.messages.length).toBe(1);
    expect(threadTwo.messages.length).toBe(0);
  });

  it('records the owning resource on each thread', async () => {
    const resourceId = resourceOf(ORG_A, 'kp:user_frank');
    await tripMemory.createThread({resourceId, threadId: 'frank-thread-1'});

    const thread = await tripMemory.getThreadById({threadId: 'frank-thread-1'});
    expect(thread?.resourceId).toBe(resourceId);
  });
});
