import type {ConversationSummary, Identity, KeySource} from '../lib/mastra-client';
import {AccountMenu} from './AccountMenu';

/**
 * Conversations, and who you are. Nothing else.
 *
 * The sidebar shows a title and a relative time per conversation — never a
 * thread id, resource id, org code or permission set. Those exist to scope data
 * on the server; putting them on screen would turn an ordinary product surface
 * into a debugging view.
 */

/** "Today", "Yesterday", then a date. Precision beyond that helps nobody here. */
export function relativeDay(value: string, now = new Date()): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';

  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(parsed)) / 86_400_000);

  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;

  return parsed.toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
}

export function Sidebar({
  open,
  conversations,
  activeThreadId,
  loading,
  failed,
  search,
  onSearch,
  onSelect,
  onNewPlan,
  identity,
  email,
  keySource,
  hasSessionKey,
  onSaveKey,
  onClearKey,
  onSignOut,
  promptForKey
}: {
  open: boolean;
  conversations: ConversationSummary[];
  activeThreadId?: string;
  loading: boolean;
  failed: boolean;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (threadId: string) => void;
  onNewPlan: () => void;
  identity: Identity | null;
  email: string;
  keySource: KeySource;
  hasSessionKey: boolean;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  onSignOut: () => void;
  promptForKey?: boolean;
}) {
  // Search only earns its place once scanning the list stops being trivial.
  const searchable = conversations.length >= 6;
  const term = search.trim().toLowerCase();
  const visible = term
    ? conversations.filter(item => item.title.toLowerCase().includes(term))
    : conversations;

  return (
    <nav className={open ? 'sidebar open' : 'sidebar'} aria-label="Conversations">
      <div className="sidebar-head">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Plan My Day
        </span>
      </div>

      <div className="sidebar-actions">
        <button type="button" className="btn ghost block small" onClick={onNewPlan}>
          + New plan
        </button>
      </div>

      {searchable ? (
        <div className="sidebar-search">
          <label className="sr-only" htmlFor="conversation-search">
            Search conversations
          </label>
          <input
            id="conversation-search"
            className="search-input"
            type="search"
            value={search}
            placeholder="Search plans"
            onChange={event => onSearch(event.target.value)}
          />
        </div>
      ) : null}

      <div className="sidebar-section">
        <p className="section-label" id="recent-label">
          Recent
        </p>

        {loading ? (
          <p className="sidebar-empty" role="status">
            Loading plans…
          </p>
        ) : failed ? (
          <p className="sidebar-empty" role="status">
            Your plans could not be loaded. Try again in a moment.
          </p>
        ) : visible.length === 0 ? (
          <p className="sidebar-empty">
            {term ? 'No plans match that search.' : 'No plans yet. Start one below.'}
          </p>
        ) : (
          <ul aria-labelledby="recent-label">
            {visible.map(conversation => {
              const active = conversation.threadId === activeThreadId;
              return (
                <li key={conversation.threadId}>
                  <button
                    type="button"
                    className={active ? 'conversation-item active' : 'conversation-item'}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(conversation.threadId)}
                  >
                    <span className="conversation-title">{conversation.title}</span>
                    <span className="conversation-time">
                      {relativeDay(conversation.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="sidebar-foot">
        <AccountMenu
          email={email}
          identity={identity}
          keySource={keySource}
          hasSessionKey={hasSessionKey}
          onSaveKey={onSaveKey}
          onClearKey={onClearKey}
          onSignOut={onSignOut}
          promptForKey={promptForKey}
        />
      </div>
    </nav>
  );
}
