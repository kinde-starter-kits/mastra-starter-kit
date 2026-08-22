import {useState} from 'react';

import {
  STAGE_LABELS,
  TOOL_LABELS,
  correctionCount,
  currentStage,
  validationPasses,
  type ExecutionState,
  type TimelineCheck
} from '../lib/execution-state';

/**
 * What the planner actually did, as it does it.
 *
 * Every line comes from a telemetry event emitted by a real operation on the
 * server — a tool that ran, a validation pass that happened. There are no
 * timers, no simulated progress and no model reasoning: if a step is shown it
 * occurred, and if it shows a duration, that duration was measured.
 *
 * While a run is in flight the timeline is open, because watching it is the
 * point. Once it finishes it collapses to a single line — the detail is still
 * one click away, but a finished run should not compete with the itinerary it
 * produced. A failed run stays open: where it stopped is the useful part.
 */

function formatMs(ms: number | undefined): string | null {
  if (typeof ms !== 'number') return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `time_window_violation` reads as "activity started before the requested window". */
const ISSUE_LABELS: Record<string, string> = {
  time_window_violation: 'An activity fell outside the time of day you asked for',
  start_too_early: 'The day started earlier than you wanted',
  out_of_order: 'Activities were not in chronological order',
  overlap: 'Two activities overlapped',
  closed_on_day: 'An activity was closed that day',
  outside_opening_hours: 'An activity was scheduled outside its opening hours',
  unknown_activity: 'An activity was not one the search returned',
  destination_mismatch: 'An activity was in a different place',
  weather_flag_mismatch: 'An activity was mislabelled for weather',
  severe_weather_unmitigated: 'Severe weather was not accounted for',
  disliked_activity: 'The plan included something you said you disliked',
  exceeds_requested_window: 'The plan ran longer than you asked for'
};

function readableIssue(code: string): string {
  return ISSUE_LABELS[code] ?? code.replace(/_/g, ' ');
}

/**
 * One line of the validation sequence.
 *
 * Every pass is shown, in order, so a correction cycle reads as what actually
 * happened. Showing only the newest pass made the panel contradict itself:
 * "no issues" directly above "sent back to fix the issues above".
 */
function CheckLine({check}: {check: TimelineCheck}) {
  if (check.kind === 'correction') {
    return (
      <li className="check check-correction">
        <div className="check-head">
          <span className="check-glyph" aria-hidden="true">
            ↻
          </span>
          <span className="check-label">Correcting the plan</span>
          <span className="check-note">Attempt {check.attempt}</span>
        </div>
      </li>
    );
  }

  if (check.valid) {
    return (
      <li className="check check-passed">
        <div className="check-head">
          <span className="check-glyph" aria-hidden="true">
            ✓
          </span>
          <span className="check-label">Plan checked</span>
          <span className="check-note">
            Check {check.pass}
            {check.pass > 1 ? ' · corrected plan is valid' : ' · no issues'}
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="check check-failed">
      <div className="check-head">
        <span className="check-glyph" aria-hidden="true">
          !
        </span>
        <span className="check-label">Plan checked</span>
        <span className="check-note">
          Check {check.pass} · {check.issueCount}{' '}
          {check.issueCount === 1 ? 'issue found' : 'issues found'}
        </span>
      </div>
      {check.issueCodes.length > 0 ? (
        <ul className="check-issues">
          {check.issueCodes.map((code, index) => (
            <li key={`${code}-${index}`}>{readableIssue(code)}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The one-line headline, which is also the collapsed state. */
function summaryOf(state: ExecutionState): {label: string; meta: string | null} {
  const operations = state.tools.length;
  const corrections = correctionCount(state);

  const parts: string[] = [];
  if (operations > 0) parts.push(`${operations} ${operations === 1 ? 'operation' : 'operations'}`);
  if (corrections > 0) {
    parts.push(`${corrections} ${corrections === 1 ? 'correction' : 'corrections'}`);
  }
  if (state.retries > 0) {
    parts.push(`${state.retries} ${state.retries === 1 ? 'retry' : 'retries'}`);
  }
  const meta = parts.length ? parts.join(' · ') : null;

  if (state.status === 'running') {
    const stage = currentStage(state);
    return {label: stage ? `${STAGE_LABELS[stage]}…` : 'Working…', meta};
  }

  if (state.status === 'succeeded') {
    const took = formatMs(state.durationMs);
    return {label: took ? `Planned in ${took}` : 'Planned', meta};
  }

  if (state.status === 'failed') {
    return {label: 'Stopped before finishing', meta};
  }

  return {label: 'Idle', meta};
}

export function ExecutionPanel({
  state,
  onCancel
}: {
  state: ExecutionState;
  onCancel?: () => void;
}) {
  const running = state.status === 'running';
  const failed = state.status === 'failed';

  // Open while it matters; collapsed once the result is the interesting thing.
  const [expanded, setExpanded] = useState(false);
  const open = running || failed || expanded;

  if (state.status === 'idle' && state.stages.length === 0 && state.tools.length === 0) {
    return null;
  }

  const {label, meta} = summaryOf(state);
  const passes = validationPasses(state);
  const lastPass = passes[passes.length - 1];
  const correctionFailed = Boolean(lastPass && !lastPass.valid && correctionCount(state) > 0);

  return (
    <section className={`execution execution-${state.status}`} aria-label="Execution timeline">
      <button
        type="button"
        className="execution-summary"
        // While running there is nothing to toggle — it is already open.
        aria-disabled={running || failed ? 'true' : undefined}
        aria-expanded={open}
        onClick={() => {
          if (!running && !failed) setExpanded(value => !value);
        }}
      >
        <span className={`execution-dot${running ? ' spinning' : ''}`} aria-hidden="true" />
        {/* Announced politely so a screen reader follows progress without
            interrupting whatever the user is doing. */}
        <span className="execution-status" role="status" aria-live="polite">
          {state.status === 'succeeded' ? <span aria-hidden="true">✓ </span> : null}
          {failed ? <span aria-hidden="true">✕ </span> : null}
          {label}
        </span>
        {meta ? <span className="execution-meta">{meta}</span> : null}
        {running && onCancel ? (
          <span
            role="button"
            tabIndex={0}
            className="btn ghost small"
            onClick={event => {
              event.stopPropagation();
              onCancel();
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }
            }}
          >
            Cancel
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="execution-body">
          <ol className="execution-steps">
            {state.stages.map((entry, index) => (
              <li
                key={`${entry.stage}-${entry.timestamp}-${index}`}
                className={`execution-step step-${entry.status}`}
              >
                {STAGE_LABELS[entry.stage]}
              </li>
            ))}
          </ol>

          {state.tools.length > 0 ? (
            <ul className="execution-tools">
              {state.tools.map((tool, index) => {
                const took = formatMs(tool.durationMs);
                return (
                  <li
                    key={`${tool.tool}-${tool.timestamp}-${index}`}
                    className={`execution-tool tool-${tool.status}`}
                  >
                    <span className="tool-name">{TOOL_LABELS[tool.tool]}</span>
                    {tool.detail ? <span className="tool-detail">{tool.detail}</span> : null}
                    <span className="tool-meta">
                      {tool.status === 'failed' ? 'failed' : null}
                      {tool.status === 'running' ? 'running…' : null}
                      {took && tool.status !== 'running' ? took : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {state.checks.length > 0 ? (
            <ol className="execution-checks" aria-label="Plan checks">
              {state.checks.map((check, index) => (
                <CheckLine key={`${check.kind}-${check.timestamp}-${index}`} check={check} />
              ))}
            </ol>
          ) : null}

          {correctionFailed ? (
            <p className="check-verdict-failed">
              <span aria-hidden="true">✕ </span>
              Plan could not satisfy the requested constraints
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
