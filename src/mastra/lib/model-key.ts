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

/** Where the key used for a request came from. Safe to report to a client. */
export type ModelKeySource = 'request' | 'server';

/**
 * Raised when neither the caller nor the server supplied a key. Carries no
 * key material, and says only which of the two options is missing.
 */
export class ModelKeyMissingError extends Error {
  readonly code = 'model_key_missing';
  constructor() {
    super(
      'No OpenAI API key is available. Add your own key in the app, or set OPENAI_API_KEY on the server.'
    );
    this.name = 'ModelKeyMissingError';
  }
}

/**
 * Resolve the key for this request. A caller-supplied key wins over the
 * server's, so a shared deployment never spends the maintainer's quota when
 * the caller brought their own.
 */
export function resolveModelKey(): {apiKey: string; source: ModelKeySource} {
  const fromRequest = getRequestModelKey();
  if (fromRequest) return {apiKey: fromRequest, source: 'request'};

  const fromServer = normalize(process.env.OPENAI_API_KEY);
  if (fromServer) return {apiKey: fromServer, source: 'server'};

  throw new ModelKeyMissingError();
}

/** True when a key is available from either source. Reveals no key material. */
export function hasModelKey(): boolean {
  return Boolean(getRequestModelKey() ?? normalize(process.env.OPENAI_API_KEY));
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
