# API and dashboard

Mercury exposes an Express API for creating, observing and controlling durable
Runs. The dashboard uses the same API; it has no privileged data path.

Default base URL: `http://127.0.0.1:3000`.

## Authentication

Protected endpoints accept either:

- `Authorization: Bearer <token>` for scripts, CI and `curl`;
- the `mercury_session` cookie issued by the login endpoint.

Tokens map to owners through:

```bash
MERCURY_API_TOKENS="tok-alice:alice,tok-bob:bob"
MERCURY_ADMIN_TOKEN="separate-admin-token"
```

The token map is currently Mercury's identity source. Admin authentication can
read and control all Runs; ordinary owners can access only their own.

Foreign or missing Run ids return `404` to avoid disclosing another owner's
resources.

### Session endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Exchange `{ "token": "..." }` for an `HttpOnly` session cookie |
| `POST` | `/api/auth/logout` | Delete the current session and clear the cookie |
| `GET` | `/api/auth/me` | Return `{ ownerId, isAdmin }` for the current credential |

The session cookie is `HttpOnly` and `SameSite=Strict`. It becomes `Secure` when
the request is HTTPS, when a trusted proxy reports HTTPS, or when
`MERCURY_COOKIE_SECURE=true`.

Dashboard sessions are stored in memory and are lost when the API process
restarts. They are not shared between multiple API processes.

## Run endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/agents` | List registered agent ids |
| `POST` | `/api/runs` | Create and durably queue a Run |
| `GET` | `/api/runs` | List visible Runs |
| `GET` | `/api/runs/:runId` | Return Run details and recorded skills |
| `POST` | `/api/runs/:runId/input` | Answer a pending input request |
| `POST` | `/api/runs/:runId/cancel` | Request cancellation |
| `POST` | `/api/runs/:runId/retry` | Create a new retry Run |
| `GET` | `/api/runs/:runId/events` | Page through durable event history |
| `GET` | `/api/runs/:runId/stream` | Stream backlog and new events over SSE |

All endpoints in this table require authentication.

## Create a Run

```bash
curl -X POST http://127.0.0.1:3000/api/runs \
  -H "Authorization: Bearer tok-alice" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: fix-auth-2026-09-05" \
  -d '{
    "task": "Fix the authentication regression and prepare a PR",
    "repository": {
      "url": "https://github.com/acme/app",
      "baseBranch": "main"
    },
    "agent": "primeagent",
    "skills": ["debugging", "testing", "security-review"],
    "constraints": {
      "maxDurationMs": 3600000,
      "maxRetries": 2
    }
  }'
```

Response:

```json
{
  "runId": "run_...",
  "status": "QUEUED"
}
```

The response means the Run is persisted and scheduled. It does not wait for the
agent to start or finish.

### Repository fields

`repository` is the primary repository:

```ts
interface RepositoryContext {
  url?: string;
  localPath?: string;
  baseBranch?: string;
  baseCommit?: string;
}
```

`repositories` may contain additional repositories. The first list entry
becomes primary only when `repository` is absent. Extra repositories are
attached under the Run workspace's `repos/` directory.

`localPath` is resolved on the worker host, not the API caller's machine.

### Idempotency

Supply `Idempotency-Key` when a client may retry creation after a timeout. Keys
are scoped to the authenticated owner. Reusing the same key returns the
original Run instead of creating a second paid execution.

Use a new key when the intended task or repository changes.

### Constraints

Supported fields:

- `maxDurationMs` — enforced by the worker;
- `maxRetries` — enforced for automatic infrastructure retries;
- `budgetTokens` — recorded, not enforced;
- `budgetCost` — recorded, not enforced;
- `resourceLimits` — optional `cpu`, `memory`, `disk` strings;
- `allowedNetworks` — requests container isolation; empty means no network,
  non-empty currently means unrestricted container bridge networking.

The API rejects unknown fields, negative/non-finite values and the former
`maxTokens`/`maxCost` names.

## List and inspect Runs

```bash
curl "http://127.0.0.1:3000/api/runs?status=RUNNING&limit=50" \
  -H "Authorization: Bearer tok-alice"
```

Query fields:

- `status` — one Run status;
- `limit` — clamped to `1..200`, default `50`;
- `cursor` — opaque pagination cursor returned as `nextCursor`.

Ordinary callers receive only their Runs. Admin callers receive all Runs.
There is no client-supplied owner filter in the current route.

Run detail:

```bash
curl http://127.0.0.1:3000/api/runs/run_123 \
  -H "Authorization: Bearer tok-alice"
```

The response contains `{ run, skills }`, including workspace, constraints,
terminal artifacts and serialized skill records.

## Event history

```bash
curl \
  "http://127.0.0.1:3000/api/runs/run_123/events?after=0&limit=1000" \
  -H "Authorization: Bearer tok-alice"
```

Response fields:

- `events` — ascending events after the requested sequence;
- `nextCursor` — sequence of the last event actually returned;
- `lastSequence` — the Run's current highest sequence;
- `hasMore` — whether another page remains.

Resume from `nextCursor`, not `lastSequence`. A page can be capped before the
Run's true maximum.

## SSE streaming

```bash
curl -N \
  "http://127.0.0.1:3000/api/runs/run_123/stream?after=42" \
  -H "Authorization: Bearer tok-alice"
```

The stream:

1. sends persisted backlog after sequence `42`;
2. delivers new events;
3. emits keepalive comments;
4. closes after a terminal event;
5. can be reopened with the last observed sequence.

Clients should fetch current Run state, page event history and then subscribe.
The sequence cursor closes the history/subscribe race.

The browser dashboard uses `fetch()` streaming rather than native
`EventSource`, because authenticated fetches need the session cookie behavior
used by the rest of the app.

## Input, cancellation and retry

Submit input only while a Run is `NEEDS_INPUT`:

```bash
curl -X POST http://127.0.0.1:3000/api/runs/run_123/input \
  -H "Authorization: Bearer tok-alice" \
  -H "Content-Type: application/json" \
  -d '{"input":"continue"}'
```

Cancel a non-terminal Run:

```bash
curl -X POST http://127.0.0.1:3000/api/runs/run_123/cancel \
  -H "Authorization: Bearer tok-alice"
```

Retry a failed, cancelled or timed-out Run:

```bash
curl -X POST http://127.0.0.1:3000/api/runs/run_123/retry \
  -H "Authorization: Bearer tok-alice"
```

Retry creates a new Run id and returns `retryOf`. Completed Runs cannot be
retried.

## Health and metrics

| Method | Path | Authentication | Description |
| --- | --- | --- | --- |
| `GET` | `/healthz` | public | Process liveness and timestamp |
| `GET` | `/healthz/workers` | public | Active leases and queue depth |
| `GET` | `/metrics` | required | Prometheus metrics |

`/healthz/workers` returns `503` when the API was started without queue
dependencies. That means “reachable but not serving Runs,” not “host down.”

Metrics are protected because they reveal accumulated Run volume, duration,
failure and sandbox information.

## Rate limits

Default fixed windows:

- login: 10 requests per minute per source IP;
- Run creation: 30 requests per minute per owner and source IP.

Over-limit responses are `429` with `Retry-After`.

The counters are process-local. Multiple API processes multiply the effective
budget and do not share browser sessions. Configure `MERCURY_TRUST_PROXY`
correctly before placing the API behind a reverse proxy; see
[`configuration.md`](configuration.md).

## Error behavior

Expected domain errors:

- `400` — invalid input or unknown agent/skill;
- `401` — missing or invalid authentication;
- `404` — missing or foreign resource;
- `409` — lifecycle conflict, such as retrying a completed Run;
- `429` — rate limit exceeded.

Unexpected errors return a fixed `500 { "error": "internal error" }`. Internal
details stay in redacted server logs.

## Dashboard

The static dashboard is served at `/`:

- login exchanges a token for the session cookie;
- Run list supports creation, status filtering and periodic refresh;
- Run details show repository, agent, constraints, skills, timeline, messages,
  tool/test activity, commits, PR and errors;
- controls expose cancellation, retry and pending input;
- static assets are public, while every data request remains authenticated.

The dashboard is vanilla JavaScript with no build step.
