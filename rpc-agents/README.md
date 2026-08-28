# rpc-agents — declarative RPC agents

JSON configs for `RpcAgentAdapter` (docs/agent-adapters.md section 6): any CLI
that speaks the RPC JSONL protocol family (PrimeAgent, Pi Agent, Oh my Pi, ...)
becomes a Mercury agent via a declarative config — no per-agent code.

Loaded from `MERCURY_RPC_AGENTS_DIR` (default `./rpc-agents`), one `.json` file
per agent. The built-in `primeagent` agent id is always registered by cli.ts;
configs here add `pi`, `omp`, or any other RPC-speaking CLI.

## pi.json — Pi Agent

```bash
npm i -g @earendil-works/pi-coding-agent   # provides the `pi` binary
```

## omp.json — Oh my Pi

```bash
bun i -g @oh-my-pi/pi-coding-agent         # provides the `omp` binary
```

Both agents authenticate through their own credential stores
(`~/.pi/agent/`, `~/.omp/`) — no Mercury secret plumbing needed.

## Config schema

See `docs/agent-adapters.md` section 6.2. Key fields:

| Field | Meaning |
| --- | --- |
| `command` | binary path or name |
| `args` | static args appended after the mode flag |
| `protocol.modeFlag` / `modeValue` | mode selection (default `--mode rpc`) |
| `protocol.ignoreEventTypes` | vendor event types to drop (e.g. omp's `ready`, `negotiate_protocol`, `subagent_lifecycle`, `host_tool_call`) |
| `input.enabled` | bridge `extension_ui_request` dialogs to Mercury `input.required` |
| `resume.enabled` | persist the RPC session file and support resume |
