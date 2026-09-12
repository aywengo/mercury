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
| Claude | write `CLAUDE.md` into the workspace; the adapter sets `cwd` to the workspace and Claude Code reads it from there | `cli.js` for claude 1.0.3 references `CLAUDE.md` 20 times; `--help` for 1.0.3 exposes **no** system-prompt flag, so a workspace file is the only path |

What is verified and what is not: the Hermes and PrimeAgent rows were checked
against the installed binaries. The Claude row is verified only as far as
`CLAUDE.md` being read by claude 1.0.3 and no persona flag existing; that
`CLAUDE.md` is discovered from the working directory specifically, rather than from
a parent directory or a config path, was **not** verified. Two Claude installs exist
on this machine (1.0.3 and 2.1.260) and the adapter header says it was verified
against 1.0.3, so any Claude persona work must re-verify against whichever build a
host actually runs.

No adapter materializes a persona today. `claudeCodeAdapter.js` writes no workspace
files and passes only `--output-format`, `--verbose`, `--model`, `--mcp-config` and
`--dangerously-skip-permissions`. `workspaceFiles` from Phase 0 is what would let
it.

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
   (invariant 9). This also gives `/api/agents` something richer than the
   goals-only `capabilities` map it returns today,
   which `README.md` already flags as blocking MCP-aware routing.
3. Snapshot the resolved bytes. The Run stores persona bytes, hash and rendering
   decision at creation; the worker executes stored bytes and never re-reads a
   mutable registry.

Ship Phase 0 alone, and prove it with a real PrimeAgent Run whose reply depends
on the persona. Until that passes, template distribution is inert.

## 5. Manifest

An Agent Template is a **separate manifest type** that reuses the Role Preset
shape. It is deliberately *not* `schemaVersion: 2` of `RolePresetManifest`:
`role-presets.md` §2.1 makes `schemaVersion` not exactly `1` a hard error, so
bumping the number would either break that rule or force a version dispatcher into
the preset validator for a change that is not breaking. A new type with its own
version keeps both validators single-versioned, which is the property that rule
exists to protect.

Structurally it reuses the preset fields, and everything in `role-presets.md` §2
still applies to them — including the rule that a manifest cannot declare itself
trusted.

```ts
interface AgentTemplateManifest extends Omit<RolePresetManifest, 'schemaVersion'> {
  schemaVersion: 1;                 // version of THIS manifest, not the preset's

  persona?: {
    file: string;                 // SOUL.md, PERSONA.md, ...
    required?: boolean;           // default true when the block is present
  };

  skills?: {
    defaults?: string[];
    required?: string[];
    autoSelect?: boolean;
    max?: number;
    none?: boolean;               // explicit "no skills", distinct from unset
    intent?: string[];            // resolved per harness by the sub-team resolver
  };

  requires?: {
    sandbox?: boolean;
    capabilities?: Array<
      | 'persona.append'
      | 'persona.workspaceFile'
      | 'skills.workspacePaths'
      | 'skills.nativeNames'
      | 'humanInput'
      | 'resume'
      | 'mcp'
      | 'modelSelection'
    >;
  };
}
```

`persona` is a file reference, never inline text, so a template diff reviews like
the instruction diff it belongs with. `SOUL.md` is the Hermes filename; the field
name stays backend-neutral.

`skills.none` exists because today nothing can express it. `RunService` computes
`input.skills && input.skills.length > 0 ? input.skills : select(...)`, and
`skillSelector` cannot return an empty list, so "no skills" is currently
inexpressible and Hermes therefore unusable — see [`teams.md`](teams.md) §3.
`none: true` alongside `defaults` or `required` is a hard error, not a precedence
rule.

`skills.intent` is the sub-team seam: the template states what the skills are for,
and each harness resolves that inside its own namespace. A template must not list
native skill names for a specific harness.

### 5.1 Additional validation

Hard errors, on top of `role-presets.md` §2.1:

- `persona.file` is absolute, contains `..`, crosses a symlink, leaves the template
  directory, is not UTF-8, or exceeds the instruction size cap;
- `persona` is present but the resolved agent advertises neither
  `persona.append` nor `persona.workspaceFile` — fail closed rather than run an
  agent that will silently ignore the persona;
- `requires.capabilities` contains a name outside the closed vocabulary above;
- `skills.none` is true and any of `skills.defaults`, `skills.required` or
  `skills.intent` is non-empty, or `skills.autoSelect` is true, or `skills.max` is
  set. `none` means none, so every other skills field is a contradiction rather
  than something to order by precedence;
- `skills.intent` is present and the resolved agent advertises neither skills
  capability.

### 5.2 API

Owner-scoped throughout; a missing or foreign template is `404`, never `403`.

| Method and path | Purpose |
| --- | --- |
| `GET /api/templates` | list templates visible to the caller |
| `GET /api/templates/:id` | one template plus its resolved capabilities |
| `POST /api/templates/validate` | dry-run validation, structured findings, stores nothing |
| `POST /api/templates` | create an owner-scoped draft |
| `POST /api/runs` with `template: { id, version? }` | resolve, snapshot, create one Run |

`template` and `preset` on `POST /api/runs` are **mutually exclusive**: supplying
both is a `400` with a named conflict, never a precedence rule. Precedence would
mean one silently loses, and a Run whose instruction came from a field nobody
mentioned is exactly the kind of surprise a snapshot is supposed to make
impossible. Supplying neither is today's behaviour, unchanged. A Team stage always
names a `template`, never a `preset`, so the two never meet inside a Team.

`POST /api/templates/validate` must be reachable before any write path exists, so
an operator can check a template against a host before that host can run it.

## 6. Persistence

Follows the `run_skills` precedent rather than inventing a second snapshot
mechanism.

- `agent_templates` — one row per template version: `id`, `version`, `owner_id`,
  `content_hash`, `manifest_json`, `persona_text`, `source` (`builtin`, `mirror`,
  `draft`), `created_at`. `source` is what assigns trust; the manifest never does.
- `run_templates` — one row per Run: `run_id`, `template_id`, `template_version`,
  `content_hash`, `resolved_json`, `rendered_as`. `rendered_as` records which
  capability the adapter actually used (`persona.append` vs
  `persona.workspaceFile`), so a replay can show what the agent really received.

Crew tables start after the current last migration, per `README.md` §6.

The known gap there still gates this: the worker re-resolves skills from the live
registry instead of executing the stored snapshot. A persona that is re-resolved
the same way would silently change what an old Run means, so snapshot execution
must be fixed before templates claim reproducibility.

## 7. Where drafts live, and what Fleet may do

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

## 8. Open questions

1. Does a Hermes persona render into a **profile** (shared, persistent, affects
   other Runs on that host) or only into the isolated workspace? A profile write
   is a host-mutating side effect and needs its own trust tier.
2. Persona plus instruction: two fields or one ordered list? Two is clearer for
   review; one is closer to how Hermes profiles are authored.
3. Are templates owner-scoped or org-scoped once multiple operators share a host?
