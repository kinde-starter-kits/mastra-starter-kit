import {SignJWT, exportJWK, generateKeyPair, type JWK, type KeyObject} from 'jose';

/**
 * A stand-in for a real Kinde tenant.
 *
 * Kinde signs access tokens with a private key and publishes the matching
 * public key at `<domain>/.well-known/jwks`. `MastraAuthKinde` fetches that
 * JWKS and verifies signatures against it. So to exercise the real provider —
 * real signature verification, real issuer/audience/expiry checks — we only
 * need to own a keypair and serve the JWKS.
 *
 * We intercept `fetch` for the JWKS URL only; every other request falls
 * through to the real implementation. Nothing about the provider is mocked.
 */
export const TEST_DOMAIN = 'https://starter-kit-test.kinde.com';
export const TEST_AUDIENCE = 'https://api.starter-kit-test.local';
const JWKS_URL = `${TEST_DOMAIN}/.well-known/jwks`;

let privateKey: KeyObject;
let publicJwk: JWK;
let originalFetch: typeof globalThis.fetch;

/** Claims a Kinde access token carries. All optional so tests can omit them. */
export type TestTokenClaims = {
  sub?: string;
  orgCode?: string;
  permissions?: string[];
  audience?: string | string[];
  issuer?: string;
  /** Seconds from now until expiry. Negative values mint an expired token. */
  expiresInSeconds?: number;
  /** Mint a machine-to-machine token (no `sub`, `gty: client_credentials`). */
  machineToMachine?: boolean;
};

export async function startTestTenant(): Promise<void> {
  const {privateKey: priv, publicKey} = await generateKeyPair('RS256', {extractable: true});
  privateKey = priv as KeyObject;
  publicJwk = {...(await exportJWK(publicKey)), kid: 'test-key-1', alg: 'RS256', use: 'sig'};

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === JWKS_URL) {
      return new Response(JSON.stringify({keys: [publicJwk]}), {
        status: 200,
        headers: {'content-type': 'application/json'}
      });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

export function stopTestTenant(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
}

/** Mint a signed token that `MastraAuthKinde` will accept (or reject, by design). */
export async function mintToken(claims: TestTokenClaims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = claims.expiresInSeconds ?? 3600;

  const payload: Record<string, unknown> = {
    aud: claims.audience ?? [TEST_AUDIENCE],
    azp: 'test_client_id',
    jti: `jti_${Math.random().toString(36).slice(2)}`,
    scp: []
  };

  if (claims.machineToMachine) {
    payload.gty = ['client_credentials'];
    payload.scope = '';
    payload.v = '1';
  } else {
    payload.sub = claims.sub ?? 'kp:user_default';
  }

  if (claims.orgCode !== undefined) payload.org_code = claims.orgCode;
  if (claims.permissions !== undefined) payload.permissions = claims.permissions;

  return new SignJWT(payload)
    .setProtectedHeader({alg: 'RS256', kid: 'test-key-1'})
    .setIssuer(claims.issuer ?? TEST_DOMAIN)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .sign(privateKey);
}
