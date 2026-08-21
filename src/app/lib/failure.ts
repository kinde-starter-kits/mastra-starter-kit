/**
 * Failure classification and diagnostic sanitisation.
 *
 * Two jobs, kept together because they operate on the same untrusted string:
 * decide which category a failure belongs to, and reduce the technical detail
 * to something safe to show a developer in the UI.
 *
 * The detail string can contain anything the server or provider emitted, so it
 * is never rendered until it has been through `sanitizeDetail`.
 */

export type FailureKind =
  | 'auth_expired'
  | 'org_not_allowed'
  | 'model_key_missing'
  | 'model_auth_failed'
  | 'model_rate_limited'
  | 'model_api_error'
  | 'model_unreachable'
  | 'mastra_unreachable'
  | 'workflow_failed'
  | 'unknown';

export const FAILURE_TITLES: Record<FailureKind, string> = {
  auth_expired: 'Session expired',
  org_not_allowed: 'Organization not allowed',
  model_key_missing: 'OpenAI API key required',
  model_auth_failed: 'OpenAI authentication failed',
  model_rate_limited: 'OpenAI rate limit reached',
  model_api_error: 'OpenAI returned an error',
  model_unreachable: 'Could not reach OpenAI',
  mastra_unreachable: 'Could not reach the Mastra server',
  workflow_failed: 'Unable to build your plan',
  unknown: 'Unable to build your plan'
};

const MESSAGES: Record<FailureKind, string> = {
  auth_expired: 'Your session has expired. Sign in again to continue.',
  org_not_allowed: 'Your Kinde organization is not allowed to use this app.',
  model_key_missing: 'Add an OpenAI API key to start planning.',
  model_auth_failed: 'Check your API key and try again.',
  model_rate_limited: 'Your OpenAI account is being rate limited. Wait a moment and try again.',
  model_api_error: 'OpenAI could not complete the request. Try again in a moment.',
  model_unreachable:
    'The request could not connect to the OpenAI API. This is usually temporary — try again.',
  mastra_unreachable: 'The planning server is not responding.',
  workflow_failed: 'The planning agent could not complete this request.',
  unknown: 'Something went wrong with that request. Please try again.'
};

/**
 * Order matters: the most specific signal wins. Authentication and rate-limit
 * checks run before the generic transport check, because a provider error
 * response can also mention connection details.
 */
export function classifyFailure(status: number, detail: string): FailureKind {
  const text = detail ?? '';

  if (status === 401) return 'auth_expired';
  if (status === 403) return 'org_not_allowed';
  if (status === 0) return 'mastra_unreachable';

  if (/model_key_missing|No OpenAI API key is available/i.test(text)) return 'model_key_missing';

  if (/invalid_api_key|incorrect api key|Invalid Authentication|\bAuthenticationError\b/i.test(text)) {
    return 'model_auth_failed';
  }
  if (/rate_?limit|429|quota|insufficient_quota|billing/i.test(text)) return 'model_rate_limited';

  if (
    /UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|other side closed|socket hang up|fetch failed|Cannot connect to API|decryption failed|bad record mac|TLS|SSL routines/i.test(
      text
    )
  ) {
    return 'model_unreachable';
  }

  if (/AI_APICallError|APICallError|openai\.com|server_error|\b5\d\d\b/i.test(text)) {
    return 'model_api_error';
  }

  if (status >= 500) return 'workflow_failed';
  return 'unknown';
}

export function failureMessage(kind: FailureKind): string {
  return MESSAGES[kind];
}

/**
 * Strip anything sensitive or noisy from a diagnostic string before it is
 * shown in the UI.
 *
 * Redacts API keys and bearer tokens, whole header/cookie lines, and absolute
 * filesystem paths, then truncates. The goal is a string a developer can act
 * on that leaks neither credentials nor the layout of the machine.
 */
export function sanitizeDetail(detail: string | undefined, maxLength = 1200): string | undefined {
  if (!detail) return undefined;

  let safe = detail;

  // Provider and platform key formats.
  safe = safe.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  safe = safe.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 ***');
  // JWTs, wherever they appear.
  safe = safe.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '***');
  // Header, cookie and key-bearing fields in serialised objects.
  safe = safe.replace(
    /("?(?:authorization|cookie|set-cookie|x-openai-api-key|api[_-]?key|apiKey|password|secret|token)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    '$1***'
  );
  // Absolute filesystem paths, POSIX and Windows.
  safe = safe.replace(/(?:\/(?:Users|home|var|opt|private|tmp)|[A-Za-z]:\\)[^\s'")]+/g, '<path>');

  if (safe.length > maxLength) safe = `${safe.slice(0, maxLength)}…`;
  return safe;
}
