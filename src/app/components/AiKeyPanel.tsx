import {useEffect, useRef, useState} from 'react';

import type {KeySource} from '../lib/mastra-client';

/**
 * Model credential control.
 *
 * The key lives in React state for the current page session and is passed up
 * to the caller, which sends it as a request header. Nothing here writes to
 * localStorage, sessionStorage, cookies, or the URL, and the value is never
 * rendered back after entry.
 *
 * The provider list is a constant rather than a hardcoded single option, so
 * adding another provider later is a data change.
 */
const PROVIDERS = [{id: 'openai', label: 'OpenAI'}] as const;

export type AiKeyPanelProps = {
  keySource: KeySource;
  hasSessionKey: boolean;
  onSave: (key: string) => void;
  onClear: () => void;
};

function statusLabel(keySource: KeySource): {text: string; dot: string} {
  if (keySource === 'request') return {text: 'Using your key', dot: 'on'};
  if (keySource === 'server') return {text: 'Server configured', dot: 'on'};
  return {text: 'Add API key', dot: 'off'};
}

export function AiKeyPanel({keySource, hasSessionKey, onSave, onClear}: AiKeyPanelProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  const status = statusLabel(keySource);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  function save() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSave(trimmed);
    // Drop the plaintext from component state as soon as it is handed over.
    setDraft('');
    setOpen(false);
  }

  return (
    <div className="ai-control" ref={panelRef}>
      <button
        type="button"
        className="ai-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(value => !value)}
      >
        <span className="ai-label">AI: OpenAI</span>
        <span className={`ai-dot ${status.dot}`} aria-hidden="true" />
        <span className="ai-status">{status.text}</span>
      </button>

      {open ? (
        <div className="ai-panel" role="dialog" aria-label="AI provider settings">
          <label className="field">
            <span className="field-label">Provider</span>
            <select className="field-input" value="openai" disabled>
              {PROVIDERS.map(provider => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">API key</span>
            <input
              className="field-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={hasSessionKey ? 'Key configured — enter a new key to replace' : 'sk-…'}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  save();
                }
              }}
            />
          </label>

          <p className="field-help">
            Your key is kept in memory for this session and is sent only when the app calls
            OpenAI. It is not stored in the app database.
          </p>

          {keySource === 'server' && !hasSessionKey ? (
            <p className="field-help muted">
              A server key is configured. Adding your own key here will be used instead.
            </p>
          ) : null}

          <div className="ai-actions">
            <button type="button" className="btn small" onClick={save} disabled={!draft.trim()}>
              Save key
            </button>
            {hasSessionKey ? (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  onClear();
                  setDraft('');
                  setOpen(false);
                }}
              >
                Clear key
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
