/**
 * Conversation thread identity.
 *
 * Mastra Memory needs a thread id per conversation. The browser chooses it —
 * that is safe, because a thread only ever belongs to the resource the server
 * derived from the Kinde token, and Mastra rejects a thread owned by a
 * different resource. The browser never chooses the resource id.
 */
export function newThreadId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `thread_${crypto.randomUUID()}`;
  }
  return `thread_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The thread the user was last looking at.
 *
 * Kept in localStorage purely so a reload lands back on the same conversation.
 * It is untrusted UI state: the server re-checks ownership on every read, and
 * an id that does not belong to the caller simply yields a not-found, which the
 * app treats as "start a new plan". Nothing is authorised from this value, and
 * no conversation content is cached here.
 */
const ACTIVE_THREAD_KEY = 'planmyday.activeThreadId';

export function readActiveThreadId(): string | undefined {
  try {
    return window.localStorage.getItem(ACTIVE_THREAD_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeActiveThreadId(threadId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
  } catch {
    // Private browsing or disabled storage: the app still works, it just does
    // not resume the previous conversation.
  }
}

export function clearActiveThreadId(): void {
  try {
    window.localStorage.removeItem(ACTIVE_THREAD_KEY);
  } catch {
    // Ignore.
  }
}
