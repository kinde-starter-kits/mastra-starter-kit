import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {findProjectRoot, resolveDatabaseUrl} from '../src/mastra/lib/database-url.js';

/**
 * A fake project: a root with package.json, a nested source tree, and a
 * `.mastra/output` build directory that also has a package.json — the trap
 * that made the database land in the wrong place.
 */
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dburl-'));
  writeFileSync(join(root, 'package.json'), '{"name":"fake"}');

  mkdirSync(join(root, 'src', 'mastra', 'public'), {recursive: true});
  mkdirSync(join(root, '.mastra', 'output'), {recursive: true});
  writeFileSync(join(root, '.mastra', 'output', 'package.json'), '{"name":"build-output"}');
});

afterAll(() => rmSync(root, {recursive: true, force: true}));

describe('findProjectRoot', () => {
  it('finds the root from the directory mastra dev actually runs in', () => {
    // `mastra dev` was observed running with CWD = src/mastra/public.
    expect(findProjectRoot(join(root, 'src', 'mastra', 'public'))).toBe(root);
  });

  it('skips the package.json inside .mastra/output', () => {
    expect(findProjectRoot(join(root, '.mastra', 'output'))).toBe(root);
  });

  it('returns the root itself when started there', () => {
    expect(findProjectRoot(root)).toBe(root);
  });

  it('falls back to the start directory when there is no project above it', () => {
    const orphan = mkdtempSync(join(tmpdir(), 'orphan-'));
    try {
      expect(findProjectRoot(orphan)).toBe(orphan);
    } finally {
      rmSync(orphan, {recursive: true, force: true});
    }
  });
});

describe('resolveDatabaseUrl', () => {
  it('puts the default database at the project root, not the working directory', () => {
    const url = resolveDatabaseUrl(undefined, join(root, 'src', 'mastra', 'public'));

    expect(url).toBe(`file:${join(root, 'mastra.db')}`);
    expect(url).not.toContain('public');
  });

  it('resolves to the same file no matter where the server starts', () => {
    const fromPublic = resolveDatabaseUrl(undefined, join(root, 'src', 'mastra', 'public'));
    const fromOutput = resolveDatabaseUrl(undefined, join(root, '.mastra', 'output'));
    const fromRoot = resolveDatabaseUrl(undefined, root);

    expect(fromPublic).toBe(fromRoot);
    expect(fromOutput).toBe(fromRoot);
  });

  it('passes an explicit DATABASE_URL through untouched', () => {
    expect(resolveDatabaseUrl('libsql://team.turso.io', root)).toBe('libsql://team.turso.io');
    expect(resolveDatabaseUrl(':memory:', root)).toBe(':memory:');
    expect(resolveDatabaseUrl('file:/tmp/custom.db', root)).toBe('file:/tmp/custom.db');
  });

  it('does not hardcode any developer machine path', () => {
    expect(resolveDatabaseUrl(undefined, root)).not.toContain('/Users/');
  });
});
