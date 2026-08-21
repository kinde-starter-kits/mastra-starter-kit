import {createClient, type Client} from '@libsql/client';
import {LibSQLStore} from '@mastra/libsql';

import {resolveDatabaseUrl} from './lib/database-url';

/**
 * One LibSQL database backs both Mastra memory and the saved itineraries.
 * Keeping it to a single file is deliberate: `git clone && npm run dev` should
 * not require provisioning a database.
 *
 * This lives in its own module so both the Mastra instance and the agent's
 * memory can share the same store without importing each other.
 */
/**
 * Anchored to the project root rather than the working directory — see
 * `resolveDatabaseUrl`. Set DATABASE_URL to point somewhere else (a Turso
 * `libsql://` URL, for example).
 */
export const databaseUrl = resolveDatabaseUrl();

/**
 * The raw LibSQL client, shared deliberately.
 *
 * Mastra's storage adapter is domain-oriented — `getStore('memory')`,
 * `getStore('workflows')` — and exposes no generic table API, so the saved
 * itineraries need SQL of their own. Rather than opening a second connection
 * to the same SQLite file (which invites write-lock contention), the client is
 * created here and handed to `LibSQLStore` through its documented `client`
 * config. One file, one connection, no ORM.
 */
export const libsql: Client = createClient({url: databaseUrl});

export const storage = new LibSQLStore({
  id: 'mastra-starter-kit',
  client: libsql
});
