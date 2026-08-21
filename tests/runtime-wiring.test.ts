// @vitest-environment jsdom
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Guards the frontend -> Mastra runtime path.
 *
 * The failure this protects against is silent: the frontend builds fine, the
 * server is simply somewhere else, and the only symptom is "could not reach
 * the planner" at runtime. These assertions pin the port, the URL default, the
 * endpoint paths, and the dev startup command so a change to any of them fails
 * here instead of in a browser.
 */
// Vitest runs with the project root as cwd; jsdom does not expose a file: URL
// for import.meta.url, so resolve from cwd instead.
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const MASTRA_PORT = 4111;
const APP_PORT = 5173;

describe('frontend targets the Mastra server', () => {
  it('defaults to the port the Mastra server listens on', async () => {
    // No VITE_MASTRA_URL set in the test env, so this exercises the default.
    const {env} = await import('../src/app/env.js');
    expect(env.mastraUrl).toBe(`http://localhost:${MASTRA_PORT}`);
  });

  it('honours VITE_MASTRA_URL when it is set', () => {
    const source = read('src/app/env.ts');
    expect(source).toContain('VITE_MASTRA_URL');
    expect(source).toContain(`http://localhost:${MASTRA_PORT}`);
  });

  it('never points at the Vite dev server itself', async () => {
    const {env} = await import('../src/app/env.js');
    expect(env.mastraUrl).not.toContain(String(APP_PORT));
  });

  it('builds absolute URLs against the configured base', () => {
    const source = read('src/app/lib/mastra-client.ts');
    expect(source).toContain('`${env.mastraUrl}${path}`');
    // A relative fetch would hit Vite, not Mastra.
    expect(source).not.toMatch(/fetch\(\s*['"`]\/(api|me)/);
  });
});

describe('endpoint paths match the server', () => {
  it('calls the identity route the server registers', () => {
    const client = read('src/app/lib/mastra-client.ts');
    const server = read('src/mastra/index.ts');

    expect(client).toContain("'/me'");
    expect(server).toContain("registerApiRoute('/me'");
  });

  it('calls the workflow under the id registered with Mastra', () => {
    const client = read('src/app/lib/mastra-client.ts');
    const server = read('src/mastra/index.ts');

    expect(client).toContain('/api/workflows/planTripWorkflow/start-async');
    // The path segment must match the key the workflow is registered under.
    expect(server).toContain('workflows: {planTripWorkflow}');
  });
});

describe('CORS allows the frontend origin', () => {
  it('defaults to the Vite dev server origin', () => {
    const server = read('src/mastra/index.ts');
    expect(server).toContain(`http://localhost:${APP_PORT}`);
    expect(server).toContain('APP_ORIGIN');
  });

  it('allows the Authorization and BYOK headers through CORS', () => {
    const server = read('src/mastra/index.ts');
    const client = read('src/app/lib/mastra-client.ts');

    expect(server).toContain("'Content-Type', 'Authorization'");

    // The browser rejects a request whose header is not in the preflight
    // allow-list, so the BYOK header must be declared on the server too.
    expect(server).toContain('OPENAI_KEY_HEADER');
    const headerName = read('src/mastra/lib/model-key.ts').match(
      /OPENAI_KEY_HEADER = '([^']+)'/
    )?.[1];
    expect(headerName).toBe('x-openai-api-key');
    expect(client).toContain(`'${headerName}'`);
  });

  it('keeps the Vite dev server on the port CORS expects', () => {
    const viteConfig = read('vite.config.ts');
    expect(viteConfig).toContain(`port: ${APP_PORT}`);
  });
});

describe('dev startup runs both processes', () => {
  const pkg = JSON.parse(read('package.json')) as {scripts: Record<string, string>};

  it('starts the Mastra server and the app together', () => {
    expect(pkg.scripts.dev).toContain('dev:mastra');
    expect(pkg.scripts.dev).toContain('dev:app');
  });

  it('does not background one process with a bare "&"', () => {
    // A bare "&" hides a failing Mastra server behind a healthy Vite, which is
    // exactly how the backend ends up unreachable without an obvious cause.
    expect(pkg.scripts.dev).not.toMatch(/&(?!&)/);
  });

  it('stops both processes when one fails', () => {
    expect(pkg.scripts.dev).toContain('--kill-others-on-fail');
  });

  it('runs the Mastra server against the agent directory', () => {
    expect(pkg.scripts['dev:mastra']).toContain('--dir src/mastra');
  });
});
