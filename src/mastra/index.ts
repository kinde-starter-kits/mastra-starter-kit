import {Mastra} from '@mastra/core/mastra';
import {registerApiRoute} from '@mastra/core/server';
import {MASTRA_RESOURCE_ID_KEY} from '@mastra/core/request-context';
import {MastraAuthKinde} from '@kinde-oss/mastra-auth-kinde';

import {getKindeUser, getOrgCode, getPermissions, resourceIdForUser, PERMISSIONS} from './lib/kinde';
import {tripAgent} from './agents/trip-agent';
import {planTripWorkflow} from './workflows/plan-trip';
import {storage} from './storage';

export {storage};

/**
 * Kinde authentication for every Mastra server route.
 *
 * `MastraAuthKinde` verifies the incoming `Authorization: Bearer <token>`
 * against your tenant's JWKS (signature, issuer, expiry, and audience when
 * configured). We add no verification logic of our own — that is the whole
 * point of using the provider.
 *
 * `allowedOrgCodes` is optional. When set, the provider rejects any token
 * whose `org_code` is not in the list, which is the coarse organization gate.
 * Fine-grained permission checks happen later, at the tool boundary.
 */
export const auth = new MastraAuthKinde({
  domain: process.env.KINDE_DOMAIN,
  audience: process.env.KINDE_AUDIENCE,
  allowedOrgCodes: parseAllowedOrgCodes(process.env.KINDE_ALLOWED_ORG_CODES),

  /**
   * Derive memory identity from the verified token, never from the client.
   * Mastra sets the result on the request context under
   * `MASTRA_RESOURCE_ID_KEY`, which takes precedence over any `resourceId`
   * the browser sends.
   */
  mapUserToResourceId: resourceIdForUser
});

function parseAllowedOrgCodes(raw: string | undefined): string[] | undefined {
  const codes = (raw ?? '')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean);
  return codes.length > 0 ? codes : undefined;
}

/**
 * `GET /api/me` — the frontend calls this immediately after sign-in.
 *
 * It exists to make the integration legible: it echoes back exactly what the
 * Mastra server derived from the Kinde token, so a developer can see at a
 * glance whether `org_code` and `permissions` actually arrived. If either is
 * missing here, the Kinde dashboard is not configured yet (see README).
 *
 * It is also the proof that authenticated requests reach Mastra: without a
 * valid token this route returns 401 before the handler ever runs.
 */
const meRoute = registerApiRoute('/me', {
  method: 'GET',
  handler: async c => {
    const requestContext = c.get('requestContext');
    const user = getKindeUser(requestContext);

    if (!user) {
      return c.json({error: 'Unauthenticated'}, 401);
    }

    const permissions = getPermissions(user);

    return c.json({
      // Identity, straight from the verified token.
      sub: user.sub ?? null,
      orgCode: getOrgCode(user) ?? null,
      permissions,

      // The server-derived memory identity. The browser never chooses this.
      resourceId: requestContext.get(MASTRA_RESOURCE_ID_KEY) ?? null,

      // Precomputed so the UI can disable the save affordance up front rather
      // than discovering the denial only after a tool call fails.
      can: {
        readItinerary: permissions.includes(PERMISSIONS.readItinerary),
        createItinerary: permissions.includes(PERMISSIONS.createItinerary)
      },

      // Surfaced so a misconfigured Kinde tenant is obvious instead of subtle.
      claimWarnings: buildClaimWarnings(user.org_code, user.permissions)
    });
  }
});

function buildClaimWarnings(orgCode: unknown, permissions: unknown): string[] {
  const warnings: string[] = [];
  if (typeof orgCode !== 'string' || orgCode.length === 0) {
    warnings.push(
      'No `org_code` claim on the access token. Enable organizations for this application in Kinde, and sign in to an organization.'
    );
  }
  if (!Array.isArray(permissions)) {
    warnings.push(
      'No `permissions` claim on the access token. Enable the permissions claim for this application in Kinde and assign permissions to the user.'
    );
  }
  return warnings;
}

export const mastra = new Mastra({
  storage,
  agents: {tripAgent},
  workflows: {planTripWorkflow},
  server: {
    auth,
    apiRoutes: [meRoute],
    // The SPA runs on a different origin in development.
    cors: {
      origin: (process.env.APP_ORIGIN ?? 'http://localhost:5173').split(','),
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      credentials: false
    }
  }
});
