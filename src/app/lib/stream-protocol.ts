import type {PlanExecutionEvent} from '../../mastra/telemetry/plan-events';

/**
 * Decoder for Mastra's workflow streaming wire format.
 *
 * ## The contract this file depends on
 *
 * Captured from a live Mastra dev server (server 1.25.1, `mastra` 1.60.0) on
 * 2026-08-21 by running a workflow that writes step output, once succeeding and
 * once throwing. The format is not documented, so it was observed rather than
 * assumed. What was measured:
 *
 * 1. A run must be created first:
 *      `POST /api/workflows/:workflowId/create-run` -> `{"runId": "<uuid>"}`
 *    Streaming without `?runId=` returns HTTP 400 ("Invalid query parameters").
 *
 * 2. The stream is:
 *      `POST /api/workflows/:workflowId/stream?runId=<uuid>`
 *      body `{"inputData": {...}}`
 *      -> 200, `content-type: text/plain`, `transfer-encoding: chunked`
 *
 * 3. Framing is **JSON text sequences** (RFC 7464 style): each record is a JSON
 *    object followed by a RECORD SEPARATOR, U+001E. The separator *trails*
 *    every record, including the last. There is no leading separator and — this
 *    is the trap — **no newlines anywhere**. A line-oriented (NDJSON) reader
 *    sees the whole response as one unparseable line and silently yields
 *    nothing. Splitting on U+001E is unambiguous because JSON requires control
 *    characters below U+0020 to be escaped, so the byte can never occur inside
 *    a string literal.
 *
 * 4. Records look like `{type, runId, from, payload}`. The observed sequence:
 *      workflow-start
 *      workflow-step-start
 *      workflow-step-output   <- `from: "USER"`, `payload.output` is our event
 *      workflow-step-result   <- `payload.status`: "success" | "failed"
 *      workflow-finish        <- `payload.workflowStatus`, `finalWorkflowResult`
 *
 * 5. On success, `workflow-finish` carries `payload.finalWorkflowResult` (the
 *    workflow's output — our `AgentResponse`). On failure, `workflow-finish`
 *    has `workflowStatus: "failed"` and **no** `finalWorkflowResult`, and the
 *    preceding `workflow-step-result` carries `payload.error` as
 *    `{message, name}`.
 *
 * If a future Mastra release changes any of this, the tests in
 * `stream-protocol.test.ts` — which are built from the captured bytes — are
 * what should fail first.
 */

/** RFC 7464 record separator (U+001E). Trails every record on the wire. */
export const RECORD_SEPARATOR = '\u001e';

/** A decoded record from the workflow stream. Only observed fields are typed. */
export type WorkflowStreamRecord = {
  type: string;
  runId?: string;
  from?: string;
  payload?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStreamRecord(value: unknown): WorkflowStreamRecord | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  return {
    type: value.type,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    from: typeof value.from === 'string' ? value.from : undefined,
    payload: isRecord(value.payload) ? value.payload : undefined
  };
}

/**
 * Parses one wire piece into records.
 *
 * Normally a piece is exactly one JSON object. The newline fallback is
 * defensive: if Mastra ever switches to NDJSON, a piece would arrive with
 * embedded newlines and would otherwise be dropped without a trace.
 */
function parsePiece(piece: string): WorkflowStreamRecord[] {
  const trimmed = piece.trim();
  if (!trimmed) return [];

  try {
    const record = toStreamRecord(JSON.parse(trimmed));
    return record ? [record] : [];
  } catch {
    // Not a single JSON value. Fall back to line-splitting before giving up.
  }

  if (!trimmed.includes('\n')) return [];

  const records: WorkflowStreamRecord[] = [];
  for (const line of trimmed.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const record = toStreamRecord(JSON.parse(text));
      if (record) records.push(record);
    } catch {
      // A malformed record is skipped. A stream must not fail on one bad frame.
    }
  }
  return records;
}

/**
 * Incremental decoder.
 *
 * Network chunks split wherever the transport decides, so a record can arrive
 * in pieces and several records can arrive in one chunk. The decoder buffers
 * whatever follows the last separator and emits only complete records.
 */
export function createStreamDecoder() {
  let buffer = '';

  return {
    /** Feed one chunk of text; returns the records completed by it. */
    push(chunk: string): WorkflowStreamRecord[] {
      buffer += chunk;
      if (!buffer.includes(RECORD_SEPARATOR)) return [];

      const pieces = buffer.split(RECORD_SEPARATOR);
      // The final piece has no terminator yet, so it stays buffered.
      buffer = pieces.pop() ?? '';

      return pieces.flatMap(parsePiece);
    },

    /**
     * Records left when the stream ends. Empty for a well-formed stream, since
     * the last record is terminated too — but a truncated or separator-less
     * final record is recovered here rather than lost.
     */
    flush(): WorkflowStreamRecord[] {
      const rest = buffer;
      buffer = '';
      return parsePiece(rest);
    }
  };
}

const PLAN_EVENT_MARKER = 'plan-execution-event';

const PLAN_EVENT_TYPES = new Set([
  'run_started',
  'stage_started',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'validation_completed',
  'correction_started',
  'model_retry',
  'run_completed',
  'run_failed'
]);

/**
 * Narrows a `workflow-step-output` payload to one of our telemetry events.
 *
 * The check is structural and lives here rather than importing the server's Zod
 * schema, so no validator reaches the browser bundle — the same reason the
 * client imports backend types with `import type`. A test cross-checks this
 * function against the real schema so the two cannot drift apart quietly.
 */
export function asPlanEvent(value: unknown): PlanExecutionEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.marker !== PLAN_EVENT_MARKER) return undefined;
  if (typeof value.type !== 'string' || !PLAN_EVENT_TYPES.has(value.type)) return undefined;
  if (typeof value.timestamp !== 'string') return undefined;

  return value as unknown as PlanExecutionEvent;
}

/** The telemetry event carried by a record, if it carries one. */
export function planEventFrom(record: WorkflowStreamRecord): PlanExecutionEvent | undefined {
  if (record.type !== 'workflow-step-output') return undefined;
  return asPlanEvent(record.payload?.output);
}

/** How a stream ended. `finalResult` is present only on success. */
export type StreamOutcome = {
  status: 'success' | 'failed';
  finalResult?: unknown;
};

/** Reads the outcome from a `workflow-finish` record. */
export function outcomeFrom(record: WorkflowStreamRecord): StreamOutcome | undefined {
  if (record.type !== 'workflow-finish') return undefined;

  return record.payload?.workflowStatus === 'success'
    ? {status: 'success', finalResult: record.payload?.finalWorkflowResult}
    : {status: 'failed'};
}

/** Error text from a failed `workflow-step-result`, if the step failed. */
export function stepErrorFrom(record: WorkflowStreamRecord): string | undefined {
  if (record.type !== 'workflow-step-result') return undefined;
  if (record.payload?.status !== 'failed') return undefined;

  const error = record.payload?.error;
  if (typeof error === 'string') return error;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return undefined;
}
