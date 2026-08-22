import type {Memory} from '@mastra/memory';

import {AgentResponseSchema, type AgentResponse} from '../schemas/agent-response';
import {CORRECTION_PROMPT_PREFIX} from './itinerary-validator';

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
  return truncate(redactSecrets(text).replace(/\s+/g, ' '));
}

/**
 * Strip credential-shaped tokens from text that becomes stored metadata.
 *
 * The fallback title is the user's own words, and a title is shown in the
 * sidebar and persisted on the thread. Someone who pastes an API key into the
 * composer should not find it living there afterwards. This does not pretend to
 * sanitise the message itself — only the metadata derived from it.
 */
function redactSecrets(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, '[redacted]');
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

/**
 * One exchange, rebuilt for replay.
 *
 * `response` is the same `AgentResponse` envelope a live run returns, so the
 * browser renders history through exactly the same cards. Nothing is invented:
 * when a stored reply cannot be parsed back into the envelope, it becomes a
 * plain `message` carrying the assistant's own words.
 */
export type ConversationTurn = {
  id: string;
  request: string;
  response: AgentResponse;
};

export type ConversationDetail = ConversationSummary & {
  turns: ConversationTurn[];
};

/**
 * The assistant's own words, with tool traffic left behind.
 *
 * Stored assistant messages carry `tool-invocation` parts holding raw tool
 * arguments and complete tool results — full weather payloads, activity
 * records. None of that belongs in the browser, so only `text` parts are read.
 */
function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';

  const parts = (content as {parts?: unknown}).parts;
  if (!Array.isArray(parts)) {
    const plain = (content as {content?: unknown}).content;
    return typeof plain === 'string' ? plain : '';
  }

  return parts
    .filter(
      (part): part is {type: string; text: string} =>
        Boolean(part) &&
        typeof part === 'object' &&
        (part as {type?: unknown}).type === 'text' &&
        typeof (part as {text?: unknown}).text === 'string'
    )
    .map(part => part.text)
    .join('')
    .trim();
}

/** The user's own words. Same shape, but only text parts ever appear. */
function userText(content: unknown): string {
  return assistantText(content);
}

/**
 * Turn a stored reply back into the response envelope.
 *
 * The agent emits its reply as JSON (structured output injects the schema into
 * the prompt), so most stored replies parse straight back into an
 * `AgentResponse` and replay as the original card. When one does not — an older
 * message, a prose answer, a truncated record — the text is preserved verbatim
 * as a `message` rather than guessed into an itinerary shape.
 */
export function replayResponse(text: string): AgentResponse {
  const trimmed = text.trim();

  if (trimmed.startsWith('{')) {
    try {
      const parsed = AgentResponseSchema.safeParse(JSON.parse(trimmed));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON after all; fall through to the plain message below.
    }
  }

  return {
    kind: 'message',
    message: trimmed || 'This reply could not be restored.',
    permissionDenied: false,
    requiredPermission: null
  };
}

/**
 * Pair stored messages into turns.
 *
 * A turn is one user message and the last assistant reply that follows it.
 * Intermediate assistant messages are tool traffic and carry no reply text, so
 * they collapse away naturally.
 */
export function buildTurns(
  messages: readonly {role: string; content: unknown; createdAt: string}[]
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const request = userText(message.content);
      if (!request) continue;

      /*
       * A correction prompt is the workflow talking to the agent, not the
       * traveller talking to either. It is stored as a user message because
       * that is how it was sent, but replaying it would show the user words
       * they never wrote — so the reply it produced is attached to the turn
       * that actually asked for the plan.
       */
      if (request.startsWith(CORRECTION_PROMPT_PREFIX)) continue;

      turns.push({id: message.createdAt, request, response: replayResponse('')});
      continue;
    }

    if (message.role !== 'assistant' || turns.length === 0) continue;

    const text = assistantText(message.content);
    if (text) turns[turns.length - 1].response = replayResponse(text);
  }

  // A turn whose reply never arrived (the run failed) is not replayable.
  return turns.filter(turn => turn.response.kind !== 'message' || turn.response.message !== 'This reply could not be restored.');
}

/**
 * How many turns are kept on a thread.
 *
 * Thread metadata is a place to put a bounded amount of data, not a log. Older
 * turns fall off rather than growing a single row without limit; their text is
 * still in memory and still replays through the message path below.
 */
export const MAX_PERSISTED_TURNS = 30;

type PersistedTurn = {at: string; request: string; response: AgentResponse};

/** The persisted turns on a thread, ignoring anything that no longer parses. */
function persistedTurns(metadata: unknown): PersistedTurn[] {
  const raw = (metadata as {turns?: unknown} | null | undefined)?.turns;
  if (!Array.isArray(raw)) return [];

  const turns: PersistedTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const {at, request, response} = entry as Record<string, unknown>;
    if (typeof at !== 'string' || typeof request !== 'string') continue;

    // Re-validated on the way out as well as in: a metadata row that has been
    // hand-edited or written by an older version must not reach the browser.
    const parsed = AgentResponseSchema.safeParse(response);
    if (!parsed.success) continue;

    turns.push({at, request, response: parsed.data});
  }
  return turns;
}

/**
 * Persist the structured reply alongside its request.
 *
 * Replay used to rebuild turns from stored message text, which mostly produced
 * plain messages: the agent's message text is often prose, while the validated
 * object comes from the structuring pass and was never stored. Keeping the
 * envelope here is what lets a reopened conversation render the same
 * `ItineraryCard` the live run did.
 *
 * What is stored is exactly `AgentResponseSchema.parse(response)` — the schema
 * strips everything it does not declare, so a model key, a request context, a
 * raw tool argument or a tool result cannot ride along even if a caller passed
 * one. Correction prompts are the workflow talking to itself and are skipped.
 *
 * Failure is swallowed: replay fidelity must never break a completed plan.
 */
export async function recordTurnResponse(input: {
  memory: Memory;
  resourceId: string;
  threadId: string;
  request: string;
  response: AgentResponse;
}): Promise<void> {
  const {memory, resourceId, threadId, request, response} = input;

  if (request.startsWith(CORRECTION_PROMPT_PREFIX)) return;

  try {
    const thread = await memory.getThreadById({threadId});
    if (!thread || thread.resourceId !== resourceId) return;

    const safe = AgentResponseSchema.safeParse(response);
    if (!safe.success) return;

    const metadata = (thread.metadata ?? {}) as Record<string, unknown>;
    const turns = [
      ...persistedTurns(metadata),
      {at: new Date().toISOString(), request, response: safe.data}
    ].slice(-MAX_PERSISTED_TURNS);

    await memory.updateThread({
      id: threadId,
      title: thread.title ?? deriveConversationTitle(request),
      metadata: {...metadata, turns}
    });
  } catch (error) {
    console.error('[conversations] could not record turn', error);
  }
}

/**
 * The most recent validated itinerary on a thread.
 *
 * This is what makes a follow-up an edit rather than a fresh guess. It reads
 * the same persisted envelope replay uses, so no new storage is introduced and
 * nothing leaves the schema — an itinerary and nothing else.
 */
export async function latestItinerary(input: {
  memory: Memory;
  resourceId: string;
  threadId: string;
}): Promise<AgentResponse | undefined> {
  const {memory, resourceId, threadId} = input;

  try {
    const thread = await memory.getThreadById({threadId});
    if (!thread || thread.resourceId !== resourceId) return undefined;

    const turns = persistedTurns(thread.metadata);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (turns[index].response.kind === 'itinerary') return turns[index].response;
    }
  } catch (error) {
    console.error('[conversations] could not read the previous plan', error);
  }

  return undefined;
}

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

  /*
   * Structured turns win when they exist: they are the validated envelope the
   * user actually saw, so an itinerary replays as an itinerary. Threads from
   * before this existed fall back to rebuilding from message text, which yields
   * messages rather than fabricated structure.
   *
   * Either way only rebuilt turns leave this function. The raw messages carry
   * tool arguments and tool results, which the browser must never receive.
   */
  const stored = persistedTurns(thread.metadata);

  const turns = stored.length
    ? stored.map((turn, index) => ({
        id: `${turn.at}-${index}`,
        request: turn.request,
        response: turn.response
      }))
    : buildTurns(messages);

  return {...toSummary(thread), turns};
}
