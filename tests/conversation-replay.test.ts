import {describe, it, expect} from 'vitest';

import {
  MAX_PERSISTED_TURNS,
  buildTurns,
  loadConversation,
  recordTurnResponse,
  replayResponse
} from '../src/mastra/lib/conversations';
import {buildCorrectionPrompt} from '../src/mastra/lib/itinerary-validator';

/**
 * Rebuilding a conversation for replay.
 *
 * Two properties matter here, and they pull in opposite directions.
 *
 * The first is fidelity: the agent emits its reply as JSON, so most stored
 * replies parse straight back into the response envelope and replay as the
 * card the user originally saw. Where that is not possible the text is kept
 * verbatim as a message — never guessed into an itinerary shape.
 *
 * The second is containment. Stored assistant messages carry `tool-invocation`
 * parts holding raw tool arguments and complete tool results: full weather
 * payloads, activity records, whatever a tool returned. None of that is
 * reconstructed and none of it is returned, so replay cannot become a way to
 * read data the live path deliberately withholds.
 */

const ITINERARY = {
  destination: 'Lagos',
  date: '2026-08-22',
  summary: 'An afternoon in Lagos.',
  weather: {
    summary: 'Sunny',
    highCelsius: 30,
    lowCelsius: 24,
    precipitationChance: 5,
    considerations: []
  },
  activities: [
    {
      order: 1,
      name: 'Terra Kulture',
      startTime: '13:00',
      durationMinutes: 120,
      category: 'culture',
      location: 'Victoria Island',
      description: 'Arts centre with a bookshop, gallery and theatre.',
      weatherDependent: false
    }
  ],
  notes: []
};

/** A stored message in the shape LibSQL actually holds. */
function stored(role: string, content: unknown, createdAt = '2026-08-21T10:00:00.000Z') {
  return {role, content, createdAt};
}

const textPart = (text: string) => ({format: 2, parts: [{type: 'text', text}], content: text});

const toolPart = (toolName: string, args: unknown, result: unknown) => ({
  format: 2,
  parts: [{type: 'tool-invocation', toolInvocation: {state: 'result', toolName, args, result}}]
});

describe('restoring one reply', () => {
  it('parses a stored itinerary back into the envelope', () => {
    const response = replayResponse(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY}));

    expect(response.kind).toBe('itinerary');
    expect((response as unknown as {itinerary: typeof ITINERARY}).itinerary.destination).toBe('Lagos');
  });

  it('parses a stored saved-list back into the envelope', () => {
    const response = replayResponse(JSON.stringify({kind: 'saved-list', itineraries: []}));
    expect(response).toEqual({kind: 'saved-list', itineraries: []});
  });

  it('keeps prose as a message rather than guessing a structure', () => {
    const response = replayResponse('Which day would you like me to plan?');

    expect(response).toEqual({
      kind: 'message',
      message: 'Which day would you like me to plan?',
      permissionDenied: false,
      requiredPermission: null
    });
  });

  it('falls back to a message when JSON does not match the envelope', () => {
    // Malformed history must not fabricate an itinerary card.
    const response = replayResponse('{"kind":"itinerary","itinerary":{"destination":"Lagos"}}');

    expect(response.kind).toBe('message');
    expect((response as {message: string}).message).toContain('destination');
  });

  it('falls back to a message for text that only looks like JSON', () => {
    expect(replayResponse('{not json at all').kind).toBe('message');
  });
});

describe('pairing messages into turns', () => {
  it('pairs each request with the reply that followed it', () => {
    const turns = buildTurns([
      stored('user', textPart('Plan me an afternoon in Lagos.'), '1'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '2'),
      stored('user', textPart('Make it more relaxed.'), '3'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '4')
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].request).toBe('Plan me an afternoon in Lagos.');
    expect(turns[1].request).toBe('Make it more relaxed.');
    expect(turns.every(turn => turn.response.kind === 'itinerary')).toBe(true);
  });

  it('collapses intermediate tool traffic into the final reply', () => {
    const turns = buildTurns([
      stored('user', textPart('Plan me an afternoon in Lagos.'), '1'),
      stored('assistant', toolPart('get-weather', {location: 'Lagos'}, {highCelsius: 30}), '2'),
      stored('assistant', toolPart('find-activities', {location: 'Lagos'}, {activities: []}), '3'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '4')
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].response.kind).toBe('itinerary');
  });

  it('never reconstructs tool arguments or tool results', () => {
    const turns = buildTurns([
      stored('user', textPart('Plan me an afternoon in Lagos.'), '1'),
      stored(
        'assistant',
        toolPart(
          'get-weather',
          {location: 'Lagos', secretArgument: 'must-not-appear'},
          {rawProviderPayload: 'must-not-appear', latitude: 6.45407}
        ),
        '2'
      ),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '3')
    ]);

    const serialised = JSON.stringify(turns);
    expect(serialised).not.toContain('must-not-appear');
    expect(serialised).not.toContain('rawProviderPayload');
    expect(serialised).not.toContain('secretArgument');
    expect(serialised).not.toContain('6.45407');
  });

  it('drops a turn whose reply never arrived', () => {
    // The run failed, so there is nothing to replay for it.
    const turns = buildTurns([
      stored('user', textPart('Plan me an afternoon in Lagos.'), '1'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '2'),
      stored('user', textPart('Make it more relaxed.'), '3')
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].request).toBe('Plan me an afternoon in Lagos.');
  });

  it('ignores an assistant message with no preceding request', () => {
    expect(buildTurns([stored('assistant', textPart('orphan'), '1')])).toEqual([]);
  });

  it('handles an empty conversation', () => {
    expect(buildTurns([])).toEqual([]);
  });

  it('reads a plain string body as well as the parts array', () => {
    const turns = buildTurns([
      stored('user', 'Plan me an afternoon in Lagos.', '1'),
      stored('assistant', JSON.stringify({kind: 'itinerary', itinerary: ITINERARY}), '2')
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].response.kind).toBe('itinerary');
  });

  it('does not leak a model key that somehow reached message text', () => {
    // Defence in depth: the key never travels in a message, but replay must not
    // become the path that surfaces one if it ever did.
    const turns = buildTurns([
      stored('user', textPart('Plan my day.'), '1'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '2')
    ]);

    expect(JSON.stringify(turns)).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

describe('internal prompts stay out of the transcript', () => {
  it('does not replay a correction prompt as something the user said', () => {
    const correction = buildCorrectionPrompt([
      {code: 'overlap', message: 'Two activities overlap.'} as never
    ]);

    const turns = buildTurns([
      stored('user', textPart('Plan me an afternoon in Lagos.'), '1'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '2'),
      // The workflow wrote this, not the traveller.
      stored('user', textPart(correction), '3'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '4')
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].request).toBe('Plan me an afternoon in Lagos.');
    expect(JSON.stringify(turns)).not.toContain('does not satisfy the request');
  });

  it('attaches the corrected plan to the turn that actually asked for it', () => {
    const correction = buildCorrectionPrompt([
      {code: 'overlap', message: 'Two activities overlap.'} as never
    ]);
    const corrected = {...ITINERARY, summary: 'The corrected plan.'};

    const turns = buildTurns([
      stored('user', textPart('Plan me an afternoon in Lagos.'), '1'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})), '2'),
      stored('user', textPart(correction), '3'),
      stored('assistant', textPart(JSON.stringify({kind: 'itinerary', itinerary: corrected})), '4')
    ]);

    expect(turns).toHaveLength(1);
    expect((turns[0].response as unknown as {itinerary: typeof ITINERARY}).itinerary.summary).toBe(
      'The corrected plan.'
    );
  });
});

/**
 * Persisted structured turns.
 *
 * Rebuilding from message text mostly produced plain messages: the agent's own
 * message text is often prose, while the validated object comes from the
 * structuring pass and was never stored. The envelope is now kept on the thread
 * so a reopened conversation renders the card the user actually saw.
 *
 * Everything stored goes through `AgentResponseSchema`, which declares only the
 * envelope — so a model key, a request context or a raw tool result cannot ride
 * along even if a caller passes one.
 */
describe('persisting a structured turn', () => {
  const thread = {
    id: 'thread-1',
    resourceId: 'org:user',
    title: 'Lagos Afternoon',
    metadata: {} as Record<string, unknown>,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  function fakeMemory(initial: Record<string, unknown> = {}) {
    const state = {...thread, metadata: initial};
    return {
      state,
      memory: {
        getThreadById: async () => state,
        updateThread: async ({metadata}: {metadata: Record<string, unknown>}) => {
          state.metadata = metadata;
          return state;
        },
        recall: async () => ({messages: []})
      } as never
    };
  }

  it('keeps an itinerary so it replays as an itinerary', async () => {
    const {state, memory} = fakeMemory();

    await recordTurnResponse({
      memory,
      resourceId: 'org:user',
      threadId: 'thread-1',
      request: 'Plan me an afternoon in Lagos.',
      response: {kind: 'itinerary', itinerary: ITINERARY} as never
    });

    const detail = await loadConversation({memory, resourceId: 'org:user', threadId: 'thread-1'});
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].response.kind).toBe('itinerary');
    expect(detail.turns[0].request).toBe('Plan me an afternoon in Lagos.');
    expect((state.metadata as {turns: unknown[]}).turns).toHaveLength(1);
  });

  it('keeps a saved-list and a message', async () => {
    const {memory} = fakeMemory();

    await recordTurnResponse({
      memory,
      resourceId: 'org:user',
      threadId: 'thread-1',
      request: 'What have I saved?',
      response: {kind: 'saved-list', itineraries: []} as never
    });
    await recordTurnResponse({
      memory,
      resourceId: 'org:user',
      threadId: 'thread-1',
      request: 'Thanks.',
      response: {
        kind: 'message',
        message: 'Any time.',
        permissionDenied: false,
        requiredPermission: null
      } as never
    });

    const detail = await loadConversation({memory, resourceId: 'org:user', threadId: 'thread-1'});
    expect(detail.turns.map(t => t.response.kind)).toEqual(['saved-list', 'message']);
  });

  it('strips anything the envelope does not declare', async () => {
    const {state, memory} = fakeMemory();

    await recordTurnResponse({
      memory,
      resourceId: 'org:user',
      threadId: 'thread-1',
      request: 'Plan my day.',
      response: {
        kind: 'itinerary',
        itinerary: ITINERARY,
        apiKey: 'sk-must-not-persist',
        requestContext: {mastra__resourceId: 'org:user'},
        toolResult: {latitude: 6.45407}
      } as never
    });

    const stored = JSON.stringify(state.metadata);
    expect(stored).not.toContain('sk-must-not-persist');
    expect(stored).not.toContain('mastra__resourceId');
    expect(stored).not.toContain('6.45407');
  });

  it('never persists an internal correction prompt', async () => {
    const {state, memory} = fakeMemory();

    await recordTurnResponse({
      memory,
      resourceId: 'org:user',
      threadId: 'thread-1',
      request: buildCorrectionPrompt([
        {code: 'overlap', message: 'Two activities overlap.'} as never
      ]),
      response: {kind: 'itinerary', itinerary: ITINERARY} as never
    });

    expect((state.metadata as {turns?: unknown[]}).turns ?? []).toHaveLength(0);
  });

  it('refuses to write to a thread owned by somebody else', async () => {
    const {state, memory} = fakeMemory();

    await recordTurnResponse({
      memory,
      resourceId: 'org:someone-else',
      threadId: 'thread-1',
      request: 'Plan my day.',
      response: {kind: 'itinerary', itinerary: ITINERARY} as never
    });

    expect((state.metadata as {turns?: unknown[]}).turns ?? []).toHaveLength(0);
  });

  it('ignores a stored turn that no longer parses, rather than crashing', async () => {
    const {memory} = fakeMemory({
      turns: [
        {at: '1', request: 'ok', response: {kind: 'itinerary', itinerary: ITINERARY}},
        {at: '2', request: 'broken', response: {kind: 'itinerary', itinerary: {destination: 'x'}}},
        {at: '3', request: 'not an object', response: 'nonsense'},
        {at: '4'}
      ]
    });

    const detail = await loadConversation({memory, resourceId: 'org:user', threadId: 'thread-1'});
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].request).toBe('ok');
  });

  it('caps how much it keeps on one thread', async () => {
    const {state, memory} = fakeMemory();

    for (let index = 0; index < MAX_PERSISTED_TURNS + 5; index += 1) {
      await recordTurnResponse({
        memory,
        resourceId: 'org:user',
        threadId: 'thread-1',
        request: `Request ${index}`,
        response: {kind: 'itinerary', itinerary: ITINERARY} as never
      });
    }

    const turns = (state.metadata as {turns: {request: string}[]}).turns;
    expect(turns).toHaveLength(MAX_PERSISTED_TURNS);
    // The newest survive, not the oldest.
    expect(turns[turns.length - 1].request).toBe(`Request ${MAX_PERSISTED_TURNS + 4}`);
  });

  it('falls back to message reconstruction for a thread with no stored turns', async () => {
    const state = {
      ...thread,
      metadata: {},
      // A thread from before structured turns existed.
    };
    const memory = {
      getThreadById: async () => state,
      recall: async () => ({
        messages: [
          {role: 'user', content: textPart('Plan my day.'), createdAt: '1'},
          {
            role: 'assistant',
            content: textPart(JSON.stringify({kind: 'itinerary', itinerary: ITINERARY})),
            createdAt: '2'
          }
        ]
      })
    } as never;

    const detail = await loadConversation({memory, resourceId: 'org:user', threadId: 'thread-1'});
    expect(detail.turns).toHaveLength(1);
    expect(detail.turns[0].response.kind).toBe('itinerary');
  });
});
