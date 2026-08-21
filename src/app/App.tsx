import {useCallback, useEffect, useRef, useState} from 'react';
import {useKindeAuth} from '@kinde-oss/kinde-auth-react';

import {
  MastraRequestError,
  fetchIdentity,
  runPlanTrip,
  type AgentResponse,
  type Identity
} from './lib/mastra-client';
import {newThreadId} from './lib/thread';
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
  const [error, setError] = useState<string | null>(null);

  // One thread for the whole conversation, so Memory can follow it.
  const threadId = useRef<string>(newThreadId());

  useEffect(() => {
    if (!isAuthenticated) return;
    void (async () => {
      try {
        setIdentity(await fetchIdentity(await getAccessToken()));
      } catch (err) {
        console.error('[app] could not load identity', err);
      }
    })();
  }, [isAuthenticated, getAccessToken]);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (!trimmed || busy) return;

      setBusy(true);
      setError(null);

      try {
        const token = await getAccessToken();
        const response = await runPlanTrip(token, {message: trimmed, threadId: threadId.current});
        setTurns(previous => [...previous, {id: `${Date.now()}`, request: trimmed, response}]);
        // Clear the box so the natural next step — "Save this itinerary." —
        // does not require deleting the previous request first.
        setRequest('');
      } catch (err) {
        setError(
          err instanceof MastraRequestError ? err.message : 'Something went wrong. Please try again.'
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, getAccessToken]
  );

  const startNewConversation = useCallback(() => {
    threadId.current = newThreadId();
    setTurns([]);
    setError(null);
    setRequest(EXAMPLE);
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

      {error ? (
        <section className="card error" role="alert">
          <h2>That didn&apos;t work</h2>
          <p>{error}</p>
        </section>
      ) : null}

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

function PermissionPill({ok, label}: {ok: boolean; label: string}) {
  return (
    <span className={ok ? 'pill yes' : 'pill no'}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span> {label}
    </span>
  );
}
