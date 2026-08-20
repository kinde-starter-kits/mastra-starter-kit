import {Agent} from '@mastra/core/agent';
import type {MastraModelConfig} from '@mastra/core/llm';

import {ItinerarySchema} from '../schemas/itinerary';
import {getWeatherTool} from '../tools/get-weather';
import {findActivitiesTool} from '../tools/find-activities';

/**
 * The model the starter kit uses.
 *
 * Mastra's model gateway resolves `provider/model` strings against the
 * provider's API key env var (here `OPENAI_API_KEY`), so no extra SDK package
 * is needed. A small model is plenty for this task — the tools do the factual
 * work, and the model only sequences and schedules.
 */
export const TRIP_AGENT_MODEL = 'openai/gpt-4.1-mini';

const instructions = `You are a day-trip planner. You turn a request like "plan me an afternoon in Lisbon tomorrow" into one realistic, coherent plan for a single day.

Always follow this order:
1. Work out the destination and the date from the request. If the user gives a relative date, resolve it before calling any tool. If either is genuinely unclear, ask one short question instead of guessing.
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
  const model = options.model ?? TRIP_AGENT_MODEL;

  return new Agent({
    id: 'trip-agent',
    name: 'Trip Agent',
    instructions,
    model,
    // The object key is the tool name the model sees, so the ids are used
    // verbatim to keep the prompt, the tool, and the traces consistent.
    tools: {
      'get-weather': getWeatherTool,
      'find-activities': findActivitiesTool
    },
    defaultOptions: {
      structuredOutput: {
        schema: ItinerarySchema,
        model
      }
    }
  });
}

/** The agent registered with the Mastra instance. */
export const tripAgent = createTripAgent();
