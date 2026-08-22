import {useCallback, useEffect, useRef, useState} from 'react';
import {useKindeAuth} from '@kinde-oss/kinde-auth-react';

import {
  MastraRequestError,
  fetchConversation,
  fetchConversations,
  fetchIdentity,
  PlanCancelledError,
  streamPlanTrip,
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
import {
  initialExecutionState,
  markInterrupted,
  reduceExecution,
  startExecution,
  type ExecutionState
} from './lib/execution-state';
import {describeChanges} from '../mastra/lib/itinerary-diff';
import {ExecutionPanel} from './components/ExecutionPanel';
import {Sidebar} from './components/Sidebar';
import {Composer} from './components/Composer';
import {ItineraryCard} from './components/ItineraryCard';
import {SavedList} from './components/SavedList';
import {MessageCard} from './components/MessageCard';

/**
 * Starting points for an empty workspace.
 *
 * Each is a request the application genuinely handles: the destination exists
 * in the activity data, and the constraint — a part of the day, weather, a
 * meal — is one the planner and validator both understand.
 */
const EXAMPLES = [
  'Plan a relaxed afternoon in Lisbon tomorrow.',
  'Plan a rainy Saturday in Copenhagen.',
  'Give me an evening in Mexico City with dinner.'
];

/**
 * Three shortcuts, in no meaningful order.
 *
 * They exist to save typing on a first visit, not to describe where the planner
 * works: places come from a worldwide gazetteer and a worldwide map, so any
 * city can be typed into the box below. Nothing here is a default, and no
 * destination is privileged over another.
 */
const POPULAR_DESTINATIONS = ['San Francisco', 'London', 'Lagos'];

/** The wording the server-side intent gate recognises as a request to save. */
const SAVE_PHRASE = 'Save this itinerary.';

type Turn = {
  id: string;
  request: string;
  response: AgentResponse;
  /** What the planner did for this turn, kept so history stays inspectable. */
  execution: ExecutionState;
  /** Set once this turn's plan has been saved, from the server's own answer. */
  saved?: boolean;
};

export function App() {
  const {isLoading, isAuthenticated, user, login, logout, getAccessToken} = useKindeAuth();

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [request, setRequest] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [execution, setExecution] = useState<ExecutionState>(initialExecutionState);
  // The reducer result is needed synchronously when the run ends, and React
  // state is not readable there, so the ref mirrors it.
  const executionRef = useRef<ExecutionState>(initialExecutionState);
  const abortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<
    {message: string; kind: string; detail?: string; request?: string} | null
  >(null);

  /*
   * The caller's OpenAI key, held in a ref so it lives in memory for this page
   * session only. It is deliberately not React state persisted anywhere — not
   * localStorage, sessionStorage, a cookie, or the URL — and never rendered.
   */
  const openaiKey = useRef<string | undefined>(undefined);
  const [hasSessionKey, setHasSessionKey] = useState(false);
  /** Set when a plan was attempted before a key was configured. */
  const [needsKey, setNeedsKey] = useState(false);

  // One thread for the whole conversation, so Memory can follow it.
  const threadId = useRef<string>(newThreadId());

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>(undefined);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [conversationsFailed, setConversationsFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /** Which turn a save was requested for, so the answer can be attributed. */
  const savingTurnId = useRef<string | null>(null);

  /** Refresh the conversation list from the server, which owns the truth. */
  const refreshConversations = useCallback(async () => {
    try {
      const {conversations: list} = await fetchConversations(await getAccessToken());
      setConversations(list);
      setConversationsFailed(false);
      return list;
    } catch (err) {
      console.error('[app] could not list conversations', err);
      setConversationsFailed(true);
      return [];
    }
  }, [getAccessToken]);

  /** Load a conversation, after the server has confirmed it belongs to us. */
  const openConversation = useCallback(
    async (id: string) => {
      setLoadingConversation(true);
      setError(null);
      setSidebarOpen(false);
      try {
        const detail = await fetchConversation(await getAccessToken(), id);
        threadId.current = detail.threadId;
        setActiveThreadId(detail.threadId);
        writeActiveThreadId(detail.threadId);
        /*
         * The transcript is rebuilt from what the server returns, never from
         * anything cached in the browser — localStorage holds the active thread
         * id and nothing else. Replayed turns carry no execution telemetry,
         * because that described a run that is over; the panel renders nothing
         * for them rather than inventing a timeline.
         */
        setTurns(
          detail.turns.map(turn => ({
            id: turn.id,
            request: turn.request,
            response: turn.response,
            execution: initialExecutionState
          }))
        );
        executionRef.current = initialExecutionState;
        setExecution(initialExecutionState);
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

      /*
       * This deployment is strictly bring-your-own-key, so a request without
       * one cannot succeed. Asking for the key here means the user sees the
       * form rather than a failed run, and no request is sent.
       */
      if (!openaiKey.current) {
        setNeedsKey(true);
        setError(null);
        return;
      }

      setBusy(true);
      setError(null);

      const fresh = startExecution();
      executionRef.current = fresh;
      setExecution(fresh);

      const controller = new AbortController();
      abortRef.current = controller;
      const savedFor = savingTurnId.current;

      try {
        const token = await getAccessToken();
        const response = await streamPlanTrip(
          token,
          {message: trimmed, threadId: threadId.current},
          {
            openaiKey: openaiKey.current,
            signal: controller.signal,
            // Each event is folded in as it arrives, so the timeline reflects
            // work the server has actually finished — never a guess.
            onEvent: streamed => {
              executionRef.current = reduceExecution(executionRef.current, streamed);
              setExecution(executionRef.current);
            }
          }
        );

        setTurns(previous => {
          const next = [
            ...previous,
            {id: `${Date.now()}`, request: trimmed, response, execution: executionRef.current}
          ];

          /*
           * A save is only marked when the server said it happened: the reply
           * is a message and it is not a permission refusal. The browser never
           * decides authorization — it reads the answer.
           */
          if (savedFor && response.kind === 'message' && !response.permissionDenied) {
            return next.map(turn => (turn.id === savedFor ? {...turn, saved: true} : turn));
          }
          return next;
        });

        setActiveThreadId(threadId.current);
        writeActiveThreadId(threadId.current);
        void refreshConversations();
        setRequest('');
      } catch (err) {
        if (err instanceof PlanCancelledError) {
          // The user stopped it. Clear the timeline rather than reporting a
          // failure they caused deliberately.
          executionRef.current = initialExecutionState;
          setExecution(initialExecutionState);
          return;
        }

        executionRef.current = markInterrupted(
          executionRef.current,
          err instanceof MastraRequestError ? err.kind : 'unknown'
        );
        setExecution(executionRef.current);

        // The request stays in the box so a failure never costs the user their
        // words.
        setRequest(current => current || trimmed);

        setError(
          err instanceof MastraRequestError
            ? {message: err.message, kind: err.kind, detail: err.detail, request: trimmed}
            : {message: 'Something went wrong. Please try again.', kind: 'unknown', request: trimmed}
        );
      } finally {
        savingTurnId.current = null;
        abortRef.current = null;
        setBusy(false);
      }
    },
    [busy, getAccessToken, refreshConversations]
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const saveTurn = useCallback(
    (id: string) => {
      savingTurnId.current = id;
      void send(SAVE_PHRASE);
    },
    [send]
  );

  const startNewConversation = useCallback(() => {
    // A fresh thread. Existing conversations are left untouched, and the BYOK
    // key stays exactly where it is — in memory for this session.
    threadId.current = newThreadId();
    setTurns([]);
    executionRef.current = initialExecutionState;
    setExecution(initialExecutionState);
    setError(null);
    setRequest('');
    setActiveThreadId(undefined);
    setSidebarOpen(false);
    clearActiveThreadId();
  }, []);

  if (isLoading) {
    return (
      <main className="centered">
        <p className="muted" role="status">
          Checking your session…
        </p>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="centered">
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

  const activeTitle =
    conversations.find(item => item.threadId === activeThreadId)?.title ?? 'New plan';

  return (
    <div className="app">
      <button
        type="button"
        className={sidebarOpen ? 'scrim open' : 'scrim'}
        aria-label="Close navigation"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
        onKeyDown={event => {
          if (event.key === 'Escape') setSidebarOpen(false);
        }}
      />

      <Sidebar
        open={sidebarOpen}
        conversations={conversations}
        activeThreadId={activeThreadId}
        loading={loadingConversation && conversations.length === 0}
        failed={conversationsFailed}
        search={search}
        onSearch={setSearch}
        onSelect={id => void openConversation(id)}
        onNewPlan={startNewConversation}
        identity={identity}
        email={user?.email ?? 'Signed in'}
        keySource={hasSessionKey ? 'request' : (identity?.ai?.keySource ?? null)}
        hasSessionKey={hasSessionKey}
        promptForKey={needsKey}
        onSaveKey={key => {
          openaiKey.current = key;
          setHasSessionKey(true);
          setNeedsKey(false);
          setError(null);
        }}
        onClearKey={() => {
          openaiKey.current = undefined;
          setHasSessionKey(false);
        }}
        onSignOut={() => void logout()}
      />

      <div className="workspace">
        <header className="workspace-head">
          <button
            type="button"
            className="btn quiet small sidebar-toggle"
            aria-label="Show conversations"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(value => !value)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <span className="workspace-title">{activeTitle}</span>
        </header>

        <div className="workspace-scroll">
          <div className="thread">
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

            {needsKey && !hasSessionKey ? (
              <section className="card warn" role="status">
                <h2>Add your OpenAI API key to use Plan My Day</h2>
                <p className="small muted">
                  Planning runs on your own OpenAI account. Open the account menu at the foot of
                  the sidebar and add a key. It is sent with each request and kept in memory only.
                </p>
              </section>
            ) : null}

            {turns.length === 0 && !busy && !error ? (
              <div className="empty-state">
                <h2>What&apos;s the plan?</h2>
                <p>
                  Describe the day you want. The planner checks the real forecast, finds activities
                  that fit, and builds an itinerary you can save.
                </p>
                {/* Real requests, not decoration: each one names a city the
                    activity data covers and a constraint the planner honours. */}
                <p className="section-label destinations-label">Popular destinations</p>
                <ul className="destinations">
                  {POPULAR_DESTINATIONS.map(city => (
                    <li key={city}>
                      <button
                        type="button"
                        className="destination"
                        onClick={() => setRequest(`Plan a relaxed afternoon in ${city} tomorrow.`)}
                      >
                        {city}
                      </button>
                    </li>
                  ))}
                </ul>

                <ul className="examples">
                  {EXAMPLES.map(example => (
                    <li key={example}>
                      <button
                        type="button"
                        className="example"
                        onClick={() => setRequest(example)}
                      >
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {turns.map((turn, index) => (
              <section key={turn.id} className="turn">
                <p className="asked">{turn.request}</p>
                <ExecutionPanel state={turn.execution} />
                {/* Derived by comparing the two structured plans, so it can only
                    ever describe differences that genuinely exist. */}
                <ChangeSummary changes={changesFor(turns, index)} />
                <ResponseView
                  response={turn.response}
                  saved={turn.saved}
                  saving={busy && savingTurnId.current === turn.id}
                  onSave={() => saveTurn(turn.id)}
                />
              </section>
            ))}

            {busy || execution.status === 'failed' ? (
              <ExecutionPanel state={execution} onCancel={cancel} />
            ) : null}

            {error ? (
              <ErrorPanel
                error={error}
                busy={busy}
                onRetry={error.request ? () => void send(error.request as string) : undefined}
              />
            ) : null}
          </div>
        </div>

        <Composer
          value={request}
          onChange={setRequest}
          onSubmit={() => void send(request)}
          onCancel={cancel}
          busy={busy}
          canCancel={Boolean(abortRef.current)}
          showHints={turns.length > 0}
        />
      </div>
    </div>
  );
}

/**
 * What changed between this plan and the one before it.
 *
 * Computed from the two structured itineraries rather than asked of the model,
 * which is the only way a summary can be trusted: if the plans are effectively
 * the same, there is nothing to list and nothing is shown.
 */
function changesFor(turns: Turn[], index: number): string[] {
  const current = turns[index]?.response;
  if (current?.kind !== 'itinerary') return [];

  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const earlier = turns[previous].response;
    if (earlier.kind !== 'itinerary') continue;
    return describeChanges(earlier.itinerary, current.itinerary);
  }

  return [];
}

function ChangeSummary({changes}: {changes: string[]}) {
  if (changes.length === 0) return null;

  return (
    <div className="change-summary">
      <p className="change-summary-title">Updated your plan</p>
      <ul>
        {changes.map(change => (
          <li key={change}>{change}</li>
        ))}
      </ul>
    </div>
  );
}

function ResponseView({
  response,
  onSave,
  saved,
  saving
}: {
  response: AgentResponse;
  onSave?: () => void;
  saved?: boolean;
  saving?: boolean;
}) {
  switch (response.kind) {
    case 'itinerary':
      return (
        <ItineraryCard
          itinerary={response.itinerary}
          onSave={onSave}
          saved={saved}
          saving={saving}
        />
      );
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

function ErrorPanel({
  error,
  onRetry,
  busy
}: {
  error: {message: string; kind: string; detail?: string};
  onRetry?: () => void;
  busy?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <section className="card error" role="alert">
      <h2>{FAILURE_TITLES[error.kind as FailureKind] ?? FAILURE_TITLES.unknown}</h2>
      <p className="small muted">{error.message}</p>

      <div className="error-actions">
        {/* Offered for anything worth another attempt. A transient model
            formatting slip is the common case and usually succeeds again. */}
        {onRetry ? (
          <button type="button" className="btn small" onClick={onRetry} disabled={busy}>
            Try again
          </button>
        ) : null}
        {error.detail ? (
          <button
            type="button"
            className="btn quiet small"
            onClick={() => setShowDetail(value => !value)}
          >
            {showDetail ? 'Hide details' : 'Show details'}
          </button>
        ) : null}
      </div>

      {showDetail && error.detail ? <pre className="error-detail">{error.detail}</pre> : null}
    </section>
  );
}
