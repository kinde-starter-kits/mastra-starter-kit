import {createStep, createWorkflow} from '@mastra/core/workflows';
import {z} from 'zod';

import {AgentResponseSchema, type AgentResponse} from '../schemas/agent-response';

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

const runTripAgent = createStep({
  id: 'run-trip-agent',
  description:
    'Hand the request to the trip agent, which plans, saves or retrieves as the request requires.',
  inputSchema: PlanTripInputSchema,
  outputSchema: AgentResponseSchema,
  execute: async ({inputData, mastra, requestContext}) => {
    const agent = mastra.getAgent('tripAgent');

    const result = await agent.generate(inputData.message, {
      // Forwarded explicitly so the agent sees the same authenticated identity
      // the workflow was started with. Memory resolves the memory resource id
      // from it via mapUserToResourceId, and the save/list tools read the
      // Kinde permissions from it.
      requestContext,
      // The thread is the caller's choice; the resource is not passed at all,
      // because it must come from the verified token.
      memory: {thread: inputData.threadId}
    });

    const response = result.object as AgentResponse | undefined;

    if (!response) {
      // Fail loudly rather than inventing a reply. A missing object means the
      // structuring pass could not produce a valid AgentResponse.
      throw new PlanTripError(
        'The trip agent did not return a usable response. Please try rephrasing the request.'
      );
    }

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
