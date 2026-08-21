import {useCallback, useEffect, useRef, useState} from 'react';
import {useKindeAuth} from '@kinde-oss/kinde-auth-react';

import {
  MastraRequestError,
  fetchConversation,
  fetchConversations,
  fetchIdentity,
  runPlanTrip,
  type ConversationSummary,
  type AgentResponse,
  type Identity
} from './lib/mastra-client';
import {
  clearActiveThreadId,
  newThreadId,
  readActiveThreadId,
  writeActiveThreadId
} from './lib/thread';
import {FAILURE_TITLES, type FailureKind} from './lib/failure';
import {AiKeyPanel} from './components/AiKeyPanel';
import {ItineraryCard} from './components/ItineraryCard';
import {SavedList} from './components/SavedList';
import {MessageCard} from './components/MessageCard';

const EXAMPLE = "Plan me an afternoon in Lagos tomorrow. I like outdoor activities and don't want anything too early.";

type Turn = {id: string; request: string; response: AgentResponse};

export function App() {
  const {isLoading, isAuthenticated, user, login, logout, getAccessToken} = useKindeAuth();

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [request, setRequest] = useState(EXAMPLE);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{message: string; kind: string; detail?: string} | null>(null);

  /*
   * The caller's OpenAI key, held in a ref so it lives in memory for this page
   * session only. It is deliberately not React state persisted anywhere, not
   * in localStorage, sessionStorage, a cookie, or the URL, and it is never
   * rendered back to the screen.
   */
  const openaiKey = useRef<string | undefined>(undefined);
  const [hasSessionKey, setHasSessionKey] = useState(false);

  // One thread for the whole conversation, so Memory can follow it.
  const threadId = useRef<string>(newThreadId());

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [loadingConversation, setLoadingConversation] = useState(false);

  /** Refresh the conversation list from the server, which owns the truth. */
  const refreshConversations = useCallback(async () => {
    try {
      const {conversations: list} = await fetchConversations(await getAccessToken());
      setConversations(list);
      return list;
    } catch (err) {
      console.error('[app] could not list conversations', err);
      return [];
    }
  }, [getAccessToken]);

  /** Load a conversation, after the server has confirmed it belongs to us. */
  const openConversation = useCallback(
    async (id: string) => {
      setLoadingConversation(true);
      setError(null);
      try {
        const detail = await fetchConversation(await getAccessToken(), id);
        threadId.current = detail.threadId;
        setActiveThreadId(detail.threadId);
        writeActiveThreadId(detail.threadId);
        // Messages come from the server; the transcript is rebuilt from this
        // conversation rather than from anything cached in the browser.
        setTurns([]);
        setRequest('');
      } catch (err) {
        // A thread that is gone, or was never ours, is not an error state —
        // it just means there is nothing to resume.
        console.error('[app] could not open conversation', err);
        clearActiveThreadId();
        setActiveThreadId(undefined);
      } finally {
        setLoadingConversation(false);
      }
    },
    [getAccessToken]
  );

  useEffect(() => {
    if (!isAuthenticated) return;
    void (async () => {
      try {
        setIdentity(await fetchIdentity(await getAccessToken(), openaiKey.current));
      } catch (err) {
        console.error('[app] could not load identity', err);
      }
    })();
  }, [isAuthenticated, getAccessToken, hasSessionKey]);

  /*
   * Startup hydration: list the caller's conversations, then resume the one
   * they were last on — but only if it is actually in their list, so a stale
   * or foreign id in localStorage can never select someone else's thread.
   */
  useEffect(() => {
    if (!isAuthenticated) return;
    void (async () => {
      const list = await refreshConversations();
      const remembered = readActiveThreadId();

      if (remembered && list.some(c => c.threadId === remembered)) {
        await openConversation(remembered);
      } else if (remembered) {
        clearActiveThreadId();
      }
    })();
  }, [isAuthenticated, refreshConversations, openConversation]);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || busy) return;

      setBusy(true);
      setError(null);

      try {
        const token = await getAccessToken();
        const response = await runPlanTrip(
          token,
          {message: trimmed, threadId: threadId.current},
          openaiKey.current
        );
        setTurns(previous => [...previous, {id: `${Date.now()}`, request: trimmed, response}]);
        setActiveThreadId(threadId.current);
        writeActiveThreadId(threadId.current);
        void refreshConversations();
        // Clear the box so the natural next step — "Save this itinerary." —
        // does not require deleting the previous request first.
        setRequest('');
      } catch (err) {
        setError(
          err instanceof MastraRequestError
            ? {message: err.message, kind: err.kind, detail: err.detail}
            : {message: 'Something went wrong. Please try again.', kind: 'unknown'}
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, getAccessToken, refreshConversations]
  );

  const startNewConversation = useCallback(() => {
    // A fresh thread. Existing conversations are left untouched, and the BYOK
    // key stays exactly where it is — in memory for this session.
    threadId.current = newThreadId();
    setTurns([]);
    setError(null);
    setRequest(EXAMPLE);
    setActiveThreadId(undefined);
    clearActiveThreadId();
  }, []);

  if (isLoading) {
    return (
      <main className="shell">
        <p className="muted" role="status">
          Loading…
        </p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="shell">
        <section className="card hero">
          <p className="eyebrow">Mastra × Kinde</p>
          <h1>Plan My Day</h1>
          <p className="lede">
            An AI day planner that knows who you are, which organization you belong to, and what
            you&apos;re allowed to do.
          </p>
          <button className="btn" onClick={() => void login()}>
            Sign in with Kinde
          </button>
          <p className="muted small">
            You&apos;ll be sent to Kinde. The access token that comes back is what the Mastra
            server verifies on every request.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="dot" aria-hidden="true" />
          <strong>Plan My Day</strong>
        </div>
        <div className="who">
          <span className="email">{user?.email ?? identity?.sub ?? 'Signed in'}</span>
          {identity?.orgCode ? <span className="org">{identity.orgCode}</span> : null}
          <AiKeyPanel
            keySource={hasSessionKey ? 'request' : (identity?.ai?.keySource ?? null)}
            hasSessionKey={hasSessionKey}
            onSave={key => {
              openaiKey.current = key;
              setHasSessionKey(true);
              setError(null);
            }}
            onClear={() => {
              openaiKey.current = undefined;
              setHasSessionKey(false);
            }}
          />
          <button className="btn ghost small" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>

      {identity?.claimWarnings.length ? (
        <section className="card warn" role="status">
          <h2>Kinde setup incomplete</h2>
          <ul>
            {identity.claimWarnings.map(warning => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card composer">
        <h1>What&apos;s the plan?</h1>
        <p className="muted">
          Describe the day you want. The agent checks the weather, finds activities, and builds an
          itinerary. Ask it to <em>save this itinerary</em> once you like it.
        </p>

        <form
          onSubmit={event => {
            event.preventDefault();
            void send(request);
          }}
        >
          <label className="sr-only" htmlFor="request">
            Your request
          </label>
          <textarea
            id="request"
            rows={3}
            value={request}
            disabled={busy}
            onChange={event => setRequest(event.target.value)}
            placeholder={EXAMPLE}
          />

          <div className="actions">
            <button className="btn" type="submit" disabled={busy || request.trim().length === 0}>
              {busy ? 'Planning…' : 'Plan my day'}
            </button>
            {turns.length > 0 ? (
              <button className="btn ghost" type="button" onClick={startNewConversation}>
                New conversation
              </button>
            ) : null}
          </div>
        </form>

        {identity ? (
          <p className="perms">
            <PermissionPill ok={identity.can.readItinerary} label="read:itinerary" />
            <PermissionPill ok={identity.can.createItinerary} label="create:itinerary" />
          </p>
        ) : null}
      </section>

      <section className="card conversations" aria-label="Recent conversations">
        <div className="conversations-head">
          <h2>Recent conversations</h2>
          <button className="btn ghost small" type="button" onClick={startNewConversation}>
            + New conversation
          </button>
        </div>

        {loadingConversation ? (
          <p className="muted small" role="status">
            Loading conversation…
          </p>
        ) : conversations.length === 0 ? (
          <p className="muted small">No conversations yet. Send a request to start one.</p>
        ) : (
          <ul className="conversation-list">
            {conversations.map(conversation => (
              <li key={conversation.threadId}>
                <button
                  type="button"
                  className={
                    conversation.threadId === activeThreadId
                      ? 'conversation-item active'
                      : 'conversation-item'
                  }
                  aria-current={conversation.threadId === activeThreadId ? 'true' : undefined}
                  onClick={() => void openConversation(conversation.threadId)}
                >
                  <span className="conversation-title">{conversation.title}</span>
                  <span className="conversation-time">
                    {new Date(conversation.updatedAt).toLocaleString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error ? <ErrorPanel error={error} /> : null}

      {busy ? (
        <section className="card loading" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>Checking the weather and finding activities…</span>
        </section>
      ) : null}

      {turns.length === 0 && !busy && !error ? (
        <section className="card empty">
          <h2>Nothing planned yet</h2>
          <p className="muted">Send a request above to get started.</p>
        </section>
      ) : null}

      {[...turns].reverse().map(turn => (
        <section key={turn.id} className="turn">
          <p className="asked">“{turn.request}”</p>
          <ResponseView response={turn.response} />
        </section>
      ))}
    </main>
  );
}

function ResponseView({response}: {response: AgentResponse}) {
  switch (response.kind) {
    case 'itinerary':
      return <ItineraryCard itinerary={response.itinerary} />;
    case 'saved-list':
      return <SavedList itineraries={response.itineraries} />;
    case 'message':
      return (
        <MessageCard
          message={response.message}
          permissionDenied={response.permissionDenied}
          requiredPermission={response.requiredPermission}
        />
      );
    default:
      return null;
  }
}

function ErrorPanel({error}: {error: {message: string; kind: string; detail?: string}}) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <section className="card error" role="alert">
      <h2>{FAILURE_TITLES[error.kind as FailureKind] ?? FAILURE_TITLES.unknown}</h2>
      <p>{error.message}</p>
      {error.detail ? (
        <>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => setShowDetail(value => !value)}
          >
            {showDetail ? 'Hide details' : 'Show details'}
          </button>
          {showDetail ? <pre className="error-detail">{error.detail}</pre> : null}
        </>
      ) : null}
    </section>
  );
}

function PermissionPill({ok, label}: {ok: boolean; label: string}) {
  return (
    <span className={ok ? 'pill yes' : 'pill no'}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span> {label}
    </span>
  );
}
