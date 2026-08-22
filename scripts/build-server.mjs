#!/usr/bin/env node
/**
 * Build the Mastra server for Vercel.
 *
 * `mastra build` runs the official `VercelDeployer`, which compiles the Hono
 * application into a single serverless function and writes the Vercel Build
 * Output API v3 layout. This wrapper exists for one reason, and should be
 * deleted when that reason goes away.
 *
 * TEMPORARY. Remove this file and call `mastra build --dir src/mastra`
 * directly once `@kinde-oss/mastra-auth-kinde` is published to npm.
 *
 * The deployer writes a package.json for the function and lists each external
 * dependency by the version it reads from the installed package, not by the
 * specifier that installed it (`readPackageMetadata` in `@mastra/deployer`).
 * The Kinde auth provider is installed from Git and is not on npm, so the
 * deployer writes `"0.1.0"`, its `npm install` returns 404, and the build stops
 * before it can finish two remaining steps. The bundle itself is complete.
 *
 * This wrapper therefore rewrites that one dependency back to the Git specifier
 * from the project package.json, runs the install, and performs the two steps
 * the aborted build did not reach: writing `.vc-config.json` and moving the
 * output to `.vercel/output`. Both are reproduced from the deployer's own
 * `bundle()` implementation. No application code or bundle output is changed.
 */
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PROVIDER = '@kinde-oss/mastra-auth-kinde';

// Matches VercelDeployer.outputDir.
const FUNCTION_DIR = join(root, '.mastra', '.vercel', 'output', 'functions', 'index.func');
const STAGED_OUTPUT = join(root, '.mastra', '.vercel', 'output');
const FINAL_OUTPUT = join(root, '.vercel', 'output');

const run = (command, args, cwd) =>
  spawnSync(command, args, {cwd, stdio: 'inherit', shell: process.platform === 'win32'});

// 1. Build. A non-zero exit is expected while the provider is unpublished, so
//    the bundle is what gets checked rather than the exit code.
const build = run('npx', ['mastra', 'build', '--dir', 'src/mastra'], root);

const handler = join(FUNCTION_DIR, 'index.mjs');
if (!existsSync(handler)) {
  console.error(
    `\n[build-server] Mastra produced no function at ${handler}. This is a real build failure, not the known dependency problem.`
  );
  process.exit(build.status ?? 1);
}

// 2. Point the generated manifest back at the Git source, so there is one place
//    to change the specifier.
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const gitSpec = rootPkg.dependencies?.[PROVIDER];

if (!gitSpec) {
  console.error(`\n[build-server] ${PROVIDER} is missing from package.json dependencies.`);
  process.exit(1);
}

const manifestPath = join(FUNCTION_DIR, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.dependencies?.[PROVIDER] && manifest.dependencies[PROVIDER] !== gitSpec) {
  console.log(`[build-server] rewriting ${PROVIDER} -> ${gitSpec}`);
  manifest.dependencies[PROVIDER] = gitSpec;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// 3. Install the function's dependencies, which the aborted build left undone.
console.log('[build-server] installing function dependencies');
const install = run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], FUNCTION_DIR);

if (install.status !== 0) {
  console.error('\n[build-server] function dependency install failed.');
  process.exit(install.status ?? 1);
}

// 4. The two steps the aborted build never reached, reproduced from
//    VercelDeployer.bundle(). The runtime tracks whichever Node version is
//    running the build, exactly as the deployer computes it.
const major = process.version?.split('.')?.[0]?.replace('v', '') ?? '22';

/*
 * The deployer applies its `VercelDeployerOptions` here, so this must too.
 * `maxDuration` is read from the Mastra config rather than repeated, because
 * a slow map query killed the function when the two disagreed.
 */
const mastraSource = readFileSync(join(root, 'src', 'mastra', 'index.ts'), 'utf8');
const maxDuration = Number(/maxDuration:\s*(\d+)/.exec(mastraSource)?.[1] ?? 0);

if (!maxDuration) {
  console.error('\n[build-server] no maxDuration found in the Mastra config.');
  process.exit(1);
}

writeFileSync(
  join(FUNCTION_DIR, '.vc-config.json'),
  JSON.stringify(
    {
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      runtime: `nodejs${major}.x`,
      shouldAddHelpers: true,
      maxDuration
    },
    null,
    2
  )
);
console.log(`[build-server] function time budget: ${maxDuration}s`);

rmSync(FINAL_OUTPUT, {recursive: true, force: true});
mkdirSync(dirname(FINAL_OUTPUT), {recursive: true});
cpSync(STAGED_OUTPUT, FINAL_OUTPUT, {recursive: true});
rmSync(STAGED_OUTPUT, {recursive: true, force: true});

console.log(`[build-server] Vercel build output ready at ${FINAL_OUTPUT}`);
