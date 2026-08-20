import {env} from '../env';

/**
 * Every call to the Mastra server carries the Kinde access token as a bearer
 * token. That token — not a cookie, not a session — is what `MastraAuthKinde`
 * verifies on the server. This is the entire client side of the integration.
 */
export type Identity = {
  sub: string | null;
  orgCode: string | null;
  permissions: string[];
  resourceId: string | null;
  can: {
    readItinerary: boolean;
    createItinerary: boolean;
  };
  claimWarnings: string[];
};

export class MastraRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'MastraRequestError';
  }
}

export async function callMastra<T>(
  path: string,
  token: string | undefined,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${env.mastraUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...init.headers
    }
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new MastraRequestError(
      res.status,
      res.status === 401
        ? 'Mastra rejected the token. Check KINDE_DOMAIN and KINDE_AUDIENCE.'
        : res.status === 403
          ? 'Authenticated, but this organization is not allowed. Check KINDE_ALLOWED_ORG_CODES.'
          : `Mastra returned ${res.status}. ${detail}`
    );
  }

  return res.json() as Promise<T>;
}

export function fetchIdentity(token: string | undefined): Promise<Identity> {
  return callMastra<Identity>('/me', token);
}
