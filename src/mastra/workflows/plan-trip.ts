import {createStep, createWorkflow} from '@mastra/core/workflows';

import {runWithSaveIntent} from '../lib/save-intent';
import type {Mastra} from '@mastra/core/mastra';
import {z} from 'zod';

import {AgentResponseSchema, type AgentResponse} from '../schemas/agent-response';
import {ensureConversation, latestItinerary, recordTurnResponse} from '../lib/conversations';
import {
  buildFollowUpPrompt,
  buildUnchangedPrompt,
  buildUnsatisfiedPrompt,
  classifyRequest
} from '../lib/follow-up';
import {materiallyIdentical, satisfiesRequest} from '../lib/itinerary-diff';
import {PLAN_TOOLS, PlanTelemetry, type PlanTool} from '../telemetry/plan-events';
import {tripMemory} from '../memory';
import {getKindeUser, resourceIdForUser} from '../lib/kinde';
import {
  buildCorrectionPrompt,
  parsePlanningConstraints,
  validateItinerary,
  type ValidationIssue
} from '../lib/itinerary-validator';

/**
 * A deterministic entry point to the trip agent.
 *
 * The workflow is intentionally thin. Weather lookup, activity selection,
 * scheduling, authorization and persistence all already live in the tools and
 * the agent, and none of it is repeated here — this exists to make the request
 * path explicit and typed:
 *
 *   request -> workflow -> trip agent -> tools/memory -> AgentResponse
 *
 * Everything identity-related is deliberately absent from the input. The
 * authenticated Kinde user arrives on the request context, which is where the
 * agent's memory scoping and the persistence tools' permission checks read it
 * from. Accepting a user, org, or resource id here would create a second,
 * forgeable source of identity.
 */

export const PlanTripInputSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('What the traveller asked for, in their own words.'),
  threadId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      'Conversation thread to continue. The caller chooses this; the memory resource is derived from the authenticated token, not from here.'
    )
});

export type PlanTripInput = z.infer<typeof PlanTripInputSchema>;

/** Raised when the agent completes but produces no structured response. */
export class PlanTripError extends Error {
  readonly code = 'plan_trip_failed';
  constructor(message: string) {
    super(message);
    this.name = 'PlanTripError';
  }
}

/**
 * Raised when a generated plan still breaks the request after one correction
 * attempt. Carries the structured issues so the interface can explain what was
 * wrong instead of showing an invalid plan.
 */
export class ItineraryValidationError extends Error {
  readonly code = 'itinerary_invalid';
  constructor(readonly issues: ValidationIssue[]) {
    super('The generated plan did not satisfy the request.');
    this.name = 'ItineraryValidationError';
  }
}

/** How many correction attempts are made. One, deliberately — never a loop. */
export const MAX_CORRECTION_ATTEMPTS = 1;

/**
 * How many times the model is asked again when it returns no usable object.
 *
 * Measured against the live model: roughly one follow-up turn in four came back
 * with `finishReason: 'other'` and no object, having answered in prose instead
 * of the schema. New plans never did — the failure is specific to turns that
 * modify an existing plan. It is a formatting slip rather than a disagreement,
 * so asking again works; three attempts takes a ~25% failure to under 2%.
 *
 * Bounded on purpose. A repeated failure is reported as
 * `model_output_invalid` rather than retried away, so a deterministic bug can
 * never hide behind the retry.
 */
export const MAX_OUTPUT_ATTEMPTS = 3;

/** Raised when the model never produced a usable object. */
export class ModelOutputError extends Error {
  readonly code = 'model_output_invalid';
  constructor(readonly attempts: number) {
    super(
      `The model did not return a usable plan after ${attempts} attempts (model_output_invalid).`
    );
    this.name = 'ModelOutputError';
  }
}


/** Tool names we report on. Anything else the agent calls is not surfaced. */
function asPlanTool(name: unknown): PlanTool | undefined {
  return PLAN_TOOLS.find(tool => tool === name);
}

/**
 * Run the agent and forward its real tool activity as telemetry.
 *
 * `agent.stream()` is used rather than `generate()` so tool-call and
 * tool-result chunks are observable. Only the tool name and a duration are
 * taken from them, plus a small allow-listed summary; arguments, results,
 * prompts and model text are never forwarded. The structured object is still
 * awaited at the end, so the AgentResponse contract is unchanged.
 */
async function runAgentWithTelemetry(input: {
  agent: Awaited<ReturnType<Mastra['getAgent']>>;
  prompt: string;
  requestContext: unknown;
  threadId: string;
  telemetry: PlanTelemetry;
}): Promise<AgentResponse | undefined> {
  const {telemetry} = input;

  for (let attempt = 1; attempt <= MAX_OUTPUT_ATTEMPTS; attempt += 1) {
    const response = await runAgentOnce(input);
    if (response) return response;

    // Only announced when another attempt genuinely follows.
    if (attempt < MAX_OUTPUT_ATTEMPTS) {
      await telemetry.stage('retry');
      await telemetry.modelRetry(attempt);
    }
  }

  throw new ModelOutputError(MAX_OUTPUT_ATTEMPTS);
}

async function runAgentOnce(input: {
  agent: Awaited<ReturnType<Mastra['getAgent']>>;
  prompt: string;
  requestContext: unknown;
  threadId: string;
  telemetry: PlanTelemetry;
}): Promise<AgentResponse | undefined> {
  const {agent, prompt, requestContext, threadId, telemetry} = input;
  let streamError: unknown;

  const stream = await agent.stream(prompt, {
    requestContext,
    memory: {thread: threadId}
  } as never);

  const startedAt = new Map<string, {tool: PlanTool; at: number}>();

  try {
    for await (const chunk of (stream as unknown as {fullStream: AsyncIterable<Record<string, unknown>>})
      .fullStream) {
      const type = String(chunk?.type ?? '');
      const payload = (chunk?.payload ?? {}) as Record<string, unknown>;

      if (type === 'tool-call') {
        const tool = asPlanTool(payload.toolName);
        const callId = String(payload.toolCallId ?? payload.toolName ?? '');
        if (tool) {
          startedAt.set(callId, {tool, at: Date.now()});
          await telemetry.toolStarted(tool);
          if (tool === 'get-weather') await telemetry.stage('weather');
          if (tool === 'find-activities') await telemetry.stage('activities');
        }
      }

      if (type === 'tool-result' || type === 'tool-error') {
        const callId = String(payload.toolCallId ?? payload.toolName ?? '');
        const started = startedAt.get(callId) ?? {
          tool: asPlanTool(payload.toolName) as PlanTool,
          at: Date.now()
        };
        if (started?.tool) {
          const durationMs = Date.now() - started.at;
          startedAt.delete(callId);

          if (type === 'tool-error') {
            await telemetry.toolFailed(started.tool, durationMs);
          } else {
            await telemetry.toolCompleted(
              started.tool,
              durationMs,
              summariseToolResult(started.tool, payload.result)
            );
          }
        }
      }
    }
  } catch (cause) {
    // A stream that ends early must not lose the run; the object is still read
    // below. The cause is kept rather than discarded — swallowing it silently
    // turned every early end into the same unexplained "no usable response".
    streamError = cause;
  }

  try {
    return (await (stream as unknown as {object: Promise<unknown>}).object) as
      | AgentResponse
      | undefined;
  } catch (cause) {
    throw new PlanTripError(agentFailureMessage(cause ?? streamError));
  }
}

/**
 * What to report when the agent produced nothing usable.
 *
 * A real cause is passed through rather than replaced. The client classifies
 * failures from this text — a dropped socket becomes "model unreachable", a
 * rate limit becomes "rate limited" — so overwriting it with friendlier wording
 * would make every failure look the same. Secrets are stripped client-side
 * before any of it is shown.
 *
 * Only when there is no cause at all does this supply its own sentence: the
 * model answered, but not with the object the contract requires.
 */
function agentFailureMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause ?? '');

  return (
    text.trim() ||
    'The planner could not turn that into a plan. Try saying what to change more specifically.'
  );
}

/**
 * Reduce a tool result to the few fields that are safe to show.
 * Everything not named here is dropped.
 */
function summariseToolResult(tool: PlanTool, result: unknown) {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as {
    location?: {name?: unknown} | unknown;
    date?: unknown;
    summary?: unknown;
    precipitationChance?: unknown;
    totalMatches?: unknown;
    activities?: unknown;
    condition?: unknown;
  };

  if (tool === 'get-weather') {
    return {
      weather: {
        location: String((value.location as {name?: unknown})?.name ?? ''),
        date: String(value.date ?? ''),
        condition: value.summary ? String(value.summary) : undefined,
        precipitationChance:
          typeof value.precipitationChance === 'number' ? value.precipitationChance : undefined
      }
    };
  }

  if (tool === 'find-activities') {
    return {
      activities: {
        location: String(value.location ?? ''),
        considered: Number(value.totalMatches ?? 0),
        selected: Array.isArray(value.activities) ? value.activities.length : undefined,
        condition: value.condition ? String(value.condition) : undefined
      }
    };
  }

  return undefined;
}

const runTripAgent = createStep({
  id: 'run-trip-agent',
  description:
    'Hand the request to the trip agent, which plans, saves or retrieves as the request requires.',
  inputSchema: PlanTripInputSchema,
  outputSchema: AgentResponseSchema,
  execute: async ({inputData, mastra, requestContext, writer, runId}) => {
    const agent = mastra.getAgent('tripAgent');
    const telemetry = new PlanTelemetry(
      writer as unknown as {write?: (v: unknown) => unknown},
      String(runId ?? '')
    );

    await telemetry.runStarted();
    await telemetry.stage('understanding');

    /*
     * The single point where a conversation record is created or touched.
     * Doing it here rather than in the browser, the agent and memory
     * separately means one owner for the metadata. The resource id comes from
     * the verified token; the caller supplies only a thread id.
     */
    const resourceId = resourceIdForUser(getKindeUser(requestContext));
    if (resourceId) {
      await ensureConversation({
        memory: tripMemory,
        resourceId,
        threadId: inputData.threadId,
        firstMessage: inputData.message
      });
    }

    /*
     * A follow-up edits the plan already in the conversation. Conversation
     * memory alone was not enough: the model had the history and still returned
     * the same schedule with a reworded summary, because nothing identified the
     * previous itinerary as the thing being changed. Handing it over as
     * structured data, with an explicit patch instruction, is what makes the
     * edit land.
     */
    const previous = resourceId
      ? await latestItinerary({memory: tripMemory, resourceId, threadId: inputData.threadId})
      : undefined;

    const previousItinerary =
      previous?.kind === 'itinerary' ? previous.itinerary : undefined;

    const kind = classifyRequest(inputData.message, Boolean(previousItinerary));
    const modifying = kind === 'follow_up_modification' && previousItinerary;

    const prompt = modifying
      ? buildFollowUpPrompt(inputData.message, previousItinerary)
      : inputData.message;

    await telemetry.stage('planning');

    // requestContext is forwarded explicitly so the agent sees the same
    // authenticated identity the workflow was started with; the thread is the
    // caller's choice and the resource is never passed.
    /*
     * Everything the agent does for this turn runs inside a save-intent scope
     * derived from the user's own words. `save-itinerary` reads it and refuses
     * when the user did not ask, so an unprompted save is impossible regardless
     * of what the model decides. Authorization is unchanged and still enforced
     * inside the tool against the verified Kinde token.
     */
    let response = await runWithSaveIntent(inputData.message, () =>
      runAgentWithTelemetry({
        agent,
        prompt,
        requestContext,
        threadId: inputData.threadId,
        telemetry
      })
    );

    if (!response) {
      await telemetry.runFailed('workflow_failed');
      // Fail loudly rather than inventing a reply. A missing object means the
      // structuring pass could not produce a valid AgentResponse.
      throw new PlanTripError(
        'The planner could not turn that into a plan. Try saying what to change more specifically.'
      );
    }

    /*
     * A modification that returns the plan it was given is a failure dressed as
     * a success. One explicit second attempt is allowed — never a loop — and if
     * that still comes back unchanged the run reports it rather than telling the
     * traveller their request was carried out.
     */
    if (modifying && response.kind === 'itinerary' && previousItinerary) {
      const unchanged = materiallyIdentical(previousItinerary, response.itinerary);
      const missed =
        !unchanged &&
        satisfiesRequest(inputData.message, previousItinerary, response.itinerary) ===
          'unsatisfied';

      if (unchanged || missed) {
        await telemetry.stage('correction');
        await telemetry.correctionStarted(1);

        const retry = await runWithSaveIntent(inputData.message, () =>
          runAgentWithTelemetry({
            agent,
            prompt: unchanged
              ? buildUnchangedPrompt(inputData.message)
              : buildUnsatisfiedPrompt(inputData.message),
            requestContext,
            threadId: inputData.threadId,
            telemetry
          })
        );

        if (retry) response = retry;

        /*
         * Only a plan that still has not moved at all is an error. A plan that
         * changed but missed the specific axis is presented anyway: it may be
         * the best the available activities allow, and the change summary shows
         * the traveller exactly what did happen so they can judge it.
         */
        if (
          response.kind === 'itinerary' &&
          materiallyIdentical(previousItinerary, response.itinerary)
        ) {
          await telemetry.runFailed('unchanged_itinerary');
          throw new PlanTripError(
            'The planner could not change the plan in the way you asked with the activities available. Try naming what to change — a stop to drop, or a time to move.'
          );
        }
      }
    }

    // Only a generated plan is validated. A saved-list or a message carries no
    // schedule to check.
    if (response.kind !== 'itinerary') {
      await persistTurn(resourceId, inputData, response);
      await telemetry.runCompleted();
      return response;
    }

    const constraints = parsePlanningConstraints(inputData.message);
    await telemetry.stage('validation');
    let validation = validateItinerary({itinerary: response.itinerary, constraints});
    await telemetry.validation(validation.valid, validation.issues.map(issue => issue.code));

    if (!validation.valid) {
      // One correction attempt, on the same thread so the agent keeps the
      // tool results and conversation it already has.
      for (let attempt = 0; attempt < MAX_CORRECTION_ATTEMPTS; attempt += 1) {
        await telemetry.stage('correction');
        await telemetry.correctionStarted(attempt + 1);

        // The same scope as the first pass: intent belongs to what the user
        // asked for, not to the correction prompt this code wrote.
        const next = await runWithSaveIntent(inputData.message, () =>
          runAgentWithTelemetry({
            agent,
            prompt: buildCorrectionPrompt(validation.issues),
            requestContext,
            threadId: inputData.threadId,
            telemetry
          })
        );

        if (!next || next.kind !== 'itinerary') break;

        response = next;
        validation = validateItinerary({itinerary: next.itinerary, constraints});
        await telemetry.validation(validation.valid, validation.issues.map(issue => issue.code));
        if (validation.valid) break;
      }
    }

    if (!validation.valid) {
      // Refuse rather than present a plan that contradicts the request.
      await telemetry.runFailed('itinerary_invalid');
      throw new ItineraryValidationError(validation.issues);
    }

    await persistTurn(resourceId, inputData, response);
    await telemetry.runCompleted();
    return response;
  }
});

/**
 * Keep the validated envelope with the conversation so it can replay as the
 * same card. Only runs for an owned thread; `recordTurnResponse` re-validates
 * and never throws.
 */
async function persistTurn(
  resourceId: string | undefined,
  inputData: {message: string; threadId: string},
  response: AgentResponse
): Promise<void> {
  if (!resourceId) return;

  await recordTurnResponse({
    memory: tripMemory,
    resourceId,
    threadId: inputData.threadId,
    request: inputData.message,
    response
  });
}

export const planTripWorkflow = createWorkflow({
  id: 'plan-trip',
  description:
    'Plan a day out, save a plan, or list previously saved plans, for the authenticated Kinde user.',
  inputSchema: PlanTripInputSchema,
  outputSchema: AgentResponseSchema
})
  .then(runTripAgent)
  .commit();
