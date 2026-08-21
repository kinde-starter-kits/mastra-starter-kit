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
