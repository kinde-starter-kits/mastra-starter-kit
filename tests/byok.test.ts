import {describe, it, expect, beforeEach, afterEach} from 'vitest';

import {
  ModelKeyMissingError,
  OPENAI_KEY_HEADER,
  getRequestModelKey,
  hasModelKey,
  resolveModelConfig,
  resolveModelKey,
  runWithRequestModelKey
} from '../src/mastra/lib/model-key.js';

const CALLER_KEY = 'sk-caller-supplied-key';
const SERVER_KEY = 'sk-server-configured-key';

let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previous;
});

describe('key resolution', () => {
  it('accepts a caller-supplied key', () => {
    runWithRequestModelKey(CALLER_KEY, () => {
      const {apiKey, source} = resolveModelKey();
      expect(apiKey).toBe(CALLER_KEY);
      expect(source).toBe('request');
    });
  });

  it('prefers the caller-supplied key over the server key', () => {
    process.env.OPENAI_API_KEY = SERVER_KEY;

    runWithRequestModelKey(CALLER_KEY, () => {
      const {apiKey, source} = resolveModelKey();
      expect(apiKey).toBe(CALLER_KEY);
      expect(source).toBe('request');
    });
  });

  it('falls back to the server key when the caller supplies none', () => {
    process.env.OPENAI_API_KEY = SERVER_KEY;

    runWithRequestModelKey(undefined, () => {
      const {apiKey, source} = resolveModelKey();
      expect(apiKey).toBe(SERVER_KEY);
      expect(source).toBe('server');
    });
  });

  it('reports a clear configuration error when neither key exists', () => {
    runWithRequestModelKey(undefined, () => {
      expect(() => resolveModelKey()).toThrow(ModelKeyMissingError);

      try {
        resolveModelKey();
      } catch (error) {
        const err = error as ModelKeyMissingError;
        expect(err.code).toBe('model_key_missing');
        expect(err.message).toMatch(/Add your own key/);
        expect(err.message).toMatch(/OPENAI_API_KEY/);
      }
    });
  });

  it('treats a blank or whitespace key as absent', () => {
    runWithRequestModelKey('   ', () => {
      expect(getRequestModelKey()).toBeUndefined();
      expect(() => resolveModelKey()).toThrow(ModelKeyMissingError);
    });
  });

  it('clears the key when a later request supplies none', () => {
    runWithRequestModelKey(CALLER_KEY, () => {
      expect(getRequestModelKey()).toBe(CALLER_KEY);
    });

    // A subsequent request without the header sees no key at all.
    runWithRequestModelKey(undefined, () => {
      expect(getRequestModelKey()).toBeUndefined();
      expect(() => resolveModelKey()).toThrow(ModelKeyMissingError);
    });
  });

  it('does not leak one request key into a concurrent request', async () => {
    const seen: (string | undefined)[] = [];

    await Promise.all([
      runWithRequestModelKey('sk-request-a', async () => {
        await new Promise(r => setTimeout(r, 20));
        seen.push(getRequestModelKey());
      }),
      runWithRequestModelKey('sk-request-b', async () => {
        seen.push(getRequestModelKey());
      }),
      runWithRequestModelKey(undefined, async () => {
        await new Promise(r => setTimeout(r, 10));
        seen.push(getRequestModelKey());
      })
    ]);

    expect(seen.sort()).toEqual(['sk-request-a', 'sk-request-b', undefined]);
  });
});

describe('hasModelKey', () => {
  it('reports availability without revealing the key', () => {
    runWithRequestModelKey(undefined, () => expect(hasModelKey()).toBe(false));

    process.env.OPENAI_API_KEY = SERVER_KEY;
    runWithRequestModelKey(undefined, () => expect(hasModelKey()).toBe(true));

    delete process.env.OPENAI_API_KEY;
    runWithRequestModelKey(CALLER_KEY, () => expect(hasModelKey()).toBe(true));
  });
});

describe('model configuration', () => {
  it('injects the key into the model config for this request only', () => {
    runWithRequestModelKey(CALLER_KEY, () => {
      const config = resolveModelConfig('openai/gpt-4.1-mini');
      expect(config.id).toBe('openai/gpt-4.1-mini');
      expect(config.apiKey).toBe(CALLER_KEY);
    });
  });
});

describe('the key stays out of durable and observable surfaces', () => {
  it('is not readable outside the request that supplied it', () => {
    runWithRequestModelKey(CALLER_KEY, () => {
      expect(getRequestModelKey()).toBe(CALLER_KEY);
    });

    // Outside the AsyncLocalStorage scope there is no store at all.
    expect(getRequestModelKey()).toBeUndefined();
  });

  it('is absent from the workflow input schema', async () => {
    const {PlanTripInputSchema} = await import('../src/mastra/workflows/plan-trip.js');

    const parsed = PlanTripInputSchema.parse({
      message: 'Plan my day',
      threadId: 't1',
      apiKey: CALLER_KEY,
      openaiApiKey: CALLER_KEY
    } as never);

    expect(parsed).toEqual({message: 'Plan my day', threadId: 't1'});
    expect(JSON.stringify(parsed)).not.toContain(CALLER_KEY);
  });

  it('is absent from the tools that persist data', async () => {
    const {SaveItineraryInputSchema} = await import('../src/mastra/tools/save-itinerary.js');
    const {ListItinerariesInputSchema} = await import('../src/mastra/tools/list-itineraries.js');

    for (const key of Object.keys(SaveItineraryInputSchema.shape)) {
      expect(key).not.toMatch(/key|secret|token/i);
    }
    for (const key of Object.keys(ListItinerariesInputSchema.shape)) {
      expect(key).not.toMatch(/key|secret|token/i);
    }
  });

  it('is absent from the working memory schema, so it cannot be remembered', async () => {
    const {travelPreferencesSchema} = await import('../src/mastra/memory.js');

    const parsed = travelPreferencesSchema.parse({
      likes: ['outdoor'],
      apiKey: CALLER_KEY,
      openaiApiKey: CALLER_KEY
    } as never);

    expect(parsed).toEqual({likes: ['outdoor']});
    expect(JSON.stringify(parsed)).not.toContain(CALLER_KEY);
  });

  it('is absent from the agent response contract', async () => {
    const {AgentResponseSchema} = await import('../src/mastra/schemas/agent-response.js');

    const parsed = AgentResponseSchema.parse({
      kind: 'message',
      message: 'done',
      permissionDenied: false,
      requiredPermission: null,
      apiKey: CALLER_KEY
    } as never);

    expect(JSON.stringify(parsed)).not.toContain(CALLER_KEY);
  });

  it('is absent from the saved itinerary record', async () => {
    const {SavedItinerarySchema} = await import('../src/mastra/schemas/saved-itinerary.js');

    for (const key of Object.keys(SavedItinerarySchema.shape)) {
      expect(key).not.toMatch(/key|secret|token/i);
    }
  });

  it('never appears in the missing-key error message', () => {
    runWithRequestModelKey(undefined, () => {
      try {
        resolveModelKey();
      } catch (error) {
        expect(String(error)).not.toContain(CALLER_KEY);
        expect(String(error)).not.toContain(SERVER_KEY);
      }
    });
  });

  it('uses a header for transport, keeping it out of URLs and bodies', () => {
    // The header name is not secret; the point is that the value travels in a
    // header rather than in a URL, a query string, or workflow input.
    expect(OPENAI_KEY_HEADER).toBe('x-openai-api-key');
    expect(OPENAI_KEY_HEADER).not.toContain('?');
  });
});

/**
 * The surfaces added since BYOK was built.
 *
 * A caller's key is only as contained as the newest thing that touches a
 * request. Execution telemetry and conversation replay both stream data to the
 * browser, so both are checked here rather than assumed safe.
 */
describe('the key stays out of the surfaces added later', () => {
  it('has no field in the telemetry contract that could carry it', async () => {
    const {PlanExecutionEventSchema} = await import('../src/mastra/telemetry/plan-events.js');

    const fields = PlanExecutionEventSchema.options.flatMap(option => Object.keys(option.shape));
    for (const field of fields) {
      expect(field).not.toMatch(/key|token|secret|authorization|apikey/i);
    }
  });

  it('is dropped by the telemetry emitter even if a caller passes one', async () => {
    const {PlanTelemetry, PLAN_EVENT_MARKER} = await import(
      '../src/mastra/telemetry/plan-events.js'
    );

    const written: unknown[] = [];
    const telemetry = new PlanTelemetry({write: value => written.push(value)}, 'run-1');

    await (telemetry as unknown as {emit: (e: unknown) => Promise<void>}).emit?.({
      type: 'run_started',
      marker: PLAN_EVENT_MARKER,
      runId: 'run-1',
      timestamp: new Date().toISOString(),
      apiKey: 'sk-must-not-be-emitted'
    });
    await telemetry.runStarted();

    expect(JSON.stringify(written)).not.toContain('sk-must-not-be-emitted');
  });

  it('has no field in conversation metadata that could carry it', async () => {
    const {deriveConversationTitle} = await import('../src/mastra/lib/conversations.js');

    // The title is the only user-derived text stored about a conversation.
    const title = deriveConversationTitle('Plan my day sk-should-not-persist');
    expect(title).not.toContain('sk-should-not-persist');
  });

  it('is not reconstructed into a replayed turn', async () => {
    const {buildTurns} = await import('../src/mastra/lib/conversations.js');

    const turns = buildTurns([
      {
        role: 'user',
        content: {format: 2, parts: [{type: 'text', text: 'Plan my day.'}]},
        createdAt: '1'
      },
      {
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'result',
                toolName: 'get-weather',
                args: {apiKey: 'sk-in-tool-args'},
                result: {apiKey: 'sk-in-tool-result'}
              }
            },
            {type: 'text', text: 'Here is your day.'}
          ]
        },
        createdAt: '2'
      }
    ]);

    const serialised = JSON.stringify(turns);
    expect(serialised).not.toContain('sk-in-tool-args');
    expect(serialised).not.toContain('sk-in-tool-result');
  });

  it('is removed from any error detail shown to the user', async () => {
    const {sanitizeDetail} = await import('../src/app/lib/failure.js');

    const detail = sanitizeDetail(
      'AI_APICallError: request failed with key sk-live-abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'
    );

    expect(detail).not.toContain('sk-live-abcdef1234567890');
    expect(detail).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});
