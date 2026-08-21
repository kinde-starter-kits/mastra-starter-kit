import {createStep, createWorkflow} from '@mastra/core/workflows';
import type {Mastra} from '@mastra/core/mastra';
import {z} from 'zod';

import {AgentResponseSchema, type AgentResponse} from '../schemas/agent-response';
import {ensureConversation} from '../lib/conversations';
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
  const {agent, prompt, requestContext, threadId, telemetry} = input;

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
  } catch {
    // A stream that ends early must not lose the run; the result is still read.
  }

  const result = (await (stream as unknown as {object: Promise<unknown>}).object) as
    | AgentResponse
    | undefined;
  return result;
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

    await telemetry.stage('planning');

    // requestContext is forwarded explicitly so the agent sees the same
    // authenticated identity the workflow was started with; the thread is the
    // caller's choice and the resource is never passed.
    let response = await runAgentWithTelemetry({
      agent,
      prompt: inputData.message,
      requestContext,
      threadId: inputData.threadId,
      telemetry
    });

    if (!response) {
      await telemetry.runFailed('workflow_failed');
      // Fail loudly rather than inventing a reply. A missing object means the
      // structuring pass could not produce a valid AgentResponse.
      throw new PlanTripError(
        'The trip agent did not return a usable response. Please try rephrasing the request.'
      );
    }

    // Only a generated plan is validated. A saved-list or a message carries no
    // schedule to check.
    if (response.kind !== 'itinerary') {
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

        const next = await runAgentWithTelemetry({
          agent,
          prompt: buildCorrectionPrompt(validation.issues),
          requestContext,
          threadId: inputData.threadId,
          telemetry
        });

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

    await telemetry.runCompleted();
    return response;
  }
});

export const planTripWorkflow = createWorkflow({
  id: 'plan-trip',
  description:
    'Plan a day out, save a plan, or list previously saved plans, for the authenticated Kinde user.',
  inputSchema: PlanTripInputSchema,
  outputSchema: AgentResponseSchema
})
  .then(runTripAgent)
  .commit();
