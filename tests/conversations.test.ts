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
import {createTestServer, type TestApp} from './helpers/test-server.js';

const dbDir = mkdtempSync(join(tmpdir(), 'conv-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'conv.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {
  ConversationAccessError,
  deriveConversationTitle,
  ensureConversation,
  listConversations,
  loadConversation,
  MAX_TITLE_LENGTH
} = await import('../src/mastra/lib/conversations.js');
const {tripMemory} = await import('../src/mastra/memory.js');

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = `${ORG_A}:kp:alice`;
const BOB = `${ORG_A}:kp:bob`;
const CARLA_ORG_B = `${ORG_B}:kp:carla`;

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

const memory = () => tripMemory;

async function seed(resourceId: string, threadId: string, message: string) {
  return ensureConversation({memory: memory(), resourceId, threadId, firstMessage: message});
}

// ---------------------------------------------------------------------------

describe('title derivation', () => {
  it.each([
    ['Plan me an afternoon in Lagos tomorrow. I like outdoor activities.', 'Lagos Afternoon'],
    ['Plan a relaxed weekend in Lisbon', 'Lisbon Weekend'],
    ['Find me something to do in Cape Town', 'Cape Town Plans'],
    ['A morning in Lagos', 'Lagos Morning']
  ])('turns %s into a short title', (message, expected) => {
    expect(deriveConversationTitle(message)).toBe(expected);
  });

  it('falls back to the trimmed message when no destination is identifiable', () => {
    const title = deriveConversationTitle('  Surprise   me with   anything  ');
    expect(title).toBe('Surprise me with anything');
  });

  it('caps the length for the UI', () => {
    const title = deriveConversationTitle('x'.repeat(300));
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });

  it('handles an empty request', () => {
    expect(deriveConversationTitle('')).toBe('New plan');
  });

  it('never contains model output or prompt text', () => {
    const title = deriveConversationTitle('Plan an afternoon in Lagos');
    expect(title).not.toMatch(/system|assistant|instruction/i);
  });
});

describe('creation is idempotent', () => {
  it('creates a conversation with timestamps', async () => {
    const created = await seed(ALICE, 'conv-create-1', 'Plan an afternoon in Lagos');

    expect(created.threadId).toBe('conv-create-1');
    expect(created.title).toBe('Lagos Afternoon');
    expect(() => new Date(created.createdAt).toISOString()).not.toThrow();
    expect(() => new Date(created.updatedAt).toISOString()).not.toThrow();
  });

  it('does not create a duplicate for the same thread', async () => {
    await seed(ALICE, 'conv-dup', 'Plan an afternoon in Lagos');
    await seed(ALICE, 'conv-dup', 'Make it more relaxed');
    await seed(ALICE, 'conv-dup', 'Replace the beach');

    const all = await listConversations({memory: memory(), resourceId: ALICE});
    expect(all.filter(c => c.threadId === 'conv-dup')).toHaveLength(1);
  });

  it('keeps the original title across later turns', async () => {
    await seed(ALICE, 'conv-title-stable', 'Plan an afternoon in Lagos');
    const second = await seed(ALICE, 'conv-title-stable', 'Now plan a weekend in Lisbon');

    expect(second.title).toBe('Lagos Afternoon');
  });

  it('refuses to adopt a thread owned by someone else', async () => {
    await seed(ALICE, 'conv-owned-by-alice', 'Plan an afternoon in Lagos');

    await expect(
      seed(BOB, 'conv-owned-by-alice', 'Let me in')
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });
});

describe('listing', () => {
  it('returns only the requesting resource conversations', async () => {
    await seed(ALICE, 'list-alice-1', 'Plan an afternoon in Lagos');
    await seed(BOB, 'list-bob-1', 'Plan a weekend in Lisbon');

    const alice = await listConversations({memory: memory(), resourceId: ALICE});
    const bob = await listConversations({memory: memory(), resourceId: BOB});

    expect(alice.some(c => c.threadId === 'list-alice-1')).toBe(true);
    expect(alice.some(c => c.threadId === 'list-bob-1')).toBe(false);
    expect(bob.some(c => c.threadId === 'list-bob-1')).toBe(true);
  });

  it('orders by most recent activity first', async () => {
    await seed(ALICE, 'order-old', 'Plan an afternoon in Lagos');
    await new Promise(r => setTimeout(r, 12));
    await seed(ALICE, 'order-new', 'Plan a weekend in Lisbon');

    const list = await listConversations({memory: memory(), resourceId: ALICE});
    const oldIndex = list.findIndex(c => c.threadId === 'order-old');
    const newIndex = list.findIndex(c => c.threadId === 'order-new');

    expect(newIndex).toBeLessThan(oldIndex);
  });

  it('returns metadata only, never messages', async () => {
    await seed(ALICE, 'list-shape', 'Plan an afternoon in Lagos');
    const list = await listConversations({memory: memory(), resourceId: ALICE});

    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(['createdAt', 'threadId', 'title', 'updatedAt']);
    }
  });

  it('isolates across organizations', async () => {
    await seed(CARLA_ORG_B, 'org-b-thread', 'Plan a weekend in Lisbon');

    const alice = await listConversations({memory: memory(), resourceId: ALICE});
    expect(alice.some(c => c.threadId === 'org-b-thread')).toBe(false);
  });
});

describe('loading', () => {
  it('loads the owner own conversation', async () => {
    await seed(ALICE, 'load-mine', 'Plan an afternoon in Lagos');

    const detail = await loadConversation({
      memory: memory(), resourceId: ALICE, threadId: 'load-mine'
    });

    expect(detail.threadId).toBe('load-mine');
    expect(Array.isArray(detail.messages)).toBe(true);
  });

  it('refuses an unknown thread', async () => {
    await expect(
      loadConversation({memory: memory(), resourceId: ALICE, threadId: 'does-not-exist'})
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  it('refuses another user thread in the same organization', async () => {
    await seed(ALICE, 'load-alice-private', 'Plan an afternoon in Lagos');

    await expect(
      loadConversation({memory: memory(), resourceId: BOB, threadId: 'load-alice-private'})
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  it('refuses a thread from another organization', async () => {
    await seed(CARLA_ORG_B, 'load-org-b', 'Plan a weekend in Lisbon');

    await expect(
      loadConversation({memory: memory(), resourceId: ALICE, threadId: 'load-org-b'})
    ).rejects.toBeInstanceOf(ConversationAccessError);
  });

  it('does not reveal whether another user thread exists', async () => {
    await seed(ALICE, 'load-exists', 'Plan an afternoon in Lagos');

    const missing = await loadConversation({
      memory: memory(), resourceId: BOB, threadId: 'totally-absent'
    }).catch(e => (e as Error).message);
    const forbidden = await loadConversation({
      memory: memory(), resourceId: BOB, threadId: 'load-exists'
    }).catch(e => (e as Error).message);

    expect(forbidden).toBe(missing);
  });
});

// ---------------------------------------------------------------------------
// HTTP layer, with real Kinde tokens
// ---------------------------------------------------------------------------

async function authed(path: string, claims: {sub: string; orgCode?: string}, headers: Record<string, string> = {}) {
  const token = await mintToken({orgCode: 'org_alpha', ...claims});
  return app.request(path, {headers: {authorization: `Bearer ${token}`, ...headers}});
}

describe('HTTP: ownership is server-derived', () => {
  it('requires authentication', async () => {
    expect((await app.request('/conversations')).status).toBe(401);
    expect((await app.request('/conversations/anything')).status).toBe(401);
  });

  it('lists only the authenticated resource conversations', async () => {
    await seed('org_alpha:kp:http_a', 'http-a-1', 'Plan an afternoon in Lagos');
    await seed('org_alpha:kp:http_b', 'http-b-1', 'Plan a weekend in Lisbon');

    const res = await authed('/conversations', {sub: 'kp:http_a'});
    const body = (await res.json()) as {conversations: {threadId: string}[]};

    expect(res.status).toBe(200);
    expect(body.conversations.some(c => c.threadId === 'http-a-1')).toBe(true);
    expect(body.conversations.some(c => c.threadId === 'http-b-1')).toBe(false);
  });

  it('ignores a forged resourceId, sub and orgCode supplied by the client', async () => {
    await seed('org_alpha:kp:victim', 'victim-thread', 'Plan an afternoon in Lagos');

    const res = await authed(
      '/conversations',
      {sub: 'kp:attacker'},
      {
        'x-test-request-context': JSON.stringify({
          mastra__resourceId: 'org_alpha:kp:victim',
          resourceId: 'org_alpha:kp:victim',
          sub: 'kp:victim',
          orgCode: 'org_alpha',
          permissions: ['read:itinerary', 'create:itinerary']
        })
      }
    );
    const body = (await res.json()) as {conversations: {threadId: string}[]};

    expect(res.status).toBe(200);
    expect(body.conversations.some(c => c.threadId === 'victim-thread')).toBe(false);
  });

  it('returns 404 for another user thread, same as for a missing one', async () => {
    await seed('org_alpha:kp:owner_x', 'owner-x-thread', 'Plan an afternoon in Lagos');

    const other = await authed('/conversations/owner-x-thread', {sub: 'kp:someone_else'});
    const missing = await authed('/conversations/no-such-thread', {sub: 'kp:someone_else'});

    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  it('loads the caller own conversation over HTTP', async () => {
    await seed('org_alpha:kp:http_self', 'http-self-thread', 'Plan an afternoon in Lagos');

    const res = await authed('/conversations/http-self-thread', {sub: 'kp:http_self'});
    const body = (await res.json()) as {threadId: string; title: string};

    expect(res.status).toBe(200);
    expect(body.threadId).toBe('http-self-thread');
    expect(body.title).toBe('Lagos Afternoon');
  });

  it('never returns tokens, keys or permissions', async () => {
    await seed('org_alpha:kp:leak', 'leak-thread', 'Plan an afternoon in Lagos');

    const listed = await (await authed('/conversations', {sub: 'kp:leak'})).text();
    const loaded = await (await authed('/conversations/leak-thread', {sub: 'kp:leak'})).text();

    for (const body of [listed, loaded]) {
      expect(body).not.toMatch(/sk-[A-Za-z0-9]/);
      expect(body).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\./);
      expect(body).not.toContain('authorization');
      expect(body).not.toContain('permissions');
    }
  });
});

describe('BYOK never reaches conversation storage', () => {
  it('is absent from a title derived from a message that mentions one', () => {
    const title = deriveConversationTitle('Plan Lagos with key sk-proj-SECRET1234567890');
    expect(title).not.toContain('sk-proj-SECRET1234567890');
  });

  it('is absent from conversation metadata and responses', async () => {
    const {runWithRequestModelKey} = await import('../src/mastra/lib/model-key.js');
    const KEY = 'sk-conversation-leak-probe';

    await runWithRequestModelKey(KEY, async () => {
      await seed('org_alpha:kp:byok_conv', 'byok-conv-thread', 'Plan an afternoon in Lagos');
    });

    const list = await listConversations({memory: memory(), resourceId: 'org_alpha:kp:byok_conv'});
    const detail = await loadConversation({
      memory: memory(), resourceId: 'org_alpha:kp:byok_conv', threadId: 'byok-conv-thread'
    });

    expect(JSON.stringify(list)).not.toContain(KEY);
    expect(JSON.stringify(detail)).not.toContain(KEY);
  });
});
