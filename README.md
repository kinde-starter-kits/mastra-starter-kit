# Plan My Day — a Mastra + Kinde starter kit

A small, complete example of an AI agent that knows **who** is asking, **which organization** they belong to, and **what they are allowed to do** — using [Kinde](https://kinde.com) for identity and [Mastra](https://mastra.ai) for the agent runtime, joined by [`@kinde-oss/mastra-auth-kinde`](https://github.com/kinde-oss/mastra-auth-kinde).

> **Status: foundation.** Authentication, organization gating, and identity-scoped memory addressing are implemented and tested. The planning agent and its tools are the next step — see [Roadmap](#roadmap).

## What this demonstrates

Most agent demos run as a single anonymous user. Real applications do not. This starter kit shows the part that is usually missing:

| Concern | How it is handled |
|---|---|
| Who is the user? | Kinde issues a JWT; `MastraAuthKinde` verifies it against Kinde's JWKS |
| Which organization? | The token's `org_code` claim, optionally restricted via `allowedOrgCodes` |
| What may they do? | The token's `permissions` claim, checked at the tool boundary |
| Whose memory is this? | A resource ID derived server-side from `org_code` + `sub` |

The demo it builds toward: the **same agent** gives **different outcomes** depending on the signed-in user's Kinde permissions. A user with `read:itinerary` can plan and view. A user who also has `create:itinerary` can save. Nothing about the prompt changes — only the identity does.

## Architecture

Two processes, one integration point.

```
┌─────────────────────────────┐
│  Browser (Vite + React SPA) │
│  @kinde-oss/kinde-auth-react│
└─────────────┬───────────────┘
              │ 1. Authorization Code + PKCE
              ▼
      ┌───────────────┐
      │  Kinde tenant │  issues an access token (JWT):
      └───────┬───────┘  sub, org_code, permissions, exp, aud…
              │
              │ 2. Authorization: Bearer <token>
              ▼
┌──────────────────────────────────────────────┐
│  Mastra server                               │
│                                              │
│  MastraAuthKinde                             │
│   ├─ authenticateToken()  JWKS verify        │
│   ├─ authorizeUser()      org gate           │
│   └─ mapUserToResourceId() org_code:sub      │
│                    │                         │
│                    ▼                         │
│           RequestContext                     │
│            ├─ 'user'              (claims)   │
│            └─ mastra__resourceId  (memory)   │
│                    │                         │
│                    ▼                         │
│           Agent → tools → memory             │
│            permission check happens HERE     │
└──────────────────────────────────────────────┘
```

The browser holds a token. The server holds the trust. Nothing the browser sends — user ID, org code, resource ID — is believed.

### Project layout

```
src/
  mastra/
    index.ts            Mastra instance: auth, storage, CORS, /me route
    lib/kinde.ts        Identity + permission helpers (the trust boundary)
    agents/             ← next
    tools/              ← next
    workflows/          ← next
    schemas/            ← next
  app/
    App.tsx             Sign-in and identity panel
    env.ts              VITE_ config with helpful errors
    lib/mastra-client.ts  Bearer-token fetch wrapper
tests/
  auth.test.ts          Authentication + resource identity (integration)
  organization.test.ts  allowedOrgCodes gating (integration)
  kinde-identity.test.ts  Helper unit tests
  helpers/              Fake Kinde tenant — no Kinde account needed to test
```

## Why Kinde

An agent that can spend money, write records, or read someone's history needs an identity model, and JWT verification is easy to get subtly wrong. Kinde supplies hosted login, organizations, and a permission model; `@kinde-oss/mastra-auth-kinde` supplies the verification. This repository writes **no** authentication logic of its own — that is the point.

## How `@kinde-oss/mastra-auth-kinde` fits in

It is a `MastraAuthProvider`, so it plugs straight into `server.auth` ([`src/mastra/index.ts`](src/mastra/index.ts)):

```ts
export const auth = new MastraAuthKinde({
  domain: process.env.KINDE_DOMAIN,
  audience: process.env.KINDE_AUDIENCE,
  allowedOrgCodes: parseAllowedOrgCodes(process.env.KINDE_ALLOWED_ORG_CODES),
  mapUserToResourceId: resourceIdForUser
});

export const mastra = new Mastra({storage, server: {auth, apiRoutes: [meRoute]}});
```

Mastra then does three things on every request, before any of your code runs:

1. **`authenticateToken(token, request)`** — verifies the signature against `<domain>/.well-known/jwks`, plus issuer, expiry, and audience. Returns the claims, or `null`.
2. **`authorizeUser(user, request)`** — denies anonymous callers, and denies organizations outside `allowedOrgCodes` when that option is set. A `null` from step 1 is a `401`; a `false` here is a `403`.
3. **`mapUserToResourceId(user)`** — derives the memory resource ID and stores it under the reserved `mastra__resourceId` key.

### How authentication works

Every Mastra route is protected by default once `server.auth` is set. The SPA attaches the Kinde access token to each call:

```ts
fetch(`${mastraUrl}/me`, {headers: {Authorization: `Bearer ${token}`}});
```

No token, an expired token, a token from another issuer, or a token for the wrong audience all produce `401` before a handler runs. You can see this yourself in [How to verify](#how-to-verify).

### How organization context works

Kinde puts the signed-in organization in the `org_code` claim. This kit uses it twice:

- **As a gate.** Set `KINDE_ALLOWED_ORG_CODES=org_abc,org_def` and tokens from any other organization get `403` at the server edge. Leave it blank to allow all organizations.
- **As a scope.** `org_code` is the first segment of the memory resource ID, so data is partitioned by organization, not just by user.

### How permissions reach the tool boundary

`authorizeUser` runs per *request*, and a request carries no tool name — so it cannot decide whether *this particular action* is allowed. That decision belongs where the action happens: inside the tool.

The verified claims are on the request context, so a tool reads them like this:

```ts
import {requireKindeUser, hasPermission, PERMISSIONS} from '../lib/kinde';

execute: async (input, {requestContext}) => {
  const user = requireKindeUser(requestContext);

  if (!hasPermission(user, PERMISSIONS.createItinerary)) {
    return {saved: false, reason: 'permission_denied'};
  }
  // ...stamp the record with user.sub and user.org_code, never with tool input
}
```

Two rules make this safe, and both are enforced in [`src/mastra/lib/kinde.ts`](src/mastra/lib/kinde.ts):

- **Identity comes from the request context, never from tool input.** A model can be talked into passing any argument; it cannot forge a JWT-derived claim.
- **A missing `permissions` claim means "no permissions", never "allow".** A misconfigured tenant fails closed.

### How memory is scoped

```ts
mapUserToResourceId: user => `${user.org_code}:${user.sub}`
```

Mastra writes that value to the reserved `mastra__resourceId` request-context key, and **reserved keys are stripped from client-supplied context**. So a browser cannot ask to read someone else's memory — the server's value always wins. Both properties are covered by tests.

The same person in two Kinde organizations gets two independent memories, which is the correct behaviour for org-scoped data. Tokens with no `sub` (machine-to-machine) produce no resource ID at all, rather than a partial one.

## Configure Kinde

You need one Kinde application and, for the permission demo, two users.

### 1. Create the application

In the Kinde dashboard: **Applications → Add application → Single Page Application**.

- **Allowed callback URLs**: `http://localhost:5173`
- **Allowed logout redirect URLs**: `http://localhost:5173`

Copy the **Client ID**. There is deliberately no client secret here — a SPA uses Authorization Code + PKCE, and a secret cannot be kept secret in a browser bundle.

### 2. Turn on organizations

**Settings → Environment → Organizations**, and make sure users sign in to an organization. Note the **organization code** (`org_...`) — that is the `org_code` claim.

### 3. Create the permissions

**Settings → Permissions**, add:

| Permission | Meaning |
|---|---|
| `read:itinerary` | View saved itineraries |
| `create:itinerary` | Save an itinerary |

Then assign them per user (directly or through a role) **inside the organization**.

For the demo, set up two users:

- **User A** — `read:itinerary` only
- **User B** — `read:itinerary` and `create:itinerary`

### 4. Register an API (recommended)

**Settings → APIs → Add API**, with an audience such as `https://api.plan-my-day.local`, then authorize your application to use it. Put that value in **both** `KINDE_AUDIENCE` and `VITE_KINDE_AUDIENCE`.

> Leave both blank until the API exists. A default Kinde token has an empty `aud`, so enabling the audience check too early rejects every token.

> **Claim availability.** `org_code` and `permissions` appear on the access token only when organizations and the permissions claim are enabled for the application. The `/me` endpoint reports exactly which claims arrived and warns about missing ones, so you can confirm this in the browser rather than guessing.

## Run locally

```bash
git clone https://github.com/kinde-starter-kits/mastra-starter-kit
cd mastra-starter-kit
npm install

cp .env.example .env   # then fill it in — see above
```

Two processes:

```bash
npm run dev:mastra   # Mastra server on http://localhost:4111
npm run dev:app      # SPA on http://localhost:5173
```

Open <http://localhost:5173>, sign in with Kinde, and the identity panel shows your `sub`, `org_code`, permissions, and the server-derived memory resource ID.

> **Mastra Studio and auth.** With `server.auth` configured, Studio at `http://localhost:4111` is subject to the same bearer-token check as the API — the provider handles API authentication, not Studio's login UI. Use the SPA for the demo flow.

## How to verify

**The tests need no Kinde account.** They generate a keypair, serve a JWKS, and mint real signed tokens, so the actual provider performs actual signature verification.

```bash
npm test        # 35 tests
npm run typecheck
npm run lint
```

What they prove:

- Requests with no token, a malformed token, a forged signature, an expired token, a wrong issuer, or a wrong audience are all rejected
- A valid Kinde identity reaches the route handler
- A disallowed `org_code` gets `403`; an allowed one gets `200`
- The resource ID is `org_code:sub`, differs per user and per organization, and **cannot be overridden by the client**
- A missing `permissions` claim fails closed

You can also watch the gate work against the live server:

```bash
npm run dev:mastra
curl -i http://localhost:4111/me                                    # 401
curl -i -H "Authorization: Bearer bogus" http://localhost:4111/me   # 401
```

## Roadmap

The foundation above is done. Still to build:

- `get-weather` (Open-Meteo, no API key) and `find-activities` (seeded local dataset)
- `save-itinerary` — the authorization showcase, gated on `create:itinerary`
- `list-itineraries` — organization-scoped reads
- The trip agent, a structured `ItinerarySchema`, and a `plan-trip` workflow
- Memory-backed preferences, plus the itinerary card and permission-denied UI

## License

MIT — see [LICENSE](LICENSE).
