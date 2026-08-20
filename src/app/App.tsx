import {useCallback, useEffect, useState} from 'react';
import {useKindeAuth} from '@kinde-oss/kinde-auth-react';

import {fetchIdentity, type Identity} from './lib/mastra-client';

export function App() {
  const {isLoading, isAuthenticated, user, login, logout, getAccessToken} = useKindeAuth();

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const loadIdentity = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const token = await getAccessToken();
      setIdentity(await fetchIdentity(token));
    } catch (err) {
      setIdentity(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, [getAccessToken]);

  useEffect(() => {
    if (isAuthenticated) void loadIdentity();
  }, [isAuthenticated, loadIdentity]);

  if (isLoading) {
    return (
      <main className="shell">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <h1>Plan My Day</h1>
          <p className="muted">Mastra agents, authenticated and scoped by Kinde.</p>
        </div>
        {isAuthenticated ? (
          <button className="btn ghost" onClick={() => void logout()}>
            Sign out
          </button>
        ) : null}
      </header>

      {!isAuthenticated ? (
        <section className="card center">
          <h2>Sign in to get started</h2>
          <p className="muted">
            You&apos;ll be sent to Kinde. The access token that comes back is what the Mastra
            server verifies on every request.
          </p>
          <button className="btn" onClick={() => void login()}>
            Sign in with Kinde
          </button>
        </section>
      ) : (
        <>
          <section className="card">
            <h2>Signed in</h2>
            <dl className="facts">
              <dt>Email</dt>
              <dd>{user?.email ?? '—'}</dd>
              <dt>Kinde user ID</dt>
              <dd>
                <code>{identity?.sub ?? '—'}</code>
              </dd>
              <dt>Organization</dt>
              <dd>{identity?.orgCode ? <code>{identity.orgCode}</code> : <em>none</em>}</dd>
              <dt>Memory resource ID</dt>
              <dd>
                {identity?.resourceId ? <code>{identity.resourceId}</code> : <em>not derived</em>}
                <span className="hint">derived server-side from the token</span>
              </dd>
            </dl>
          </section>

          <section className="card">
            <h2>Permissions</h2>
            {identity && identity.permissions.length > 0 ? (
              <ul className="chips">
                {identity.permissions.map(permission => (
                  <li key={permission} className="chip">
                    {permission}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No permissions on this token.</p>
            )}

            <ul className="checks">
              <Check ok={!!identity?.can.readItinerary} label="read:itinerary — view saved itineraries" />
              <Check ok={!!identity?.can.createItinerary} label="create:itinerary — save an itinerary" />
            </ul>
          </section>

          {identity?.claimWarnings.length ? (
            <section className="card warn">
              <h2>Kinde setup incomplete</h2>
              <ul>
                {identity.claimWarnings.map(warning => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {error ? (
            <section className="card error">
              <h2>Could not reach Mastra</h2>
              <p>{error}</p>
            </section>
          ) : null}

          <button className="btn ghost" onClick={() => void loadIdentity()} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check identity'}
          </button>

          <p className="muted next">
            Next: the planning agent, its tools, and saved itineraries.
          </p>
        </>
      )}
    </main>
  );
}

function Check({ok, label}: {ok: boolean; label: string}) {
  return (
    <li className={ok ? 'check yes' : 'check no'}>
      <span aria-hidden="true">{ok ? '✓' : '✕'}</span>
      {label}
    </li>
  );
}
