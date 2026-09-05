# Agent backends

Mercury talks to coding agents through `AgentAdapter`. The worker chooses an
adapter by Run `agent` id, supplies a `RunContext`, consumes translated events
and owns cancellation, timeout and cleanup.

Detailed protocol research and adapter roadmaps live in
[`agent-adapters.md`](agent-adapters.md).

## Adapter boundary

Conceptually:

```ts
interface AgentAdapter {
  start(context: RunContext): Promise<AgentHandle>;
  sendInput(runId: string, input: AgentInput): Promise<void>;
  cancel(runId: string): Promise<void>;
  resume?(runId: string, context?: RunContext): Promise<AgentHandle>;
  dispose?(runId: string): void;
}
```

The returned handle exposes an asynchronous event stream, an exit promise and a
forceful termination method. The worker must terminate a handle before calling
`dispose()`; reversing that order can lose the only reference to a live child
process.

Adapters translate backend output into Mercury event types. Raw stdout is not
the Run domain model.

## Registered agents

`GET /api/agents` returns `{ agents, defaultAgent }` for the current process.
`defaultAgent` is `MERCURY_DEFAULT_AGENT` (default `fake`). Builtin ids
normally include:

- `fake` (create-Run default when `agent` is omitted);
- `primeagent`;
- `hermes`;
- `claude`;
- any ids loaded from local, remote and RPC registry directories.

The exact list depends on startup configuration. Run creation rejects an
unknown id before queueing. Startup fails if `MERCURY_DEFAULT_AGENT` is not in
the registered list.

## Capability summary

| Backend | Transport | Structured tool events | Human input | Resume | Status |
| --- | --- | --- | --- | --- | --- |
| Fake | in-process deterministic script | scripted | scripted | test-specific | create-Run default; plumbing and tests |
| PrimeAgent | RPC JSONL subprocess | yes | yes | session file | supported coding transport |
| Hermes | quiet CLI text | no | no interactive bridge | session id | supported with reduced fidelity |
| Claude | stream JSON CLI | yes | no interactive bridge | session id | supported with version-specific limits |
| Local | configurable CLI | depends on config | configurable | configurable | supported |
| RPC | configurable RPC JSONL CLI | yes | configurable | configurable | supported |
| Remote | configurable HTTP API | depends on API | configurable | reattach | supported |
| PrimeAgent daemon | daemon socket | intended | intended | resident session | experimental, not production-ready |

“Supported” means the adapter contract is implemented and tested against its
fixture or verified interface. It does not mean every third-party agent version
is compatible. `npm install` does not ship coding-agent CLIs.

## Fake agent

`FakeAgentAdapter` supplies scripted messages, delays, input requests, failures
and completions. The `fake` id is registered in every mode. Omitting `agent` on
create selects it unless `MERCURY_DEFAULT_AGENT` is set.

It needs no binary. Use it to prove the control plane (queue, workspace, events,
dashboard) without an LLM. Normal tests use it so they need no network, model
API or real coding-agent process. It is not a production coding backend.

## PrimeAgent RPC

### Install

Binary: `prime-agent`. Mercury `agent` id: `primeagent`.

```bash
curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh
which prime-agent
```

Docs: [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).

`PrimeAgentAdapter` is the supported coding transport:

```text
prime-agent --mode rpc
  --cwd <workspace>
  --session-dir <workspace>/.mercury-sessions
  --skill <materialized-skill-path> ...
```

The adapter:

- writes `.mercury-context.json`;
- points the task prompt at the context and selected skills;
- translates message, tool, UI-request and completion events;
- maps supported UI requests to `NEEDS_INPUT`;
- persists a session file path for retry resume;
- sends `MERCURY_RUN_ID`, `MERCURY_TRACE_ID` and `MERCURY_WORKER_ID`;
- cooperatively aborts before forceful process termination.

Each Run receives a separate RPC process. The process lifetime belongs to the
worker, not the client connection.

The RPC client implements strict LF-delimited JSONL directly. It correlates
responses by id, dispatches events and captures stderr without turning it into
domain events.

## Hermes

### Install

Binary: `hermes`. Mercury `agent` id: `hermes`.

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
which hermes
```

Docs: [Hermes Agent installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation).

`HermesAgentAdapter` runs Hermes in quiet programmatic mode:

```text
hermes chat -Q --query-file - --in <workspace> -s <skill> ...
```

Task text goes through stdin. The final text becomes `agent.message`, and a
session id found on stderr supports resume.

Quiet mode does not expose tool-level events or an interactive
`input.required` bridge. Options such as `--yolo` and `--accept-hooks` handle
approval behavior before startup and should be enabled only under appropriate
operator policy.

Configuration: [`configuration.md`](configuration.md#hermes).

## Claude

### Install

Binary: `claude` (Claude Code CLI). Mercury `agent` id: `claude`.

```bash
curl -fsSL https://claude.ai/install.sh | bash
which claude
```

Docs: [Claude Code setup](https://code.claude.com/docs/en/setup).

`ClaudeCodeAdapter` drives the installed Claude CLI with stream JSON output.
The implementation follows behavior verified against the local supported CLI
version rather than assuming every flag described by newer documentation.

It provides:

- assistant messages;
- tool start/completion/failure correlation;
- terminal result handling using both `is_error` and process exit;
- session-id refresh on resume;
- static process-level model, tool and MCP options.

It does not provide an interactive human-input channel in the verified CLI
version. `sendInput()` fails explicitly instead of placing a Run in an
unanswerable wait.

`MERCURY_CLAUDE_MCP_CONFIG` is process-wide. It is not the per-Run MCP system
designed under [`crew/mcp-security.md`](crew/mcp-security.md).

## Declarative local agents

`LocalAgentAdapter` turns a non-interactive CLI into an agent without adding a
class. JSON configuration selects:

- task input through argv, stdin or file;
- output as JSONL, JSON or text;
- event-field mappings;
- input through stdin, flag or prompt file;
- cancellation signal and grace;
- resume session-id source;
- skill-to-tool flag mappings;
- static environment and sandbox flags.

Example:

```json
{
  "id": "my-agent",
  "description": "Example JSONL coding agent",
  "command": "my-agent",
  "taskInput": { "mode": "stdin" },
  "output": {
    "format": "jsonl",
    "stream": true,
    "eventPath": "type"
  },
  "eventMap": {
    "message": "agent.message",
    "toolStarted": "tool.started",
    "toolCompleted": "tool.completed",
    "completed": "done"
  },
  "cancel": { "signal": "SIGTERM", "graceMs": 3000 }
}
```

Files are loaded from `MERCURY_LOCAL_AGENTS_DIR`. One malformed config currently
fails registry loading rather than being isolated.

Full contract: [`local-agents/README.md`](../local-agents/README.md).

## Declarative RPC agents

`RpcAgentAdapter` reuses Mercury's RPC JSONL machinery for CLIs such as Pi Agent
and Oh My Pi:

```json
{
  "id": "pi",
  "description": "Pi coding agent",
  "command": "pi",
  "args": [],
  "protocol": {
    "modeFlag": "--mode",
    "modeValue": "rpc"
  },
  "eventMap": {},
  "input": { "enabled": true },
  "resume": { "enabled": true }
}
```

Configuration can override protocol startup, ignored vendor events, input
methods and session-directory behavior. Static arguments are operator-owned
configuration, not per-Run user input.

Full contract: [`rpc-agents/README.md`](../rpc-agents/README.md).

## Declarative remote agents

`RemoteAgentAdapter` maps a SaaS or remote coding API onto Run operations:

- create task;
- poll status and events;
- send input;
- cancel;
- reattach on resume.

Authentication comes from the environment variable named by operator config.
The value is not stored in Run records or event payloads.

Remote APIs need explicit poll intervals and timeouts. Mercury does not infer
vendor semantics from arbitrary responses; status and event mappings are part
of the reviewed config.

Full contract: [`remote-agents/README.md`](../remote-agents/README.md).

## Daemon mode

`MERCURY_AGENT_MODE=daemon` selects `DaemonAgentAdapter` for the `primeagent`
id. This path is not production-ready.

The canonical verification in
[`daemon-agent-sessions.md`](daemon-agent-sessions.md) found that the adapter
and PrimeAgent 0.8.1 daemon protocol disagree on framing, command envelope,
session identity and socket choice. Its mock-based tests do not establish
compatibility with that real daemon.

Use RPC mode unless a later verification updates both implementation and the
canonical daemon document.

## Sandboxing

Local process adapters can be wrapped by `SandboxManager` when a Run requests
resource or network constraints. The image must contain the selected agent
binary and Git.

Remote API agents do not become container-isolated merely because Mercury's
worker is sandboxed; their actual execution occurs in the remote service's
security boundary.

See [`operations.md`](operations.md#sandboxed-execution).

## Adding an agent

Choose the smallest fitting extension:

1. use `LocalAgentAdapter` for a non-interactive CLI with configurable output;
2. use `RpcAgentAdapter` for a CLI speaking the RPC JSONL family;
3. use `RemoteAgentAdapter` for an HTTP task API;
4. add a dedicated adapter only when vendor behavior cannot be expressed safely
   through a registry.

Every adapter needs deterministic tests for startup, translation, failure,
cancellation, cleanup and any claimed input/resume behavior.
