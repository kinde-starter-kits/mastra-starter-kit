/**
 * A plain reply from the agent.
 *
 * The agent uses `kind: 'message'` for confirmations, clarifying questions and
 * — the case that matters most for this starter kit — permission refusals. The
 * backend decides the wording; the UI only detects a refusal so it can style it
 * as a denial rather than an ordinary reply. No permission logic lives here.
 */
export function MessageCard({message}: {message: string}) {
  const looksLikeDenial = /permission/i.test(message);

  if (!looksLikeDenial) {
    return (
      <article className="card message" aria-label="Reply">
        <p>{message}</p>
      </article>
    );
  }

  return (
    <article className="card denied" role="status" aria-label="Permission denied">
      <div className="denied-head">
        <span className="lock" aria-hidden="true">
          🔒
        </span>
        <h2>Not permitted</h2>
      </div>
      <p>{message}</p>
      <p className="muted small">
        Permissions come from Kinde and are checked on the server, inside the tool that performs
        the action. Ask an admin to grant the permission in your Kinde organization.
      </p>
    </article>
  );
}
