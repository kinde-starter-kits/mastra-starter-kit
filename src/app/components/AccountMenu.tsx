import {useEffect, useRef, useState} from 'react';

import type {Identity, KeySource} from '../lib/mastra-client';

/**
 * Account, model key, and sign out — in one quiet popover.
 *
 * What it shows is deliberately thin: an email and whose OpenAI key is paying
 * for the request. No subject, no organization code, no resource id, no
 * permission array, no token internals. Those are how the server scopes data,
 * not facts a person needs while planning a day out.
 *
 * The key control lives here rather than in the workspace because it is a
 * setting, not part of planning. Its security model is unchanged: the key is
 * held in memory by the caller, sent as a header on each request, and never
 * rendered back — this component never receives the value it saved.
 */

export function AccountMenu({
  email,
  identity,
  keySource,
  hasSessionKey,
  onSaveKey,
  onClearKey,
  onSignOut
}: {
  email: string;
  identity: Identity | null;
  keySource: KeySource;
  hasSessionKey: boolean;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus returns to the control that opened it.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setEditing(false);
        setDraft('');
        triggerRef.current?.focus();
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setEditing(false);
        setDraft('');
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const usingOwnKey = hasSessionKey || keySource === 'request';
  const keyLabel = usingOwnKey
    ? 'Using your key'
    : keySource === 'server'
      ? 'Using server key'
      : 'No key configured';

  const initial = (email || '?').trim().charAt(0).toUpperCase();

  return (
    <div ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="account-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(value => !value)}
      >
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="account-name">{email}</span>
        <span className="subtle" aria-hidden="true">
          ⋯
        </span>
      </button>

      {open ? (
        <div className="popover" role="dialog" aria-label="Account and settings">
          <h3>Account</h3>
          <p className="small muted">{email}</p>

          <div className="popover-divider" />

          <h3>AI</h3>
          <div className="popover-row">
            <span className="small muted">OpenAI · {keyLabel}</span>
            {usingOwnKey ? (
              <button
                type="button"
                className="btn quiet small"
                onClick={() => {
                  onClearKey();
                  setEditing(false);
                  setDraft('');
                }}
              >
                Clear key
              </button>
            ) : (
              <button type="button" className="btn quiet small" onClick={() => setEditing(true)}>
                Add key
              </button>
            )}
          </div>

          {editing && !usingOwnKey ? (
            <form
              onSubmit={event => {
                event.preventDefault();
                const value = draft.trim();
                if (!value) return;
                onSaveKey(value);
                // The value is handed over and dropped here immediately; this
                // component never keeps a copy of it.
                setDraft('');
                setEditing(false);
              }}
            >
              <label className="sr-only" htmlFor="openai-key">
                OpenAI API key
              </label>
              <input
                id="openai-key"
                className="key-field"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                placeholder="sk-…"
                onChange={event => setDraft(event.target.value)}
              />
              <div className="popover-row">
                <span className="small subtle">Sent as a header, kept in memory only.</span>
                <button type="submit" className="btn small" disabled={!draft.trim()}>
                  Save key
                </button>
              </div>
            </form>
          ) : (
            <p className="small subtle">
              Your OpenAI API key is sent directly with your request and kept in memory only. It is
              never stored in your account or conversation history.
            </p>
          )}

          {identity && (!identity.can.readItinerary || !identity.can.createItinerary) ? (
            <>
              <div className="popover-divider" />
              <p className="small subtle">
                Some actions are unavailable in your organization. Saving and listing plans are
                checked on the server when you use them.
              </p>
            </>
          ) : null}

          <div className="popover-divider" />

          <button type="button" className="btn quiet small block" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
