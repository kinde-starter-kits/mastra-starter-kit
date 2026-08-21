import type {AgentResponse} from '../../mastra/schemas/agent-response';
import type {Itinerary} from '../../mastra/schemas/itinerary';
import type {SavedItinerary} from '../../mastra/schemas/saved-itinerary';

import {env} from '../env';
import {classifyFailure, failureMessage, sanitizeDetail, type FailureKind} from './failure';

export type {FailureKind};

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

function friendlyError(status: number, detail: string): MastraRequestError {
  const kind = classifyFailure(status, detail);
  // The console keeps the raw text for local debugging; anything surfaced in
  // the UI goes through sanitizeDetail first.
  console.error(`[mastra] ${status} (${kind})`, detail);
  return new MastraRequestError(status, failureMessage(kind), kind, sanitizeDetail(detail));
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
      `Could not reach the Mastra server at ${env.mastraUrl}. Start it with "npm run dev:mastra", or run both processes with "npm run dev".`,
      'mastra_unreachable'
    );
  }

  if (!res.ok) {
    throw friendlyError(res.status, await res.text().catch(() => ''));
  }

  return res.json() as Promise<T>;
}

/** Identity as the server sees it — used to show who is signed in. */
/** Conversation metadata. Never contains messages, keys or tokens. */
export type ConversationSummary = {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ConversationDetail = ConversationSummary & {
  messages: {role: string; content: unknown; createdAt: string}[];
};

/**
 * The caller's conversations. Ownership is derived server-side from the Kinde
 * token; no identity is sent from here.
 */
export function fetchConversations(token: string | undefined): Promise<{
  conversations: ConversationSummary[];
}> {
  return callMastra<{conversations: ConversationSummary[]}>('/conversations', token);
}

export function fetchConversation(
  token: string | undefined,
  threadId: string
): Promise<ConversationDetail> {
  return callMastra<ConversationDetail>(`/conversations/${encodeURIComponent(threadId)}`, token);
}

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
    const kind = classifyFailure(500, detail);
    throw new MastraRequestError(500, failureMessage(kind), kind, sanitizeDetail(detail));
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
