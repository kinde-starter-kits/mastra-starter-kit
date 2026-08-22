import {useEffect, useRef} from 'react';

/**
 * The one input in the product.
 *
 * Enter sends and Shift+Enter breaks the line, which is the convention people
 * already have for this shape of box. The field grows with its content up to a
 * cap so a long request stays visible without pushing the plan off screen.
 *
 * The hints are real requests, not decoration: each one is a phrase the agent
 * genuinely handles — a contextual follow-up, or the explicit save wording the
 * server-side intent gate looks for.
 */

const HINTS = ['Make it more relaxed', 'Start later', 'Save this itinerary'];

export function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
  busy,
  canCancel,
  showHints
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  busy: boolean;
  canCancel: boolean;
  /** Follow-up hints only make sense once there is something to follow up on. */
  showHints: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [value]);

  const empty = value.trim().length === 0;

  return (
    <div className="composer-bar">
      <div className="composer-inner">
        <form
          className="composer-box"
          onSubmit={event => {
            event.preventDefault();
            if (!busy && !empty) onSubmit();
          }}
        >
          <label className="sr-only" htmlFor="request">
            Your request
          </label>
          <textarea
            id="request"
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={busy}
            placeholder="Plan a relaxed afternoon in Lagos…"
            onChange={event => onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                // Guarding here as well as on submit stops a held Enter from
                // queueing a second run behind the one already in flight.
                if (!busy && !empty) onSubmit();
              }
            }}
          />
          <button
            type="submit"
            className="btn composer-send"
            disabled={busy || empty}
            aria-label="Send request"
          >
            <span aria-hidden="true">↑</span>
          </button>
        </form>

        {showHints && !busy ? (
          <div className="composer-hints">
            {HINTS.map(hint => (
              <button
                key={hint}
                type="button"
                className="hint"
                onClick={() => onChange(hint)}
              >
                {hint}
              </button>
            ))}
          </div>
        ) : null}

        <div className="composer-foot">
          <span>{busy ? 'Planning…' : 'Enter to send · Shift + Enter for a new line'}</span>
          {busy && canCancel ? (
            <button type="button" className="btn quiet small" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
