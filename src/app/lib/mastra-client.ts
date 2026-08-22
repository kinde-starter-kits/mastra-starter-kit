import type {AgentResponse} from '../../mastra/schemas/agent-response';
import type {Itinerary} from '../../mastra/schemas/itinerary';
import type {SavedItinerary} from '../../mastra/schemas/saved-itinerary';

import type {PlanExecutionEvent} from '../../mastra/telemetry/plan-events';

import {env} from '../env';
import {
  createStreamDecoder,
  outcomeFrom,
  planEventFrom,
  stepErrorFrom,
  type StreamOutcome
} from './stream-protocol';
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

/**
 * The headers every Mastra call carries.
 *
 * Credentials live only here: the bearer token and the model key are headers,
 * never query parameters and never request bodies, so neither can reach a URL,
 * a server access log, or workflow state.
 */
function authHeaders(token: string | undefined, openaiKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
    // Sent per request, from memory. Never stored, never in the URL.
    ...(openaiKey ? {[OPENAI_KEY_HEADER]: openaiKey} : {})
  };
}

/** The single message shown when the Mastra process is not reachable. */
function unreachable(cause: unknown): MastraRequestError {
  console.error('[mastra] network failure', cause);
  return new MastraRequestError(
    0,
    `Could not reach the Mastra server at ${env.mastraUrl}. Start it with "npm run dev:mastra", or run both processes with "npm run dev".`,
    'mastra_unreachable'
  );
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
        ...authHeaders(token, openaiKey),
        ...init.headers
      }
    });
  } catch (cause) {
    throw unreachable(cause);
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

/**
 * A replayed exchange. `response` is the same envelope a live run returns, so
 * history renders through the same cards. The server rebuilds these from
 * memory; raw tool arguments and results never cross this boundary.
 */
export type ConversationTurn = {
  id: string;
  request: string;
  response: AgentResponse;
};

export type ConversationDetail = ConversationSummary & {
  turns: ConversationTurn[];
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

  return asAgentResponse(run.result, run);
}

/** The workflow key registered on the Mastra instance. */
const PLAN_WORKFLOW = 'planTripWorkflow';

/** Narrows a workflow result to the response envelope, or fails loudly. */
function asAgentResponse(result: unknown, context: unknown): AgentResponse {
  if (!result || typeof result !== 'object' || !('kind' in result)) {
    console.error('[mastra] unexpected workflow result', context);
    throw new MastraRequestError(
      500,
      'The planner returned something unexpected. Please retry.',
      'workflow_failed'
    );
  }

  return result as AgentResponse;
}

/**
 * Raised when the caller aborts a run. Distinct from a failure so the UI can
 * clear quietly instead of showing an error the user caused on purpose.
 */
export class PlanCancelledError extends Error {
  constructor() {
    super('Planning was cancelled.');
    this.name = 'PlanCancelledError';
  }
}

export type PlanStreamOptions = {
  openaiKey?: string;
  /** Called for each telemetry event, in wire order, as it arrives. */
  onEvent?: (event: PlanExecutionEvent) => void;
  signal?: AbortSignal;
};

function isAbort(cause: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (cause instanceof Error && cause.name === 'AbortError');
}

/**
 * Run the plan-trip workflow, reporting progress as it happens.
 *
 * Mastra's streaming endpoint requires a `runId` query parameter and creates
 * the run itself, so one request is enough — there is a `create-run` endpoint,
 * but calling it first would only add a round trip. The wire format is
 * documented and tested in `stream-protocol.ts`.
 *
 * The final itinerary still comes from the stream's terminal record, so the
 * caller gets exactly the same `AgentResponse` as `runPlanTrip` — streaming
 * adds visibility, not a second result contract. Only `message` and `threadId`
 * are sent; identity and the model key stay in headers.
 */
export async function streamPlanTrip(
  token: string | undefined,
  input: {message: string; threadId: string},
  options: PlanStreamOptions = {}
): Promise<AgentResponse> {
  const {openaiKey, onEvent, signal} = options;

  const runId = crypto.randomUUID();

  const url =
    `${env.mastraUrl}/api/workflows/${PLAN_WORKFLOW}/stream` +
    `?runId=${encodeURIComponent(runId)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token, openaiKey),
      // The model key is NOT in this body — it travels in a header, so it never
      // enters workflow input, workflow state, or a trace.
      body: JSON.stringify({inputData: input}),
      signal
    });
  } catch (cause) {
    if (isAbort(cause, signal)) throw new PlanCancelledError();
    throw unreachable(cause);
  }

  if (!res.ok) {
    throw friendlyError(res.status, await res.text().catch(() => ''));
  }

  if (!res.body) {
    // No readable stream in this environment. The workflow still runs to
    // completion on start-async, so degrade to it rather than failing.
    console.warn('[mastra] streaming unsupported here; falling back to start-async');
    return runPlanTrip(token, input, openaiKey);
  }

  const reader = res.body.getReader();
  const text = new TextDecoder();
  const decoder = createStreamDecoder();

  let outcome: StreamOutcome | undefined;
  let stepError: string | undefined;

  const consume = (records: ReturnType<typeof decoder.push>) => {
    for (const record of records) {
      const event = planEventFrom(record);
      if (event) {
        onEvent?.(event);
        continue;
      }

      stepError = stepErrorFrom(record) ?? stepError;
      outcome = outcomeFrom(record) ?? outcome;
    }
  };

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      consume(decoder.push(text.decode(value, {stream: true})));
    }
    consume(decoder.push(text.decode()));
    consume(decoder.flush());
  } catch (cause) {
    if (isAbort(cause, signal)) throw new PlanCancelledError();
    console.error('[mastra] stream interrupted', cause);
    throw new MastraRequestError(
      0,
      'The connection dropped while planning. Please retry.',
      'mastra_unreachable'
    );
  }

  if (!outcome || outcome.status !== 'success') {
    const detail = stepError ?? 'The workflow did not finish.';
    const kind = classifyFailure(500, detail);
    console.error('[mastra] workflow did not succeed', {status: outcome?.status, kind});
    throw new MastraRequestError(500, failureMessage(kind), kind, sanitizeDetail(detail));
  }

  return asAgentResponse(outcome.finalResult, {runId});
}
