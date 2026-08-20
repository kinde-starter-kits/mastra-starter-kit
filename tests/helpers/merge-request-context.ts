import {
  MASTRA_AUTH_TOKEN_KEY,
  MASTRA_INHERITED_MEMORY_KEY,
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  MASTRA_VERSIONS_KEY,
  type RequestContext
} from '@mastra/core/request-context';

/**
 * Reserved request-context keys, mirroring the adapter's own reserved-key list.
 * Mastra does not export its `isReservedRequestContextKey` predicate, so the
 * set is reconstructed from the exported key constants.
 */
const RESERVED_KEYS = new Set<string>([
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  MASTRA_AUTH_TOKEN_KEY,
  MASTRA_VERSIONS_KEY,
  MASTRA_INHERITED_MEMORY_KEY,
  'mastra__user',
  'mastra__userPermissions',
  'mastra__userRoles'
]);

/**
 * Mirrors the adapter's `mergeRequestContext`: client-supplied context values
 * are accepted, except for reserved keys such as `mastra__resourceId`, which
 * are dropped. This is the mechanism that stops a browser from choosing whose
 * memory it reads.
 */
export function mergeClientRequestContext(
  requestContext: RequestContext,
  values: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(values)) {
    if (RESERVED_KEYS.has(key)) continue;
    requestContext.set(key, value);
  }
}
