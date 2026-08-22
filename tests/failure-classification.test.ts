import {describe, it, expect} from 'vitest';

import {
  FAILURE_TITLES,
  classifyFailure,
  failureMessage,
  sanitizeDetail,
  type FailureKind
} from '../src/app/lib/failure.js';

describe('classification', () => {
  it.each<[string, number, string, FailureKind]>([
    ['expired session', 401, 'Invalid or expired token', 'auth_expired'],
    ['disallowed org', 403, 'Forbidden', 'org_not_allowed'],
    ['unreachable server', 0, 'fetch failed', 'mastra_unreachable'],
    ['missing key', 500, 'ModelKeyMissingError: No OpenAI API key is available.', 'model_key_missing'],
    ['invalid key', 500, 'AI_APICallError: Incorrect API key provided', 'model_auth_failed'],
    ['invalid_api_key code', 500, '{"error":{"code":"invalid_api_key"}}', 'model_auth_failed'],
    ['rate limited', 500, '{"error":{"code":"rate_limit_exceeded"}}', 'model_rate_limited'],
    ['quota exhausted', 500, 'insufficient_quota: check your billing', 'model_rate_limited'],
    ['socket closed', 500, 'AI_APICallError: Cannot connect to API: other side closed', 'model_unreachable'],
    ['UND_ERR_SOCKET', 500, 'SocketError UND_ERR_SOCKET', 'model_unreachable'],
    ['ECONNRESET', 500, 'Error: read ECONNRESET', 'model_unreachable'],
    ['TLS failure', 500, 'SSL routines:tls_get_more_records:decryption failed or bad record mac', 'model_unreachable'],
    ['provider 500', 500, 'AI_APICallError: server_error from openai.com', 'model_api_error'],
    ['workflow failure', 500, 'step run-trip-agent failed', 'workflow_failed'],
    ['unknown', 400, 'something odd', 'unknown']
  ])('classifies %s', (_label, status, detail, expected) => {
    expect(classifyFailure(status, detail)).toBe(expected);
  });

  it('prefers authentication over the generic transport signal', () => {
    // A provider auth error whose text also mentions a connection.
    const detail = 'AI_APICallError: invalid_api_key (connection to api.openai.com)';
    expect(classifyFailure(500, detail)).toBe('model_auth_failed');
  });

  it('prefers rate limiting over a generic API error', () => {
    expect(classifyFailure(500, 'AI_APICallError 429 rate_limit_exceeded')).toBe(
      'model_rate_limited'
    );
  });

  it('has a title and a message for every kind', () => {
    const kinds = Object.keys(FAILURE_TITLES) as FailureKind[];
    for (const kind of kinds) {
      expect(FAILURE_TITLES[kind].length).toBeGreaterThan(0);
      expect(failureMessage(kind).length).toBeGreaterThan(0);
    }
  });

  it('distinguishes an unreachable Mastra server from an unreachable OpenAI', () => {
    expect(classifyFailure(0, 'fetch failed')).toBe('mastra_unreachable');
    expect(classifyFailure(500, 'AI_APICallError: other side closed')).toBe('model_unreachable');
  });
});

describe('sanitisation of diagnostics', () => {
  it('redacts an OpenAI key', () => {
    const out = sanitizeDetail('failed with key sk-proj-ABCDEFGH1234567890abcdefXYZ')!;
    expect(out).not.toContain('ABCDEFGH1234567890');
    expect(out).toContain('sk-***');
  });

  it('redacts a bearer token', () => {
    const out = sanitizeDetail('Authorization: Bearer abcdef1234567890TOKEN')!;
    expect(out).not.toContain('abcdef1234567890TOKEN');
  });

  it('redacts a JWT wherever it appears', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJrcDp1c2VyIn0.c2lnbmF0dXJl';
    const out = sanitizeDetail(`token was ${jwt} and then failed`)!;
    expect(out).not.toContain(jwt);
    expect(out).toContain('***');
  });

  it('redacts header, cookie and key fields in serialised objects', () => {
    const detail = JSON.stringify({
      headers: {authorization: 'Bearer secret-value', cookie: 'session=abc123'},
      'x-openai-api-key': 'sk-inline-secret',
      apiKey: 'another-secret'
    });
    const out = sanitizeDetail(detail)!;

    expect(out).not.toContain('secret-value');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('another-secret');
  });

  it('removes absolute filesystem paths', () => {
    const out = sanitizeDetail(
      'at handleFetchError (/Users/someone/projects/app/node_modules/x/index.mjs:605:14)'
    )!;
    expect(out).not.toContain('/Users/someone');
    expect(out).toContain('<path>');
  });

  it('removes Windows paths too', () => {
    const out = sanitizeDetail('at C:\\Users\\someone\\app\\index.js')!;
    expect(out).not.toContain('C:\\Users\\someone');
  });

  it('keeps the actionable part of the message', () => {
    const out = sanitizeDetail(
      'AI_APICallError: Cannot connect to API: other side closed at /Users/x/y.mjs:1:1'
    )!;
    expect(out).toContain('Cannot connect to API');
    expect(out).toContain('other side closed');
  });

  it('truncates very long diagnostics', () => {
    const out = sanitizeDetail('x'.repeat(5000))!;
    expect(out.length).toBeLessThanOrEqual(1201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns undefined when there is nothing to show', () => {
    expect(sanitizeDetail(undefined)).toBeUndefined();
    expect(sanitizeDetail('')).toBeUndefined();
  });
});

/**
 * Failures added by the stabilization pass.
 *
 * The distinction that matters: a plan that broke the user's own constraints is
 * not a broken planner, and a follow-up the model could not structure is not an
 * unreachable server. Reporting either as "could not reach the planner" sends
 * the user to debug the wrong thing.
 */
describe('validation and follow-up failures', () => {
  it('names a plan that could not satisfy the constraints', () => {
    const kind = classifyFailure(500, 'ItineraryValidationError: The generated plan did not satisfy the request.');

    expect(kind).toBe('itinerary_invalid');
    expect(FAILURE_TITLES[kind]).toMatch(/did not fit your request/i);
    expect(failureMessage(kind)).toMatch(/relaxing one of them/i);
  });

  it('does not blame the network when the model answered in prose', () => {
    const kind = classifyFailure(
      500,
      'The planner could not turn that into a plan. Try saying what to change more specifically.'
    );

    expect(kind).toBe('workflow_failed');
    expect(kind).not.toBe('mastra_unreachable');
    expect(failureMessage(kind)).not.toMatch(/could not reach|not responding/i);
  });

  it('still reports a genuine transport drop as unreachable', () => {
    // The workflow now passes the real cause through, so this keeps working.
    expect(classifyFailure(500, 'UND_ERR_SOCKET: other side closed')).toBe('model_unreachable');
  });

  it('still reports an unreachable Mastra process distinctly', () => {
    expect(classifyFailure(0, 'failed to fetch')).toBe('mastra_unreachable');
  });
});
