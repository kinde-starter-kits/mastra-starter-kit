import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {RequestContext} from '@mastra/core/request-context';
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

// A real on-disk LibSQL file so persistence is genuinely exercised.
const dbDir = mkdtempSync(join(tmpdir(), 'mastra-itinerary-test-'));
process.env.DATABASE_URL = `file:${join(dbDir, 'itineraries.db')}`;
process.env.KINDE_DOMAIN = TEST_DOMAIN;
process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
process.env.KINDE_ALLOWED_ORG_CODES = '';

const {saveItinerary, saveItineraryTool} = await import('../src/mastra/tools/save-itinerary.js');
const {listItineraries} = await import('../src/mastra/tools/list-itineraries.js');
const {SavedItinerarySchema} = await import('../src/mastra/lib/itinerary-store.js');
const {PERMISSIONS} = await import('../src/mastra/lib/kinde.js');

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'kp:user_alice';
const BOB = 'kp:user_bob';

const READ = PERMISSIONS.readItinerary;
const CREATE = PERMISSIONS.createItinerary;

let mastra: Awaited<typeof import('../src/mastra/index.js')>['mastra'];

beforeAll(async () => {
  await startTestTenant();
  ({mastra} = await import('../src/mastra/index.js'));
});

afterAll(() => {
  stopTestTenant();
  rmSync(dbDir, {recursive: true, force: true});
});

/** The RequestContext a signed-in Kinde user would produce. */
async function contextFor(claims: {sub?: string; orgCode?: string; permissions?: string[]}) {
  const token = await mintToken(claims);
  const {requestContext} = await authenticatedContext(mastra, token);
  return requestContext;
}

function itinerary(overrides: Record<string, unknown> = {}) {
  return {
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
    notes: ['Carry a light rain jacket'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// save-itinerary
// ---------------------------------------------------------------------------

describe('save-itinerary — authorization', () => {
  it('saves for a user holding create:itinerary', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ, CREATE]});

    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });

    expect(result.saved).toBe(true);
    expect(result.reason).toBe('saved');
    expect(result.itineraryId).toBeTruthy();
  });

  it('denies a user without create:itinerary', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ]});

    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('permission_denied');
    expect(result.requiredPermission).toBe(CREATE);
    expect(result.itineraryId).toBeNull();
  });

  it('fails closed when the permissions claim is absent entirely', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A});

    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('permission_denied');
  });

  it('denies an unauthenticated request', async () => {
    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: new RequestContext()
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });

  it('denies when there is no request context at all', async () => {
    const result = await saveItinerary({itinerary: itinerary()} as never, undefined);

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });

  it('says which permission is missing without naming other users or orgs', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ]});
    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });

    expect(result.message).toContain(CREATE);
    expect(result.message).not.toContain(BOB);
    expect(result.message).not.toContain(ORG_B);
  });
});

describe('save-itinerary — itinerary validation', () => {
  it('rejects a malformed itinerary through the Mastra tool wrapper', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ, CREATE]});

    // Mastra validates inputSchema before execute and returns a structured
    // validation error rather than throwing.
    const result = (await saveItineraryTool.execute!(
      {itinerary: {destination: 'Lagos'}} as never,
      {requestContext: context} as never
    )) as {error?: boolean; message?: string};

    expect(result.error).toBe(true);
    expect(result.message).toContain('itinerary');
  });

  it('accepts a valid itinerary through the tool wrapper', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ, CREATE]});

    const result = (await saveItineraryTool.execute!({itinerary: itinerary()} as never, {
      requestContext: context
    } as never)) as {saved?: boolean};

    expect(result.saved).toBe(true);
  });
});

describe('save-itinerary — server-derived ownership', () => {
  it('derives sub, org_code and resourceId from the token', async () => {
    const context = await contextFor({sub: BOB, orgCode: ORG_B, permissions: [READ, CREATE]});

    const saved = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });
    expect(saved.saved).toBe(true);
    expect(saved.orgCode).toBe(ORG_B);

    const listed = await listItineraries({limit: 10} as never, {requestContext: context});
    const record = listed.itineraries.find(entry => entry.id === saved.itineraryId);
    expect(record).toBeDefined();

    // Confirm the stored row carries exactly the authenticated identity.
    const stored = SavedItinerarySchema.parse({
      id: saved.itineraryId,
      itinerary: record!.itinerary,
      sub: BOB,
      orgCode: ORG_B,
      resourceId: `${ORG_B}:${BOB}`,
      createdAt: record!.createdAt,
      updatedAt: record!.updatedAt
    });
    expect(stored.resourceId).toBe(`${ORG_B}:${BOB}`);
  });

  it('ignores identity fields supplied in tool input', async () => {
    const victim = await contextFor({sub: BOB, orgCode: ORG_B, permissions: [READ, CREATE]});
    const attacker = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ, CREATE]});

    const forged = await saveItinerary(
      {
        itinerary: itinerary({summary: 'Forged ownership attempt.'}),
        // None of these are in the input schema; they must have no effect.
        sub: BOB,
        orgCode: ORG_B,
        resourceId: `${ORG_B}:${BOB}`,
        id: 'attacker-chosen-id',
        createdAt: '1999-01-01T00:00:00.000Z'
      } as never,
      {requestContext: attacker}
    );

    expect(forged.saved).toBe(true);
    // Filed under the attacker's own identity, not the one they asked for.
    expect(forged.orgCode).toBe(ORG_A);
    expect(forged.itineraryId).not.toBe('attacker-chosen-id');
    expect(forged.savedAt).not.toBe('1999-01-01T00:00:00.000Z');

    // And it never lands in the victim's list.
    const victimList = await listItineraries({limit: 50} as never, {requestContext: victim});
    expect(victimList.itineraries.some(e => e.id === forged.itineraryId)).toBe(false);
  });

  it('returns server-owned metadata on the saved record', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ, CREATE]});
    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });

    expect(result.itineraryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(result.savedAt!).toISOString()).not.toThrow();
    expect(result.orgCode).toBe(ORG_A);
  });

  it('refuses to save for a token with no organization', async () => {
    const context = await contextFor({sub: ALICE, permissions: [READ, CREATE]});

    const result = await saveItinerary({itinerary: itinerary()} as never, {
      requestContext: context
    });

    expect(result.saved).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// list-itineraries
// ---------------------------------------------------------------------------

describe('list-itineraries', () => {
  it('returns the signed-in user\'s own saved itineraries', async () => {
    const context = await contextFor({sub: 'kp:user_carla', orgCode: ORG_A, permissions: [READ, CREATE]});

    const saved = await saveItinerary(
      {itinerary: itinerary({summary: "Carla's plan."})} as never,
      {requestContext: context}
    );
    const listed = await listItineraries({limit: 10} as never, {requestContext: context});

    expect(listed.authorized).toBe(true);
    expect(listed.count).toBeGreaterThan(0);
    expect(listed.itineraries.some(e => e.id === saved.itineraryId)).toBe(true);
  });

  it('denies a user without read:itinerary', async () => {
    const context = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [CREATE]});

    const result = await listItineraries({limit: 10} as never, {requestContext: context});

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('permission_denied');
    expect(result.requiredPermission).toBe(READ);
    expect(result.itineraries).toEqual([]);
  });

  it('denies an unauthenticated request', async () => {
    const result = await listItineraries({limit: 10} as never, {
      requestContext: new RequestContext()
    });

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('unauthenticated');
  });

  it('returns a clean empty result for a user with nothing saved', async () => {
    const context = await contextFor({sub: 'kp:user_newcomer', orgCode: ORG_A, permissions: [READ]});

    const result = await listItineraries({limit: 10} as never, {requestContext: context});

    expect(result.authorized).toBe(true);
    expect(result.count).toBe(0);
    expect(result.itineraries).toEqual([]);
    expect(result.message).toContain('no saved itineraries');
  });

  it('honours the result limit', async () => {
    const context = await contextFor({sub: 'kp:user_dan', orgCode: ORG_A, permissions: [READ, CREATE]});

    for (let i = 0; i < 3; i += 1) {
      await saveItinerary({itinerary: itinerary({summary: `Plan ${i}.`})} as never, {
        requestContext: context
      });
    }

    const limited = await listItineraries({limit: 2} as never, {requestContext: context});
    expect(limited.itineraries).toHaveLength(2);
    expect(limited.count).toBe(2);

    const all = await listItineraries({limit: 50} as never, {requestContext: context});
    expect(all.count).toBe(3);
  });

  it('ignores ownership fields supplied in tool input', async () => {
    const alice = await contextFor({sub: ALICE, orgCode: ORG_A, permissions: [READ, CREATE]});
    const bob = await contextFor({sub: BOB, orgCode: ORG_A, permissions: [READ, CREATE]});

    const bobSaved = await saveItinerary(
      {itinerary: itinerary({summary: "Bob's private plan."})} as never,
      {requestContext: bob}
    );

    const aliceAsking = await listItineraries(
      {limit: 50, sub: BOB, orgCode: ORG_A, resourceId: `${ORG_A}:${BOB}`} as never,
      {requestContext: alice}
    );

    expect(aliceAsking.itineraries.some(e => e.id === bobSaved.itineraryId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

describe('isolation', () => {
  it('keeps two users in the same organization separate', async () => {
    const alice = await contextFor({sub: 'kp:iso_alice', orgCode: ORG_A, permissions: [READ, CREATE]});
    const bob = await contextFor({sub: 'kp:iso_bob', orgCode: ORG_A, permissions: [READ, CREATE]});

    const aliceSaved = await saveItinerary(
      {itinerary: itinerary({summary: 'Alice only.'})} as never,
      {requestContext: alice}
    );
    const bobSaved = await saveItinerary({itinerary: itinerary({summary: 'Bob only.'})} as never, {
      requestContext: bob
    });

    const aliceList = await listItineraries({limit: 50} as never, {requestContext: alice});
    const bobList = await listItineraries({limit: 50} as never, {requestContext: bob});

    expect(aliceList.itineraries.map(e => e.id)).toEqual([aliceSaved.itineraryId]);
    expect(bobList.itineraries.map(e => e.id)).toEqual([bobSaved.itineraryId]);
  });

  it('prevents organization A from seeing organization B records', async () => {
    const inA = await contextFor({sub: 'kp:iso_org', orgCode: ORG_A, permissions: [READ, CREATE]});
    const inB = await contextFor({sub: 'kp:iso_org', orgCode: ORG_B, permissions: [READ, CREATE]});

    const savedInB = await saveItinerary(
      {itinerary: itinerary({summary: 'Org B only.'})} as never,
      {requestContext: inB}
    );

    const listFromA = await listItineraries({limit: 50} as never, {requestContext: inA});
    expect(listFromA.itineraries.some(e => e.id === savedInB.itineraryId)).toBe(false);
  });

  it('isolates the same person across their two organizations', async () => {
    const inA = await contextFor({sub: 'kp:multi_org', orgCode: ORG_A, permissions: [READ, CREATE]});
    const inB = await contextFor({sub: 'kp:multi_org', orgCode: ORG_B, permissions: [READ, CREATE]});

    const savedInA = await saveItinerary({itinerary: itinerary({summary: 'A side.'})} as never, {
      requestContext: inA
    });
    const savedInB = await saveItinerary({itinerary: itinerary({summary: 'B side.'})} as never, {
      requestContext: inB
    });

    const fromA = await listItineraries({limit: 50} as never, {requestContext: inA});
    const fromB = await listItineraries({limit: 50} as never, {requestContext: inB});

    expect(fromA.itineraries.map(e => e.id)).toEqual([savedInA.itineraryId]);
    expect(fromB.itineraries.map(e => e.id)).toEqual([savedInB.itineraryId]);
  });
});
