import {z} from 'zod';

import {ItinerarySchema} from './itinerary';
import {SavedItinerarySchema} from './saved-itinerary';

/**
 * The one shape every trip-agent reply takes.
 *
 * A planner answers three genuinely different kinds of question — "plan my
 * day", "what have I saved?", and everything else — and no single payload
 * covers all three. Rather than forcing a saved list into an itinerary shape,
 * the reply is tagged with `kind` and carries only the payload that fits.
 *
 * The envelope wraps the existing schemas and redefines nothing: `Itinerary`
 * and `SavedItinerary` remain the source of truth for their own data.
 */

export const RESPONSE_KINDS = ['itinerary', 'saved-list', 'message'] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

/** A newly generated plan. */
export const ItineraryResponseSchema = z
  .object({
    kind: z.literal('itinerary').describe('Use when you have generated a plan for a day.'),
    itinerary: ItinerarySchema
  })
  .describe('A freshly generated itinerary.');

/** Itineraries the user saved previously, exactly as returned by list-itineraries. */
export const SavedListResponseSchema = z
  .object({
    kind: z
      .literal('saved-list')
      .describe('Use when the user asked to see itineraries they saved earlier.'),
    itineraries: z
      .array(SavedItinerarySchema)
      .describe(
        'The records returned by the list-itineraries tool, copied verbatim. Never invent entries; return an empty array when the tool returned none.'
      )
  })
  .describe('The saved itineraries belonging to the signed-in user.');

/** Anything else: confirmations, refusals, questions, small talk. */
export const MessageResponseSchema = z
  .object({
    kind: z
      .literal('message')
      .describe(
        'Use for everything else — confirming a save, explaining a permission refusal, asking a clarifying question, or answering a general question.'
      ),
    message: z.string().min(1).max(2000).describe('A concise reply for the user.')
  })
  .describe('A plain reply with no structured payload.');

export type ItineraryResponse = z.infer<typeof ItineraryResponseSchema>;
export type SavedListResponse = z.infer<typeof SavedListResponseSchema>;
export type MessageResponse = z.infer<typeof MessageResponseSchema>;
export type AgentResponse = ItineraryResponse | SavedListResponse | MessageResponse;

/**
 * The union is annotated as `ZodType<AgentResponse>` rather than left as the
 * inferred `ZodDiscriminatedUnion`. Mastra types `structuredOutput.schema` as
 * an invariant `StandardSchemaWithJSON<OUTPUT>`, and inferring OUTPUT straight
 * from a discriminated union collapses it to the union's last branch. Naming
 * the type keeps the full union. Runtime behaviour is unchanged.
 */
export const AgentResponseSchema: z.ZodType<AgentResponse> = z
  .discriminatedUnion('kind', [
    ItineraryResponseSchema,
    SavedListResponseSchema,
    MessageResponseSchema
  ])
  .describe('Exactly one of: a generated itinerary, a list of saved itineraries, or a message.');
