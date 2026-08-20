import {RequestContext} from '@mastra/core/request-context';
import {coreAuthMiddleware} from '@mastra/server/auth';
import type {Mastra} from '@mastra/core/mastra';

/**
 * Produce the RequestContext a tool would see for a given Kinde token.
 *
 * This runs the real pipeline — `MastraAuthKinde.authenticateToken` verifies
 * the signature against the test tenant's JWKS, `authorizeUser` gates it, and
 * `mapUserToResourceId` derives the resource id — using the same
 * `coreAuthMiddleware` the Mastra server calls. Nothing about identity is
 * hand-assembled, so what the tests exercise is what production does.
 */
export async function authenticatedContext(
  mastra: Mastra,
  token: string | null,
  path = '/api/agents'
): Promise<{requestContext: RequestContext; authorized: boolean; status?: number}> {
  const requestContext = new RequestContext();
  const authConfig = mastra.getServer()?.auth;

  if (!authConfig) return {requestContext, authorized: true};

  const result = await coreAuthMiddleware({
    path,
    method: 'POST',
    getHeader: name => (name.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined),
    mastra,
    authConfig,
    customRouteAuthConfig: undefined,
    requestContext,
    rawRequest: new Request(`http://localhost${path}`, {method: 'POST'}),
    token,
    buildAuthorizeContext: () => null
  });

  return {
    requestContext,
    authorized: result.action === 'next',
    status: result.action === 'error' ? result.status : undefined
  };
}
