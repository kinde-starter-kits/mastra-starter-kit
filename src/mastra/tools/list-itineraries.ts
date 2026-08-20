import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import type {RequestContext} from '@mastra/core/request-context';

import {ItinerarySchema} from '../schemas/itinerary';
import {PERMISSIONS, getKindeUser, hasPermission} from '../lib/kinde';
import {listItinerariesForOwner} from '../lib/itinerary-store';
import {resolveOwner} from './save-itinerary';

/**
 * Retrieve the signed-in user's saved itineraries.
 *
 * The query scope is not a parameter. `org_code` and `sub` come from the
 * verified token and go straight into the WHERE clause, so there is no input
 * a caller could change to widen the search to another person or another
 * organization. The only thing the caller controls is how many rows come back.
 */

export const LIST_OUTCOMES = ['ok', 'unauthenticated', 'permission_denied'] as const;
export type ListOutcome = (typeof LIST_OUTCOMES)[number];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

export const ListItinerariesInputSchema = z.object({
  limit: z
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`How many saved itineraries to return, newest first (default ${DEFAULT_LIMIT}).`)
});

export const SavedItinerarySummarySchema = z
  .object({
    id: z.string().describe('Identifier of the saved record.'),
    itinerary: ItinerarySchema,
    createdAt: z.string().describe('When it was saved, as an ISO timestamp.'),
    updatedAt: z.string().describe('When it was last changed, as an ISO timestamp.')
  })
  .describe('One saved itinerary belonging to the signed-in user.');

export const ListItinerariesOutputSchema = z
  .object({
    authorized: z.boolean().describe('Whether the user was allowed to read saved itineraries.'),
    reason: z.enum(LIST_OUTCOMES).describe('Outcome of the attempt.'),
    message: z.string().describe('Human-readable explanation, safe to relay to the user.'),
    requiredPermission: z
      .string()
      .nullable()
      .describe('The Kinde permission the user needed but did not have, if that was the problem.'),
    count: z.int().min(0).describe('How many itineraries were returned.'),
    itineraries: z.array(SavedItinerarySummarySchema).describe('The saved itineraries, newest first.')
  })
  .describe("The signed-in user's saved itineraries.");

export type ListItinerariesOutput = z.infer<typeof ListItinerariesOutputSchema>;

function denied(
  reason: ListOutcome,
  message: string,
  requiredPermission: string | null = null
): ListItinerariesOutput {
  return {authorized: false, reason, message, requiredPermission, count: 0, itineraries: []};
}

export async function listItineraries(
  input: z.infer<typeof ListItinerariesInputSchema>,
  context?: {requestContext?: RequestContext}
): Promise<ListItinerariesOutput> {
  const requestContext = context?.requestContext;
  const user = getKindeUser(requestContext);

  if (!user) {
    return denied('unauthenticated', 'You must be signed in to view saved itineraries.');
  }

  if (!hasPermission(user, PERMISSIONS.readItinerary)) {
    return denied(
      'permission_denied',
      `You do not have permission to view saved itineraries. This action requires the "${PERMISSIONS.readItinerary}" permission in Kinde.`,
      PERMISSIONS.readItinerary
    );
  }

  const owner = resolveOwner(requestContext);
  if (!owner) {
    return denied(
      'unauthenticated',
      'Your session is missing an organization, so there are no itineraries to show.'
    );
  }

  const records = await listItinerariesForOwner({owner, limit: input.limit});

  return {
    authorized: true,
    reason: 'ok',
    // Phrased without implying anything about records that might exist
    // elsewhere — a caller learns only about their own data.
    message:
      records.length === 0
        ? 'You have no saved itineraries yet.'
        : `Found ${records.length} saved ${records.length === 1 ? 'itinerary' : 'itineraries'}.`,
    requiredPermission: null,
    count: records.length,
    itineraries: records.map(record => ({
      id: record.id,
      itinerary: record.itinerary,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    }))
  };
}

export const listItinerariesTool = createTool({
  id: 'list-itineraries',
  description:
    'List the signed-in user\'s previously saved itineraries, newest first. Requires the "read:itinerary" Kinde permission. Only ever returns the current user\'s own itineraries.',
  inputSchema: ListItinerariesInputSchema,
  outputSchema: ListItinerariesOutputSchema,
  execute: async (input, context) => listItineraries(input, context)
});
