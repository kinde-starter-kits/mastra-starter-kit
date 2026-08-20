import {Memory} from '@mastra/memory';
import {z} from 'zod';

import {storage} from './storage';

/**
 * What the agent is allowed to remember about a traveller.
 *
 * This schema is the whole contract for working memory. It is deliberately a
 * closed set of trip-planning fields rather than a free-text notes blob:
 * the agent can only write what the schema allows, so it cannot quietly
 * accumulate personal detail that has nothing to do with planning a day out.
 *
 * Every field is optional — a new traveller starts with an empty object and it
 * fills in as they mention things. Schema-based working memory uses merge
 * semantics, so the agent only sends the fields it wants to change.
 */
export const travelPreferencesSchema = z.object({
  dietary: z
    .array(z.string().max(40))
    .max(5)
    .optional()
    .describe('Dietary requirements that affect food stops, e.g. ["vegetarian", "no shellfish"].'),

  likes: z
    .array(z.string().max(40))
    .max(8)
    .optional()
    .describe('Kinds of activity the traveller enjoys, e.g. ["outdoor", "live music"].'),

  dislikes: z
    .array(z.string().max(40))
    .max(8)
    .optional()
    .describe('Kinds of activity to avoid, e.g. ["museums", "crowds"].'),

  preferredStartTime: z
    .enum(['early-morning', 'late-morning', 'afternoon', 'evening'])
    .optional()
    .describe('When they like to start. "I am not a morning person" means late-morning.'),

  pace: z
    .enum(['relaxed', 'balanced', 'packed'])
    .optional()
    .describe('How much to fit into a day.'),

  accessibility: z
    .array(z.string().max(60))
    .max(4)
    .optional()
    .describe('Mobility or access needs that affect which activities work, e.g. ["step-free access"].')
});

export type TravelPreferences = z.infer<typeof travelPreferencesSchema>;

/**
 * Conversational memory for the trip agent.
 *
 * Two things are being remembered, and they have different lifetimes:
 *
 * - `lastMessages` is the running conversation, scoped to one thread.
 * - `workingMemory` with `scope: 'resource'` is the traveller's standing
 *   preferences, which persist across every thread belonging to that resource.
 *   That is what lets "I'm vegetarian" said last week apply to today's plan.
 *
 * The resource id is never chosen here or by the browser. Mastra sets it from
 * `mapUserToResourceId` on the verified Kinde token (`<org_code>:<sub>`), and
 * the server prefers that value over anything a client sends — see
 * `resourceIdForUser` in `lib/kinde.ts`.
 *
 * Semantic recall is deliberately off: it needs a vector store and an embedder,
 * which is a lot of setup for a starter kit whose conversations are short.
 */
export function createTripMemory(): Memory {
  return new Memory({
    storage,
    options: {
      lastMessages: 20,
      workingMemory: {
        enabled: true,
        schema: travelPreferencesSchema,
        // 'resource' — preferences follow the person, not the conversation.
        scope: 'resource'
      }
    }
  });
}

/** The memory instance attached to the trip agent. */
export const tripMemory = createTripMemory();
