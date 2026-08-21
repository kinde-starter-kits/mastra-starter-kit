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
};

/** A failure worth showing a user, with the technical detail kept for the console. */
export class MastraRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'MastraRequestError';
  }
}

function friendlyError(status: number, detail: string): MastraRequestError {
  const message =
    status === 401
      ? 'Your session has expired. Sign in again to continue.'
      : status === 403
        ? 'Your Kinde organization is not allowed to use this app.'
        : status >= 500
          ? 'The planner is unavailable right now. Please try again.'
          : 'Something went wrong with that request. Please try again.';

  // Developers get the specifics; users get a sentence.
  console.error(`[mastra] ${status}: ${detail}`);
  return new MastraRequestError(status, message, detail);
}

async function callMastra<T>(
  path: string,
  token: string | undefined,
  init: RequestInit = {}
): Promise<T> {
  let res: Response;

  try {
    res = await fetch(`${env.mastraUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
        ...init.headers
      }
    });
  } catch (cause) {
    console.error('[mastra] network failure', cause);
    throw new MastraRequestError(
      0,
      `Could not reach the planner at ${env.mastraUrl}. Is the Mastra server running?`
    );
  }

  if (!res.ok) {
    throw friendlyError(res.status, await res.text().catch(() => ''));
  }

  return res.json() as Promise<T>;
}

/** Identity as the server sees it — used to show who is signed in. */
export function fetchIdentity(token: string | undefined): Promise<Identity> {
  return callMastra<Identity>('/me', token);
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
  input: {message: string; threadId: string}
): Promise<AgentResponse> {
  const run = await callMastra<WorkflowRunResponse>(
    '/api/workflows/planTripWorkflow/start-async',
    token,
    {
      method: 'POST',
      body: JSON.stringify({inputData: input})
    }
  );

  if (run.status && run.status !== 'success') {
    console.error('[mastra] workflow did not succeed', run);
    throw new MastraRequestError(
      500,
      'The planner could not complete that request. Try rephrasing it.',
      typeof run.error === 'string' ? run.error : JSON.stringify(run.error ?? {})
    );
  }

  const response = run.result as AgentResponse | undefined;

  if (!response || typeof response !== 'object' || !('kind' in response)) {
    console.error('[mastra] unexpected workflow result', run);
    throw new MastraRequestError(500, 'The planner returned something unexpected. Please retry.');
  }

  return response;
}
