import {createTool} from '@mastra/core/tools';
import {z} from 'zod';
import type {RequestContext} from '@mastra/core/request-context';

import {ItinerarySchema} from '../schemas/itinerary';
import {
  PERMISSIONS,
  getKindeUser,
  getOrgCode,
  hasPermission,
  resourceIdForUser
} from '../lib/kinde';
import {insertItinerary, type ItineraryOwner} from '../lib/itinerary-store';

/**
 * Persist an itinerary — and the starter kit's central authorization moment.
 *
 * Everything about who owns the record is derived here, on the server, from
 * the Kinde token that `MastraAuthKinde` already verified. The tool's input
 * carries the itinerary and nothing else: no user id, no organization, no
 * resource id. A model can be talked into passing any argument, so the
 * arguments simply do not include anything worth forging.
 *
 * Denials are returned as data rather than thrown. Losing a permission check
 * is an expected outcome, not a crash: the model needs to explain it, and the
 * UI needs to render it. Only genuine faults (storage) throw.
 */

/** Why a save did or did not happen. */
export const SAVE_OUTCOMES = ['saved', 'unauthenticated', 'permission_denied'] as const;
export type SaveOutcome = (typeof SAVE_OUTCOMES)[number];

export const SaveItineraryInputSchema = z.object({
  itinerary: ItinerarySchema.describe('The itinerary to save. Must be a complete, valid plan.')
});

export const SaveItineraryOutputSchema = z
  .object({
    saved: z.boolean().describe('Whether the itinerary was stored.'),
    reason: z
      .enum(SAVE_OUTCOMES)
      .describe('Outcome of the attempt. Tell the user plainly when this is not "saved".'),
    message: z.string().describe('Human-readable explanation, safe to relay to the user.'),
    requiredPermission: z
      .string()
      .nullable()
      .describe('The Kinde permission the user needed but did not have, if that was the problem.'),
    itineraryId: z.string().nullable().describe('Identifier of the stored record, when saved.'),
    savedAt: z.string().nullable().describe('When it was stored, as an ISO timestamp.'),
    orgCode: z
      .string()
      .nullable()
      .describe('The organization the record was filed under, derived from the token.')
  })
  .describe('The result of attempting to save an itinerary.');

export type SaveItineraryOutput = z.infer<typeof SaveItineraryOutputSchema>;

function denied(reason: SaveOutcome, message: string, requiredPermission: string | null = null) {
  return {
    saved: false,
    reason,
    message,
    requiredPermission,
    itineraryId: null,
    savedAt: null,
    orgCode: null
  } satisfies SaveItineraryOutput;
}

/**
 * Resolve the authenticated owner, or explain why we cannot.
 *
 * Returns `undefined` for the owner when the request has no usable identity —
 * which also covers M2M tokens, since those have no `sub` to own a record.
 */
export function resolveOwner(requestContext?: RequestContext): ItineraryOwner | undefined {
  const user = getKindeUser(requestContext);
  const resourceId = resourceIdForUser(user);
  const orgCode = getOrgCode(user);

  if (!user?.sub || !orgCode || !resourceId) return undefined;
  return {sub: user.sub, orgCode, resourceId};
}

export async function saveItinerary(
  input: z.infer<typeof SaveItineraryInputSchema>,
  context?: {requestContext?: RequestContext}
): Promise<SaveItineraryOutput> {
  const requestContext = context?.requestContext;
  const user = getKindeUser(requestContext);

  // 1. There must be a verified human identity behind this call.
  if (!user) {
    return denied('unauthenticated', 'You must be signed in to save an itinerary.');
  }

  // 2. Fail closed: an absent permissions claim grants nothing.
  if (!hasPermission(user, PERMISSIONS.createItinerary)) {
    return denied(
      'permission_denied',
      `You do not have permission to save itineraries. This action requires the "${PERMISSIONS.createItinerary}" permission in Kinde.`,
      PERMISSIONS.createItinerary
    );
  }

  // 3. Ownership is derived, never accepted.
  const owner = resolveOwner(requestContext);
  if (!owner) {
    return denied(
      'unauthenticated',
      'Your session is missing an organization, so there is nowhere to file this itinerary.'
    );
  }

  const record = await insertItinerary({itinerary: input.itinerary, owner});

  return {
    saved: true,
    reason: 'saved',
    message: 'Itinerary saved.',
    requiredPermission: null,
    itineraryId: record.id,
    savedAt: record.createdAt,
    orgCode: record.orgCode
  };
}

export const saveItineraryTool = createTool({
  id: 'save-itinerary',
  description:
    'Save a completed itinerary for the signed-in user. Requires the "create:itinerary" Kinde permission — if the user does not have it, this returns a refusal instead of saving, and you should tell them plainly.',
  inputSchema: SaveItineraryInputSchema,
  outputSchema: SaveItineraryOutputSchema,
  execute: async (input, context) => saveItinerary(input, context)
});
