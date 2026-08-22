import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {
  PLAN_EVENT_MARKER,
  PlanExecutionEventSchema,
  type PlanExecutionEvent
} from '../src/mastra/telemetry/plan-events';
import {
  RECORD_SEPARATOR,
  asPlanEvent,
  createStreamDecoder,
  outcomeFrom,
  planEventFrom,
  stepErrorFrom
} from '../src/app/lib/stream-protocol';

/**
 * These tests are written against bytes captured from a running Mastra server,
 * not against an assumed format. The two `.bin` fixtures are verbatim response
 * bodies — see `tests/fixtures/README.md`. If Mastra changes its wire format,
 * this file is what should fail first.
 */

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

const SUCCESS = fixture('workflow-stream-success.bin');
const FAILED = fixture('workflow-stream-failed.bin');

const OBSERVED_SEQUENCE = [
  'workflow-start',
  'workflow-step-start',
  'workflow-step-output',
  'workflow-step-output',
  'workflow-step-result',
  'workflow-finish'
];

/** Feeds a whole body through the decoder in fixed-size slices. */
function decodeInChunks(body: string, size: number) {
  const decoder = createStreamDecoder();
  const records = [];

  for (let index = 0; index < body.length; index += size) {
    records.push(...decoder.push(body.slice(index, index + size)));
  }
  records.push(...decoder.flush());

  return records;
}

describe('captured wire format', () => {
  it('separates records with U+001E and contains no newlines', () => {
    expect(RECORD_SEPARATOR).toBe('\u001e');
    expect(SUCCESS).not.toContain('\n');
    expect(FAILED).not.toContain('\n');
    expect(SUCCESS.startsWith(RECORD_SEPARATOR)).toBe(false);
    expect(SUCCESS.endsWith(RECORD_SEPARATOR)).toBe(true);
  });

  it('would yield nothing to a line-based reader, which is why framing was measured', () => {
    const lines = SUCCESS.split('\n');
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).toThrow();
  });

  it('decodes the observed record sequence', () => {
    expect(decodeInChunks(SUCCESS, SUCCESS.length).map(record => record.type)).toEqual(
      OBSERVED_SEQUENCE
    );
  });

  it('marks telemetry as coming from the step rather than the framework', () => {
    const outputs = decodeInChunks(SUCCESS, 64).filter(
      record => record.type === 'workflow-step-output'
    );
    expect(outputs.map(record => record.from)).toEqual(['USER', 'USER']);
  });
});

describe('chunk boundaries', () => {
  // A record can be split anywhere by the transport, so every split must work.
  for (const size of [1, 7, 64, 500, 5000]) {
    it(`produces the same records with ${size}-character chunks`, () => {
      expect(decodeInChunks(SUCCESS, size).map(record => record.type)).toEqual(OBSERVED_SEQUENCE);
    });
  }

  it('emits several records from one chunk', () => {
    const decoder = createStreamDecoder();
    expect(decoder.push(SUCCESS)).toHaveLength(6);
  });

  it('holds back a record until its separator arrives', () => {
    const decoder = createStreamDecoder();
    const firstEnd = SUCCESS.indexOf(RECORD_SEPARATOR);

    expect(decoder.push(SUCCESS.slice(0, firstEnd))).toEqual([]);
    expect(decoder.push(SUCCESS.slice(firstEnd, firstEnd + 1))).toHaveLength(1);
  });

  it('recovers a final record that arrives without a trailing separator', () => {
    const decoder = createStreamDecoder();
    const body = '{"type":"workflow-finish","payload":{"workflowStatus":"success"}}';

    expect(decoder.push(body)).toEqual([]);
    expect(decoder.flush().map(record => record.type)).toEqual(['workflow-finish']);
  });

  it('flushes nothing for a well-formed stream', () => {
    const decoder = createStreamDecoder();
    decoder.push(SUCCESS);
    expect(decoder.flush()).toEqual([]);
  });
});

describe('malformed input', () => {
  it('skips an unparseable record and keeps the rest of the stream', () => {
    const decoder = createStreamDecoder();
    const body = `{"type":"workflow-start"}${RECORD_SEPARATOR}{not json${RECORD_SEPARATOR}{"type":"workflow-finish","payload":{"workflowStatus":"success"}}${RECORD_SEPARATOR}`;

    expect(decoder.push(body).map(record => record.type)).toEqual([
      'workflow-start',
      'workflow-finish'
    ]);
  });

  it('ignores JSON that is not a record shape', () => {
    const decoder = createStreamDecoder();
    const body = `"a string"${RECORD_SEPARATOR}[1,2,3]${RECORD_SEPARATOR}{"no":"type"}${RECORD_SEPARATOR}null${RECORD_SEPARATOR}`;

    expect(decoder.push(body)).toEqual([]);
  });

  it('ignores empty records', () => {
    const decoder = createStreamDecoder();
    expect(decoder.push(`${RECORD_SEPARATOR}${RECORD_SEPARATOR}`)).toEqual([]);
  });

  it('does not throw on a truncated stream', () => {
    const decoder = createStreamDecoder();
    expect(() => {
      decoder.push(SUCCESS.slice(0, 900));
      decoder.flush();
    }).not.toThrow();
  });
});

describe('telemetry extraction', () => {
  it('pulls the plan events out of the captured stream', () => {
    const events = decodeInChunks(SUCCESS, 32)
      .map(planEventFrom)
      .filter((event): event is PlanExecutionEvent => Boolean(event));

    expect(events.map(event => event.type)).toEqual(['run_started', 'tool_completed']);
  });

  it('rejects step output that is not ours', () => {
    expect(
      planEventFrom({
        type: 'workflow-step-output',
        payload: {output: {type: 'run_started', timestamp: 'now'}}
      })
    ).toBeUndefined();
  });

  it('only reads events from step output records', () => {
    const event = {type: 'run_started', marker: PLAN_EVENT_MARKER, runId: 'r', timestamp: 'now'};
    expect(planEventFrom({type: 'workflow-step-result', payload: {output: event}})).toBeUndefined();
  });

  it('rejects an unknown event type even when the marker is right', () => {
    expect(
      asPlanEvent({type: 'model_reasoning', marker: PLAN_EVENT_MARKER, timestamp: 'now'})
    ).toBeUndefined();
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'run_started', 42, ['run_started']]) {
      expect(asPlanEvent(value)).toBeUndefined();
    }
  });
});

describe('the browser check agrees with the server schema', () => {
  // The client validates structurally so no validator ships to the browser.
  // This is the guard against the two drifting apart.
  const samples: PlanExecutionEvent[] = [
    {type: 'run_started', marker: PLAN_EVENT_MARKER, runId: 'r', timestamp: 'now'},
    {type: 'stage_started', marker: PLAN_EVENT_MARKER, stage: 'weather', timestamp: 'now'},
    {type: 'tool_started', marker: PLAN_EVENT_MARKER, tool: 'get-weather', timestamp: 'now'},
    {
      type: 'tool_completed',
      marker: PLAN_EVENT_MARKER,
      tool: 'get-weather',
      durationMs: 12,
      timestamp: 'now'
    },
    {
      type: 'tool_failed',
      marker: PLAN_EVENT_MARKER,
      tool: 'find-activities',
      durationMs: 3,
      timestamp: 'now'
    },
    {
      type: 'validation_completed',
      marker: PLAN_EVENT_MARKER,
      valid: false,
      issueCount: 1,
      issueCodes: ['overlap'],
      timestamp: 'now'
    },
    {type: 'correction_started', marker: PLAN_EVENT_MARKER, attempt: 1, timestamp: 'now'},
    {type: 'model_retry', marker: PLAN_EVENT_MARKER, attempt: 1, timestamp: 'now'},
    {type: 'run_completed', marker: PLAN_EVENT_MARKER, durationMs: 900, timestamp: 'now'},
    {
      type: 'run_failed',
      marker: PLAN_EVENT_MARKER,
      category: 'workflow_failed',
      durationMs: 900,
      timestamp: 'now'
    }
  ];

  it('accepts every event the server can emit', () => {
    for (const sample of samples) {
      expect(PlanExecutionEventSchema.safeParse(sample).success).toBe(true);
      expect(asPlanEvent(sample), sample.type).toBeDefined();
    }
  });

  it('covers every branch of the server union', () => {
    const serverTypes = PlanExecutionEventSchema.options.map(
      option => option.shape.type.value as string
    );
    expect(new Set(samples.map(sample => sample.type))).toEqual(new Set(serverTypes));
  });
});

describe('outcome', () => {
  it('reads the final result from a successful finish', () => {
    const finish = decodeInChunks(SUCCESS, 64).at(-1);
    expect(outcomeFrom(finish!)).toEqual({
      status: 'success',
      finalResult: {kind: 'message', message: 'done'}
    });
  });

  it('reports failure without inventing a result', () => {
    const finish = decodeInChunks(FAILED, 64).at(-1);
    expect(outcomeFrom(finish!)).toEqual({status: 'failed'});
  });

  it('reads the error from the failed step', () => {
    expect(decodeInChunks(FAILED, 64).map(stepErrorFrom).filter(Boolean)).toEqual([
      'probe deliberate failure'
    ]);
  });

  it('reports no error for a successful step', () => {
    expect(decodeInChunks(SUCCESS, 64).map(stepErrorFrom).filter(Boolean)).toEqual([]);
  });

  it('ignores records that are not a finish', () => {
    expect(outcomeFrom({type: 'workflow-start'})).toBeUndefined();
  });
});

describe('what decoding exposes', () => {
  it('keeps only the four contract fields of a record', () => {
    const decoder = createStreamDecoder();
    const body = `{"type":"workflow-step-output","from":"USER","authorization":"Bearer secret","payload":{"output":{"type":"run_started","marker":"${PLAN_EVENT_MARKER}","runId":"r","timestamp":"now"}}}${RECORD_SEPARATOR}`;

    const [record] = decoder.push(body);
    expect(Object.keys(record).sort()).toEqual(['from', 'payload', 'runId', 'type']);
    expect(JSON.stringify(record)).not.toContain('secret');
  });

  it('has no event field that could carry a credential', () => {
    // The real defence is server-side: `PlanTelemetry` validates against this
    // schema before writing, so an unexpected field is dropped before it ever
    // reaches the wire. This asserts the contract has no place to put one.
    const fields = PlanExecutionEventSchema.options.flatMap(option => Object.keys(option.shape));

    for (const field of fields) {
      expect(field).not.toMatch(/key|token|secret|authorization|cookie|password/i);
    }
  });

  it('drops an unexpected field at the server boundary', () => {
    const parsed = PlanExecutionEventSchema.parse({
      type: 'run_started',
      marker: PLAN_EVENT_MARKER,
      runId: 'r',
      timestamp: 'now',
      apiKey: 'sk-should-never-be-emitted'
    });

    expect(parsed).not.toHaveProperty('apiKey');
  });
});
