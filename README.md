# Plan My Day — a Kinde + Mastra starter kit

Plan My Day is a working example of an AI agent that knows which user is asking, which organization that user belongs to, and which actions that user is allowed to perform. It uses [Kinde](https://kinde.com) for identity and [Mastra](https://mastra.ai) for the agent runtime, connected by the [`@kinde-oss/mastra-auth-kinde`](https://github.com/kinde-oss/mastra-auth-kinde) provider.

When you ask the agent to plan an afternoon, it reads the weather forecast, selects activities, and returns a structured itinerary. When you then ask it to save that itinerary, the outcome depends on the permissions in your Kinde access token. A user who holds `create:itinerary` saves the plan. A user who does not hold that permission receives a clear refusal. The prompt is identical in both cases, and only the authenticated identity differs.

## What this starter kit demonstrates

| Concern | Implementation |
|---|---|
| Authentication | Kinde SPA using Authorization Code with PKCE, a bearer token, and `MastraAuthKinde` verification of signature, issuer, expiry, and audience |
| Organization identity | The `org_code` claim, with an optional allow-list through `allowedOrgCodes` |
| Authorization | The `permissions` claim, checked inside the backend tools |
| Data isolation | A resource ID derived on the server from `org_code` and `sub` |
| Memory | Thread-scoped conversation history and resource-scoped working memory, stored in LibSQL |
| Persistence | Saved itineraries in LibSQL, with ownership fields written from the verified token |
| Agent | One agent with four tools and multi-step tool calling |
| Structured output | A discriminated-union response envelope that the frontend renders directly |
| Workflow | A typed `plan-trip` workflow that acts as the entry point |
| Validation | A deterministic itinerary validator, with one correction attempt before the run fails |
| Follow-ups | A later message edits the plan already in the conversation, using the stored structured itinerary |
| Telemetry | Execution events streamed to the browser over the workflow stream |
| Conversation replay | Validated responses stored on the Mastra thread, so a reopened conversation renders the original cards |
| Activity discovery | Real places anywhere in the world, from OpenStreetMap, with no provider key |
| Model access | Strictly bring-your-own-key: each user supplies their own OpenAI key |
| Frontend | A React and Vite single-page application |

### The identity model

The security model follows from a single derivation:

```
org_code + sub  →  server-derived resource ID  →  memory and persistence isolation
```

The provider's `mapUserToResourceId` hook produces the resource ID from the verified token. The browser cannot supply or influence this value.

## Architecture

```mermaid
flowchart TD
    B["Browser — React SPA<br/>@kinde-oss/kinde-auth-react"]
    K["Kinde<br/>hosted login"]
    B -->|"1 · Authorization Code + PKCE"| K
    K -->|"2 · access token (JWT)<br/>sub · org_code · permissions"| B
    B -->|"3 · Authorization: Bearer &lt;token&gt;<br/>body: { message, threadId }"| A

    subgraph S["Mastra server"]
        direction TB
        A["MastraAuthKinde<br/>verifies signature · issuer · expiry · audience"]
        A -->|"authorizeUser() — organization gate"| RC
        RC["RequestContext<br/>'user' = verified claims<br/>mastra__resourceId = org_code:sub"]
        RC --> W["plan-trip workflow"]
        W --> AG["trip agent"]
        AG --> T1["get-weather<br/><i>Open-Meteo</i>"]
        AG --> T2["find-activities<br/><i>Open-Meteo geocoding<br/>+ OpenStreetMap places</i>"]
        AG --> T3["save-itinerary<br/><b>requires create:itinerary</b>"]
        AG --> T4["list-itineraries<br/><b>requires read:itinerary</b>"]
        AG --> M["Memory<br/>thread history + working memory"]
        T3 --> DB[("LibSQL<br/>saved_itineraries")]
        T4 --> DB
        M --> DB
    end

    AG -->|"4 · AgentResponse"| B
```

The browser sends only a message and a thread ID. It does not send `sub`, `org_code`, `resourceId`, or permissions, and the server ignores those fields if a client supplies them. Four mechanisms enforce this:

- Tool input schemas contain no identity fields, so Zod strips unknown keys before `execute` runs.
- Mastra removes reserved keys, including `mastra__resourceId`, from any client-supplied request context.
- Each tool reads identity from the request context rather than from its arguments.
- Each database read is scoped with `WHERE org_code = ? AND sub = ?`.

Authorization runs at the tool boundary rather than at the route boundary. An HTTP request carries no tool name, so a route-level check cannot determine which action the caller intends to perform. The tool that performs the action has that information and applies the check.

## Features

### Authentication

The frontend is a public SPA that uses Authorization Code with PKCE through `@kinde-oss/kinde-auth-react`. This application type has no client secret, because a browser cannot store one securely, and the starter kit never asks for one.

The frontend sends the access token to the Mastra server in an `Authorization: Bearer <token>` header. `MastraAuthKinde` verifies the token against the JWKS endpoint of your Kinde tenant and checks the signature, the issuer, the expiry, and the audience. This repository contains no token verification logic of its own, because the provider supplies it.

The server returns `401` for requests that present no token, a malformed token, an expired token, a token from another issuer, or a token for another audience.

### Authorization

The starter kit defines two permissions in [`src/mastra/lib/kinde.ts`](src/mastra/lib/kinde.ts):

| Permission | Required by |
|---|---|
| `read:itinerary` | `list-itineraries` |
| `create:itinerary` | `save-itinerary` |

The permission checks run on the server, inside the tools. They fail closed: the code treats an absent or malformed `permissions` claim as an empty permission set, so a misconfigured tenant denies access rather than granting it.

The frontend applies no authorization policy. It reads a `permissionDenied` flag that the backend sets and selects a presentation for it. All policy remains on the server.

A refused action returns structured data rather than raising an exception. A denied save is an expected outcome that the model explains to the user and the interface renders, so it does not interrupt the run.

### Isolation

- The resource ID is `org_code:sub`, derived from the verified token.
- The server writes `sub`, `org_code`, and `resourceId` onto each saved itinerary.
- Every read filters on both `org_code` and `sub`.
- Users in the same organization cannot read each other's saved itineraries. This behavior was verified against a live Kinde tenant with two real users.
- The same person signed in to two organizations receives two independent sets of saved itineraries and two independent memories.

> Cross-organization isolation is covered by the automated test suite. It has not been verified against a live tenant, because the available test users belonged to the same organization.

### Memory

Memory is configured in [`src/mastra/memory.ts`](src/mastra/memory.ts) and has two layers:

- **Conversation history** holds the last 20 messages and is scoped to a thread.
- **Working memory** holds travel preferences and is scoped to the resource, so preferences apply across every conversation that the same user starts. A preference such as "I am vegetarian" therefore affects plans generated in later sessions.

The working memory schema is a closed set of fields with no free-text entry, which limits what the agent can record to trip-planning facts:

```
dietary · likes · dislikes · preferredStartTime · pace · accessibility
```

The frontend supplies the `threadId` and generates a new one when the user starts a new conversation. The frontend never supplies the resource ID, because Mastra derives it from the token through `mapUserToResourceId`. A browser can therefore select its own conversation but cannot select whose memory it reads.

### Weather

[`get-weather`](src/mastra/tools/get-weather.ts) uses the Open-Meteo geocoding and daily forecast endpoints, which require no API key and no account. The tool resolves a place name to coordinates, requests the forecast with `timezone=auto` so that dates refer to the local day at the destination, and returns a small stable output shape.

Both this tool and the activity search resolve a place name through the same module, [`src/mastra/lib/geocoding.ts`](src/mastra/lib/geocoding.ts), so the two can never disagree about where a request means.

The tool reports failures explicitly instead of returning substitute data. An unknown place, a date outside the available forecast range, an upstream error, and a request timeout each produce a distinct typed error.

### Global activity discovery

[`find-activities`](src/mastra/tools/find-activities.ts) discovers real places near the requested city. There is no list of supported cities: a location is whatever a gazetteer can find, and a location that cannot be found is reported as unfindable rather than unsupported.

The pipeline is:

```
city name → geocoding → place discovery → adapter → ranking → agent
```

| Step | Provider | Credential |
|---|---|---|
| Geocoding | Open-Meteo geocoding, with Nominatim as a fallback | None |
| Place discovery | OpenStreetMap Overpass (two mirrors) | None |
| Weather | Open-Meteo forecast | None |

None of the three needs an API key, so the starter kit stays clone-and-run and there is no discovery credential that could leak.

Discovery responds to the request rather than fetching everything: an asked-for category, the tags in the request, and severe weather all narrow which kinds of place are searched. Anything unrecognised leaves the search wide, because guessing narrowly is worse than searching broadly. The search widens its radius when a place is sparse, and returns few results — or none — rather than inventing any.

Only places somebody could visit are returned. A plain "anything tagged tourism" query is mostly hotels and apartments, so the tool selects from an allow-list of visitable kinds: museums, galleries, theatres, parks, gardens, beaches, attractions, restaurants, cafés, markets, wellness venues and similar.

Discovered places are adapted into the same shape the ranking already used, so the preference hierarchy and the weather policy apply identically everywhere. Ranking is deterministic and accounts for weather: when you pass the forecast from `get-weather`, weather-sensitive activities rank lower and each result carries a `weatherFit` value. Such activities remain in the results, so the agent can still select one when the user asks for it.

The **Popular destinations** shortcuts on the empty workspace fill the composer with an example request. They are a convenience only, and any city can be typed instead.

> Set `ACTIVITY_SOURCE=seeded` to plan from the small activity fixtures bundled with the repository rather than calling a map server. The test suite sets this itself so it can run offline and deterministically. It is opt-in, so production always discovers for real.

#### What OpenStreetMap does and does not give you

Coverage is worldwide, but density varies a great deal. A relaxed-afternoon search measured roughly 210 places in London, 200 in San Francisco and 210 in Tokyo, against 15 in Lagos and 18 in Port Harcourt. Those are real places in every case; some cities simply have less mapped.

Opening hours are recorded for many venues in Europe and North America and for few elsewhere. When hours are absent the plan neither claims the venue is open nor discards it: unknown stays unknown, and the validator skips the opening-hours rule for that place. The syntax OpenStreetMap uses for hours is expressive, and only the plain unambiguous forms are read, because misreading one would state a venue is open when it is closed.

Cost and price data does not exist in this source, so the agent cannot rank a day by cost. It says so instead of estimating.

### Streaming execution

A planning run streams what it is doing while it does it. The workflow emits execution events — the stage it has reached, each tool that ran and how long it took, each validation pass — and the browser folds them into the timeline above the itinerary.

Every line comes from a real operation. There are no timers and no simulated progress, so a step shown is a step that happened and a duration shown was measured. The events carry no prompt, tool argument, tool result, credential, or resource ID.

The stream is a sequence of JSON records separated by `\x1e` (RFC 7464 JSON text sequences), not newline-delimited JSON. [`src/app/lib/stream-protocol.ts`](src/app/lib/stream-protocol.ts) decodes it, and `tests/fixtures/` holds captured responses so the format is pinned to something observed rather than assumed.

### Persistence

Saved itineraries are stored in LibSQL, in the `saved_itineraries` table. Each record wraps the itinerary in metadata that the server owns:

```
id · itinerary · sub · orgCode · resourceId · createdAt · updatedAt
```

The `itinerary` field holds the agent-facing `ItinerarySchema` object. The server writes the ownership fields, which never originate from the model or from the client.

#### Database location

The default database is `mastra.db` in the project root. The path resolves from the project root rather than from the current working directory.

This distinction is important. A relative path such as `file:./mastra.db` resolves against the directory in which the process starts, and `mastra dev` runs its bundled server from a different directory than `npm test` uses. That behavior placed the database in unexpected locations and caused `npm run dev` and `npm test` to use different files. [`src/mastra/lib/database-url.ts`](src/mastra/lib/database-url.ts) resolves the path from the project root and removes the inconsistency.

Set `DATABASE_URL` to override the location. The value passes through unchanged:

```env
DATABASE_URL=file:/absolute/path/to/mastra.db   # explicit local file
DATABASE_URL=libsql://your-db.turso.io          # hosted Turso database
```

Do not set a relative path such as `file:./mastra.db`, because that reintroduces the working-directory dependency.

A hosted database also needs `DATABASE_AUTH_TOKEN`. It is read only when set, so a local `file:` database — which needs no credential — is unaffected.

#### Conversations

Conversations are Mastra threads, owned by the resource ID derived from the token. There is no second conversation database.

When a run finishes, the validated `AgentResponse` is stored on the thread alongside the request that produced it, capped at the most recent 30 turns. Reopening a conversation replays those turns through the same cards a live run renders. Storing the envelope is what makes that possible: the agent's message text is often prose, while the structured object comes from the structuring pass and would otherwise be lost.

Tool arguments and tool results are never part of a replayed turn, and an internal correction prompt is never shown as something the user said.

#### Browser storage

The browser stores exactly one value:

```
localStorage["planmyday.activeThreadId"]
```

It exists so a reload returns to the same conversation. No itinerary content, no conversation text, and no API key is written to `localStorage`, `sessionStorage`, or a cookie.

### Model access — bring your own key

Model access is strictly bring-your-own-key. Each user supplies their own OpenAI API key, and the server holds none.

Sign in, open the account menu at the foot of the sidebar, and select **Add key**. The key is kept in memory for that page session and sent with each planning request.

```
account menu → memory → x-openai-api-key header → AsyncLocalStorage → model
```

The server reads no OpenAI key from its environment. Setting `OPENAI_API_KEY` on the server has no effect on model access, which is why the variable is absent from the configuration below. A shared deployment therefore cannot spend the maintainer's quota on a visitor's request.

When no key is present, the frontend asks for one and **sends no request at all**, rather than starting a run that must fail.

The key is held in `AsyncLocalStorage` for the life of the request, which keeps it out of workflow input, workflow state, workflow traces, telemetry, working memory, conversation metadata, and the database. It is never written to `localStorage`, `sessionStorage`, a cookie, or a URL, never logged, and never returned in an API response. The `/me` endpoint reports only whether a key is present, never the key.

Model usage is charged by OpenAI to the account that owns the key.

## Prerequisites

- Node.js 22.13.0 or later, as declared in the `engines` field of `package.json`.
- npm. The repository includes `package-lock.json`; pnpm and yarn are untested.
- A Kinde account. The free tier is sufficient.
- An OpenAI API key, which each user enters in the application at run time. See [Model access](#model-access--bring-your-own-key). The agent uses the `openai/gpt-4.1-mini` model through the Mastra model gateway.

The starter kit requires no separate database installation, and no key for weather, geocoding, or place discovery.

## Configure Kinde

The setup requires one application, one API, one organization, two permissions, and two users.

> Kinde updates its dashboard wording from time to time. The following steps describe what to create. The exact menu labels in your dashboard can differ.

### 1. Create the application

Create a **Front-end and mobile** application, which is the SPA application type, for the React and Vite frontend. Copy the **Client ID** and use it as `VITE_KINDE_CLIENT_ID`.

This application type has no client secret, and the starter kit never requires one.

### 2. Set the callback and logout URLs

Set both URLs to the origin of the frontend:

```
Allowed callback URL:          http://localhost:5173
Allowed logout redirect URL:   http://localhost:5173
```

> This starter kit does not implement an `/api/auth/...` callback route. The Kinde React SDK completes the PKCE redirect in the browser and returns to the application origin. [`src/app/env.ts`](src/app/env.ts) defaults both URLs to `window.location.origin`, so register the deployed origin as well when you host the frontend elsewhere.

### 3. Register an API and authorize the application

Create an API and give it an identifier such as `plan-my-day-api`. Then authorize the front-end application to request tokens for that API.

Use the same identifier for both `KINDE_AUDIENCE` on the server and `VITE_KINDE_AUDIENCE` in the frontend. The frontend requests a token for that audience, and the server requires the token to carry it, so the two values must match.

> Complete this step before you start the application. A Kinde token issued without an API audience carries an empty `aud` claim, and the server rejects such a token when `KINDE_AUDIENCE` is set.

### 4. Enable organizations

Configure your users to sign in to an organization so that their tokens carry an `org_code` claim. Record the organization code, which has the form `org_...`.

### 5. Create the permissions

Create these two permissions:

```
read:itinerary
create:itinerary
```

Assign them to users within the organization rather than only at the account level. You can assign them directly or through a role. For example, a *Planner* role can hold both permissions and a *Viewer* role can hold only `read:itinerary`. The starter kit reads the `permissions` claim and does not read roles, so either assignment method works.

### 6. Create two test users

The two users demonstrate the difference that permissions make:

| User | Permissions | Expected behavior |
|---|---|---|
| Planner | `read:itinerary`, `create:itinerary` | Plans, saves, and lists itineraries |
| Viewer | `read:itinerary` | Plans and lists itineraries; the save operation is denied |

### 7. Confirm that the claims arrive

Sign in and check the header and the permission indicators in the application, or call `GET /me` with the access token. The endpoint returns the values that the server derived, including `sub`, `orgCode`, `permissions`, and `resourceId`, together with a `claimWarnings` array that names any missing claim. If `org_code` or `permissions` are absent, this endpoint reports the problem directly.

## Environment variables

Copy the example file and complete it:

```bash
cp .env.example .env
```

### Required

| Variable | Used by | Description |
|---|---|---|
| `KINDE_DOMAIN` | Mastra server | The tenant URL. The value must include the `https://` scheme, and the provider throws an error if the variable is absent. |
| `VITE_KINDE_DOMAIN` | Frontend | The same tenant URL. |
| `VITE_KINDE_CLIENT_ID` | Frontend | The Client ID of the SPA application. |
| `KINDE_AUDIENCE` | Mastra server | The API identifier that you created for the Plan My Day API. The server requires each token to carry this value in its `aud` claim. |
| `VITE_KINDE_AUDIENCE` | Frontend | The same API identifier. The frontend requests a token for this audience, so the value must match `KINDE_AUDIENCE`. |

> There is no OpenAI variable. Each user supplies their own key in the application — see [Model access](#model-access--bring-your-own-key).

> The provider enforces the audience only when `KINDE_AUDIENCE` holds a value, so the code also runs with both audience variables empty. The recommended configuration for this starter kit sets them, because an API audience makes the access token an API token for your backend. If you leave them empty, complete step 3 of the Kinde setup first and then set both values together.

### Optional

Each of the following variables has a working default.

| Variable | Used by | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Mastra server | `mastra.db` in the project root | An absolute `file:` path or a `libsql://` URL. |
| `DATABASE_AUTH_TOKEN` | Mastra server | Not set | The auth token for a hosted LibSQL database. A local `file:` database needs none. |
| `KINDE_ALLOWED_ORG_CODES` | Mastra server | All organizations allowed | A comma-separated allow-list of organization codes. The server returns `403` for other organizations. |
| `APP_ORIGIN` | Mastra server | `http://localhost:5173` | The CORS origin, or a comma-separated list of origins, that the Mastra server accepts. A deployment must include the deployed frontend origin. |
| `ACTIVITY_SOURCE` | Mastra server | Not set — discovery runs for real | Set to `seeded` to plan from the bundled activity fixtures instead. The test suite sets this itself. Leave unset in production. |
| `VITE_KINDE_REDIRECT_URI` | Frontend | The application origin | The redirect target after sign-in. |
| `VITE_KINDE_LOGOUT_URI` | Frontend | The application origin | The redirect target after sign-out. |
| `VITE_MASTRA_URL` | Frontend | `http://localhost:4111` | The address of the Mastra server. A deployment must set this to the deployed backend origin. |

### Example `.env`

The following values are placeholders. Do not commit real credentials. The `.env` file is listed in `.gitignore`.

```env
KINDE_DOMAIN=https://your-domain.kinde.com
VITE_KINDE_DOMAIN=https://your-domain.kinde.com
VITE_KINDE_CLIENT_ID=your-client-id
KINDE_AUDIENCE=your-api-audience
VITE_KINDE_AUDIENCE=your-api-audience
```

## Run the starter kit

```bash
git clone https://github.com/kinde-starter-kits/mastra-starter-kit
cd mastra-starter-kit
npm install
cp .env.example .env   # then complete the file
```

> `npm install` installs `@kinde-oss/mastra-auth-kinde` from GitHub rather than from npm, and builds it through the package's `prepare` script.

Start both processes:

```bash
npm run dev          # Mastra server on :4111 and the React SPA on :5173
```

Or run them separately, in two terminals:

```bash
npm run dev:mastra   # Mastra server at http://localhost:4111
npm run dev:app      # React SPA at http://localhost:5173
```

Local development stores everything in a `mastra.db` file at the project root. No database service is needed.

Then open <http://localhost:5173> and sign in.

> Mastra Studio at `http://localhost:4111` applies the same bearer-token check as the API, because `server.auth` is configured. The provider handles API authentication and does not provide the Studio login interface, so use the SPA to run the demonstration.

## Run the demonstration

Sign in as the Planner user and send the following request:

> Plan me an afternoon in Lagos tomorrow. I like outdoor activities and don't want anything too early.

The agent resolves the relative date against the current date, calls `get-weather` for Lagos, passes the forecast to `find-activities`, selects activities that fit an afternoon, and returns a structured itinerary that the frontend renders as a card.

Then send:

> Save this itinerary.

The agent calls `save-itinerary`, the tool stores the record, and the interface confirms the result.

Now sign in as the Viewer user and repeat both requests. The agent still produces an itinerary. The save operation is denied, the interface displays a permission-denied state that names `create:itinerary`, and the server writes no record. When you ask the Viewer to list saved itineraries, the response contains only itineraries that the Viewer saved, and it does not include the record that the Planner saved.

## HTTP API

The frontend calls these endpoints on the Mastra server. Every one requires a valid bearer token, and every one returns `401` without it.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/me` | Returns the identity that the server derived from the token, including `sub`, `orgCode`, `permissions`, `resourceId`, and `claimWarnings`. |
| `GET` | `/conversations` | Lists the caller's conversations. Ownership comes from the token, never from the request. |
| `GET` | `/conversations/:threadId` | Returns one conversation, rebuilt as turns. A thread that is missing and a thread that belongs to somebody else give the same `404`. |
| `POST` | `/api/workflows/planTripWorkflow/stream?runId=<uuid>` | Runs the workflow and streams execution events while it works. The `runId` query parameter is required. |
| `POST` | `/api/workflows/planTripWorkflow/start-async` | Runs the workflow to completion in one response. Used as a fallback when the environment cannot read a stream. |

The stream is a sequence of JSON records separated by `\x1e` (RFC 7464), not newline-delimited JSON. The wire format is captured in `tests/fixtures/` and decoded in [`src/app/lib/stream-protocol.ts`](src/app/lib/stream-protocol.ts).

A caller may send an OpenAI key in the `x-openai-api-key` header. The key is held in browser memory for the session, sent as a header on each request, and read on the server through `AsyncLocalStorage`. It never enters workflow input, telemetry, conversation metadata, or storage.

## Response contract

Every agent reply takes one of three shapes, defined in [`src/mastra/schemas/agent-response.ts`](src/mastra/schemas/agent-response.ts):

```ts
{ kind: 'itinerary',  itinerary: Itinerary }
{ kind: 'saved-list', itineraries: SavedItinerary[] }
{ kind: 'message',    message: string,
                      permissionDenied: boolean,
                      requiredPermission: string | null }
```

A single itinerary schema cannot represent a list of saved plans or a refusal, so the envelope carries a `kind` discriminator and only the payload that matches it. The frontend switches on `kind` and reads the `permissionDenied` flag, so it never inspects message text to determine authorization state.

## Project layout

```
src/
  mastra/
    index.ts                 Mastra instance: auth, storage, CORS, /me route
    storage.ts               Shared LibSQL client
    memory.ts                Memory configuration and travel preference schema
    agents/trip-agent.ts     Agent instructions, four tools, structured output
    tools/
      get-weather.ts         Open-Meteo forecast lookup
      find-activities.ts     Global discovery, ranking, seeded fixtures
      save-itinerary.ts      Requires create:itinerary
      list-itineraries.ts    Requires read:itinerary
    workflows/plan-trip.ts   Typed workflow entry point
    telemetry/plan-events.ts Execution event contract
    schemas/                 itinerary, saved-itinerary, agent-response
    lib/
      kinde.ts               Identity and permission checks
      geocoding.ts           Worldwide location resolution, two providers
      places.ts              OpenStreetMap place discovery
      discovered-activities.ts  Adapts a place into a plannable candidate
      activity-context.ts    What discovery offered, for validation
      itinerary-store.ts     Saved itinerary table
      itinerary-validator.ts Deterministic plan validation
      conversations.ts       Threads, stored turns, replay
      follow-up.ts           Follow-up classification and patch prompts
      itinerary-diff.ts      Deterministic change detection
      save-intent.ts         Explicit save requirement
      model-key.ts           Per-request OpenAI credential
      weather-conditions.ts  WMO codes, shared with the browser
  app/                       React SPA: sidebar, composer, itinerary,
                             execution panel, account menu
scripts/
  build-server.mjs           Vercel build wrapper — see Deploy
tests/                       776 tests
```

## Tests

```bash
npm test         # 776 tests across 30 files
npm run typecheck
npm run lint
npm run build    # server bundle, then the frontend
```

The test suite requires no Kinde account, no OpenAI key, and no network access. It sets `ACTIVITY_SOURCE=seeded` so planning uses the bundled fixtures; discovery itself is tested separately with the providers stubbed at the `fetch` boundary. It generates an RSA key pair, serves a JWKS document, and mints signed tokens, so the provider performs real signature verification. Open-Meteo responses are stubbed at the `fetch` boundary and the model is scripted turn by turn, which leaves the tools, the database, the agent, and the authentication pipeline running as they do in production.

The suite verifies the following behavior, among other cases:

- The server rejects malformed, expired, forged, wrong-issuer, and wrong-audience tokens.
- The resource ID equals `org_code:sub` and a client cannot override it.
- An absent `permissions` claim fails closed.
- A save without `create:itinerary` is refused and writes no record.
- One user cannot read another user's itineraries, in the same organization or in a different organization.
- The weather forecast affects activity selection.
- An itinerary that breaks the requested time window, opening hours, or the weather policy is rejected.
- A plan is never saved unless the message asked for it, whatever the model decides.
- A follow-up that returns the previous plan unchanged is detected and reported, not presented as a change.
- Telemetry carries no prompt, tool argument, tool result, credential, or resource ID.
- A stored conversation replays as the same cards, with no raw tool data.
- An arbitrary city resolves and discovers through one path, with no city named in the code.
- A place nobody discovered is rejected, so the model cannot invent a venue.
- Unknown opening hours neither disqualify a place nor claim it is open.
- No provider credential appears in any discovery request.

## Limitations

The starter kit demonstrates a complete pattern, and several parts stay deliberately small.

Activity discovery is worldwide, but OpenStreetMap density varies: a relaxed-afternoon search finds roughly 200 places in London, San Francisco or Tokyo and around 15 to 20 in Lagos or Port Harcourt. Opening hours are recorded for many venues in some regions and few in others, and are treated as unknown when absent. Neither is a defect in the starter kit; it is what the map holds. The source carries no price data, so the agent cannot rank a day by cost and says so instead of estimating.

Discovery is slower in dense cities, because more places match. San Francisco has been measured at about 20 seconds. The deployed function is configured for a 60-second budget, which leaves headroom but cannot guarantee that a slow or busy map server will answer in time.

The model sometimes replies in prose rather than the response schema, which occurs on turns that modify an existing plan. Measured against the live model, this affected about one turn in four before mitigation. The workflow restates the output contract in the prompt and retries up to three times, which removed the failure across 36 measured turns. A run that still fails reports `model_output_invalid`, and the interface offers to try again.

A follow-up that names a measurable change, such as fewer stops or a later start, is checked against the previous plan. A request with no single measure, such as "make it more relaxed", relies on the model and the validator. The change detection compares the schedule rather than the prose, so an edit that changes only the notes reads as no change.

Weather comes from the Open-Meteo daily forecast, which gives one summary for the whole day rather than hourly detail. Dates resolve in UTC, so a traveller several time zones from UTC can see "today" change early or late.

## Deploy

The starter kit deploys to Vercel as **two projects from one repository**. The Mastra backend compiles to a single serverless function whose route table claims every path, so it cannot share a project with the frontend's static files.

| | Frontend | Backend |
|---|---|---|
| Project | `mastra-starter-kit` | `mastra-starter-kit-api` |
| Build command | `npm run build:app` | `npm run build:server` |
| Output | `dist/app` | Vercel Build Output API (`.vercel/output`) |
| Framework preset | Vite | Other |

Build settings live in each project's Vercel settings rather than in a `vercel.json`, because a single committed config file would apply to both projects and configure one of them wrongly.

The reference deployment runs at:

- Frontend — `https://kinde-mastra-demo.vercel.app`
- Backend — `https://mastra-starter-kit-api.vercel.app`

### Environment variables per project

**Backend** (`mastra-starter-kit-api`): `KINDE_DOMAIN`, `KINDE_AUDIENCE`, `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `APP_ORIGIN`.

**Frontend** (`mastra-starter-kit`): `VITE_KINDE_DOMAIN`, `VITE_KINDE_CLIENT_ID`, `VITE_KINDE_AUDIENCE`, `VITE_MASTRA_URL`.

Three values must agree, or the deployment will not work:

- `VITE_MASTRA_URL` on the frontend must be the deployed **backend** origin. Otherwise the browser calls `http://localhost:4111`.
- `APP_ORIGIN` on the backend must contain the deployed **frontend** origin, or CORS blocks every request.
- The Kinde application's callback and logout URLs must use the deployed **frontend** origin, or sign-in fails.

Set `DATABASE_URL` to a hosted LibSQL or Turso database with `DATABASE_AUTH_TOKEN`. A serverless filesystem does not persist, so a `file:` database loses conversations and saved itineraries between invocations.

Leave `ACTIVITY_SOURCE` unset in production so discovery runs for real.

### The build wrapper

[`scripts/build-server.mjs`](scripts/build-server.mjs) exists for one specific reason, and should be removed when that reason goes away.

`@kinde-oss/mastra-auth-kinde` is installed from its official GitHub repository at a pinned commit, because version `0.1.0` is not published to npm. When `mastra build` runs the Vercel deployer, it writes a `package.json` for the generated function and lists each external dependency by the version it reads from the installed package, not by the specifier that installed it. It therefore writes `"0.1.0"`, runs `npm install`, and npm answers 404 — stopping the build before it finishes.

The wrapper lets the bundle complete, rewrites that one dependency back to the Git specifier from `package.json`, runs the install, and performs the two steps the aborted build never reached: writing `.vc-config.json` and moving the output to `.vercel/output`. Both are reproduced from the deployer's own `bundle()`.

Once the package is published to npm, change the dependency to the published version, delete `scripts/build-server.mjs`, and set `build:server` back to `mastra build --dir src/mastra`.

### Function duration

The backend configures the deployer in [`src/mastra/index.ts`](src/mastra/index.ts):

```ts
deployer: new VercelDeployer({maxDuration: 60})
```

A planning run resolves a location and queries a map server before the model turn, and a dense city takes longer. On a default serverless budget the function was killed part-way through, which made every tool in the run appear to fail at once. Sixty seconds leaves room for a slow query; it does not guarantee that every provider request completes.

The wrapper reads this value from the Mastra config when it writes `.vc-config.json`, and fails the build if it is missing.

## Adapt the starter kit

- **Use real activity data.** Replace the dataset in `find-activities.ts`. The tool contract does not change.
- **Add permissions.** Add entries to `PERMISSIONS` in `lib/kinde.ts` and check them inside the tool that performs the action.
- **Change the model.** Update `TRIP_AGENT_MODEL` in `agents/trip-agent.ts` and set the API key for the provider you select.
- **Restrict organizations.** Set `KINDE_ALLOWED_ORG_CODES` to a comma-separated list of organization codes.

## License

MIT. See [LICENSE](LICENSE).
