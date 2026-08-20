import {LibSQLStore} from '@mastra/libsql';

/**
 * One LibSQL database backs both Mastra memory and (later) saved itineraries.
 * Keeping it to a single file is deliberate: `git clone && npm run dev` should
 * not require provisioning a database.
 *
 * This lives in its own module so both the Mastra instance and the agent's
 * memory can share the same store without importing each other.
 */
export const storage = new LibSQLStore({
  id: 'mastra-starter-kit',
  url: process.env.DATABASE_URL ?? 'file:./mastra.db'
});
