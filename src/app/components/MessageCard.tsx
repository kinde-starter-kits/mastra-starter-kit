/**
 * A plain reply from the agent.
 *
 * The agent uses `kind: 'message'` for confirmations, clarifying questions and
 * — the case that matters most for this starter kit — permission refusals.
 *
 * Whether something was refused is read from `permissionDenied`, which the
 * backend sets from the tool's own result. The UI never inspects the wording
 * and never decides policy; it only chooses how to present what the server
 * already decided.
 */
export function MessageCard({
  message,
  permissionDenied = false,
  requiredPermission = null
}: {
  message: string;
  permissionDenied?: boolean;
  requiredPermission?: string | null;
}) {
  if (!permissionDenied) {
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
      {requiredPermission ? (
        <p className="small">
          Requires <code>{requiredPermission}</code> in your Kinde organization.
        </p>
      ) : null}
      <p className="muted small">
        Permissions come from Kinde and are checked on the server, inside the tool that performs
        the action.
      </p>
    </article>
  );
}
