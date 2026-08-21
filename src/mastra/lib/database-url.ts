import {existsSync} from 'node:fs';
import {dirname, join, sep} from 'node:path';

/**
 * Work out where the LibSQL database file should live.
 *
 * A bare `file:./mastra.db` is resolved against the process working directory,
 * and that directory is not stable: `mastra dev` runs the bundled server from
 * inside the project (observed CWD: `src/mastra/public`), while tests and a
 * production start run from elsewhere. The result is the database appearing in
 * surprising places, and `npm run dev` and `npm test` silently using different
 * files.
 *
 * So the default is anchored to the project root instead of the CWD. An
 * explicit `DATABASE_URL` always wins and is passed through untouched, which is
 * what a Turso/libsql URL needs.
 */

/**
 * Walk up from `startDir` to the nearest `package.json`, ignoring anything
 * inside Mastra's `.mastra` build output — that directory has a `package.json`
 * of its own, which would otherwise be mistaken for the project root.
 */
export function findProjectRoot(startDir: string = process.cwd()): string {
  let dir = startDir;

  for (;;) {
    const insideBuildOutput = dir.split(sep).includes('.mastra');
    if (!insideBuildOutput && existsSync(join(dir, 'package.json'))) return dir;

    const parent = dirname(dir);
    // Reached the filesystem root without finding one; fall back to the CWD
    // rather than guessing.
    if (parent === dir) return startDir;
    dir = parent;
  }
}

/**
 * The database URL to use. `DATABASE_URL` overrides; otherwise the file sits at
 * the project root, wherever the server happens to be started from.
 */
export function resolveDatabaseUrl(
  override: string | undefined = process.env.DATABASE_URL,
  startDir: string = process.cwd()
): string {
  if (override) return override;
  return `file:${join(findProjectRoot(startDir), 'mastra.db')}`;
}
