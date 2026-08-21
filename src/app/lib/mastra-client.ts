import type {AgentResponse} from '../../mastra/schemas/agent-response';
import type {Itinerary} from '../../mastra/schemas/itinerary';
import type {SavedItinerary} from '../../mastra/schemas/saved-itinerary';

import {env} from '../env';

/**
 * The only place the app talks to Mastra.
 *
 * Every call carries the Kinde access token as a bearer token. That token —
 * not a cookie, not a session — is what `MastraAuthKinde` verifies. Identity is
 * never sent as data: no user id, no organization, no resource id. The server
 * derives all of that from the token.
 *
 * Types are imported from the backend schemas rather than restated, so the two
 * sides cannot drift. The imports are type-only, so no Zod reaches the bundle.
 */

export type {AgentResponse, Itinerary, SavedItinerary};

/** Where the model credential for a request came from. Never the key itself. */
export type KeySource = 'request' | 'server' | null;

export type Identity = {
  sub: string | null;
  orgCode: string | null;
  permissions: string[];
  resourceId: string | null;
  can: {
    readItinerary: boolean;
    createItinerary: boolean;
  };
  claimWarnings: string[];
  ai: {provider: 'openai'; keySource: KeySource};
};

/** Header carrying a caller-supplied model key. Matches the server constant. */
const OPENAI_KEY_HEADER = 'x-openai-api-key';

/**
 * Categories the UI can act on. Derived from the server's response, never from
 * a raw provider payload.
 */
export type FailureKind =
  | 'auth_expired'
  | 'org_not_allowed'
  | 'model_key_missing'
  | 'model_auth_failed'
  | 'model_unreachable'
  | 'workflow_failed'
  | 'network'
  | 'unknown';

/** A failure worth showing a user, with the technical detail kept for the console. */
export class MastraRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly kind: FailureKind = 'unknown',
    readonly detail?: string
  ) {
    super(message);
    this.name = 'MastraRequestError';
  }
}

/**
 * Classify a failure from the server's own error text.
 *
 * The detail string is matched only to choose a category and a heading. It is
 * never rendered to the user directly, so a provider payload cannot reach the
 * interface through this path.
 */
function classify(status: number, detail: string): {kind: FailureKind; message: string} {
  if (status === 401) {
    return {kind: 'auth_expired', message: 'Your session has expired. Sign in again to continue.'};
  }
  if (status === 403) {
    return {
      kind: 'org_not_allowed',
      message: 'Your Kinde organization is not allowed to use this app.'
    };
  }
  if (/model_key_missing|No OpenAI API key is available/i.test(detail)) {
    return {
      kind: 'model_key_missing',
      message: 'Add an OpenAI API key to start planning.'
    };
  }
  if (/\b401\b|invalid_api_key|incorrect api key|authentication/i.test(detail)) {
    return {
      kind: 'model_auth_failed',
      message: 'OpenAI authentication failed. Check your API key and try again.'
    };
  }
  if (/UND_ERR_SOCKET|ECONNREFUSED|ENOTFOUND|other side closed|Cannot connect to API|fetch failed|timed out/i.test(detail)) {
    return {
      kind: 'model_unreachable',
      message: 'Could not reach OpenAI. The request could not connect to the OpenAI API.'
    };
  }
  if (status >= 500) {
    return {kind: 'workflow_failed', message: 'The planning agent could not complete this request.'};
  }
  return {kind: 'unknown', message: 'Something went wrong with that request. Please try again.'};
}

function friendlyError(status: number, detail: string): MastraRequestError {
  const {kind, message} = classify(status, detail);
  // Developers get the specifics in the console; users get a sentence.
  console.error(`[mastra] ${status} (${kind})`, detail);
  return new MastraRequestError(status, message, kind, detail);
}

async function callMastra<T>(
  path: string,
  token: string | undefined,
  init: RequestInit = {},
  openaiKey?: string
): Promise<T> {
  let res: Response;

  try {
    res = await fetch(`${env.mastraUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
        // Sent per request, from memory. Never stored, never in the URL.
        ...(openaiKey ? {[OPENAI_KEY_HEADER]: openaiKey} : {}),
        ...init.headers
      }
    });
  } catch (cause) {
    console.error('[mastra] network failure', cause);
    throw new MastraRequestError(
      0,
      `Could not reach the planner at ${env.mastraUrl}. Is the Mastra server running?`,
      'network'
    );
  }

  if (!res.ok) {
    throw friendlyError(res.status, await res.text().catch(() => ''));
  }

  return res.json() as Promise<T>;
}

/** Identity as the server sees it — used to show who is signed in. */
export function fetchIdentity(
  token: string | undefined,
  openaiKey?: string
): Promise<Identity> {
  return callMastra<Identity>('/me', token, {}, openaiKey);
}

/**
 * The shape Mastra's `start-async` endpoint returns for a workflow run.
 * Only the fields this app reads are described.
 */
type WorkflowRunResponse = {
  status?: string;
  result?: unknown;
  error?: unknown;
};

/**
 * Run the plan-trip workflow and wait for its result.
 *
 * `start-async` runs the workflow to completion in one request, which suits a
 * request/response UI. Only `message` and `threadId` are sent: the workflow's
 * input schema has no identity fields, and the memory resource is derived
 * server-side from the verified token.
 */
export async function runPlanTrip(
  token: string | undefined,
  input: {message: string; threadId: string},
  openaiKey?: string
): Promise<AgentResponse> {
  const run = await callMastra<WorkflowRunResponse>(
    '/api/workflows/planTripWorkflow/start-async',
    token,
    {
      method: 'POST',
      // The key is NOT in this body — it travels in a header, so it never
      // enters workflow input, workflow state, or a trace.
      body: JSON.stringify({inputData: input})
    },
    openaiKey
  );

  if (run.status && run.status !== 'success') {
    const detail = typeof run.error === 'string' ? run.error : JSON.stringify(run.error ?? {});
    console.error('[mastra] workflow did not succeed', run);
    const {kind, message} = classify(500, detail);
    throw new MastraRequestError(500, message, kind, detail);
  }

  const response = run.result as AgentResponse | undefined;

  if (!response || typeof response !== 'object' || !('kind' in response)) {
    console.error('[mastra] unexpected workflow result', run);
    throw new MastraRequestError(
      500,
      'The planner returned something unexpected. Please retry.',
      'workflow_failed'
    );
  }

  return response;
}
