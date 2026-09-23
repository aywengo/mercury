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

### POST /api/auth/login

Exchange a configured API token for a session cookie.

```bash
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"token": "tok-alice"}'
```

Required body fields:

| Field | Type | Notes |
| --- | --- | --- |
| `token` | string | A configured API token (`MERCURY_API_TOKENS` or `MERCURY_ADMIN_TOKEN`) |

On success the response sets a `mercury_session` cookie (`HttpOnly; SameSite=Strict;
Max-Age=604800`) and returns a JSON body. The cookie carries only the session id; all
session data is stored server-side.

Responses:

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ ok: true, ownerId, isAdmin }` | Session created; cookie set |
| `401` | `{ error: "invalid token" }` | Token unknown, empty, or missing — the error does not distinguish these cases intentionally |

### POST /api/auth/logout

Delete the current session and clear the session cookie.

```bash
curl -X POST http://127.0.0.1:3000/api/auth/logout \
  -H "Cookie: mercury_session=<sid>"
```

Responses:

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ ok: true }` | Session deleted (if it existed) and cookie cleared (`Max-Age=0`). Returns `200` even when there was no session — logout is idempotent |

### GET /api/auth/me

Return the identity of the currently authenticated caller.

```bash
curl http://127.0.0.1:3000/api/auth/me \
  -H "Authorization: Bearer tok-alice"
```

Responses:

| Status | Body | Notes |
| --- | --- | --- |
| `200` | `{ ownerId, isAdmin }` | Caller is authenticated |
| `401` | `{ error: "authentication required" }` | No valid session cookie or Bearer token |

## Run endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/agents` | List registered agent ids and the create-Run default |
| `POST` | `/api/runs` | Create and durably queue a Run |
| `GET` | `/api/runs` | List visible Runs |
| `GET` | `/api/runs/:runId` | Return Run details and recorded skills |
| `POST` | `/api/runs/:runId/input` | Answer a pending input request |
| `POST` | `/api/runs/:runId/cancel` | Request cancellation |
| `POST` | `/api/runs/:runId/retry` | Create a new retry Run |
| `GET` | `/api/runs/:runId/events` | Page through durable event history |
| `GET` | `/api/runs/:runId/stream` | Stream backlog and new events over SSE |
| `GET` | `/api/runs/:runId/goal` | Return the Run's goal state |
| `POST` | `/api/runs/:runId/goal/cancel` | Cancel the Run's goal (operator drop) |

All endpoints in this table require authentication. Goal state is documented in
[goals.md](goals.md); the HTTP contract for the two goal routes is in
[Goal endpoints](#goal-endpoints) below.

## Preset endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/presets` | List browsable builtin roles |
| `GET` | `/api/presets/:presetId` | Inspect one role (instruction, skills, constraints, hash) |

Both require authentication and are available to every authenticated caller:
a preset is host configuration, not per-owner data (the same rule as
`/api/agents`).

`GET /api/presets` returns `{ presets: [...] }` with the short fields the
Roles page renders — `id`, `role`, `version`, `tags`, `description`,
`enabled`, `trust` and `contentHash`. Adding `?diagnostics=1` requires an
admin token and appends `invalid: [...]` with the per-preset validation
findings for preset directories that failed to load; invalid presets never
appear in the browsable list, and registry load failures are startup logs and
metrics ([role-presets.md](crew/role-presets.md) section 10), not Run events.

`GET /api/presets/:presetId` adds the instruction text, the agent preference,
the default/required skill lists, the constraint block and the preset-relative
source path. It never returns runtime secrets — a builtin manifest cannot
carry any (validation rejects unknown keys). An unknown id is a `404` naming
the preset; a preset whose files are invalid is a `400` carrying its findings.
Running a task with a role is `POST /api/runs` with a `preset: { id, version? }`
block ([role-presets.md](crew/role-presets.md) section 9); omitting the block
keeps the Run payload exactly as it was before presets existed.

## Knowledge endpoints

These endpoints are served only by processes that have `knowledgeStatus` or `knowledgeNotes`
wired in (typically the API process when Atlas is configured). A process that does not have the
surface wired answers `404` with a message that distinguishes "not on this process" from "not
found".

**Authentication:** all knowledge endpoints require an **admin token**
(`MERCURY_ADMIN_TOKEN`). An authenticated non-admin caller receives `403`, not `404`.

### GET /api/knowledge/status

Returns the state of this host's knowledge synchronisation.

```bash
curl http://127.0.0.1:3000/api/knowledge/status \
  -H "Authorization: Bearer admin-token"
```

Responses:

| Status | Meaning |
| --- | --- |
| `200` | JSON body with the current `KnowledgeStatus` snapshot |
| `403` | Authenticated but not an admin token |
| `404` | Knowledge status is not served by this process |

### POST /api/knowledge/notes

Submit an operator-authored note to the local outbox. The note goes into the durable outbox
and is delivered to Atlas by the next pusher pass. Because the note is durable but not yet
in Atlas, the response is `202`, not `201`.

```bash
curl -X POST http://127.0.0.1:3000/api/knowledge/notes \
  -H "Authorization: Bearer admin-token" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "convention",
    "scope": "project",
    "claim": "Every route returns JSON; no plain-text 200s.",
    "detail": "Confirmed by reading routes.ts end to end.",
    "evidence": []
  }'
```

Required body fields:

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | string | One of `fact`, `convention`, `pitfall`, `command`, `decision`, `artifact-pointer` |
| `scope` | string | A closed grammar, not a free-form path. Exactly one of: `project`; `repo:<16 hex>` naming a repository by its identity hash, optionally `repo:<16 hex>#<relative/path>` to narrow to a path inside it; or `agent:<id>` naming a harness by its registry slug. Anything else is refused with `reason: invalid-scope`. The path form must be relative and may not contain `..` |
| `claim` | string | The claim text; max `MERCURY_KNOWLEDGE_MAX_CLAIM_BYTES` (default 1024) bytes |

The `scope` value is checked before anything else about the note, and the common mistake is to write a
directory. `"scope": "src/api"` is refused with `invalid-scope`; `"scope": "project"` is not.

To scope a claim to one repository you need its identity hash: the first 16 hex characters of the SHA-256
of the normalized repository identity (`host[:port]/path`, with credentials, query and fragment dropped),
computed by `identityHash()` in `src/knowledge/identity.ts`. Append `#relative/path` to narrow within that
repository.

`mercury knowledge identity <url>...` prints the `repo:<hash>` scope key for a URL or local
path (`docs/knowledge-base.md` §5); `GET /api/runs/:id/knowledge` also returns notes with
their scopes verbatim.

Optional body fields:

| Field | Type | Notes |
| --- | --- | --- |
| `detail` | string | Supporting detail; max `MERCURY_KNOWLEDGE_MAX_DETAIL_BYTES` (default 4096) bytes |
| `evidence` | array | Evidence references; `decision` and `pitfall` kinds require at least one |
| `contradicts` | string[] | Claim hashes this note supersedes |
| `operatorOverride` | `{ rule, reason }` | Overrides a K2 rejection on this note (see below) |

Responses:

| Status | Meaning |
| --- | --- |
| `202` | Note accepted; `{ claimHash, queued }`. `queued: false` means an identical note was already waiting — still a success |
| `400` | Note refused: body did not pass validation. Includes `reason` |
| `403` | Authenticated but not an admin token |
| `404` | This process does not accept notes |
| `409` | Host cannot deliver notes: Atlas not configured (`MERCURY_ATLAS_URL` unset), or `MERCURY_ATLAS_ADMIN_TOKEN` is not set. The error message names the missing variable |

The `409` is a host misconfiguration, not a caller error. A note refused here is never queued;
it is not silently lost in an outbox that cannot drain.

#### K2 override

A claim that trips a K2 rule (`reason: k2-violation`, naming the rule) is refused. An operator
who has verified the note may resubmit it with `operatorOverride: { rule, reason }`, where
`rule` names the rule that was reported and `reason` is a non-empty justification of at most
`MERCURY_KNOWLEDGE_MAX_CLAIM_BYTES` bytes. The override skips only the K2 scan: bounds, closed
vocabularies and evidence requirements still apply, and a declared secret is refused no matter
what the override says. An override that names a rule other than the one that fired, or that
arrives with no note whose rule fired, is refused with `reason: invalid-override`. The recorded
override travels with the note to Atlas and is visible on the note there (`operatorOverride` on
the note and in its revision history), so a reader can see both the violation and the
justification. Only an operator note can carry one: an agent cannot override K2 from
`.mercury/notes.jsonl`, and an `agent-reported` contribution carrying the field is refused.

### GET /api/runs/:runId/knowledge

Returns the knowledge pack the Run was created with.

```bash
curl http://127.0.0.1:3000/api/runs/run_123/knowledge \
  -H "Authorization: Bearer tok-alice"
```

Owner-scoped by the same access check as every other Run read. A caller who cannot see the Run
cannot read its pack.

Responses:

| Status | Meaning |
| --- | --- |
| `200` | `{ knowledge }` — the pack snapshot |
| `404` | Run not found (or belongs to another owner), or the Run was created without a knowledge pack |

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

Omitting `agent` selects `MERCURY_DEFAULT_AGENT` (default `fake`). Send an
explicit id such as `"agent": "primeagent"` for a real coding Run. `GET
/api/agents` returns `{ "agents": ["fake", "primeagent", ...], "defaultAgent": "fake" }`.

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

The response contains `{ run, skills, goal, knowledge }` — workspace, constraints,
terminal artifacts and serialized skill records, plus the goal state as a sibling of `run`
(`null` when the Run has no goal) and the knowledge pack snapshot (`null` when created
without one).

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

## Goal endpoints

A Run may carry a goal: the objective it was created with, tracked as a **sibling** of the
Run status (never a field on the Run). Semantics, status vocabulary and the validation rules
for `goal` on Run creation are specified in [goals.md](goals.md) §4 and §8; this section is
the HTTP contract.

**Authentication:** both routes require authentication and are owner-scoped by the same
access check as every other Run read. An admin caller can act on any visible Run.

### GET /api/runs/:runId/goal

```bash
curl http://127.0.0.1:3000/api/runs/run_123/goal \
  -H "Authorization: Bearer tok-alice"
```

Responses:

| Status | Meaning |
| --- | --- |
| `200` | `{ goal }` — the current `GoalState` (status, objective, contract, gates, budget usage) |
| `404` | Run not found (or belongs to another owner), or the Run has no goal |

`GET /api/runs/:runId` also returns the goal as a sibling of `run`, and `GET /api/runs`
returns a parallel `goals` map keyed by run id — those are the reads a renderer should use,
because they can show a Run status next to a goal status. The dedicated route exists for
callers that need only the goal.

### POST /api/runs/:runId/goal/cancel

Operator drop: cancels the goal without touching the Run. Cancel is the only goal mutation
and the only writer of the `cancelled` status; there is deliberately no route that can set a
goal status, an objective, or a `complete` verdict (goals.md §12).

```bash
curl -X POST http://127.0.0.1:3000/api/runs/run_123/goal/cancel \
  -H "Authorization: Bearer tok-alice"
```

Responses:

| Status | Meaning |
| --- | --- |
| `200` | `{ goal }` — the updated `GoalState` with status `cancelled` |
| `404` | Run not found (or belongs to another owner), or the Run has no goal |
| `409` | The goal already carries a terminal verdict (`complete`, `cancelled` or `unmet`); a verdict is never overwritten by a no-op |
| `400` | Goals are not enabled on this server |

A `409` matters because `complete` and `unmet` are verdicts: cancelling a goal that already
completed would erase the record the feature exists to keep.

## Health and metrics

| Method | Path | Authentication | Description |
| --- | --- | --- | --- |
| `GET` | `/healthz` | public | Process liveness, product id and version |
| `GET` | `/healthz/workers` | public | Active leases and queue depth |
| `GET` | `/metrics` | required | Prometheus metrics |

`GET /healthz` is unauthenticated and returns:

```json
{ "ok": true, "ts": "2026-09-05T12:00:00.000Z", "product": "host", "version": "0.1.0" }
```

`product` is always `host` on this process. `version` is the running build's SemVer, taken from
`package.json` / `HOST_VERSION`, so the value above is a sample and not a promise about what a given
server reports. This is not a capabilities API.

`/healthz/workers` returns `503` when the API was started without queue
dependencies. That means “reachable but not serving Runs,” not “host down.”
It does not include a version field.

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
