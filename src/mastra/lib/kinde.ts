import type {KindeUser} from '@kinde-oss/mastra-auth-kinde';
import type {RequestContext} from '@mastra/core/request-context';

/**
 * The permissions this starter kit demonstrates.
 *
 * Create these in your Kinde dashboard under Settings -> Permissions, then
 * assign them to users (or to a role that users belong to) inside the
 * organization they sign in to. See README "Configure Kinde".
 */
export const PERMISSIONS = {
  /** Required to read saved itineraries. */
  readItinerary: 'read:itinerary',
  /** Required to persist an itinerary. This is the authorization showcase. */
  createItinerary: 'create:itinerary'
} as const;

export type DemoPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Mastra stores the user returned by `MastraAuthKinde.authenticateToken()` on
 * the request context after a request passes authentication. It writes the
 * value under both a documented public alias (`user`) and a reserved internal
 * key; we read the public one first and fall back, so this keeps working if
 * the alias is ever retired.
 */
const USER_KEY = 'user';
const RESERVED_USER_KEY = 'mastra__user';

/**
 * Read the verified Kinde user off the request context.
 *
 * This is the ONLY trustworthy source of identity inside a tool. Never read a
 * user id, org code, or permission list out of tool input — a caller controls
 * tool input, but it cannot forge this object, because it is derived from a
 * JWT that `MastraAuthKinde` verified against Kinde's JWKS.
 */
export function getKindeUser(requestContext?: RequestContext): KindeUser | null {
  if (!requestContext) return null;
  const user =
    (requestContext.get(USER_KEY) as KindeUser | undefined) ??
    (requestContext.get(RESERVED_USER_KEY) as KindeUser | undefined);
  return user ?? null;
}

/**
 * Thrown when a tool runs without an authenticated identity. In practice the
 * server rejects these requests before a tool is reached; this is defence in
 * depth for direct/programmatic invocation.
 */
export class UnauthenticatedError extends Error {
  readonly code = 'unauthenticated';
  constructor(message = 'No authenticated Kinde user on this request.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export function requireKindeUser(requestContext?: RequestContext): KindeUser {
  const user = getKindeUser(requestContext);
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * Kinde emits granted permissions as a flat array of strings on the access
 * token, which is how `@kinde-oss/mastra-auth-kinde` types the claim
 * (`permissions?: string[]`).
 *
 * IMPORTANT: the claim is absent from a default Kinde token — it only appears
 * once you enable it for the application in the Kinde dashboard. An absent
 * claim is treated as "no permissions granted", never as "allow", so a
 * misconfigured tenant fails closed.
 */
export function getPermissions(user: KindeUser | null | undefined): string[] {
  if (!user) return [];
  return Array.isArray(user.permissions) ? user.permissions : [];
}

export function hasPermission(
  user: KindeUser | null | undefined,
  permission: DemoPermission | string
): boolean {
  return getPermissions(user).includes(permission);
}

/**
 * The organization the token was issued for.
 *
 * Like `permissions`, `org_code` is only present when organizations are in use
 * and the claim is enabled for the application.
 */
export function getOrgCode(user: KindeUser | null | undefined): string | undefined {
  const orgCode = user?.org_code;
  return typeof orgCode === 'string' && orgCode.length > 0 ? orgCode : undefined;
}

/**
 * Derive the Mastra memory resource id from the verified token.
 *
 * Wired into `MastraAuthKinde` via `mapUserToResourceId`, so Mastra sets it on
 * the request context under `MASTRA_RESOURCE_ID_KEY` after authentication.
 * That key takes precedence over any client-supplied `resourceId`, which is
 * what stops one user from reading another user's memory.
 *
 * Shape: `<org_code>:<sub>` — memory is therefore scoped to a person *within*
 * an organization. The same human in two Kinde organizations gets two
 * independent memories, which is the correct behaviour for org-scoped data.
 *
 * Returns `undefined` when the token cannot produce a safe identity (for
 * example an M2M token, which has no `sub`). Mastra then leaves the resource
 * id unset rather than falling back to something attacker-controlled.
 */
export function resourceIdForUser(user: KindeUser | null | undefined): string | undefined {
  const sub = user?.sub;
  if (typeof sub !== 'string' || sub.length === 0) return undefined;

  const orgCode = getOrgCode(user);
  if (!orgCode) return undefined;

  return `${orgCode}:${sub}`;
}
