import {Agent} from '@mastra/core/agent';
import type {MastraModelConfig} from '@mastra/core/llm';

import {resolveModelConfig} from '../lib/model-key';

import {AgentResponseSchema, type AgentResponse} from '../schemas/agent-response';
import {getWeatherTool} from '../tools/get-weather';
import {findActivitiesTool} from '../tools/find-activities';
import {saveItineraryTool} from '../tools/save-itinerary';
import {listItinerariesTool} from '../tools/list-itineraries';
import {tripMemory} from '../memory';

/** Today, in UTC, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Instructions are built per request so the agent is told the real date.
 *
 * A model has no reliable sense of "today" — it infers one from training data,
 * so "tomorrow" would silently resolve to the wrong day and the weather tool
 * would be queried for it. The date is computed on the server and injected
 * here; it is never accepted from the client, and no date logic lives in the
 * browser.
 *
 * The date is UTC. A traveller several hours off UTC could see "today" flip
 * early or late; resolving that properly needs a per-user timezone, which is
 * more machinery than this starter kit warrants.
 */
export function buildInstructions(): string {
  return `${baseInstructions}\n\nToday's date is ${todayIso()}. Use it to resolve any relative date.`;
}

/**
 * The model the starter kit uses.
 *
 * Mastra's model gateway resolves `provider/model` strings against the
 * provider's API key env var (here `OPENAI_API_KEY`), so no extra SDK package
 * is needed. A small model is plenty for this task — the tools do the factual
 * work, and the model only sequences and schedules.
 */
export const TRIP_AGENT_MODEL = 'openai/gpt-4.1-mini';

const baseInstructions = `You are a day-trip planner. You turn a request like "plan me an afternoon in Lisbon tomorrow" into one realistic, coherent plan for a single day.

Always follow this order:
1. Work out the destination and the date from the request. Resolve relative dates like "tomorrow" or "this weekend" against today's date, given below, and never against your own assumption of the date. Pass an absolute YYYY-MM-DD date to the tools. If the destination or date is genuinely unclear, ask one short question instead of guessing.
2. Call get-weather for that destination and date. Never state or assume weather yourself — it must come from the tool.
3. Call find-activities for the same destination and date, passing the weather numbers returned by get-weather and any preferences the user expressed as tags. Never invent activities, and never call find-activities without the weather from step 2.
4. Choose a set of activities that fits the time window the user asked for, then build the plan.

Rules for the plan:
- Use only activities returned by find-activities. Do not invent names, venues, descriptions or opening hours, and do not add factual detail the tool did not give you.
- Respect each activity's availability. Never schedule something before it opens or after it closes.
- Honour the user's time window. "An afternoon" means roughly 12:00-18:00; "nothing too early" means don't start first thing; "I have three hours" means the whole plan fits in three hours.
- Prefer activities whose weatherFit is "good". You may still include one with weatherFit "poor" if it is clearly what the user wants — but say why in the notes.
- Keep it realistic: 2-4 activities for a half day, allow travel time between them, and use each activity's durationMinutes rather than inventing a length.
- Build a day that flows. Activities should make sense in sequence and in location, not read as a list of unrelated suggestions.
- Order activities chronologically, numbering them from 1, and give each a start time.
- Use the notes for practical advice and for any weather trade-off worth flagging.

Saving and retrieving plans:
- Planning never saves. Only call save-itinerary when the user explicitly asks to save, keep, or remember the plan.
- To show plans they saved before, call list-itineraries. Never invent a saved itinerary, and never describe one you did not receive from that tool.
- Both tools enforce Kinde permissions and may refuse. When one does, say plainly that they lack the required permission and name it. Never say an itinerary was saved unless the tool reported success.

Remembering the traveller:
- You have working memory holding their standing travel preferences. Apply it silently — if they are vegetarian, pick food stops accordingly; if they dislike museums, do not offer one.
- When they state a lasting preference ("I'm vegetarian", "I don't like museums", "I prefer late mornings"), record it in working memory so later conversations benefit.
- Only record trip-planning preferences that fit the schema. Never record anything else they mention about themselves.
- A one-off detail about this specific trip is not a standing preference — leave it out.

How to shape your reply:
- Every reply is one of three kinds. Pick the one that fits and fill in only its payload.
- "itinerary" — you generated a plan. Put it under the itinerary field.
- "saved-list" — the user asked what they saved earlier. Put the records list-itineraries returned under the itineraries field, copied exactly. If it returned none, use an empty array. Never invent entries.
- "message" — everything else: confirming a save, explaining a permission refusal, asking a clarifying question, answering a general question.
- After a save, reply with "message": confirm it only if save-itinerary reported success, otherwise explain the refusal and name the permission.
- When a tool refuses for lack of a permission, set permissionDenied to true and copy its requiredPermission into requiredPermission. Otherwise leave permissionDenied false and requiredPermission null.

Be concise. The plan matters, not the commentary.`;

/**
 * Build the trip-planning agent.
 *
 * The model is injectable purely so tests can drive the agent with a scripted
 * mock instead of a real API key. Production code should use the `tripAgent`
 * export below, which is this factory with the configured model.
 *
 * Structured output is configured with its own `model`. That is what lets a
 * single agent both call tools and return a validated object: the main agent
 * runs the tool-calling steps, then Mastra hands the result to an internal
 * structuring agent that produces the `ItinerarySchema` object. Without a
 * `model` here, some providers refuse to combine tool calling with a response
 * schema in one request.
 */
export function createTripAgent(options: {model?: MastraModelConfig} = {}) {
  /*
   * Resolved per request rather than fixed at construction, so a caller who
   * brought their own OpenAI key is billed for their own usage. The key comes
   * from AsyncLocalStorage (see lib/model-key), never from agent input, so it
   * cannot reach workflow state or a trace. Tests inject a scripted model,
   * which bypasses key resolution entirely.
   */
  // A test may inject a scripted model; production resolves one per request.
  const injected = options.model;
  const model = injected ?? (() => resolveModelConfig(TRIP_AGENT_MODEL));

  // The object key is the tool name the model sees, so the ids are used
  // verbatim to keep the prompt, the tool, and the traces consistent.
  const tools = {
    'get-weather': getWeatherTool,
    'find-activities': findActivitiesTool,
    // Authorization lives inside these two — they read the verified Kinde
    // identity from the request context and enforce the permission
    // themselves. The agent only decides when to call them.
    'save-itinerary': saveItineraryTool,
    'list-itineraries': listItinerariesTool
  };

  // The output type is stated rather than inferred: TypeScript collapses a
  // discriminated union when inferring it through `defaultOptions`, narrowing
  // it to a single branch. Naming it keeps the full union.
  return new Agent<'trip-agent', typeof tools, AgentResponse>({
    id: 'trip-agent',
    name: 'Trip Agent',
    instructions: buildInstructions,
    model,
    tools,
    // Conversation history plus resource-scoped travel preferences. The
    // resource id comes from the verified Kinde token, never from the client.
    memory: tripMemory,
    /*
     * `schema` is asserted because `AgentExecutionOptions<OUTPUT>` is declared
     * with a naked `OUTPUT extends {} ? ...` conditional
     * (@mastra/core/dist/agent/agent.types.d.ts:725). Naked type parameters
     * make a conditional distributive, so a union OUTPUT is split and the
     * schema is checked against only the union's last branch. No annotation on
     * our side can rejoin it. The agent's `TOutput` generic above still
     * declares the full `AgentResponse` union, so callers get correct types,
     * and all three kinds are covered in tests/trip-agent-response.test.ts.
     */
    /*
     * A function, so the structuring pass resolves the same per-request key as
     * the main model. `structuredOutput.model` alone cannot take a function.
     */
    defaultOptions: injected
      ? {
          structuredOutput: {
            schema: AgentResponseSchema as never,
            model: injected,
            jsonPromptInjection: true
          }
        }
      : () => ({
          structuredOutput: {
            schema: AgentResponseSchema as never,
            model: resolveModelConfig(TRIP_AGENT_MODEL),
            /*
             * Required for the discriminated union.
             *
             * `AgentResponse` is a union, which becomes a root-level `oneOf` in
             * JSON Schema. OpenAI's native structured-output mode cannot express
             * that, and Mastra returns `object: null` with `finishReason: 'other'`
             * instead of raising an error — the response then looks empty to the
             * caller. Injecting the schema into the prompt avoids the native
             * response format and produces a valid object.
             *
             * Verified against the live model: with this flag the union parses;
             * without it, and with 'auto', the result is null.
             */
            jsonPromptInjection: true
          }
        }),
  });
}

/** The agent registered with the Mastra instance. */
export const tripAgent = createTripAgent();
