import {describe, it, expect} from 'vitest';

import {
  PLAN_EVENT_MARKER,
  PlanExecutionEventSchema,
  PlanTelemetry,
  asPlanEvent
} from '../src/mastra/telemetry/plan-events.js';

/** Captures everything the telemetry emitter writes. */
function recorder() {
  const written: unknown[] = [];
  return {
    written,
    writer: {write: (value: unknown) => void written.push(value)}
  };
}

describe('event contract', () => {
  it('accepts a well-formed event', () => {
    const parsed = PlanExecutionEventSchema.safeParse({
      type: 'tool_completed',
      marker: PLAN_EVENT_MARKER,
      tool: 'get-weather',
      durationMs: 1200,
      weather: {location: 'Lagos', date: '2026-08-22'},
      timestamp: new Date().toISOString()
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown tool', () => {
    const parsed = PlanExecutionEventSchema.safeParse({
      type: 'tool_started', marker: PLAN_EVENT_MARKER,
      tool: 'exfiltrate-secrets', timestamp: new Date().toISOString()
    });
    expect(parsed.success).toBe(false);
  });

  it('recognises only marked chunks as telemetry', () => {
    const event = {
      type: 'run_completed', marker: PLAN_EVENT_MARKER,
      durationMs: 10, timestamp: new Date().toISOString()
    };
    expect(asPlanEvent(event)?.type).toBe('run_completed');
    expect(asPlanEvent({...event, marker: 'something-else'})).toBeUndefined();
    expect(asPlanEvent({type: 'text-delta', delta: 'hello'})).toBeUndefined();
    expect(asPlanEvent(undefined)).toBeUndefined();
  });
});

describe('emitted lifecycle', () => {
  it('emits a full successful run in order', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-1');

    await t.runStarted();
    await t.stage('understanding');
    await t.stage('planning');
    await t.toolStarted('get-weather');
    await t.toolCompleted('get-weather', 1200, {weather: {location: 'Lagos', date: '2026-08-22'}});
    await t.toolStarted('find-activities');
    await t.toolCompleted('find-activities', 800, {
      activities: {location: 'Lagos', considered: 24, selected: 3}
    });
    await t.stage('validation');
    await t.validation(true, []);
    await t.runCompleted();

    const types = written.map(e => (e as {type: string}).type);
    expect(types).toEqual([
      'run_started', 'stage_started', 'stage_started',
      'tool_started', 'tool_completed',
      'tool_started', 'tool_completed',
      'stage_started', 'validation_completed', 'run_completed'
    ]);

    // Every emitted value is a valid event.
    for (const event of written) {
      expect(PlanExecutionEventSchema.safeParse(event).success).toBe(true);
    }
  });

  it('emits the correction cycle when validation fails then passes', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-2');

    await t.validation(false, ['time_window_violation', 'start_too_early']);
    await t.stage('correction');
    await t.correctionStarted(1);
    await t.validation(true, []);
    await t.runCompleted();

    const types = written.map(e => (e as {type: string}).type);
    expect(types).toEqual([
      'validation_completed', 'stage_started', 'correction_started',
      'validation_completed', 'run_completed'
    ]);

    const first = written[0] as {valid: boolean; issueCount: number; issueCodes: string[]};
    expect(first.valid).toBe(false);
    expect(first.issueCount).toBe(2);
    expect(first.issueCodes).toContain('time_window_violation');
  });

  it('emits a failure category rather than a provider payload', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-3');

    await t.toolFailed('get-weather', 300);
    await t.runFailed('model_unreachable');

    const failure = written.at(-1) as {type: string; category: string};
    expect(failure.type).toBe('run_failed');
    expect(failure.category).toBe('model_unreachable');
  });

  it('reports real durations, never fabricated ones', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-4');

    await t.toolCompleted('find-activities', 42.7);
    expect((written[0] as {durationMs: number}).durationMs).toBe(43);
    await t.toolCompleted('find-activities', -5);
    expect((written[1] as {durationMs: number}).durationMs).toBe(0);
  });

  it('never throws when the stream is gone', async () => {
    const t = new PlanTelemetry({write: () => { throw new Error('closed'); }}, 'run-5');
    await expect(t.runCompleted()).resolves.toBeUndefined();

    const none = new PlanTelemetry(undefined, 'run-6');
    await expect(none.runStarted()).resolves.toBeUndefined();
  });
});

describe('nothing sensitive can reach the stream', () => {
  const SECRETS = [
    'sk-proj-SUPERSECRETKEY1234567890',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
    'x-openai-api-key'
  ];

  it('drops fields that are not in the contract', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-7');

    await t.toolCompleted('get-weather', 100, {
      weather: {
        location: 'Lagos',
        date: '2026-08-22',
        // Not part of the schema: must be stripped.
        apiKey: SECRETS[0],
        authorization: SECRETS[1],
        rawResult: {headers: {cookie: 'session=abc'}}
      } as never
    });

    const serialised = JSON.stringify(written);
    for (const secret of SECRETS) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised).not.toContain('cookie');
    expect(serialised).not.toContain('rawResult');
  });

  it('refuses an event carrying a credential at the top level', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-8');

    // Bypass the typed helpers the way a careless caller might.
    await (t as unknown as {emit: (e: unknown) => Promise<void>}).emit?.({
      type: 'run_started', marker: PLAN_EVENT_MARKER, runId: 'r',
      timestamp: new Date().toISOString(), openaiApiKey: SECRETS[0]
    });

    expect(JSON.stringify(written)).not.toContain(SECRETS[0]);
  });

  it('never emits chain-of-thought or prompt text', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-9');

    await t.stage('planning');
    await t.validation(false, ['overlap']);
    await t.runCompleted();

    const serialised = JSON.stringify(written).toLowerCase();
    for (const banned of ['prompt', 'system', 'reasoning', 'thought', 'message', 'instruction']) {
      expect(serialised).not.toContain(banned);
    }
  });

  it('caps issue codes and emits codes rather than messages', async () => {
    const {written, writer} = recorder();
    const t = new PlanTelemetry(writer, 'run-10');

    await t.validation(false, Array.from({length: 40}, (_v, i) => `code_${i}`));
    const event = written[0] as {issueCodes: string[]};
    expect(event.issueCodes.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(event)).not.toContain('outside the requested');
  });
});
