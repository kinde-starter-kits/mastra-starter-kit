import {describe, it, expect} from 'vitest';
import type {KindeUser} from '@kinde-oss/mastra-auth-kinde';
import {RequestContext} from '@mastra/core/request-context';

import {
  PERMISSIONS,
  UnauthenticatedError,
  getKindeUser,
  getOrgCode,
  getPermissions,
  hasPermission,
  requireKindeUser,
  resourceIdForUser
} from '../src/mastra/lib/kinde.js';

function user(overrides: Partial<KindeUser> = {}): KindeUser {
  return {
    iss: 'https://example.kinde.com',
    sub: 'kp:user_alice',
    aud: [],
    azp: 'client',
    exp: 0,
    iat: 0,
    jti: 'jti',
    scp: [],
    ...overrides
  } as KindeUser;
}

describe('getKindeUser', () => {
  it('reads the user from the documented context key', () => {
    const ctx = new RequestContext();
    ctx.set('user', user());
    expect(getKindeUser(ctx)?.sub).toBe('kp:user_alice');
  });

  it('falls back to the reserved internal key', () => {
    const ctx = new RequestContext();
    ctx.set('mastra__user', user({sub: 'kp:user_bob'}));
    expect(getKindeUser(ctx)?.sub).toBe('kp:user_bob');
  });

  it('returns null when there is no user', () => {
    expect(getKindeUser(new RequestContext())).toBeNull();
    expect(getKindeUser(undefined)).toBeNull();
  });
});

describe('requireKindeUser', () => {
  it('throws UnauthenticatedError when no user is present', () => {
    expect(() => requireKindeUser(new RequestContext())).toThrow(UnauthenticatedError);
  });
});

describe('permissions', () => {
  it('reads the permissions array', () => {
    expect(getPermissions(user({permissions: ['read:itinerary']}))).toEqual(['read:itinerary']);
  });

  it('treats a missing claim as no permissions (fails closed)', () => {
    expect(getPermissions(user())).toEqual([]);
    expect(hasPermission(user(), PERMISSIONS.createItinerary)).toBe(false);
  });

  it('treats a malformed claim as no permissions (fails closed)', () => {
    expect(getPermissions(user({permissions: 'create:itinerary' as never}))).toEqual([]);
  });

  it('matches an exact permission only', () => {
    const alice = user({permissions: ['read:itinerary']});
    expect(hasPermission(alice, PERMISSIONS.readItinerary)).toBe(true);
    expect(hasPermission(alice, PERMISSIONS.createItinerary)).toBe(false);
  });

  it('returns false for a null user', () => {
    expect(hasPermission(null, PERMISSIONS.readItinerary)).toBe(false);
  });
});

describe('resourceIdForUser', () => {
  it('composes org_code and sub', () => {
    expect(resourceIdForUser(user({org_code: 'org_abc'}))).toBe('org_abc:kp:user_alice');
  });

  it('returns undefined without an org_code, rather than a partial identity', () => {
    expect(resourceIdForUser(user())).toBeUndefined();
  });

  it('returns undefined for an M2M token with no sub', () => {
    expect(resourceIdForUser(user({sub: undefined, org_code: 'org_abc'}))).toBeUndefined();
  });

  it('returns undefined for an empty org_code', () => {
    expect(resourceIdForUser(user({org_code: ''}))).toBeUndefined();
    expect(getOrgCode(user({org_code: ''}))).toBeUndefined();
  });
});
