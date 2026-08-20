import {MastraLanguageModelV2Mock} from '@mastra/core/test-utils/llm-mock';

/**
 * A language model whose turns are scripted one by one.
 *
 * Mastra's own `MastraLanguageModelV2Mock` accepts an array of results, one per
 * model turn, which is exactly what a tool-calling agent needs: turn 1 asks for
 * the weather, turn 2 asks for activities, turn 3 answers, and a final turn
 * serves the structured-output pass. The agent loop, both tools, and the
 * structuring step all run for real — only the model's output is canned, so no
 * API key is required.
 *
 * Both `doGenerate` and `doStream` are supplied because `generate()` and
 * `stream()` take different paths into the model.
 */

const USAGE = {inputTokens: 10, outputTokens: 10, totalTokens: 20};

/**
 * AI SDK v5 content/stream shapes, declared locally rather than deep-imported:
 * `ai` is not a direct dependency of this starter kit, because Mastra's model
 * gateway means the app never imports it.
 */
type Content = {type: string} & Record<string, unknown>;

export type ScriptedStep = {
  content: Content[];
  finishReason: 'tool-calls' | 'stop';
};

/** A model turn that calls one tool with the given arguments. */
export function toolCallStep(
  toolName: string,
  args: unknown,
  callId = `call-${toolName}`
): ScriptedStep {
  return {
    content: [{type: 'tool-call', toolCallId: callId, toolName, input: JSON.stringify(args)}],
    finishReason: 'tool-calls'
  };
}

/** A model turn that emits plain text and stops. */
export function textStep(text: string): ScriptedStep {
  return {content: [{type: 'text', text}], finishReason: 'stop'};
}

function toGenerateResult(step: ScriptedStep) {
  return {
    content: step.content,
    finishReason: step.finishReason,
    usage: USAGE,
    warnings: []
  };
}

function toStreamResult(step: ScriptedStep) {
  const parts: Content[] = [{type: 'stream-start', warnings: []}];

  for (const item of step.content) {
    if (item.type === 'text') {
      parts.push(
        {type: 'text-start', id: 'text-1'},
        {type: 'text-delta', id: 'text-1', delta: item.text},
        {type: 'text-end', id: 'text-1'}
      );
    } else {
      parts.push(item);
    }
  }

  parts.push({type: 'finish', finishReason: step.finishReason, usage: USAGE});

  return {
    stream: new ReadableStream<Content>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      }
    })
  };
}

/**
 * Build a mock model from an ordered list of turns.
 *
 * The turns are served by a function rather than handed over as an array:
 * the underlying AI SDK mock records each call before selecting from an array,
 * which shifts the mapping by one. Driving it from an explicit counter keeps
 * turn N of the script matched to model call N.
 *
 * `calls` exposes the options the agent actually sent, which is how the tests
 * assert that tool results were fed back to the model.
 */
export function scriptedModel(steps: ScriptedStep[]) {
  const calls: {prompt: unknown; tools: {name: string}[]; via: string}[] = [];
  let index = 0;

  function next(options: unknown, via: string) {
    const opts = options as {prompt?: unknown; tools?: {name: string}[]};
    calls.push({prompt: opts?.prompt, tools: opts?.tools ?? [], via});
    // Repeat the final turn if the agent runs longer than the script, so a
    // mismatch shows up as a failed assertion rather than a crash.
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    return step;
  }

  const model = new MastraLanguageModelV2Mock({
    provider: 'mock',
    modelId: 'scripted',
    doGenerate: (async (options: unknown) => toGenerateResult(next(options, 'generate'))) as never,
    doStream: (async (options: unknown) => toStreamResult(next(options, 'stream'))) as never
  });

  return Object.assign(model, {
    /** One entry per model turn, in order. */
    scriptedCalls: calls
  });
}
