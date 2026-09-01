# Agent Adapters — Roadmap & Design

How Mercury drives other coding agents, and the design for the generic
`LocalAgentAdapter` and `RemoteAgentAdapter`.

Spec context: [ARCHITECTURE.md](../ARCHITECTURE.md) §8 (Agent Adapter), §9 (Run Context),
§14 (events), §16 (durable execution), §29 (testing).

---

## 1. The contract (recap)

Every agent backend implements the same interface:

```ts
interface AgentAdapter {
  start(context: RunContext): Promise<AgentHandle>;
  sendInput(runId: string, input: AgentInput): Promise<void>;
  cancel(runId: string): Promise<void>;
  resume?(runId: string): Promise<void>;   // optional
}

interface AgentHandle {
  runId: string;
  events: AsyncIterable<AgentEvent>;   // raw agent output → translated to Hermes events
  exit: Promise<AgentExit>;            // resolves when the agent process finishes
  terminate(): Promise<void>;          // forceful kill, last resort
}
```

The worker only ever talks to `AgentAdapter`. Adding an agent = adding one class
+ one mock fixture + tests. Nothing else changes.

**Event translation** is the hard part. The worker consumes `AgentEvent`s and
persists them as Hermes events (`tool.started`, `agent.message`, `input.required`,
`git.commit`, …). The fidelity of the translation depends on what the agent's
interface exposes:

| Fidelity | What you get | Agents |
| --- | --- | --- |
| **Native structured** | typed event stream (tool calls, messages, errors) | PrimeAgent (RPC), Codex (`--json`), Claude (`stream-json`), Gemini (`stream-json`) |
| **Text + session** | final answer + session id; parse stdout for progress | Hermes Agent (`-Q`), Aider (`--json` has some) |
| **Remote API** | HTTP endpoints, polling/webhooks | Devin, Copilot coding agent, OpenHands server |

---

## 2. Integration patterns

Three patterns cover every agent we care about:

### Pattern A — Spawn CLI, structured stdout (recommended for local CLIs)

```
worker → spawn <agent> <non-interactive flags> → parse JSONL/JSON stdout → AgentEvent stream
```

- **Pros**: no SDK dependency, process isolation, works with the existing sandbox.
- **Cons**: CLI flags drift between versions; stdout parsing is brittle.
- **Used by**: Codex, Claude Code, Gemini, Aider.

### Pattern B — Native RPC / daemon protocol

```
worker → spawn <agent> --mode rpc (or socket) → typed protocol → AgentEvent stream
```

- **Pros**: designed for machine-to-machine; highest fidelity; session resume.
- **Cons**: only exists where the vendor built it; protocol versions drift between
  vendors (mitigated by the generic `RpcAgentAdapter`, Phase 10).
- **Used by**: PrimeAgent (RPC + daemon), Pi Agent (`pi --mode rpc`), Oh my Pi
  (`omp --mode rpc`), and any future RPC-protocol agent.
- **Caveat**: the daemon half of this pattern is currently broken against the real
  PrimeAgent daemon — the adapter and its mock agree on a protocol the daemon does not
  speak. Verified against PrimeAgent 0.8.1 (daemon protocol v7) in
  [`daemon-agent-sessions.md`](daemon-agent-sessions.md), which also documents the real
  supervisor/worker topology and the correct JSONL command envelope. RPC mode is unaffected.

### Pattern C — Remote HTTP API

```
worker → POST /tasks → poll GET /tasks/:id (or webhook) → AgentEvent stream
```

- **Pros**: no local install, cloud-scale, no sandbox needed.
- **Cons**: network dependency, latency, cost, vendor API drift, credentials.
- **Used by**: Devin, Copilot coding agent, OpenHands (server mode).

---

## 3. Roadmap

Priority order. Each item is independently shippable; all follow the same
template (adapter + mock fixture + tests + docs).

**New:** Phase 10 (`RpcAgentAdapter`) — generic adapter for the RPC JSONL
protocol family (PrimeAgent, Pi Agent, Oh my Pi). High priority: reuses the
existing RPC machinery, one adapter yields three backends. ✅ implemented.

**Worker leftovers (rows 11-12 in §9):** ✅ done — `adapter.resume()` is wired
into the retry path (with `run.resuming` events and a `resume?(runId, context?)`
contract returning a handle), and cancellation is raced into the drive loop so
hanging agents can be cancelled promptly (E2E: 0.3s vs the previous timeout).
Details in §7 "Known gaps".

### Phase 1 — CodexAdapter (OpenAI Codex CLI) — *high priority*

**Interface (verified):**

```bash
codex exec "<task>" --json                 # JSONL event stream on stdout
codex exec --sandbox workspace-write "<task>"   # least-privilege sandbox
codex exec resume <SESSION_ID>             # resume a session
codex exec resume --last "<task>"          # resume most recent
codex exec --skip-git-repo-check           # allow non-git dirs (we always have a repo)
codex exec --model <model>                 # model override
```

**Event mapping** (`--json` emits JSONL):

| Codex event | Hermes event |
| --- | --- |
| `thread.started` | `run.started` |
| `turn.started` | `step.started` |
| `item.*` (agent message) | `agent.message` |
| `item.*` (command execution) | `tool.started` / `tool.completed` |
| `item.*` (file change) | `git.changed` |
| `item.*` (MCP tool call) | `tool.started` / `tool.completed` |
| `turn.completed` | `step.completed` |
| `turn.failed` / `error` | `error` |
| process exit 0 | `run.completed` |

**Notes:**
- Requires a git repo (we always provide one via the workspace).
- Sandbox: map `RunConstraints.resourceLimits` → `--sandbox` policy
  (`workspace-write` default, `danger-full-access` only when the Run requests it).
- Approval: Codex asks for approval in interactive mode; in `exec` it uses the
  sandbox policy. Map `input.required` → approval prompts if surfaced.
- Resume: `codex exec resume <SESSION_ID>`; persist the session id from the
  `thread.started` event.

**Effort:** M (adapter + translator + mock fixture + ~8 tests).

### Phase 2 — ClaudeCodeAdapter (Anthropic Claude Code) — *high priority*

**Interface (verified locally):**

```bash
claude -p "<task>" --output-format stream-json   # JSONL event stream
claude -p --input-format stream-json             # stream input (for sendInput)
claude --resume <session_id>                     # resume
claude --session-id <uuid>                       # pin session id
claude --permission-mode <mode>                  # acceptEdits | auto | bypassPermissions | ...
claude --allowedTools "Bash(git *) Edit"         # tool allowlist
claude --include-partial-messages                # partial message chunks
claude --max-turns <n>                           # turn budget
claude --mcp-config <json>                       # MCP servers
claude --model <model>                           # model override
```

**Event mapping** (`stream-json` emits JSONL):

| Claude event | Hermes event |
| --- | --- |
| `system` (init) | `run.started` |
| `assistant` (message) | `agent.message` |
| `assistant` (tool_use) | `tool.started` |
| `user` (tool_result) | `tool.completed` / `tool.failed` |
| `user` (is_error) | `tool.failed` |
| `result` (final) | `run.completed` |
| `stream_event` (error) | `error` |

**Notes:**
- `--permission-mode` is the human-in-the-loop knob: `acceptEdits`/`auto` for
  unattended runs, `bypassPermissions` only inside the sandbox.
- `--allowedTools` maps from `RunContext.skills` capabilities (e.g. git-pr →
  `Bash(git *)`).
- Human input: Claude's permission prompts surface as `user` events with
  `is_error`/permission payloads → translate to `input.required`.
- Resume: `--resume <session_id>`; session id comes from the `system` init event.
- `--include-partial-messages` gives streaming text deltas → richer `agent.message`.

**Effort:** M (same template as Codex).

### Phase 3 — HermesAgentAdapter (Nous Research Hermes Agent) — ✅ **implemented**

**Implementation:** `src/adapters/hermesAgentAdapter.ts` (adapter),
`test/hermesAgentAdapter.test.ts` (10 tests), `test/fixtures/mock-hermes-agent.mjs`
(mock CLI). Wired into `cli.ts` as agent id `hermes` (`MERCURY_HERMES_CMD`,
`MERCURY_HERMES_ARGS`, `MERCURY_HERMES_MAX_TURNS`, `MERCURY_HERMES_RUN_BUDGET_SECONDS`,
`MERCURY_HERMES_YOLO`, `MERCURY_HERMES_ACCEPT_HOOKS`).

**Interface (verified locally):**

```bash
hermes chat -q "<task>"                 # single query, non-interactive
hermes chat --query-file -              # stdin (safe for arbitrary text)
hermes chat -Q                          # quiet: suppress banner/spinner, final answer + session info only
hermes chat --resume <SESSION_ID>       # resume
hermes chat --max-turns <n>             # turn budget
hermes chat --run-budget <seconds>      # wall-clock budget
hermes chat -s <skill>                  # preload skills
hermes chat --in <dir>                  # working directory
hermes chat --worktree                  # git worktree isolation (native!)
hermes chat --yolo                      # skip confirmations
hermes chat --accept-hooks              # accept hook prompts
```

**Event mapping** (text output, `-Q` — verified against hermes v0.20.5 source):

| Hermes output | Hermes event |
| --- | --- |
| final response (stdout, quiet mode guarantees only this) | `agent.message` |
| `session_id: <id>` (stderr, printed on exit) | persisted for `resume` |
| exit code 0 | `run.completed` |
| exit code != 0 | `run.failed` |

The session id goes to **stderr** (`cli.py` prints `\nsession_id: <id>` on exit),
not stdout — the adapter captures it from stderr. `--query-file -` passes the task
via stdin (nothing shell-interpreted).

**Notes:**
- **Fidelity is text-level**, not tool-level: no structured event stream in
  `-Q` mode. First version = `agent.message` + completion. Tool-level fidelity
  requires their Python library or REST endpoints (see Phase 7).
- `--query-file -` is the safe way to pass the task (nothing shell-interpreted).
- `--worktree` gives native git isolation — but we already isolate via the
  workspace; keep `--in <workspace>` and let Mercury own isolation.
- Human input: Hermes has `--yolo`/`--accept-hooks`; a real `input.required`
  bridge needs their approval/hook surface — defer to Phase 7.
- Resume: `--resume <SESSION_ID>`; capture the id from `-Q` output.

**Effort:** S–M (adapter + text parser + mock fixture + ~6 tests).

### Phase 4 — GeminiAdapter (Google Gemini CLI) — *medium priority*

**Interface (verified):**

```bash
gemini -p "<task>" --output-format stream-json   # JSONL event stream
gemini -p --output-format json                   # single JSON result
gemini --resume <session_id>                     # resume (checkpointing)
gemini --continue                                # continue most recent
gemini --tools <tools>                           # tool selection
gemini --mcp <config>                            # MCP servers
gemini -m <model>                                # model override
```

**Event mapping** (`stream-json`): same shape as Claude — `assistant`/`user`
message events, tool calls, final result. Map like ClaudeCodeAdapter.

**Effort:** M (near-copy of ClaudeCodeAdapter).

### Phase 5 — AiderAdapter (Aider) — *low priority*

**Interface (well-known):**

```bash
aider --message "<task>" --yes-always     # non-interactive, auto-confirm
aider --json                              # JSON output
aider --message-file <file>               # task from file
aider --model <model>                     # model override
aider --git                              # git integration (native)
```

**Notes:**
- Aider is git-native and edits files directly in the repo — it pairs naturally
  with our git-worktree isolation.
- `--json` gives structured output but is coarser than Codex/Claude.
- Human input: `--yes-always` skips confirmations; map to `input.required` only
  if we want interactive mode (defer).

**Effort:** S–M.

### Phase 6 — LocalAgentAdapter (generic local CLI) — ✅ **implemented**

The "bring your own agent" adapter: any local CLI that can run non-interactively
becomes a Mercury agent via a declarative config. **Design in §4; implementation in
`src/adapters/localAgentAdapter.ts` + `src/adapters/localAgentRegistry.ts`.**

### Phase 7 — RemoteAgentAdapter (generic remote API) — ✅ **implemented**

The "cloud agent" adapter: Devin, Copilot coding agent, OpenHands server, or any
HTTP agent API. **Design in §5; implementation in
`src/adapters/remoteAgentAdapter.ts` + `src/adapters/remoteAgentRegistry.ts`.**

### Phase 8 — OpenHandsAdapter (concrete RemoteAgentAdapter) — *low priority*

OpenHands exposes a REST API + event stream (`/api/sessions`, `/api/sessions/:id/events`).
Implement as a thin config on top of RemoteAgentAdapter.

### Phase 9 — DevinAdapter (concrete RemoteAgentAdapter) — *low priority*

Devin's API: create session → poll status → fetch events; webhooks for
completion. Implement as a RemoteAgentAdapter config. Requires a Devin API key
(credential scoping: `MERCURY_DEVIN_API_KEY` via secret manager, never in events).

### Phase 10 — RpcAgentAdapter (generic RPC protocol) — ✅ **implemented**

The "bring your own RPC agent" adapter: any CLI that speaks the RPC JSONL
protocol family (PrimeAgent, Pi Agent, Oh my Pi, …) becomes a Mercury agent via
a declarative config — no per-agent code. **Design in §6.**

**Why now:** Pi Agent (`pi --mode rpc`) and Oh my Pi (`omp --mode rpc`) are both
forks of the same harness family as PrimeAgent and speak the **same protocol
vocabulary** Mercury already implements (`prompt`/`abort`/`set_model` commands;
`agent_start`/`agent_end`/`turn_start`/`turn_end`/`message_update`/`message_end`/
`tool_execution_start`/`tool_execution_end`/`extension_ui_request` events; strict
JSONL framing). Verified against pi.dev/docs, omp.sh/docs, and the prime-agent
`docs/rpc.md` — the three docs describe the same protocol. One generic adapter
yields three backends (primeagent, pi, omp) plus any future RPC agent.

**Effort:** M (adapter + config schema + mock fixture reuse + ~10 tests).

---

## 4. LocalAgentAdapter — design (implemented)

A generic adapter for **any local CLI agent** that can run non-interactively.
No per-agent code: everything is declarative config.

**Implementation status:** `src/adapters/localAgentAdapter.ts` (adapter),
`src/adapters/localAgentRegistry.ts` (config loader), `test/localAgentAdapter.test.ts`
(22 tests), `test/fixtures/mock-local-agent.mjs` (generic mock fixture).
Config files are **JSON** (zero dependencies); the YAML examples below are the same
structure. Loaded from `MERCURY_LOCAL_AGENTS_DIR` (default `./local-agents`), one
`.json` file per agent. `eventMap` accepts **any** agent event type as a key
(index signature), so snake_case/kebab-case agent types map directly.

### 4.1 Config schema

```ts
interface LocalAgentConfig {
  id: string;                    // e.g. "aider", "my-custom-agent"
  description: string;

  // how to spawn
  command: string;               // binary path or name
  args: string[];                // static args
  cwd: string;                   // workspace root (usually the Run workspace)

  // how the task is passed
  taskInput: {
    mode: 'arg' | 'stdin' | 'file';
    flag?: string;               // for 'arg': "--message"; for 'file': "--message-file"
    filePath?: string;           // for 'file': relative path in workspace
  };

  // how output is produced
  output: {
    format: 'jsonl' | 'json' | 'text';
    stream?: boolean;            // jsonl: parse line-by-line; json: single doc at end
    eventPath?: string;          // jsonl: JSON pointer to the event type field, e.g. "type"
  };

  // how to map agent events → Hermes events
  eventMap: {
    started?: string;            // agent event type → Hermes event type
    message?: string;
    toolStarted?: string;
    toolCompleted?: string;
    toolFailed?: string;
    stepStarted?: string;
    stepCompleted?: string;
    error?: string;
    completed?: string;          // agent event that means "done"
  };

  // human input
  input?: {
    mode: 'stdin' | 'flag' | 'prompt-file';
    flag?: string;               // e.g. "--answer"
    promptEvent?: string;        // agent event type that means "waiting for input"
  };

  // cancellation
  cancel: {
    signal: 'SIGTERM' | 'SIGINT' | 'stdin';
    graceMs: number;             // before SIGKILL
  };

  // session resume
  resume?: {
    flag: string;                // e.g. "--resume"
    sessionIdSource: 'stdout' | 'file' | 'event';
    sessionIdPath?: string;      // JSON pointer or regex capture
  };

  // sandbox mapping
  sandbox?: {
    policyFlag?: string;         // e.g. "--sandbox"
    policyValue?: string;        // e.g. "workspace-write"
  };
}
```

### 4.2 Runtime behavior

```
start(context):
  1. build argv: [command, ...args, taskFlag(task), ...(skills → tool flags)]
  2. spawn with cwd = workspace, env = { MERCURY_RUN_ID, MERCURY_TRACE_ID, MERCURY_WORKER_ID, ... }
  3. attach stdout parser per output.format:
       jsonl  → line reader → JSON.parse → eventMap lookup → push AgentEvent
       json   → accumulate → parse at exit → map
       text   → line reader → regex/prefix heuristics → agent.message
  4. if output.format is jsonl/json and eventMap.completed seen → resolve exit 0
  5. return AgentHandle { events, exit, terminate }

sendInput(runId, input):
  - stdin mode: write JSON/text to child stdin
  - flag mode: restart with flag (only if agent supports it)

cancel(runId):
  - send cancel.signal, wait graceMs, then SIGKILL

resume?(runId):
  - if resume.flag set: respawn with [flag, sessionId] where sessionId was
    captured from the previous run (stdout/event/file)
```

> **Note:** the worker emits `run.started` itself, so mapping `started → run.started`
> in `eventMap` duplicates it. Prefer `step.started` (or omit the mapping).
> Flag-mode input: the agent exits after asking; `sendInput` waits for the exit,
> then respawns with the answer flag (bounded wait, stdin fallback).

### 4.3 Example configs

```yaml
# aider as a LocalAgentAdapter
id: aider
command: aider
args: ["--yes-always"]
taskInput: { mode: "arg", flag: "--message" }
output: { format: "json", stream: false }
eventMap:
  message: "agent.message"
  completed: "result"
cancel: { signal: "SIGTERM", graceMs: 5000 }
```

```yaml
# a hypothetical "my-agent" that emits JSONL
id: my-agent
command: my-agent
args: []
taskInput: { mode: "stdin" }
output: { format: "jsonl", stream: true, eventPath: "type" }
eventMap:
  started: "run.started"
  message: "agent.message"
  toolStarted: "tool.started"
  toolCompleted: "tool.completed"
  toolFailed: "tool.failed"
  completed: "done"
input: { mode: "stdin", promptEvent: "ask" }
cancel: { signal: "SIGTERM", graceMs: 3000 }
resume: { flag: "--resume", sessionIdSource: "event", sessionIdPath: "session_id" }
```

### 4.4 Testing (implemented)

- Mock fixture: `test/fixtures/mock-local-agent.mjs` — one generic fixture driven
  by env vars (`MOCK_LOCAL_MODE`: happy/input/input-flag/fail/hang/json/text/resume,
  plus `MOCK_LOCAL_ARGV_FILE`/`MOCK_LOCAL_ENV_FILE`/`MOCK_LOCAL_SESSION_FILE`).
- Tests (`test/localAgentAdapter.test.ts`, 22): happy path, event mapping,
  argv/env construction (task flag, skills flags, sandbox policy flags), task via
  stdin/file, input round-trip (stdin/flag/prompt-file), cancel (SIGTERM/stdin),
  spawn failure, agent failure, terminate, json/text output, resume (event/stdout
  sources), config validation, registry loading.
- **No real agent required in tests** (ARCHITECTURE.md §29).

---

## 5. RemoteAgentAdapter — design (implemented)

A generic adapter for **cloud/SaaS agents** exposed over HTTP. No local install,
no sandbox needed (the vendor runs it), but network + credentials required.

**Implementation status:** `src/adapters/remoteAgentAdapter.ts` (adapter),
`src/adapters/remoteAgentRegistry.ts` (config loader), `test/remoteAgentAdapter.test.ts`
(18 tests), `test/fixtures/mock-remote-agent.mjs` (generic mock HTTP server).
Config files are **JSON** (zero dependencies); the YAML examples below are the same
structure. Loaded from `MERCURY_REMOTE_AGENTS_DIR` (default `./remote-agents`), one
`.json` file per agent. Credentials come from `api.auth.envVar` and are only used
in request headers/query — never in events, logs, or Run records.

### 5.1 Config schema

```ts
interface RemoteAgentConfig {
  id: string;                    // e.g. "devin", "copilot-coding-agent"
  description: string;

  // HTTP API shape
  api: {
    baseUrl: string;             // e.g. "https://api.devin.ai/v1"
    auth: {
      type: 'bearer' | 'header' | 'query';
      headerName?: string;       // e.g. "Authorization"
      envVar: string;            // e.g. "MERCURY_DEVIN_API_KEY" — credential source
    };
    createTask: {
      method: 'POST';
      path: string;              // e.g. "/sessions"
      body: Record<string, unknown>;  // template; {task} and {workspace} placeholders
      idField: string;           // response field with the task id
    };
    getTask: {
      method: 'GET';
      path: string;              // e.g. "/sessions/{id}"
      statusField: string;       // e.g. "status"
      statusMap: Record<string, 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>;
    };
    events?: {
      method: 'GET';
      path: string;              // e.g. "/sessions/{id}/events"
      eventField: string;        // array field
      eventTypeField: string;    // per-event type field
    };
    sendInput?: {
      method: 'POST';
      path: string;              // e.g. "/sessions/{id}/messages"
      body: Record<string, unknown>;
    };
    cancel?: {
      method: 'POST';
      path: string;              // e.g. "/sessions/{id}/cancel"
    };
  };

  // polling
  poll: {
    intervalMs: number;          // default 5000
    timeoutMs: number;           // default = RunConstraints.maxDurationMs
  };

  // webhook (optional, preferred over polling)
  webhook?: {
    path: string;                // Mercury endpoint that receives vendor webhooks
    secretEnvVar: string;        // shared secret for signature verification
  };

  // event mapping (same shape as LocalAgentAdapter.eventMap)
  eventMap: Record<string, string>;
}
```

### 5.2 Runtime behavior

```
start(context):
  1. resolve credentials from api.auth.envVar (never log them; redactor covers events)
  2. POST createTask with {task, workspace info, skills} → taskId
  3. emit run.started
  4. loop:
       - GET getTask → status
       - if events endpoint: GET events (since last seq) → map → push AgentEvent
       - if status terminal → resolve exit
       - sleep poll.intervalMs
     (or: register webhook, then just listen)
  5. return AgentHandle { events, exit, terminate }

sendInput(runId, input):  POST sendInput with the input payload
cancel(runId):            POST cancel; if that fails, mark cancelled locally
resume?(runId):           if the vendor supports it (e.g. Devin sessions persist),
                          re-attach to the existing taskId instead of creating a new one
```

> **Notes:** the worker emits `run.started` itself, so the adapter does not emit it.
> Events are deduplicated by count (fetch all, emit new ones); `{id}` in endpoint
> paths and `{task}`/`{workspace}`/`{input}` in bodies are templated. `idField` and
> `statusField` support dot paths (e.g. `session.id`). Missing credential env var
> fails `start()` (infrastructure kind → auto-retry). Transient API errors during
> polling are retried until the poll deadline; `poll.timeoutMs` → exit reason
> `timeout`.

### 5.3 Credential & security rules

- Credentials come from `api.auth.envVar` (secret manager / env), **never** from
  Run records, events, logs, or browser responses (ARCHITECTURE.md §24).
- The workspace never contains platform-wide credentials — only the scoped
  vendor token for the target repository.
- Webhook endpoints verify the shared secret before accepting events.

### 5.4 Example configs

```yaml
# Devin
id: devin
api:
  baseUrl: "https://api.devin.ai/v1"
  auth: { type: "bearer", headerName: "Authorization", envVar: "MERCURY_DEVIN_API_KEY" }
  createTask: { method: "POST", path: "/sessions", body: { prompt: "{task}", repository: "{workspace}" }, idField: "session.id" }
  getTask: { method: "GET", path: "/sessions/{id}", statusField: "status", statusMap: { running: "running", blocked: "running", success: "completed", error: "failed", cancelled: "cancelled" } }
  events: { method: "GET", path: "/sessions/{id}/events", eventField: "events", eventTypeField: "type" }
  sendInput: { method: "POST", path: "/sessions/{id}/messages", body: { message: "{input}" } }
  cancel: { method: "POST", path: "/sessions/{id}/cancel" }
poll: { intervalMs: 5000 }
eventMap:
  message: "agent.message"
  tool_started: "tool.started"
  tool_completed: "tool.completed"
  error: "error"
```

```yaml
# OpenHands (server mode)
id: openhands
api:
  baseUrl: "http://localhost:3000"
  auth: { type: "header", headerName: "X-API-Key", envVar: "MERCURY_OPENHANDS_API_KEY" }
  createTask: { method: "POST", path: "/api/sessions", body: { prompt: "{task}" }, idField: "session_id" }
  getTask: { method: "GET", path: "/api/sessions/{id}", statusField: "status", statusMap: { running: "running", stopped: "completed", error: "failed" } }
  events: { method: "GET", path: "/api/sessions/{id}/events", eventField: "events", eventTypeField: "type" }
poll: { intervalMs: 2000 }
eventMap:
  agent_message: "agent.message"
  tool_call: "tool.started"
  tool_result: "tool.completed"
```

### 5.5 Testing (implemented)

- Mock HTTP server fixture: `test/fixtures/mock-remote-agent.mjs` — a node:http
  server implementing the Devin-style API shape, driven by env vars
  (`MOCK_REMOTE_MODE`: happy/input/fail/hang/api-fail, plus request log, auth
  enforcement, session/input/cancel capture files).
- Tests (`test/remoteAgentAdapter.test.ts`, 18): create → poll → complete, event
  mapping, body templating, auth header presence, missing credential, credential
  redaction, input round-trip, cancel (with/without endpoint), terminate, agent
  failure, poll timeout, transient API failure, resume (no duplicate task),
  config validation, registry loading.
- Webhook signature verification is deferred (the adapter polls; webhooks are a
  future optimization).

---

## 6. RpcAgentAdapter — design (implemented)

A generic adapter for **any CLI agent that speaks the RPC JSONL protocol
family** (PrimeAgent, Pi Agent, Oh my Pi, …). No per-agent code: everything is
declarative config. Reuses Mercury's existing RPC machinery (`rpcClient.ts` +
`eventTranslation.ts`) — the protocol is already implemented and tested.

**Implementation status:** `src/adapters/rpcAgentAdapter.ts` (adapter +
`validateRpcAgentConfig`), `src/adapters/rpcAgentRegistry.ts` (config loader),
`test/rpcAgentAdapter.test.ts` (18 tests), `test/fixtures/mock-prime-agent-rpc.mjs`
(reused; `MOCK_RPC_VENDOR_EXTRAS=1` emits omp-style `ready`/`negotiate_protocol`
frames to prove they are ignored). Config files are **JSON** (zero dependencies),
loaded from `MERCURY_RPC_AGENTS_DIR` (default `./rpc-agents`), one file per agent.
Example configs: `rpc-agents/pi.json`, `rpc-agents/omp.json`. Wired into `cli.ts`
alongside the built-in `primeagent` id.

### 6.1 Why a generic adapter (not per-agent classes)

Pi, omp, and prime-agent are forks of the same harness family. Their RPC
protocols are the same vocabulary (verified against pi.dev/docs, omp.sh/docs,
and prime-agent `docs/rpc.md`):

| Surface | prime-agent | pi | omp |
| --- | --- | --- | --- |
| Entry | `prime-agent --mode rpc` | `pi --mode rpc` | `omp --mode rpc` |
| Commands | `prompt`, `abort`, `set_model`, `get_state`, `new_session` | same | same + `negotiate_protocol` (v2) |
| Events | `agent_start/end`, `turn_start/end`, `message_update/end`, `tool_execution_start/end`, `extension_ui_request` | same | same + `subagent_lifecycle`, `host_tool_call` |
| Framing | strict JSONL, LF-only | same | same (v1) / lossless chunks (v2) |

Mercury's `RpcClient` already dispatches **any** non-response record to
listeners, and `EventTranslator` ignores unknown types — so vendor extras
(`negotiate_protocol`, `subagent_lifecycle`, `host_tool_call`, `ready` frames)
are safely ignored today and can be mapped later. The generic adapter is a thin
config layer over this existing machinery.

### 6.2 Config schema

```ts
interface RpcAgentConfig {
  id: string;                    // e.g. "pi", "omp", "primeagent"
  description: string;

  // how to spawn
  command: string;               // binary path or name
  args?: string[];               // static args appended after --mode rpc
  cwd?: string;                  // default: the Run workspace

  // RPC protocol knobs
  protocol: {
    modeFlag?: string;           // default "--mode"
    modeValue?: string;          // default "rpc"
    readyDelayMs?: number;       // startup readiness delay (default 150)
    stopGraceMs?: number;        // SIGTERM -> SIGKILL grace (default 1000)
    // vendor extras to ignore (default: all unknown types ignored)
    ignoreEventTypes?: string[]; // e.g. ["negotiate_protocol", "ready"]
  };

  // how agent events map to Mercury events (same shape as LocalAgentAdapter)
  eventMap: LocalAgentEventMap;  // defaults to the shared RPC translation

  // human input (extension_ui_request dialogs)
  input?: {
    enabled: boolean;            // default true (dialog -> input.required)
    dialogMethods?: string[];    // default ["select","confirm","input","editor"]
  };

  // session resume
  resume?: {
    enabled: boolean;            // default true (new_session / session-dir)
    sessionDirFlag?: string;     // default "--session-dir"
  };
}
```

### 6.3 Runtime behavior

```
start(context):
  1. build argv: [command, ...args, --mode rpc, --cwd <workspace>, --session-dir <workspace>/.mercury-sessions]
  2. spawn with env = { MERCURY_RUN_ID, MERCURY_TRACE_ID, MERCURY_WORKER_ID, ... }
  3. attach the existing RpcClient (strict JSONL line reader, request/response correlation)
  4. send prompt { type: "prompt", message: task } (streamingBehavior: "steer" if busy)
  5. translate events via EventTranslator (message_update -> agent.message, tool_execution_* -> tool.*, extension_ui_request -> input.required)
  6. return AgentHandle { events, exit, terminate }

sendInput(runId, input):  send extension_ui_response { id, value } on stdin
cancel(runId):            send { type: "abort" }; SIGTERM after grace if still running
resume?(runId):           respawn with --session-dir <workspace>/.mercury-sessions and new_session
terminate(runId):         SIGKILL
```

### 6.4 Example configs

```yaml
# Pi Agent
id: pi
command: pi
args: []
protocol: { modeFlag: "--mode", modeValue: "rpc" }
eventMap: {}   # use the shared RPC translation defaults
input: { enabled: true }
resume: { enabled: true }
```

```yaml
# Oh my Pi (omp) — protocol v2 extras are ignored by default
id: omp
command: omp
args: []
protocol:
  modeFlag: "--mode"
  modeValue: "rpc"
  ignoreEventTypes: ["negotiate_protocol", "ready", "subagent_lifecycle", "host_tool_call"]
eventMap: {}
input: { enabled: true }
resume: { enabled: true }
```

### 6.5 Testing

- **Reuse** `test/fixtures/mock-prime-agent-rpc.mjs` (already implements the RPC
  protocol: happy/input/fail/hang/ignore modes, argv/env capture). Add a mode
  knob for vendor extras (`ready` frame, `negotiate_protocol`) to prove they are
  ignored.
- Tests: happy path (events translated), argv construction (mode flag, cwd,
  session-dir, trace env), input round-trip (extension_ui_request →
  input.required → extension_ui_response), cancel (abort command), resume
  (session-dir persistence), spawn failure, agent failure, vendor-extras
  tolerance, config validation, registry loading.
- **No real agent required in tests** (ARCHITECTURE.md §29).

### 6.6 Registry & wiring

- `RpcAgentRegistry` mirrors `LocalAgentRegistry`/`RemoteAgentRegistry`: loads
  JSON configs from `MERCURY_RPC_AGENTS_DIR` (default `./rpc-agents`), one file
  per agent.
- `cli.ts` registers the built-in `primeagent` (existing) plus any configs from
  the registry; `pi`/`omp` become drop-in config files.

### 6.7 Acceptance criteria

Same as §8, plus: vendor-specific event types never break the stream (unknown
types ignored), and the shared `EventTranslator` remains the single translation
path (no per-agent translation forks).

---

## 7. Cross-cutting work (applies to every adapter)

| Area | What to do |
| --- | --- |
| **Sandbox** | Local CLIs run inside the existing container sandbox when the Run requests isolation. Remote agents need no sandbox (vendor-side). |
| **Credentials** | Per-agent env vars via secret manager; redactor covers events/logs; never in workspace. |
| **Skills** | Map `RunContext.skills` capabilities → agent tool flags (`--allowedTools`, `-s`, `--tools`). Keep the mapping declarative in the adapter config. |
| **Session persistence** | Persist the agent's session id on the Run record (new column `agent_session_id` or reuse `workspace` metadata) so `resume()` works after worker restart. |
| **Cancellation** | Cooperative first (agent's cancel mechanism), SIGKILL/API-cancel after grace. |
| **Timeouts** | `maxDurationMs` enforced by the worker's drive loop (already done); remote agents also get a poll timeout. |
| **Observability** | All adapters inherit the trace env (`MERCURY_RUN_ID`/`MERCURY_TRACE_ID`/`MERCURY_WORKER_ID`) and structured logs. |
| **Docs** | Each adapter gets a section in this file + a `docs/agents/<id>.md` with the exact flags/API used. |

### Known gaps (worker-level, affect every adapter) — ✅ both fixed

Two gaps lived in the **worker** (`src/worker/worker.ts`), not in any adapter.
Both were found during the RpcAgentAdapter E2E review; they applied equally to
PrimeAgentAdapter and every future adapter. Both are now implemented (rows
11-12 in §9).

**Gap 1 — resume is not wired into the worker. ✅ fixed.** `adapter.resume()`
is part of the `AgentAdapter` contract and is implemented + unit-tested by
every adapter, but the worker always called `adapter.start(context)` — a retry
run (`retryOf`) was executed as a fresh start. The persisted session file
(`.mercury-session-path` in the workspace) was written but never consumed.

*Fix (implemented):* in the worker's execute path, when `run.retryOf` is set
and the adapter implements `resume()`, the worker reads the parent run's
`.mercury-session-path` and calls `adapter.resume(run.id, context)` with
`context.resumeSessionFile` set (falling back to `start()` when resume throws
or no session file exists). The `AgentAdapter.resume?` contract changed to
`resume?(runId, context?): Promise<AgentHandle>` so the worker gets a handle
to drive; every adapter (PrimeAgent, RpcAgent, LocalAgent, RemoteAgent,
HermesAgent) creates the session from context when missing and returns a
handle. A `run.resuming` event is emitted when a retry resumes. Worker tests:
fail → retry → assert `resume()` called with the parent session file; and
retry falls back to `start()` when the adapter has no `resume()`.

**Gap 2 — cancel of a hanging agent races the events iterator. ✅ fixed.** The
worker's drive loop checked `isCancellationRequested(run.id)` only at the top
of the loop, then blocked in `await iterator.next()`. An agent that hangs
without emitting events (e.g. RPC `hang` mode, a stuck CLI) never yielded, so
the loop never re-checked cancellation — `run.cancelling` was emitted but the
run stayed RUNNING until the max-duration timeout.

*Fix (implemented):* a cancellable `createCancellationSignal` polls
`isCancellationRequested(run.id)` every 100ms and is raced into the
`Promise.race` alongside the timeout and lease races. When the cancel race
wins, the loop takes the same path as the top-of-loop check (`cancelled =
true; await adapter.cancel(run.id); break`). Worker test: a hanging mock agent
+ `POST /cancel` → run reaches CANCELLED promptly (E2E verified: 0.3s vs the
previous 1h max-duration timeout).

### Findings (architecture review round 1, 2026-08-31) — ✅ all closed

These are recorded here because they define the contract every adapter must honour, not because any
of them is still open. **All were fixed and merged**; the per-finding disposition, the PR that closed
each one, and two cases where the review's own conclusion turned out to be wrong are in
[Round 1 — archived](architecture-review-round-1.md). The current backlog is
[Round 2](architecture-review.md), whose adapter-layer finding is
[R2-4](architecture-review.md#r2-4-two-credential-resolution-implementations-and-the-security-fix-reached-only-one)
adjacent but in `src/api/`, not here.

Each finding below was verified directly in source at commit `d005fad`; none was asserted on a
reviewer's authority. The `Where` column cites that commit and has not been re-pointed, so line
numbers refer to code that has since moved.

| Issue | Sev | Finding | Where |
| --- | --- | --- | --- |
| [#46](https://github.com/aywengo/mercury/issues/46) | High | Successful run leaks the agent process — the exit promise is settled on `agent.end` but the client is never stopped; `terminate()` is only reached on timeout. | `primeAgentAdapter.ts:176-181` |
| [#47](https://github.com/aywengo/mercury/issues/47) | High | A cancelled run can keep being executed and written to: the second throw in the catch unwinds before any `terminate()`, so the agent survives and keeps editing a cancelled workspace. | `worker.ts:237-245` |
| [#55](https://github.com/aywengo/mercury/issues/55) | High | Daemon `terminate()` sets `done = true` but never settles the exit, so the process-exit handler refuses to and the worker fabricates a `SIGKILL` exit after a 10 s stall. `cancel()` in the same file does it correctly. | `daemonAgentAdapter.ts:240-246` |
| [#68](https://github.com/aywengo/mercury/issues/68) | Med | `readFrame` discards every byte after the first frame in a chunk, so pipelined frames are silently dropped; the `error` listener is also never removed. | `daemonAgentAdapter.ts:308-324` |
| [#62](https://github.com/aywengo/mercury/issues/62) | Med | The per-run `sessions` Map is never pruned — no `.delete` anywhere in `src/adapters/`. Session objects and buffers live for the worker's lifetime. | `primeAgentAdapter.ts:78,120` |
| [#50](https://github.com/aywengo/mercury/issues/50) | High | SSE frame injection: adapters may emit arbitrary event types and the worker passes them through unvalidated into the SSE frame. The adapter layer is the producer; enforcement belongs at the write choke point. | `worker.ts:425`, `routes.ts:134` |
| [#60](https://github.com/aywengo/mercury/issues/60) | Med | The `EVENT_TYPES` contract is unenforced (`isEventType()` is never called) and two internally-appended types are not even in the set. Directly enables #50. | `types.ts:141-175` |
| [#56](https://github.com/aywengo/mercury/issues/56) | High | The sandbox forwards only `PATH` despite a comment promising environment passthrough, so any sandboxed adapter run fails at the first provider call. Affects the `sandbox` row in §7. | `sandboxManager.ts:109-111` |
| [#74](https://github.com/aywengo/mercury/issues/74) | — | Remediation plan and dependency order for all review findings. Read before starting work: severity order is not the right order. | — |

**The pattern worth acting on.** #46, #47, #55 and #62 are one bug class — exit settlement
and session lifetime — hand-rolled across five adapters with three different answers, one
of them wrong. That is a correctness argument for the shared adapter base class
(spawn, stderr buffering, exit settlement, session lifetime), not a tidiness one.
[#30](https://github.com/aywengo/mercury/issues/30) already tracks the same duplication in
the `extension_ui_response` shape and should be folded into that work rather than fixed
separately.

**What a new adapter must still do, now that these are closed.** The fixes moved the obligations
rather than removing them:

- The worker terminates the handle and calls `dispose(runId)` on **every** exit path
  (`worker.ts:350-388`). An adapter must therefore make `terminate()` idempotent and `dispose()`
  safe to call after it, and must key per-run state by `runId` so `dispose()` can actually find it.
- Exit settlement must be guarded on its own `exitSettled` flag and never on `done`. That is the
  #55 lesson and the best-commented part of the adapter layer.
- Event types are rejected at the write choke point (`eventStore.ts:47-50` throws), and the worker
  additionally discards them at the boundary (`worker.ts:605-608`) so that one odd event type from a
  rogue agent cannot throw out of the drive loop and kill its own run. The discard is logged at warn
  with the offending type, so it is diagnosable — but the event is still gone. Register new types in
  `EVENT_TYPES` as part of adding them.
- Skill ids are contained before use, so `--skill` arguments an adapter builds cannot escape the
  workspace, but an adapter that joins skill paths itself must route through the same helper.

---

## 8. Acceptance criteria (per adapter)

1. `start()` spawns/creates the agent with the Run's task, workspace, skills, constraints.
2. Agent output is translated into persisted Hermes events (no raw stdout as the domain model).
3. `sendInput()` reaches the agent; `input.required`/`input.received` round-trip works.
4. `cancel()` stops the agent; the Run reaches `CANCELLED` with events preserved.
5. `resume()` (where supported) continues the same session; otherwise retry-from-scratch.
6. Timeout → `TIMED_OUT`; infrastructure failure → `FAILED` (kind `infrastructure`, auto-retry).
7. Credentials never appear in events, logs, or browser responses.
8. Tests run without the real agent (mock fixture), per ARCHITECTURE.md §29.
9. `tsc` clean; full suite green.

---

## 8b. Shared plumbing an adapter MUST reuse

`src/adapters/exitSettlement.ts` owns exit settlement for every adapter. Import it; do not
re-implement it.

```ts
import { rearmExitGate, settleExit } from './exitSettlement.ts';

const session = rearmExitGate({ ...fields, exitPromise: null as any, exitResolve: null as any });
// ... later, from whichever transport path observes completion first:
settleExit(session, { code, signal, reason: 'completed' });
```

This exists because the same bug was hand-copied six times. Round 1 of the architecture review
diagnosed it ("exit settlement is hand-rolled in five adapters with three different answers, one of
them wrong ... the same bug is reproduced five times") and its remediation table promised a shared base
as step 9, marked delivered. It was never built; the three linked PRs patched the three bugs per
adapter instead. By Round 2 there were six `settleExit()` functions, five of them byte-identical, plus
thirteen hand-rolled copies of the same four lines that allocate the exit promise and capture its
resolver. Issue #148 removed all of them.

`rearmExitGate()` matters for `resume()`: a resumed run reuses its session object, and re-arming
without clearing the settled flag would leave the retried run's exit promise unresolvable.

Two rules, both enforced by `test/adapterExitSettlement.test.ts`:

1. **An adapter must not declare `settleExit`, write `exitSettled`, or call `exitResolve`.** The test
   scans every file in `src/adapters/` except the shared module and fails on any of the three. It
   strips comments first, because the comments explaining this history quote the code the guard
   forbids.
2. **`settleExit()` has exactly one definition in `src/`.**

Rows 1-2, 4 and 6 of the table below are all still to be written. Each is a new adapter, which is
exactly the situation that produced this issue six times over; reuse is the whole point.

## 9. Suggested implementation order

| # | Adapter | Pattern | Effort | Depends on |
| --- | --- | --- | --- | --- |
| 1 | CodexAdapter | A (CLI JSONL) | M | — |
| 2 | ClaudeCodeAdapter | A (CLI JSONL) | M | — |
| 3 | HermesAgentAdapter | A (CLI text) | S–M | ✅ done |
| 4 | GeminiAdapter | A (CLI JSONL) | M | — |
| 5 | LocalAgentAdapter | A (generic) | M | ✅ done |
| 6 | AiderAdapter | A (via LocalAgentAdapter config) | S | 5 |
| 7 | RemoteAgentAdapter | C (generic HTTP) | M | ✅ done |
| 8 | OpenHandsAdapter | C (RemoteAgentAdapter config) | S | 7 |
| 9 | DevinAdapter | C (RemoteAgentAdapter config) | S | 7 |
| 10 | RpcAgentAdapter | B (generic RPC) | M | ✅ done |
| 11 | Worker: wire `resume()` into retry | — (worker) | S | ✅ done |
| 12 | Worker: cancel race for hanging agents | — (worker) | S | ✅ done |

Codex + Claude first (highest value, cleanest interfaces). LocalAgentAdapter
before Aider (Aider becomes a config, not code). RemoteAgentAdapter before
OpenHands/Devin (they become configs). RpcAgentAdapter is high priority because
it reuses the existing RPC machinery — one adapter yields pi + omp + any future
RPC agent (see §6).

Rows 11-12 are worker-level leftovers found during the RpcAgentAdapter review
(see §7 "Known gaps"): wire `adapter.resume()` into the retry path, and race
cancellation into the drive loop so hanging agents can be cancelled promptly.
Both are small, independent of any adapter, and unblock full resume + cancel
semantics for every adapter.
