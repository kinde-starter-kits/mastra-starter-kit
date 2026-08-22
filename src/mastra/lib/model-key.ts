import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Per-request model credentials, deliberately kept out of every durable path.
 *
 * A caller may bring their own OpenAI key. That key must never reach the
 * database, working memory, workflow input, workflow snapshots, or traces, so
 * it is not carried on `RequestContext` — Mastra passes request context into
 * workflow runs, where it can be snapshotted. It lives instead in
 * `AsyncLocalStorage` for the lifetime of the HTTP request, which no Mastra
 * persistence path can reach.
 *
 * The key is read once, in server middleware, and consumed once, when the
 * model is constructed. It is never returned to a client, logged, or included
 * in an error message.
 */

/** Header the browser uses to send a caller-supplied key. */
export const OPENAI_KEY_HEADER = 'x-openai-api-key';

type RequestModelCredentials = {openaiApiKey?: string};

const storage = new AsyncLocalStorage<RequestModelCredentials>();

/** Run `fn` with the caller's key attached to the current async context. */
export function runWithRequestModelKey<T>(openaiApiKey: string | undefined, fn: () => T): T {
  return storage.run({openaiApiKey: normalize(openaiApiKey)}, fn);
}

/** The caller-supplied key for the current request, if there is one. */
export function getRequestModelKey(): string | undefined {
  return storage.getStore()?.openaiApiKey;
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Where the key used for a request came from.
 *
 * Only one source exists. The type is kept as a union of one so the wire shape
 * and the client's handling stay explicit rather than boolean.
 */
export type ModelKeySource = 'request';

/**
 * Raised when the caller supplied no key. Carries no key material.
 *
 * This is the only outcome when a key is absent: the deployment is strictly
 * bring-your-own, so there is no server credential to fall back to and no model
 * call is attempted.
 */
export class ModelKeyMissingError extends Error {
  readonly code = 'model_key_missing';
  constructor() {
    super('No OpenAI API key was supplied with this request. Add your own key in the app.');
    this.name = 'ModelKeyMissingError';
  }
}

/**
 * Resolve the key for this request.
 *
 * Deliberately the caller's key or nothing. An earlier version fell back to
 * `process.env.OPENAI_API_KEY`, which meant a shared deployment silently spent
 * the maintainer's quota for every visitor. The environment variable is now
 * never read for model access, so setting it cannot re-enable that.
 */
export function resolveModelKey(): {apiKey: string; source: ModelKeySource} {
  const fromRequest = getRequestModelKey();
  if (fromRequest) return {apiKey: fromRequest, source: 'request'};

  throw new ModelKeyMissingError();
}

/** True when the caller supplied a key. Reveals no key material. */
export function hasModelKey(): boolean {
  return Boolean(getRequestModelKey());
}

/**
 * Build the model configuration for this request.
 *
 * Returning `{id, apiKey}` makes Mastra's model gateway use this key for this
 * call only, instead of reading the process environment.
 */
export function resolveModelConfig(modelId: `${string}/${string}`): {
  id: `${string}/${string}`;
  apiKey: string;
} {
  const {apiKey} = resolveModelKey();
  return {id: modelId, apiKey};
}
