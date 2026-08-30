# AGENTS.md — mercury

Mercury is the durable orchestration layer for long-running PrimeAgent coding Runs.
Architecture and full spec: [`ARCHITECTURE.md`](ARCHITECTURE.md). This file is the short operating guide.

## What this is

- **Runs are the unit of work**, not HTTP requests or chat messages. Everything (state, events,
  workspace, skills) hangs off a `runId`.
- The API (Express) creates/serves Runs. A separate **Worker** process claims Runs from a
  SQLite-backed queue, builds an isolated workspace, and drives an **AgentAdapter**.
- Agents speak a translation layer: raw agent output becomes structured, persisted Mercury events
  with monotonic per-Run sequences. The UI never reads raw stdout.

## Commands

```bash
npm test            # node --test over test/*.test.ts (no real PrimeAgent needed; fake + mock RPC)
npm run typecheck   # tsc --noEmit
npm run migrate     # apply/verify SQLite migrations (Mercury: `node src/cli.ts migrate`)
npm run dev         # API; also runs the embedded worker when MERCURY_EMBEDDED_WORKER=true
npm run server      # API only (production: run `worker` separately)
npm run worker      # worker only
node src/cli.ts gc  # one workspace retention/quota GC pass
```

Environment: everything is `MERCURY_*` in `src/config.ts`. Defaults are safe (bind `127.0.0.1`,
git-worktree workspaces, `prime-agent --mode rpc`).

## Layout

| Path | Owns |
| --- | --- |
| `src/domain/` | Run/event types, state machine, secret redaction — no I/O |
| `src/runs/` | Run persistence (`RunStore`) and lifecycle operations (`RunService`) |
| `src/events/` | Event persistence + sequence, SSE fan-out |
| `src/queue/` | SQLite queue, leases, expiry/requeue |
| `src/worker/` | Claim → workspace → adapter → drive loop (input/cancel/timeout) → finalize |
| `src/adapters/` | `AgentAdapter` interface, `PrimeAgentAdapter` (RPC), `DaemonAgentAdapter`, `FakeAgentAdapter` |
| `src/workspace/` | Git-worktree/copy isolation + retention/quota GC |
| `src/sandbox/` | Container (docker/podman) resource/network limits; fail-closed |
| `src/api/` | Routes, auth (token/cookie), sessions, rate limiting |
| `src/skills/` | Filesystem skill registry + deterministic auto-selection |
| `.agents/skills/` | The skill library (one `SKILL.md` per skill; no credentials) |
| `ui/` | Static dashboard SPA (list, details, SSE timeline, cancel/retry/input) |
| `deploy/` | systemd units, backup script, logrotate, ops guide |

## Boundaries (do not cross)

- **Mercury ≠ PrimeAgent logic.** No PrimeAgent-specific behavior outside `src/adapters/`.
  New agent backends = new `AgentAdapter` implementation.
- **The web server must not execute agents** except in explicit dev mode.
- **State transitions** go through `RunStore.transition` (validates the §6 state machine).
  Terminal runs are never re-executed; retry = new Run with `retryOf`.
- **Events** are appended via `EventStore.append` (single-writer sequence). Never write the
  `events` table directly.
- **Skills** are guidance, not enforced phases. `skill.started/completed` are agent-reported.
- **`repository` is the primary repo; `repositories[]` are extras** cloned under
  `workspace/repos/`. The workspace manager skips the primary when attaching extras.

## Testing

- `FakeAgentAdapter` drives normal tests (scripted events, input, fail, delay). No network, no LLM.
- `test/fixtures/mock-prime-agent-rpc.mjs` speaks the real RPC JSONL protocol for
  `PrimeAgentAdapter` tests (env knobs: `MOCK_RPC_MODE`, `MOCK_RPC_ARGV_FILE`, `MOCK_RPC_ENV_FILE`,
  `MOCK_RPC_SESSION_FILE`, `MOCK_RPC_LOG`).
- Timing-sensitive tests (cancel, input timeout, stuck runs) use generous margins; if a test
  flakes, widen the window rather than adding sleeps in production code.
- `test/helpers.ts::makeEnv` builds an isolated temp-dir env (own SQLite, fake worker). Close it
  in `finally`.

## Common mistakes

- Assuming `run.repositories` includes the primary — it does not; `run.repository` is primary.
- Forgetting a Run may already be terminal when an API call lands (cancel/retry must 400, not crash).
- Letting the claim loop do periodic work that must run *while* a Run executes (use its own timer,
  like the stuck-run check does).
- Adding a Run API without owner-scoping (non-admin callers see only their Runs; 404, not 403).
- Committing real secrets: events/logs pass through the redactor, and skills must not contain
  credentials.
