import {Mastra} from '@mastra/core/mastra';
import {registerApiRoute} from '@mastra/core/server';
import {VercelDeployer} from '@mastra/deployer-vercel';
import {MASTRA_RESOURCE_ID_KEY} from '@mastra/core/request-context';
import {MastraAuthKinde} from '@kinde-oss/mastra-auth-kinde';

import {getKindeUser, getOrgCode, getPermissions, resourceIdForUser, PERMISSIONS} from './lib/kinde';
import {tripAgent} from './agents/trip-agent';
import {tripMemory} from './memory';
import {
  ConversationAccessError,
  listConversations,
  loadConversation
} from './lib/conversations';
import {planTripWorkflow} from './workflows/plan-trip';
import {storage} from './storage';
import {
  OPENAI_KEY_HEADER,
  hasModelKey,
  runWithRequestModelKey
} from './lib/model-key';

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
      claimWarnings: buildClaimWarnings(user.org_code, user.permissions),

      /*
       * Which model credential this request would use. Reports only the
       * source, never the key.
       *
       * This deployment is strictly bring-your-own, so the answer is either
       * the caller's own key or nothing at all. There is no server credential
       * to report and none to fall back on.
       */
      ai: {
        provider: 'openai' as const,
        keySource: hasModelKey() ? ('request' as const) : null
      }
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

/**
 * Conversation routes.
 *
 * Mastra reserves the `/api` prefix for its own routes and rejects a custom
 * route that starts with it, so these live at `/conversations`. Both derive the
 * resource id from the verified request context and never read an owner,
 * subject, organization or resource id from the request.
 */
const conversationsRoute = registerApiRoute('/conversations', {
  method: 'GET',
  handler: async c => {
    const requestContext = c.get('requestContext');
    const user = getKindeUser(requestContext);
    const resourceId = resourceIdForUser(user);

    if (!user || !resourceId) {
      return c.json({error: 'Unauthenticated'}, 401);
    }

    const conversations = await listConversations({memory: tripMemory, resourceId});
    return c.json({conversations});
  }
});

const conversationRoute = registerApiRoute('/conversations/:threadId', {
  method: 'GET',
  handler: async c => {
    const requestContext = c.get('requestContext');
    const user = getKindeUser(requestContext);
    const resourceId = resourceIdForUser(user);

    if (!user || !resourceId) {
      return c.json({error: 'Unauthenticated'}, 401);
    }

    try {
      const conversation = await loadConversation({
        memory: tripMemory,
        resourceId,
        threadId: c.req.param('threadId')
      });
      return c.json(conversation);
    } catch (error) {
      if (error instanceof ConversationAccessError) {
        // Same response whether it is missing or owned by someone else.
        return c.json({error: 'Conversation not found.'}, 404);
      }
      throw error;
    }
  }
});

export const mastra = new Mastra({
  storage,
  agents: {tripAgent},
  workflows: {planTripWorkflow},
  /*
   * Deploys this same server to Vercel as one serverless function.
   *
   * `mastra build` hands the Hono application to `hono/vercel` and writes the
   * Vercel Build Output API v3 layout, with every route directed at that
   * function. Nothing about the application changes: the agent, the tools, the
   * workflow, the auth provider, the custom routes and the middleware are the
   * ones defined in this file. The deployer is only read by the build command.
   */
  deployer: new VercelDeployer({
    /*
     * Discovery is slower than a default serverless budget allows.
     *
     * Measured against the live map server: San Francisco takes about 20
     * seconds to answer and London about 13, because a dense city matches a
     * great many places. On the default limit the function was killed
     * mid-request, so every tool in the run appeared to fail at once and the
     * agent reported that it could not reach weather or activities.
     *
     * Sixty seconds is the ceiling on the lowest Vercel plan and leaves room
     * for a slow query plus the model turn that follows it.
     */
    maxDuration: 60
  }),
  server: {
    auth,
    apiRoutes: [meRoute, conversationsRoute, conversationRoute],
    middleware: [
      {
        /*
         * Lift a caller-supplied OpenAI key off the request header into
         * AsyncLocalStorage for the duration of this request.
         *
         * The header is read here and nowhere else. The value is never copied
         * onto RequestContext (which Mastra can serialise into workflow
         * snapshots), never placed in workflow input, and never logged. The
         * header name itself is not secret; the value is, and it stays in
         * process memory for one request.
         */
        path: '*',
        handler: async (c, next) => {
          const suppliedKey = c.req.header(OPENAI_KEY_HEADER);
          return runWithRequestModelKey(suppliedKey, () => next());
        }
      }
    ],
    // The SPA runs on a different origin in development.
    cors: {
      origin: (process.env.APP_ORIGIN ?? 'http://localhost:5173').split(','),
      // OPENAI_KEY_HEADER must be listed, or the browser's preflight rejects
      // every BYOK request before it is sent.
      allowHeaders: ['Content-Type', 'Authorization', OPENAI_KEY_HEADER],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      credentials: false
    }
  }
});
