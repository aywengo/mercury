# Agent Templates — persona-bearing agent definitions

Status: **design only.** Nothing here is implemented. Extends
[`role-presets.md`](role-presets.md); read that first.

A Role Preset resolves *instruction + skills + agent + constraints* for one Run.
It has no persona concept. This document adds one, and records why the persona
cannot be delivered today.

## 1. The blocking fact: no backend can receive a per-run persona yet

Verified against the installed binaries and the shipped Mercury 0.1.0 build:

- PrimeAgent 0.9.4 exposes `--append-system-prompt <text>` (repeatable),
  `--system-prompt <text>` (replace), `--prompt-template <path>`, and reads
  `AGENTS.md` / `CLAUDE.md` from the working directory. It has **no** `SOUL.md`
  concept — zero references in its distribution.
- Mercury `RpcClient` sends exactly `{ type: "prompt", message }`. There is no
  field for a system prompt.
- `MERCURY_PRIMEAGENT_ARGS` is parsed once at startup into
  `config.primeAgentArgs` and handed to the adapter as a **process-global**
  default. It is not per-Run.
- `HermesAgentAdapter`'s verified interface (`hermes chat -Q --query-file -`,
  `--resume`, `--max-turns`, `--run-budget`, `-s <skill>`, `--in <dir>`,
  `--yolo`, `--accept-hooks`) contains no persona flag.
- Hermes itself auto-injects persona files: `hermes --help` documents
  `--ignore-rules` as "Skip auto-injection of AGENTS.md, SOUL.md, ...", and the
  implementation resolves `SOUL.md` from a **profile directory**
  (`profile_dir / "SOUL.md"`), alongside `config.yaml` and installed skills.

Consequence: distributing persona files without first adding a per-Run capability
produces a store whose contents nothing executes. That capability is Phase 0
below and it gates everything else.

## 2. Definitions

- **Agent Template** — a portable agent identity bundle: persona text,
  instruction, skill references, model preference, tool/MCP requirements,
  constraint defaults, and per-backend bindings. Identified by `templateId` and
  `version`, addressed by content hash.
- **Persona** — durable identity and behavioural posture for an agent. Rendered
  per backend; never stored as a backend-specific artifact.
- **Rendering** — the adapter-owned translation of a resolved Template into the
  native surface of one backend. Invariant 6 of `README.md` keeps this inside
  `src/adapters/`.

`SOUL.md` is the Hermes spelling of a persona. It is not a wire format and must
not become Mercury's field name. The schema field is `persona`; `SOUL.md` is what
the Hermes renderer writes.

## 3. Rendering per backend

| Backend | Persona rendering | Verified surface |
| --- | --- | --- |
| Hermes | write `SOUL.md` into the profile/workspace Hermes resolves; Hermes injects it itself | `--ignore-rules` help text; `profile_dir / "SOUL.md"` |
| PrimeAgent | `--append-system-prompt <persona>`, plus `AGENTS.md` in the workspace for project context | `prime-agent --help` |
| Claude | `CLAUDE.md` in the workspace | adapter docs |

**Never use `--system-prompt`.** It replaces PrimeAgent's default system prompt,
which carries its own tool-calling harness. A template that replaces it disables
the machinery required to execute the template. Append only. This is a hard rule,
not a preference: the failure is silent and looks like a misbehaving agent.

## 4. Phase 0 — per-Run adapter capabilities

Mercury needs adapters to declare and accept structured per-Run capabilities.
The minimum set for templates:

- `appendSystemPrompt` (string)
- `workspaceFiles` (list of `{ path, content }`, materialized into the workspace
  before the agent starts, subject to the existing `resolveContained` traversal
  and symlink checks)
- `model` (string)

Rules:

1. Structured fields only. A template must not append arbitrary argv — the
   existing Crew principle, restated because persona injection is exactly where
   an `args` escape hatch would be tempting.
2. Advertisable and fail-closed. A template that requires a capability the
   target adapter lacks rejects Run creation with an actionable error
   (invariant 9). This also gives `/api/agents` something richer than bare names,
   which `README.md` already flags as blocking MCP-aware routing.
3. Snapshot the resolved bytes. The Run stores persona bytes, hash and rendering
   decision at creation; the worker executes stored bytes and never re-reads a
   mutable registry.

Ship Phase 0 alone, and prove it with a real PrimeAgent Run whose reply depends
on the persona. Until that passes, template distribution is inert.

## 5. Where drafts live, and what Fleet may do

The Git mirror in [`preset-store.md`](preset-store.md) stays the source of truth.
Drafts are owner-scoped on the host.

Fleet is a client of the host HTTP API. It is not a configuration plane, and the
current child allowlist in `fleet/src/child.js` has no template routes. Two ways
to add them:

- **A — host stores, Fleet proxies.** New host endpoints (`/api/templates` CRUD +
  validate). Fleet's CLI and dashboard author through them. One authority per
  host: the host that resolves and snapshots.
- **B — Fleet stores and pushes.** Fleet holds the store and distributes to
  hosts. This creates a second source of truth, a sync and conflict story, and
  N-copy drift, and it means the host that executes a Run is not the authority on
  what it executed.

Recommend **A**. It keeps the coupling rule — Fleet speaks HTTP and imports no
Mercury internals — and keeps "what did this Run execute" answerable from one
place. Choosing A still means deliberately widening the `child.js` allowlist,
which is a security control; that widening needs its own review, not a side
effect of a feature PR.

Either way there is no version negotiation between Fleet and a host today. Adding
template routes needs a capability advertisement, or an old host fails at the
first template call rather than at registration.

## 6. Open questions

1. Does a Hermes persona render into a **profile** (shared, persistent, affects
   other Runs on that host) or only into the isolated workspace? A profile write
   is a host-mutating side effect and needs its own trust tier.
2. Persona plus instruction: two fields or one ordered list? Two is clearer for
   review; one is closer to how Hermes profiles are authored.
3. Are templates owner-scoped or org-scoped once multiple operators share a host?
