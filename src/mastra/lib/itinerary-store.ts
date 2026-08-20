import {randomUUID} from 'node:crypto';
import {z} from 'zod';

import {libsql} from '../storage';
import {ItinerarySchema, type Itinerary} from '../schemas/itinerary';

/**
 * Persistence for saved itineraries.
 *
 * The stored record is deliberately a different shape from `ItinerarySchema`:
 * the agent produces a plan, and this layer wraps it in ownership and audit
 * fields the server alone controls. Keeping them apart means the model can
 * never influence who a record belongs to — the itinerary is a payload, not
 * the whole row.
 */

/** Ownership derived from the verified Kinde token. Never from tool input. */
export type ItineraryOwner = {
  /** Kinde `sub` claim. */
  sub: string;
  /** Kinde `org_code` claim. */
  orgCode: string;
  /** `<org_code>:<sub>`, matching the memory resource identity. */
  resourceId: string;
};

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

/** A storage failure, stated without leaking driver or SQL detail. */
export class ItineraryStorageError extends Error {
  readonly code = 'storage_error';
  constructor(message = 'Could not access saved itineraries. Please try again.') {
    super(message);
    this.name = 'ItineraryStorageError';
  }
}

const TABLE = 'saved_itineraries';

let initialised: Promise<void> | undefined;

/**
 * Create the table on first use.
 *
 * Memoised rather than run at import time so importing a tool never performs
 * I/O, and so tests can point at a fresh database per run.
 */
async function ensureTable(): Promise<void> {
  initialised ??= (async () => {
    await libsql.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        sub TEXT NOT NULL,
        org_code TEXT NOT NULL,
        itinerary TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    // Every read is scoped by owner, so that is what the index covers.
    await libsql.execute(`
      CREATE INDEX IF NOT EXISTS idx_${TABLE}_owner
      ON ${TABLE} (org_code, sub, created_at DESC)
    `);
  })();

  return initialised;
}

/** Reset the memoised init. Test-only; lets a suite target a fresh database. */
export function __resetItineraryStoreForTests(): void {
  initialised = undefined;
}

type Row = {
  id: string;
  resource_id: string;
  sub: string;
  org_code: string;
  itinerary: string;
  created_at: string;
  updated_at: string;
};

function toSavedItinerary(row: Row): SavedItinerary {
  return {
    id: row.id,
    itinerary: JSON.parse(row.itinerary) as Itinerary,
    sub: row.sub,
    orgCode: row.org_code,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Persist an itinerary against an owner.
 *
 * `owner` comes from the authenticated request context; the caller cannot
 * supply it. The id and timestamps are generated here for the same reason.
 */
export async function insertItinerary(input: {
  itinerary: Itinerary;
  owner: ItineraryOwner;
}): Promise<SavedItinerary> {
  await ensureTable();

  const now = new Date().toISOString();
  const record: SavedItinerary = {
    id: randomUUID(),
    itinerary: input.itinerary,
    sub: input.owner.sub,
    orgCode: input.owner.orgCode,
    resourceId: input.owner.resourceId,
    createdAt: now,
    updatedAt: now
  };

  try {
    await libsql.execute({
      sql: `INSERT INTO ${TABLE} (id, resource_id, sub, org_code, itinerary, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        record.resourceId,
        record.sub,
        record.orgCode,
        JSON.stringify(record.itinerary),
        record.createdAt,
        record.updatedAt
      ]
    });
  } catch {
    // The driver message could name the table or the file path; neither is
    // useful to a model and both are noise in a chat transcript.
    throw new ItineraryStorageError('Could not save the itinerary. Please try again.');
  }

  return record;
}

/**
 * List itineraries for exactly one owner.
 *
 * Both `org_code` and `sub` are always in the WHERE clause. There is no code
 * path that reads across owners, so no input can widen the query.
 */
export async function listItinerariesForOwner(input: {
  owner: ItineraryOwner;
  limit: number;
}): Promise<SavedItinerary[]> {
  await ensureTable();

  try {
    const result = await libsql.execute({
      sql: `SELECT id, resource_id, sub, org_code, itinerary, created_at, updated_at
            FROM ${TABLE}
            WHERE org_code = ? AND sub = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
      args: [input.owner.orgCode, input.owner.sub, input.limit]
    });

    return (result.rows as unknown as Row[]).map(toSavedItinerary);
  } catch {
    throw new ItineraryStorageError('Could not load saved itineraries. Please try again.');
  }
}
