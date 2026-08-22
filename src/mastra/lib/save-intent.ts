import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Whether the user actually asked for the plan to be saved.
 *
 * Instructions alone did not hold. The agent was told "planning never saves",
 * and it still called `save-itinerary` after ordinary requests like "Start
 * later." — observed twice in one ten-turn session. A prompt is guidance; this
 * is a gate.
 *
 * The intent is derived on the server from the message the user actually sent,
 * carried out-of-band in AsyncLocalStorage exactly as the BYOK key is, and read
 * by the tool. It is never accepted from the client, never part of agent input,
 * and never part of workflow state — so a model that decides to save anyway
 * cannot manufacture the permission to do it.
 *
 * This does not replace authorization. `save-itinerary` still checks the Kinde
 * `create:itinerary` permission against the verified token. Intent answers "did
 * they ask?"; the permission answers "are they allowed?". Both must hold.
 */

const storage = new AsyncLocalStorage<{explicit: boolean}>();

/**
 * Verbs that mean "persist this", paired with the plan as their object.
 *
 * `save` and `bookmark` are unambiguous in this app: there is nothing else to
 * save. `keep`, `remember` and `store` are not — "keep it relaxed" and "keep it
 * short" are ordinary planning requests — so those require the object to be the
 * plan itself rather than a bare pronoun followed by an adjective.
 */
const UNAMBIGUOUS_SAVE = /\b(save|bookmark)\b/i;

const KEEP_THE_PLAN =
  /\b(keep|remember|store)\b[^.?!]{0,24}\b(plan|itinerary|itineraries)\b/i;

/** "keep this"/"keep it" only counts when nothing modifies it. */
const KEEP_THIS = /\b(keep|remember|store)\s+(this|it|that)\s*(one|for me|for later|please)?\s*[.!]?$/i;

/**
 * Does this message explicitly ask to save?
 *
 * Deliberately conservative: a missed save is a user repeating themselves, an
 * unwanted save writes a record they never asked for. Detection is exact-match
 * on intent, never a guess about what the user "probably" wanted.
 */
export function hasExplicitSaveIntent(message: string): boolean {
  const text = String(message ?? '');
  if (!text.trim()) return false;

  if (UNAMBIGUOUS_SAVE.test(text)) return true;
  if (KEEP_THE_PLAN.test(text)) return true;
  return KEEP_THIS.test(text.trim());
}

/** Run `fn` with the save intent derived from the user's own message. */
export function runWithSaveIntent<T>(message: string, fn: () => T): T {
  return storage.run({explicit: hasExplicitSaveIntent(message)}, fn);
}

/**
 * Whether the current request carries explicit save intent.
 *
 * Defaults to `false` when no scope is active. Failing closed matters: a code
 * path that forgets to establish the scope must not silently gain the right to
 * write.
 */
export function saveIntentGranted(): boolean {
  return storage.getStore()?.explicit ?? false;
}
