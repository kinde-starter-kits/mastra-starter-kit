import {z} from 'zod';

/**
 * Public execution telemetry for a planning run.
 *
 * These events describe what the *application* did — which tool ran, how long
 * it took, whether validation passed. They are not model reasoning. Nothing
 * here carries a prompt, a model deliberation, a credential, a token, or a
 * request context, and the emitter below strips anything unexpected rather
 * than trusting callers to be careful.
 *
 * Every event is emitted from a real operation. There are no timers and no
 * synthetic progress.
 */

export const PLAN_STAGES = [
  'understanding',
  'weather',
  'activities',
  'planning',
  'validation',
  'correction'
] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];

export const PLAN_TOOLS = [
  'get-weather',
  'find-activities',
  'save-itinerary',
  'list-itineraries'
] as const;
export type PlanTool = (typeof PLAN_TOOLS)[number];

/** Marks a chunk as our telemetry rather than some other step output. */
export const PLAN_EVENT_MARKER = 'plan-execution-event';

/**
 * Small, explicitly allow-listed summaries. Anything not named here never
 * reaches the browser, which is why the shapes are closed rather than
 * `Record<string, unknown>`.
 */
const WeatherSummarySchema = z.object({
  location: z.string().max(120),
  date: z.string().max(20),
  condition: z.string().max(120).optional(),
  precipitationChance: z.int().min(0).max(100).optional()
});

const ActivitiesSummarySchema = z.object({
  location: z.string().max(120),
  considered: z.int().min(0),
  selected: z.int().min(0).optional(),
  condition: z.string().max(40).optional()
});

export const PlanExecutionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run_started'),
    marker: z.literal(PLAN_EVENT_MARKER),
    runId: z.string(),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('stage_started'),
    marker: z.literal(PLAN_EVENT_MARKER),
    stage: z.enum(PLAN_STAGES),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('tool_started'),
    marker: z.literal(PLAN_EVENT_MARKER),
    tool: z.enum(PLAN_TOOLS),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('tool_completed'),
    marker: z.literal(PLAN_EVENT_MARKER),
    tool: z.enum(PLAN_TOOLS),
    durationMs: z.int().min(0),
    weather: WeatherSummarySchema.optional(),
    activities: ActivitiesSummarySchema.optional(),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('tool_failed'),
    marker: z.literal(PLAN_EVENT_MARKER),
    tool: z.enum(PLAN_TOOLS),
    durationMs: z.int().min(0),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('validation_completed'),
    marker: z.literal(PLAN_EVENT_MARKER),
    valid: z.boolean(),
    issueCount: z.int().min(0),
    /** Issue codes only — never the messages, which can quote user content. */
    issueCodes: z.array(z.string().max(60)).max(20),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('correction_started'),
    marker: z.literal(PLAN_EVENT_MARKER),
    attempt: z.int().min(1),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('run_completed'),
    marker: z.literal(PLAN_EVENT_MARKER),
    durationMs: z.int().min(0),
    timestamp: z.string()
  }),
  z.object({
    type: z.literal('run_failed'),
    marker: z.literal(PLAN_EVENT_MARKER),
    /** A failure category, never a provider payload. */
    category: z.string().max(60),
    durationMs: z.int().min(0),
    timestamp: z.string()
  })
]);

export type PlanExecutionEvent = z.infer<typeof PlanExecutionEventSchema>;

/** Narrow an arbitrary stream chunk payload to one of our events. */
export function asPlanEvent(value: unknown): PlanExecutionEvent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if ((value as {marker?: unknown}).marker !== PLAN_EVENT_MARKER) return undefined;

  const parsed = PlanExecutionEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

type Writable = {write?: (value: unknown) => unknown} | undefined;

/**
 * Emits telemetry onto the workflow stream.
 *
 * Every event is validated against the schema before it is written, so a field
 * that is not part of the contract — a stray tool argument, an error object, a
 * header — cannot reach the browser even if a caller passes one by mistake.
 * Writing is best-effort: telemetry must never break a planning run.
 */
export class PlanTelemetry {
  private readonly startedAt = Date.now();

  constructor(
    private readonly writer: Writable,
    readonly runId: string
  ) {}

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private async emit(event: PlanExecutionEvent): Promise<void> {
    const parsed = PlanExecutionEventSchema.safeParse(event);
    if (!parsed.success) return;

    try {
      await this.writer?.write?.(parsed.data);
    } catch {
      // A closed or absent stream must not fail the run.
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  runStarted() {
    return this.emit({
      type: 'run_started',
      marker: PLAN_EVENT_MARKER,
      runId: this.runId,
      timestamp: this.now()
    });
  }

  stage(stage: PlanStage) {
    return this.emit({
      type: 'stage_started',
      marker: PLAN_EVENT_MARKER,
      stage,
      timestamp: this.now()
    });
  }

  toolStarted(tool: PlanTool) {
    return this.emit({
      type: 'tool_started',
      marker: PLAN_EVENT_MARKER,
      tool,
      timestamp: this.now()
    });
  }

  toolCompleted(
    tool: PlanTool,
    durationMs: number,
    summary?: Pick<Extract<PlanExecutionEvent, {type: 'tool_completed'}>, 'weather' | 'activities'>
  ) {
    return this.emit({
      type: 'tool_completed',
      marker: PLAN_EVENT_MARKER,
      tool,
      durationMs: Math.max(0, Math.round(durationMs)),
      ...(summary ?? {}),
      timestamp: this.now()
    });
  }

  toolFailed(tool: PlanTool, durationMs: number) {
    return this.emit({
      type: 'tool_failed',
      marker: PLAN_EVENT_MARKER,
      tool,
      durationMs: Math.max(0, Math.round(durationMs)),
      timestamp: this.now()
    });
  }

  validation(valid: boolean, issueCodes: string[]) {
    return this.emit({
      type: 'validation_completed',
      marker: PLAN_EVENT_MARKER,
      valid,
      issueCount: issueCodes.length,
      issueCodes: issueCodes.slice(0, 20),
      timestamp: this.now()
    });
  }

  correctionStarted(attempt: number) {
    return this.emit({
      type: 'correction_started',
      marker: PLAN_EVENT_MARKER,
      attempt,
      timestamp: this.now()
    });
  }

  runCompleted() {
    return this.emit({
      type: 'run_completed',
      marker: PLAN_EVENT_MARKER,
      durationMs: this.elapsedMs,
      timestamp: this.now()
    });
  }

  runFailed(category: string) {
    return this.emit({
      type: 'run_failed',
      marker: PLAN_EVENT_MARKER,
      category: category.slice(0, 60),
      durationMs: this.elapsedMs,
      timestamp: this.now()
    });
  }
}
