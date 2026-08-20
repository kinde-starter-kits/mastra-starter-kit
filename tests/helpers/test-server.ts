import {Hono, type Handler} from 'hono';
import {RequestContext} from '@mastra/core/request-context';
import {coreAuthMiddleware} from '@mastra/server/auth';
import type {Mastra} from '@mastra/core/mastra';

import {mergeClientRequestContext} from './merge-request-context.js';

type TestVariables = {
  requestContext: RequestContext;
  mastra: Mastra;
};

/**
 * Wraps a real Mastra instance in a Hono app for testing.
 *
 * The authentication decision is NOT reimplemented here: `coreAuthMiddleware`
 * is the same function Mastra's own server adapter calls, so these tests
 * exercise the real authenticate -> authorize -> resource-id pipeline against
 * the real `MastraAuthKinde` provider. Only the HTTP plumbing is local.
 */
export type TestApp = Hono<{Variables: TestVariables}>;

export function createTestServer(mastra: Mastra): TestApp {
  const serverConfig = mastra.getServer();
  const authConfig = serverConfig?.auth;
  const routes = serverConfig?.apiRoutes ?? [];

  // Mastra defaults custom routes to requiresAuth: true.
  const customRouteAuthConfig = new Map<string, boolean>();
  for (const route of routes) {
    customRouteAuthConfig.set(`${route.method}:${route.path}`, route.requiresAuth !== false);
  }

  const app = new Hono<{Variables: TestVariables}>();

  app.use('*', async (c, next) => {
    const requestContext = new RequestContext();
    c.set('requestContext', requestContext);
    c.set('mastra', mastra);

    // A client may try to seed the request context (Mastra supports this for
    // non-reserved keys). Mirror that here so tests can prove the reserved
    // resource-id key cannot be injected this way.
    const injected = c.req.header('x-test-request-context');
    if (injected) {
      mergeClientRequestContext(requestContext, JSON.parse(injected));
    }

    if (!authConfig) return next();

    const authHeader = c.req.header('authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim() || null;

    const result = await coreAuthMiddleware({
      path: new URL(c.req.url).pathname,
      method: c.req.method,
      getHeader: name => c.req.header(name),
      mastra,
      authConfig,
      customRouteAuthConfig,
      requestContext,
      rawRequest: c.req.raw,
      token,
      buildAuthorizeContext: () => null
    });

    if (result.action === 'error') {
      return c.json(result.body, result.status as 401 | 403);
    }
    return next();
  });

  for (const route of routes) {
    const handler = (route as {handler?: Handler}).handler;
    if (!handler) continue;
    app.on(route.method, route.path, handler as Handler<{Variables: TestVariables}>);
  }

  return app;
}
