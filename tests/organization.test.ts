import {describe, it, expect, beforeAll, afterAll, vi} from 'vitest';
import {
  TEST_DOMAIN,
  TEST_AUDIENCE,
  mintToken,
  startTestTenant,
  stopTestTenant
} from './helpers/kinde-test-tenant.js';
import {createTestServer, type TestApp} from './helpers/test-server.js';

/**
 * Organization gating is configured through KINDE_ALLOWED_ORG_CODES, which
 * src/mastra/index.ts parses into the provider's `allowedOrgCodes` option.
 * Each block re-imports the module with different env so the shipped parsing
 * is under test too, not just the provider.
 */
async function bootWithAllowedOrgs(allowed: string): Promise<TestApp> {
  vi.resetModules();
  process.env.KINDE_DOMAIN = TEST_DOMAIN;
  process.env.KINDE_AUDIENCE = TEST_AUDIENCE;
  process.env.KINDE_ALLOWED_ORG_CODES = allowed;
  process.env.DATABASE_URL = ':memory:';

  const {mastra} = await import('../src/mastra/index.js');
  return createTestServer(mastra);
}

beforeAll(async () => {
  await startTestTenant();
});

afterAll(() => {
  stopTestTenant();
});

function get(app: TestApp, token: string) {
  return app.request('/me', {headers: {authorization: `Bearer ${token}`}});
}

describe('allowedOrgCodes', () => {
  it('accepts a user from an allowed organization', async () => {
    const app = await bootWithAllowedOrgs('org_allowed,org_other');
    const token = await mintToken({sub: 'kp:user_alice', orgCode: 'org_allowed'});

    const res = await get(app, token);
    expect(res.status).toBe(200);
  });

  it('rejects a user from a disallowed organization with 403', async () => {
    const app = await bootWithAllowedOrgs('org_allowed');
    const token = await mintToken({sub: 'kp:user_mallory', orgCode: 'org_not_allowed'});

    const res = await get(app, token);
    expect(res.status).toBe(403);
  });

  it('rejects a token with no org_code when a list is configured', async () => {
    const app = await bootWithAllowedOrgs('org_allowed');
    const token = await mintToken({sub: 'kp:user_alice'});

    const res = await get(app, token);
    expect(res.status).toBe(403);
  });

  it('trims whitespace in the env list', async () => {
    const app = await bootWithAllowedOrgs(' org_allowed , org_other ');
    const token = await mintToken({sub: 'kp:user_alice', orgCode: 'org_other'});

    const res = await get(app, token);
    expect(res.status).toBe(200);
  });

  it('allows every organization when the list is empty', async () => {
    const app = await bootWithAllowedOrgs('');
    const token = await mintToken({sub: 'kp:user_alice', orgCode: 'org_anything'});

    const res = await get(app, token);
    expect(res.status).toBe(200);
  });

  it('applies the org gate to M2M tokens too', async () => {
    const app = await bootWithAllowedOrgs('org_allowed');
    const token = await mintToken({machineToMachine: true, orgCode: 'org_not_allowed'});

    const res = await get(app, token);
    expect(res.status).toBe(403);
  });
});
