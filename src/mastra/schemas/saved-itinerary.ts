import {z} from 'zod';

import {ItinerarySchema} from './itinerary';

/**
 * An itinerary as stored, with the ownership metadata the server controls.
 *
 * Deliberately a different shape from `ItinerarySchema`: the agent produces a
 * plan, and persistence wraps it in ownership and audit fields that only the
 * server may set. Keeping them apart means the model can never influence who a
 * record belongs to — the itinerary is a payload, not the whole row.
 *
 * This lives beside the other schemas rather than next to the storage code so
 * that importing the type never pulls in a database driver.
 */
export const SavedItinerarySchema = z
  .object({
    id: z.uuid().describe('Server-generated identifier for the saved record.'),
    itinerary: ItinerarySchema,
    sub: z.string().min(1).describe('Kinde subject that owns this record.'),
    orgCode: z.string().min(1).describe('Kinde organization the record belongs to.'),
    resourceId: z.string().min(1).describe('`<org_code>:<sub>` — matches memory scoping.'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .describe('An itinerary as stored, with its server-owned ownership metadata.');

export type SavedItinerary = z.infer<typeof SavedItinerarySchema>;
