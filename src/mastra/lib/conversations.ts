import type {Memory} from '@mastra/memory';

import {SEEDED_ACTIVITIES} from '../tools/find-activities';

/**
 * Conversations, built on Mastra's own thread storage.
 *
 * Mastra already persists a thread record with an id, a resource id, a title
 * and timestamps, and can list threads filtered by resource. That is the whole
 * conversation model, so no second table and no duplicated message store is
 * introduced here. This module adds only the two things Mastra does not:
 * a deterministic title, and an ownership check on every read.
 *
 * The resource id always arrives from the caller, which obtains it from the
 * verified Kinde request context. Nothing here reads a resource id, org code
 * or subject from client input.
 */

/** Metadata a client may see. Deliberately excludes messages and internals. */
export type ConversationSummary = {
  threadId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export const MAX_TITLE_LENGTH = 60;

const TIMEFRAMES = [
  'weekend',
  'afternoon',
  'morning',
  'evening',
  'night',
  'day trip',
  'day'
] as const;

/** Cities the activity dataset covers, matched first because they are known-good. */
const KNOWN_DESTINATIONS = [...new Set(SEEDED_ACTIVITIES.map(activity => activity.location))];

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map(word => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/**
 * Derive a short conversation title from the traveller's first request.
 *
 * Deterministic and local — no extra model call is made purely to name a
 * conversation. It looks for a destination the dataset knows about, then a
 * timeframe word, and falls back to a trimmed version of the message when it
 * cannot identify either.
 */
export function deriveConversationTitle(firstMessage: string): string {
  const text = (firstMessage ?? '').trim();
  if (!text) return 'New plan';

  const lower = text.toLowerCase();

  let destination = KNOWN_DESTINATIONS.find(city => lower.includes(city.toLowerCase()));

  if (!destination) {
    // "... in Lisbon tomorrow" — take the capitalised phrase after "in".
    const match = /\bin\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)/.exec(text);
    if (match) destination = match[1]!.trim();
  }

  const timeframe = TIMEFRAMES.find(word => lower.includes(word));

  if (destination) {
    const label = timeframe ? `${destination} ${timeframe}` : `${destination} plans`;
    return truncate(titleCase(label));
  }

  // Nothing identifiable: a normalised, trimmed version of what they asked.
  return truncate(text.replace(/\s+/g, ' '));
}

function truncate(value: string): string {
  if (value.length <= MAX_TITLE_LENGTH) return value;
  return `${value.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function toSummary(thread: {
  id: string;
  title?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}): ConversationSummary {
  const iso = (value: Date | string) =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();

  return {
    threadId: thread.id,
    title: thread.title?.trim() || 'New plan',
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt)
  };
}

/**
 * Create the conversation if it does not exist yet, and touch it if it does.
 *
 * Idempotent: repeated turns on the same thread update the record rather than
 * inserting another. The title is set once, from the first request, so later
 * messages do not rewrite it.
 */
export async function ensureConversation(input: {
  memory: Memory;
  resourceId: string;
  threadId: string;
  firstMessage: string;
}): Promise<ConversationSummary> {
  const {memory, resourceId, threadId, firstMessage} = input;

  const existing = await memory.getThreadById({threadId});

  if (existing && existing.resourceId === resourceId) {
    const title = existing.title?.trim() || deriveConversationTitle(firstMessage);
    const updated = await memory.updateThread({id: threadId, title, metadata: existing.metadata});
    return toSummary(updated ?? {...existing, title, updatedAt: new Date()});
  }

  if (existing && existing.resourceId !== resourceId) {
    // The thread belongs to somebody else. Refuse rather than adopt it.
    throw new ConversationAccessError(threadId);
  }

  const created = await memory.createThread({
    threadId,
    resourceId,
    title: deriveConversationTitle(firstMessage)
  });

  return toSummary(created);
}

/** Raised when a thread is not readable by the authenticated resource. */
export class ConversationAccessError extends Error {
  readonly code = 'conversation_not_found';
  constructor(readonly threadId: string) {
    // Deliberately identical wording whether the thread is missing or owned by
    // someone else, so a caller cannot probe for the existence of other
    // people's conversations.
    super('Conversation not found.');
    this.name = 'ConversationAccessError';
  }
}

/** Every conversation belonging to one resource, newest activity first. */
export async function listConversations(input: {
  memory: Memory;
  resourceId: string;
}): Promise<ConversationSummary[]> {
  const {memory, resourceId} = input;

  const result = await memory.listThreads({filter: {resourceId}} as never);
  const threads = (Array.isArray(result) ? result : (result?.threads ?? [])) as {
    id: string;
    title?: string;
    resourceId: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  }[];

  return threads
    // Belt and braces: filter by owner again, so a storage adapter that ignores
    // the filter cannot leak another resource's conversations.
    .filter(thread => thread.resourceId === resourceId)
    .map(toSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type ConversationDetail = ConversationSummary & {
  messages: {role: string; content: unknown; createdAt: string}[];
};

/**
 * Load one conversation, after confirming it belongs to the caller.
 *
 * Messages come from Mastra Memory, which is the single source of truth. No
 * second representation is stored.
 */
export async function loadConversation(input: {
  memory: Memory;
  resourceId: string;
  threadId: string;
}): Promise<ConversationDetail> {
  const {memory, resourceId, threadId} = input;

  const thread = await memory.getThreadById({threadId});

  // Missing and not-yours are the same answer on purpose.
  if (!thread || thread.resourceId !== resourceId) {
    throw new ConversationAccessError(threadId);
  }

  const recalled = await memory.recall({threadId, resourceId} as never);

  const messages = (recalled?.messages ?? []).map(message => ({
    role: String((message as {role?: unknown}).role ?? 'assistant'),
    content: (message as {content?: unknown}).content,
    createdAt: new Date((message as {createdAt?: string | Date}).createdAt ?? Date.now()).toISOString()
  }));

  return {...toSummary(thread), messages};
}
