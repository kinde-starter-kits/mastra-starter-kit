import type {
  PlanExecutionEvent,
  PlanStage,
  PlanTool
} from '../../mastra/telemetry/plan-events';

/**
 * The reduced view of a planning run.
 *
 * The backend emits a flat event stream; a timeline needs structure. This
 * module is the only place that turns one into the other, so the panel stays a
 * pure rendering of state and the transitions can be tested without a browser.
 *
 * Two properties of the real event stream shape this design:
 *
 * - **Stages are not monotonic.** The workflow emits `planning` before the
 *   agent runs, then `weather` and `activities` as tools fire, and `validation`
 *   again after a correction. So stages are an append-only list of occurrences
 *   rather than a fixed checklist — a repeated stage is a real second visit and
 *   is shown as one.
 * - **A tool may complete without having started.** Tool activity is derived
 *   from the agent's own stream, and a `tool_completed` can arrive for a call
 *   whose start was not observed. Completing an unknown tool records it rather
 *   than dropping it.
 */

export type RunStatus = 'idle' | 'running' | 'succeeded' | 'failed';

export type StageEntry = {
  stage: PlanStage;
  /** `active` until a later stage begins or the run ends. */
  status: 'active' | 'done';
  timestamp: string;
};

export type ToolEntry = {
  tool: PlanTool;
  status: 'running' | 'completed' | 'failed';
  durationMs?: number;
  /** A short, already-sanitised summary from the server. Never raw output. */
  detail?: string;
  timestamp: string;
};

/** One validation pass, numbered in the order it ran. */
export type ValidationCheck = {
  kind: 'validation';
  /** 1 for the first pass, 2 for the re-check after a correction, and so on. */
  pass: number;
  valid: boolean;
  issueCount: number;
  /** Issue codes only — never the messages, which can quote user content. */
  issueCodes: string[];
  timestamp: string;
};

/** The plan being sent back to the agent between two validation passes. */
export type CorrectionCheck = {
  kind: 'correction';
  attempt: number;
  timestamp: string;
};

/**
 * Validation and correction share one ordered list rather than two.
 *
 * A correction only means anything in relation to the pass before and the pass
 * after it, so keeping them in a single chronological sequence is what lets the
 * panel say "check failed -> sent back -> check passed" truthfully. Rendering
 * only the newest validation, as an earlier version did, produced the
 * contradiction "no issues" directly above "sent back to fix the issues above".
 */
export type TimelineCheck = ValidationCheck | CorrectionCheck;

export type ExecutionState = {
  runId: string | null;
  /** How many times the model had to be asked again. Never a guess. */
  retries: number;
  status: RunStatus;
  stages: StageEntry[];
  tools: ToolEntry[];
  /** Validation passes and corrections, in the order they happened. */
  checks: TimelineCheck[];
  /** Wall-clock duration reported by the server when the run ended. */
  durationMs?: number;
  /** A failure *category*, never a provider message. */
  failureCategory?: string;
};

export const initialExecutionState: ExecutionState = {
  runId: null,
  status: 'idle',
  stages: [],
  tools: [],
  checks: [],
  retries: 0
};

/** A fresh state for a new run, keeping nothing from the previous one. */
export function startExecution(): ExecutionState {
  return {...initialExecutionState, status: 'running'};
}

/** Human-readable labels. Kept next to the state so the panel stays dumb. */
export const STAGE_LABELS: Record<PlanStage, string> = {
  understanding: 'Reading your request',
  weather: 'Checking the weather',
  activities: 'Finding activities',
  planning: 'Planning the day',
  validation: 'Checking the plan',
  correction: 'Fixing the plan',
  retry: 'Retrying'
};

export const TOOL_LABELS: Record<PlanTool, string> = {
  'get-weather': 'Weather lookup',
  'find-activities': 'Activity search',
  'save-itinerary': 'Save itinerary',
  'list-itineraries': 'Load saved itineraries'
};

/**
 * A one-line summary of what a tool returned.
 *
 * Only the allow-listed fields the server chose to publish are read, so this
 * cannot widen what reaches the screen.
 */
function toolDetail(event: Extract<PlanExecutionEvent, {type: 'tool_completed'}>): string | undefined {
  if (event.weather) {
    const {location, condition, precipitationChance} = event.weather;
    const parts = [location, condition].filter(Boolean);
    if (typeof precipitationChance === 'number') {
      parts.push(`${precipitationChance}% rain`);
    }
    return parts.join(' · ') || undefined;
  }

  if (event.activities) {
    const {location, considered, selected} = event.activities;
    const count =
      typeof selected === 'number'
        ? `${selected} of ${considered} options`
        : `${considered} options`;
    return `${location} · ${count}`;
  }

  return undefined;
}

/** Marks every earlier stage done, since only one stage is current. */
function closeStages(stages: StageEntry[]): StageEntry[] {
  return stages.map(entry => (entry.status === 'active' ? {...entry, status: 'done'} : entry));
}

/** Resolves the newest running call for a tool, or records one that never started. */
function resolveTool(
  tools: ToolEntry[],
  tool: PlanTool,
  resolution: Omit<ToolEntry, 'tool' | 'timestamp'> & {timestamp: string}
): ToolEntry[] {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index].tool === tool && tools[index].status === 'running') {
      const next = [...tools];
      next[index] = {...next[index], ...resolution, tool};
      return next;
    }
  }

  return [...tools, {tool, ...resolution}];
}

/**
 * Applies one event. Pure: same state and event always give the same result,
 * and the previous state is never mutated.
 */
export function reduceExecution(state: ExecutionState, event: PlanExecutionEvent): ExecutionState {
  switch (event.type) {
    case 'run_started':
      return {...startExecution(), runId: event.runId};

    case 'stage_started': {
      const last = state.stages[state.stages.length - 1];
      // A repeat of the stage already running is not a new visit.
      if (last?.stage === event.stage && last.status === 'active') return state;

      return {
        ...state,
        status: 'running',
        stages: [
          ...closeStages(state.stages),
          {stage: event.stage, status: 'active', timestamp: event.timestamp}
        ]
      };
    }

    case 'tool_started':
      return {
        ...state,
        status: 'running',
        tools: [...state.tools, {tool: event.tool, status: 'running', timestamp: event.timestamp}]
      };

    case 'tool_completed':
      return {
        ...state,
        tools: resolveTool(state.tools, event.tool, {
          status: 'completed',
          durationMs: event.durationMs,
          detail: toolDetail(event),
          timestamp: event.timestamp
        })
      };

    case 'tool_failed':
      return {
        ...state,
        tools: resolveTool(state.tools, event.tool, {
          status: 'failed',
          durationMs: event.durationMs,
          timestamp: event.timestamp
        })
      };

    case 'validation_completed':
      return {
        ...state,
        checks: [
          ...state.checks,
          {
            kind: 'validation',
            pass: validationPasses(state).length + 1,
            valid: event.valid,
            issueCount: event.issueCount,
            issueCodes: event.issueCodes,
            timestamp: event.timestamp
          }
        ]
      };

    case 'model_retry':
      // The model answered in prose instead of the schema, so it was asked
      // again. Recorded only because it actually happened.
      return {...state, status: 'running', retries: Math.max(state.retries, event.attempt)};

    case 'correction_started':
      return {
        ...state,
        checks: [
          ...state.checks,
          {kind: 'correction', attempt: event.attempt, timestamp: event.timestamp}
        ]
      };

    case 'run_completed':
      return {
        ...state,
        status: 'succeeded',
        stages: closeStages(state.stages),
        durationMs: event.durationMs
      };

    case 'run_failed':
      return {
        ...state,
        status: 'failed',
        stages: closeStages(state.stages),
        durationMs: event.durationMs,
        failureCategory: event.category
      };

    default: {
      // Exhaustive today; an unknown future event leaves state untouched
      // rather than breaking a run in progress.
      const _never: never = event;
      void _never;
      return state;
    }
  }
}

/** Applies a batch in order. */
export function reduceAll(
  state: ExecutionState,
  events: readonly PlanExecutionEvent[]
): ExecutionState {
  return events.reduce(reduceExecution, state);
}

/** Ends a run that stopped without a terminal event (transport dropped, aborted). */
export function markInterrupted(state: ExecutionState, category: string): ExecutionState {
  if (state.status !== 'running') return state;
  return {...state, status: 'failed', stages: closeStages(state.stages), failureCategory: category};
}

/** Every validation pass, in order. */
export function validationPasses(state: ExecutionState): ValidationCheck[] {
  return state.checks.filter((check): check is ValidationCheck => check.kind === 'validation');
}

/** How many times the plan was sent back to the agent. */
export function correctionCount(state: ExecutionState): number {
  return state.checks.filter(check => check.kind === 'correction').length;
}

/** The stage to describe in a single-line status, if the run is active. */
export function currentStage(state: ExecutionState): PlanStage | undefined {
  const last = state.stages[state.stages.length - 1];
  return last?.status === 'active' ? last.stage : undefined;
}
