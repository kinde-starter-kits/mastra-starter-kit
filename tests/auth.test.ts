import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {
  TEST_DOMAIN,
  TEST_AUDIENCE,
  mintToken,
  startTestTenant,
  stopTestTenant
} from './helpers/kinde-test-tenant.js';
import {createTestServer, type TestApp} from './helpers/test-server.js';

/**
 * These tests boot the ACTUAL Mastra instance from src/mastra/index.ts, so
 * they verify the wiring this starter kit ships — not a test-only copy of it.
 */
let app: TestApp;

beforeAll(async () => {
  await startTestTenant();

  process.env.KINDE_DOMAIN = TEST_DOMAIN;
  process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
  process.env.KINDE_ALLOWED_ORG_CODES = '';
  process.env.DATABASE_URL = ':memory:';

  const {mastra} = await import('../src/mastra/index.js');
  app = createTestServer(mastra);
});

afterAll(() => {
  stopTestTenant();
});

const ORG = 'org_starterkit';
const SUB = 'kp:user_alice';

function get(token?: string, headers: Record<string, string> = {}) {
  return app.request('/me', {
    headers: {...(token ? {authorization: `Bearer ${token}`} : {}), ...headers}
  });
}

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await get();
    expect(res.status).toBe(401);
  });

  it('rejects a token that is not a JWT', async () => {
    const res = await get('not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('rejects a token signed by an unknown key', async () => {
    // A well-formed JWT whose signature does not match the tenant's JWKS.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrcDp1c2VyX2V2aWwifQ.' +
      'c2lnbmF0dXJlLXRoYXQtaXMtbm90LXZhbGlk';
    const res = await get(forged);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await mintToken({sub: SUB, orgCode: ORG, expiresInSeconds: -60});
    const res = await get(token);
    expect(res.status).toBe(401);
  });

  it('rejects a token from the wrong issuer', async () => {
    const token = await mintToken({
      sub: SUB,
      orgCode: ORG,
      issuer: 'https://attacker.kinde.com'
    });
    const res = await get(token);
    expect(res.status).toBe(401);
  });

  it('rejects a token for the wrong audience', async () => {
    const token = await mintToken({
      sub: SUB,
      orgCode: ORG,
      audience: ['https://api.someone-else.example']
    });
    const res = await get(token);
    expect(res.status).toBe(401);
  });

  it('accepts a valid Kinde identity and reaches the Mastra route handler', async () => {
    const token = await mintToken({sub: SUB, orgCode: ORG, permissions: ['read:itinerary']});
    const res = await get(token);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sub).toBe(SUB);
    expect(body.orgCode).toBe(ORG);
  });
});

describe('permissions surfaced to the application', () => {
  it('reports createItinerary false when the permission is absent', async () => {
    const token = await mintToken({sub: SUB, orgCode: ORG, permissions: ['read:itinerary']});
    const body = await (await get(token)).json();

    expect(body.permissions).toEqual(['read:itinerary']);
    expect(body.can).toEqual({readItinerary: true, createItinerary: false});
  });

  it('reports createItinerary true when the permission is present', async () => {
    const token = await mintToken({
      sub: SUB,
      orgCode: ORG,
      permissions: ['read:itinerary', 'create:itinerary']
    });
    const body = await (await get(token)).json();

    expect(body.can).toEqual({readItinerary: true, createItinerary: true});
  });

  it('fails closed when the permissions claim is missing entirely', async () => {
    const token = await mintToken({sub: SUB, orgCode: ORG});
    const body = await (await get(token)).json();

    expect(body.permissions).toEqual([]);
    expect(body.can).toEqual({readItinerary: false, createItinerary: false});
    expect(body.claimWarnings.join(' ')).toContain('permissions');
  });

  it('warns when the org_code claim is missing', async () => {
    const token = await mintToken({sub: SUB, permissions: ['read:itinerary']});
    const body = await (await get(token)).json();

    expect(body.orgCode).toBeNull();
    expect(body.claimWarnings.join(' ')).toContain('org_code');
  });
});

describe('resource identity', () => {
  it('derives the resource id from the authenticated org_code and sub', async () => {
    const token = await mintToken({sub: SUB, orgCode: ORG});
    const body = await (await get(token)).json();

    expect(body.resourceId).toBe(`${ORG}:${SUB}`);
  });

  it('gives two users in the same org different resource ids', async () => {
    const alice = await mintToken({sub: 'kp:user_alice', orgCode: ORG});
    const bob = await mintToken({sub: 'kp:user_bob', orgCode: ORG});

    const aliceBody = await (await get(alice)).json();
    const bobBody = await (await get(bob)).json();

    expect(aliceBody.resourceId).not.toBe(bobBody.resourceId);
  });

  it('gives the same person in two orgs different resource ids', async () => {
    const inOrgA = await mintToken({sub: SUB, orgCode: 'org_a'});
    const inOrgB = await mintToken({sub: SUB, orgCode: 'org_b'});

    const bodyA = await (await get(inOrgA)).json();
    const bodyB = await (await get(inOrgB)).json();

    expect(bodyA.resourceId).toBe(`org_a:${SUB}`);
    expect(bodyB.resourceId).toBe(`org_b:${SUB}`);
  });

  it('ignores a client-supplied resource id and uses the server-derived one', async () => {
    const token = await mintToken({sub: SUB, orgCode: ORG});

    const res = await get(token, {
      'x-test-request-context': JSON.stringify({
        mastra__resourceId: 'org_victim:kp:user_victim',
        resourceId: 'org_victim:kp:user_victim'
      })
    });

    const body = await res.json();
    expect(body.resourceId).toBe(`${ORG}:${SUB}`);
    expect(body.resourceId).not.toContain('victim');
  });

  it('does not derive a resource id for an M2M token (no sub)', async () => {
    const token = await mintToken({machineToMachine: true, orgCode: ORG});
    const res = await get(token);

    // The provider authenticates M2M tokens, but there is no human identity to
    // scope memory to, so no resource id is set.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sub).toBeNull();
    expect(body.resourceId).toBeNull();
  });
});
