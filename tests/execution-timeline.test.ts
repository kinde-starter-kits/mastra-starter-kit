// @vitest-environment jsdom
// The client imports the frontend env module, which reads `window.location`.
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  PLAN_EVENT_MARKER,
  type PlanExecutionEvent
} from '../src/mastra/telemetry/plan-events';
import {
  correctionCount,
  currentStage,
  initialExecutionState,
  markInterrupted,
  reduceAll,
  reduceExecution,
  startExecution,
  validationPasses
} from '../src/app/lib/execution-state';
import {RECORD_SEPARATOR} from '../src/app/lib/stream-protocol';
import {
  MastraRequestError,
  PlanCancelledError,
  streamPlanTrip
} from '../src/app/lib/mastra-client';

const now = '2026-08-21T10:00:00.000Z';

function event(partial: Record<string, unknown>): PlanExecutionEvent {
  return {marker: PLAN_EVENT_MARKER, timestamp: now, ...partial} as PlanExecutionEvent;
}

describe('execution state', () => {
  it('starts empty and renders nothing until something happens', () => {
    expect(initialExecutionState.status).toBe('idle');
    expect(initialExecutionState.stages).toEqual([]);
    expect(initialExecutionState.tools).toEqual([]);
  });

  it('does not mutate the state it is given', () => {
    const before = startExecution();
    const snapshot = structuredClone(before);

    reduceExecution(before, event({type: 'stage_started', stage: 'weather'}));

    expect(before).toEqual(snapshot);
  });

  it('marks the newest stage active and the earlier ones done', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'stage_started', stage: 'understanding'}),
      event({type: 'stage_started', stage: 'planning'})
    ]);

    expect(state.stages.map(entry => [entry.stage, entry.status])).toEqual([
      ['understanding', 'done'],
      ['planning', 'active']
    ]);
    expect(currentStage(state)).toBe('planning');
  });

  it('ignores a repeat of the stage already running', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'stage_started', stage: 'weather'}),
      event({type: 'stage_started', stage: 'weather'})
    ]);

    expect(state.stages).toHaveLength(1);
  });

  it('records a genuine second visit to a stage', () => {
    // The real workflow validates, corrects, then validates again.
    const state = reduceAll(startExecution(), [
      event({type: 'stage_started', stage: 'validation'}),
      event({type: 'stage_started', stage: 'correction'}),
      event({type: 'stage_started', stage: 'validation'})
    ]);

    expect(state.stages.map(entry => entry.stage)).toEqual([
      'validation',
      'correction',
      'validation'
    ]);
  });

  it('pairs a tool completion with the call that started it', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'tool_started', tool: 'get-weather'}),
      event({
        type: 'tool_completed',
        tool: 'get-weather',
        durationMs: 42,
        weather: {location: 'Lagos', date: '2026-08-22', condition: 'Sunny', precipitationChance: 10}
      })
    ]);

    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({
      tool: 'get-weather',
      status: 'completed',
      durationMs: 42,
      detail: 'Lagos · Sunny · 10% rain'
    });
  });

  it('summarises an activity search from the published fields only', () => {
    const state = reduceExecution(
      startExecution(),
      event({
        type: 'tool_completed',
        tool: 'find-activities',
        durationMs: 8,
        activities: {location: 'Lagos', considered: 12, selected: 3}
      })
    );

    expect(state.tools[0].detail).toBe('Lagos · 3 of 12 options');
  });

  it('records a completion whose start was never observed', () => {
    // Tool activity comes from the agent stream, which can drop a start.
    const state = reduceExecution(
      startExecution(),
      event({type: 'tool_completed', tool: 'save-itinerary', durationMs: 5})
    );

    expect(state.tools).toEqual([
      {tool: 'save-itinerary', status: 'completed', durationMs: 5, detail: undefined, timestamp: now}
    ]);
  });

  it('resolves the newest running call when a tool runs twice', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'tool_started', tool: 'get-weather'}),
      event({type: 'tool_completed', tool: 'get-weather', durationMs: 10}),
      event({type: 'tool_started', tool: 'get-weather'}),
      event({type: 'tool_failed', tool: 'get-weather', durationMs: 20})
    ]);

    expect(state.tools.map(tool => [tool.status, tool.durationMs])).toEqual([
      ['completed', 10],
      ['failed', 20]
    ]);
  });

  it('keeps a correction cycle in chronological order', () => {
    // The bug this replaced: only the last pass was kept, so the panel showed
    // "no issues" above "sent back to fix the issues above".
    const state = reduceAll(startExecution(), [
      event({type: 'validation_completed', valid: false, issueCount: 2, issueCodes: ['overlap', 'out_of_order']}),
      event({type: 'correction_started', attempt: 1}),
      event({type: 'validation_completed', valid: true, issueCount: 0, issueCodes: []})
    ]);

    expect(state.checks).toEqual([
      {
        kind: 'validation',
        pass: 1,
        valid: false,
        issueCount: 2,
        issueCodes: ['overlap', 'out_of_order'],
        timestamp: now
      },
      {kind: 'correction', attempt: 1, timestamp: now},
      {kind: 'validation', pass: 2, valid: true, issueCount: 0, issueCodes: [], timestamp: now}
    ]);
    expect(correctionCount(state)).toBe(1);
    expect(validationPasses(state)).toHaveLength(2);
  });

  it('records a single passing validation as one check', () => {
    const state = reduceExecution(
      startExecution(),
      event({type: 'validation_completed', valid: true, issueCount: 0, issueCodes: []})
    );

    expect(state.checks).toEqual([
      {kind: 'validation', pass: 1, valid: true, issueCount: 0, issueCodes: [], timestamp: now}
    ]);
    expect(correctionCount(state)).toBe(0);
  });

  it('keeps both passes when the correction did not fix the plan', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'validation_completed', valid: false, issueCount: 1, issueCodes: ['outside_opening_hours']}),
      event({type: 'correction_started', attempt: 1}),
      event({type: 'validation_completed', valid: false, issueCount: 1, issueCodes: ['outside_opening_hours']}),
      event({type: 'run_failed', category: 'itinerary_invalid', durationMs: 40})
    ]);

    expect(state.checks.map(c => (c.kind === 'validation' ? `v${c.pass}:${c.valid}` : `c${c.attempt}`)))
      .toEqual(['v1:false', 'c1', 'v2:false']);
    expect(state.status).toBe('failed');
    expect(state.failureCategory).toBe('itinerary_invalid');
  });

  it('numbers every pass when validation runs more than twice', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'validation_completed', valid: false, issueCount: 1, issueCodes: ['overlap']}),
      event({type: 'correction_started', attempt: 1}),
      event({type: 'validation_completed', valid: false, issueCount: 1, issueCodes: ['overlap']}),
      event({type: 'correction_started', attempt: 2}),
      event({type: 'validation_completed', valid: true, issueCount: 0, issueCodes: []})
    ]);

    expect(validationPasses(state).map(v => v.pass)).toEqual([1, 2, 3]);
    expect(correctionCount(state)).toBe(2);
    expect(state.checks).toHaveLength(5);
  });

  it('keeps the validation history when the run fails afterwards', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'validation_completed', valid: false, issueCount: 1, issueCodes: ['overlap']}),
      event({type: 'run_failed', category: 'workflow_failed', durationMs: 10})
    ]);

    expect(validationPasses(state)).toHaveLength(1);
    expect(state.status).toBe('failed');
  });

  it('keeps the validation history when the run is interrupted', () => {
    const state = markInterrupted(
      reduceExecution(
        startExecution(),
        event({type: 'validation_completed', valid: false, issueCount: 1, issueCodes: ['overlap']})
      ),
      'mastra_unreachable'
    );

    expect(validationPasses(state)).toHaveLength(1);
    expect(state.checks[0]).toMatchObject({kind: 'validation', valid: false});
  });

  it('closes the timeline when the run completes', () => {
    const state = reduceAll(startExecution(), [
      event({type: 'stage_started', stage: 'planning'}),
      event({type: 'run_completed', durationMs: 1234})
    ]);

    expect(state.status).toBe('succeeded');
    expect(state.durationMs).toBe(1234);
    expect(state.stages.every(entry => entry.status === 'done')).toBe(true);
    expect(currentStage(state)).toBeUndefined();
  });

  it('records a failure category without a provider message', () => {
    const state = reduceExecution(
      startExecution(),
      event({type: 'run_failed', category: 'itinerary_invalid', durationMs: 50})
    );

    expect(state).toMatchObject({status: 'failed', failureCategory: 'itinerary_invalid'});
  });

  it('resets on a new run rather than carrying the previous one over', () => {
    const finished = reduceAll(startExecution(), [
      event({type: 'tool_started', tool: 'get-weather'}),
      event({type: 'run_completed', durationMs: 10})
    ]);

    const restarted = reduceExecution(finished, event({type: 'run_started', runId: 'run-2'}));

    expect(restarted).toMatchObject({
      runId: 'run-2',
      status: 'running',
      tools: [],
      stages: [],
      checks: []
    });
  });

  it('closes a run that stopped without a terminal event', () => {
    const state = markInterrupted(
      reduceExecution(startExecution(), event({type: 'stage_started', stage: 'weather'})),
      'mastra_unreachable'
    );

    expect(state).toMatchObject({status: 'failed', failureCategory: 'mastra_unreachable'});
    expect(state.stages[0].status).toBe('done');
  });

  it('leaves a finished run alone when marking interrupted', () => {
    const done = reduceExecution(startExecution(), event({type: 'run_completed', durationMs: 1}));
    expect(markInterrupted(done, 'unknown')).toBe(done);
  });
});

/** Builds a body in the captured wire format. */
function wire(records: unknown[]): string {
  return records.map(record => JSON.stringify(record) + RECORD_SEPARATOR).join('');
}

/**
 * A body delivered in small pieces, so the decoder is exercised across chunk
 * boundaries. Aborting errors the stream, which is what real fetch does.
 */
function bodyStream(
  body: string,
  options: {signal?: AbortSignal; chunkSize?: number} = {}
): ReadableStream<Uint8Array> {
  const {signal, chunkSize = 17} = options;
  const bytes = new TextEncoder().encode(body);
  let offset = 0;

  return new ReadableStream({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(Object.assign(new Error('The operation was aborted.'), {
          name: 'AbortError'
        }));
        return;
      }

      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    }
  });
}

const ITINERARY_RESULT = {kind: 'itinerary', itinerary: {destination: 'Lagos'}};

const SUCCESS_BODY = wire([
  {type: 'workflow-start', runId: 'run-1', from: 'WORKFLOW', payload: {}},
  {
    type: 'workflow-step-output',
    runId: 'run-1',
    from: 'USER',
    payload: {output: {type: 'run_started', marker: PLAN_EVENT_MARKER, runId: 'run-1', timestamp: now}}
  },
  {
    type: 'workflow-step-output',
    runId: 'run-1',
    from: 'USER',
    payload: {
      output: {type: 'tool_started', marker: PLAN_EVENT_MARKER, tool: 'get-weather', timestamp: now}
    }
  },
  {
    type: 'workflow-step-output',
    runId: 'run-1',
    from: 'USER',
    payload: {
      output: {type: 'run_completed', marker: PLAN_EVENT_MARKER, durationMs: 900, timestamp: now}
    }
  },
  {
    type: 'workflow-finish',
    runId: 'run-1',
    from: 'WORKFLOW',
    payload: {workflowStatus: 'success', finalWorkflowResult: ITINERARY_RESULT}
  }
]);

type Call = {url: string; init: RequestInit};

/** Stubs create-run plus the stream, and records what was sent. */
function stubFetch(
  options: {body?: string; streamStatus?: number; bodyless?: boolean} = {}
) {
  const calls: Call[] = [];

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({url, init});

    // Real fetch rejects with an AbortError rather than ignoring the signal.
    if (init.signal?.aborted) {
      throw Object.assign(new Error('The operation was aborted.'), {name: 'AbortError'});
    }

    if (url.includes('/start-async')) {
      return new Response(JSON.stringify({status: 'success', result: ITINERARY_RESULT}), {
        status: 200,
        headers: {'Content-Type': 'application/json'}
      });
    }

    if (options.streamStatus && options.streamStatus !== 200) {
      return new Response('forbidden', {status: options.streamStatus});
    }

    // Some environments hand back a response with no readable body.
    if (options.bodyless) return new Response(null, {status: 200});

    return new Response(bodyStream(options.body ?? SUCCESS_BODY, {signal: init.signal ?? undefined}), {
      status: 200,
      headers: {'Content-Type': 'text/plain'}
    });
  });

  vi.stubGlobal('fetch', fetchStub);
  return calls;
}

describe('streamPlanTrip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('streams in a single request, carrying a run id it generated', async () => {
    // The stream route requires `runId` and creates the run itself, so there
    // is no need for a separate create-run round trip.
    const calls = stubFetch();

    await streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'});

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(
      /\/api\/workflows\/planTripWorkflow\/stream\?runId=[0-9a-f-]{36}$/
    );
  });

  it('uses a different run id for each run', async () => {
    const calls = stubFetch();

    await streamPlanTrip('token', {message: 'One', threadId: 'thread-1'});
    await streamPlanTrip('token', {message: 'Two', threadId: 'thread-1'});

    expect(calls[0].url).not.toBe(calls[1].url);
  });

  it('returns the response envelope from the final record', async () => {
    stubFetch();

    const response = await streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'});

    expect(response).toEqual(ITINERARY_RESULT);
  });

  it('reports events in wire order as they arrive', async () => {
    stubFetch();
    const seen: string[] = [];

    await streamPlanTrip(
      'token',
      {message: 'Plan Lagos', threadId: 'thread-1'},
      {onEvent: streamed => seen.push(streamed.type)}
    );

    expect(seen).toEqual(['run_started', 'tool_started', 'run_completed']);
  });

  it('builds a timeline that matches what the stream described', async () => {
    stubFetch();
    let state = startExecution();

    await streamPlanTrip(
      'token',
      {message: 'Plan Lagos', threadId: 'thread-1'},
      {onEvent: streamed => (state = reduceExecution(state, streamed))}
    );

    expect(state.status).toBe('succeeded');
    expect(state.tools.map(tool => tool.tool)).toEqual(['get-weather']);
  });

  it('sends credentials as headers on both requests and never in the URL or body', async () => {
    const calls = stubFetch();

    await streamPlanTrip(
      'token',
      {message: 'Plan Lagos', threadId: 'thread-1'},
      {openaiKey: 'sk-test-key'}
    );

    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer token');
      expect(headers['x-openai-api-key']).toBe('sk-test-key');

      expect(call.url).not.toContain('token');
      expect(call.url).not.toContain('sk-test-key');
      expect(String(call.init.body ?? '')).not.toContain('sk-test-key');
      expect(String(call.init.body ?? '')).not.toContain('Bearer');
    }
  });

  it('sends only the message and thread, never identity', async () => {
    const calls = stubFetch();

    await streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'});

    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      inputData: {message: 'Plan Lagos', threadId: 'thread-1'}
    });
  });

  it('fails when the stream ends without a successful finish', async () => {
    stubFetch({
      body: wire([
        {
          type: 'workflow-step-result',
          payload: {status: 'failed', error: {message: 'boom', name: 'Error'}}
        },
        {type: 'workflow-finish', payload: {workflowStatus: 'failed'}}
      ])
    });

    await expect(
      streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'})
    ).rejects.toBeInstanceOf(MastraRequestError);
  });

  it('fails when the stream stops before finishing', async () => {
    stubFetch({body: wire([{type: 'workflow-start', payload: {}}])});

    await expect(
      streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'})
    ).rejects.toThrow(MastraRequestError);
  });

  it('surfaces an authorization failure from the stream request', async () => {
    stubFetch({streamStatus: 403});

    await expect(
      streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'})
    ).rejects.toMatchObject({status: 403});
  });

  it('reports cancellation distinctly from a failure', async () => {
    stubFetch();
    const controller = new AbortController();
    controller.abort();

    // Aborting during create-run must not be reported as an unreachable server.
    await expect(
      streamPlanTrip(
        'token',
        {message: 'Plan Lagos', threadId: 'thread-1'},
        {signal: controller.signal}
      )
    ).rejects.toBeInstanceOf(PlanCancelledError);
  });

  it('reports cancellation once the stream is already open', async () => {
    stubFetch();
    const controller = new AbortController();

    // Abort part-way through reading rather than before the first request.
    await expect(
      streamPlanTrip(
        'token',
        {message: 'Plan Lagos', threadId: 'thread-1'},
        {signal: controller.signal, onEvent: () => controller.abort()}
      )
    ).rejects.toBeInstanceOf(PlanCancelledError);
  });

  it('falls back to the non-streaming path when the response has no body', async () => {
    const calls = stubFetch({bodyless: true});

    const response = await streamPlanTrip('token', {message: 'Plan Lagos', threadId: 'thread-1'});

    expect(response).toEqual(ITINERARY_RESULT);
    expect(calls.some(call => call.url.includes('/start-async'))).toBe(true);
  });
});
