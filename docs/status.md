# Current status and limitations

Mercury implements the complete single-host durable Run path: API, SQLite
queue, worker, isolated workspaces, agent adapters, events, dashboard, human
control, retries, sandbox integration, metrics and deployment packaging.

This page records active limitations without the long historical completion
list previously kept in the root README.

## Supported baseline

The production baseline is:

- one host;
- one local SQLite database shared by API and workers;
- separate `server` and `worker` processes;
- `fake` as the create-Run default when `agent` is omitted (`MERCURY_DEFAULT_AGENT`);
- PrimeAgent RPC as the supported coding-agent transport;
- Git-worktree isolation;
- optional Docker or Podman sandboxing;
- bearer-token or browser-session authentication;
- persisted event history with SSE delivery.

Fleet can federate several independent Mercury hosts over HTTP. It does not
turn them into one shared database or move active Runs between hosts.

## Active limitations

### Single-host storage

SQLite WAL is the coordination layer. It is unsuitable for a shared database on
network storage, so Mercury cannot run one control plane across several hosts.

Fleet is the supported federation direction. Replacing SQLite with a networked
transactional store would be a separate architecture project.

### Identity and API scaling

`MERCURY_API_TOKENS` remains the identity source. Browser sessions and rate
limits are process-local memory.

Consequences:

- sessions disappear on API restart;
- two API processes do not recognize each other's sessions;
- each API process has an independent rate-limit budget;
- OIDC/SSO and horizontally shared session/rate-limit storage remain future
  work.

`MERCURY_TRUST_PROXY` fixes source-IP attribution behind a proxy; it does not
make these stores shared.

### Network policy granularity

Sandbox network behavior is:

- empty `allowedNetworks` → network disabled;
- non-empty `allowedNetworks` → unrestricted bridge networking.

Names in the array do not enforce destinations. Hostname allowlists, private
network restrictions and HTTP MCP egress require a real proxy or network policy
layer.

### Sandbox prerequisites

Constrained Runs fail closed without a configured container runtime. The
default Node image lacks PrimeAgent and Git, so operators need a purpose-built
image.

Disk limits depend on the host storage driver and are disabled unless explicitly
declared supported. Strict systemd hardening requires the documented opt-in
runtime-socket configuration.

### Token and cost budgets

`budgetTokens` and `budgetCost` are recorded but not enforced. Adapters do not
report normalized usage to the worker, so Mercury cannot stop a Run at those
budgets.

`maxDurationMs` and `maxRetries` are enforced.

### Agent capability differences

Not every adapter offers the same fidelity:

- PrimeAgent RPC supports structured tools, human input and session resume;
- Hermes quiet mode is text-level and has no live input bridge;
- the verified Claude CLI path has structured tool events and resume but no
  answerable interactive-input channel;
- declarative adapters provide only the capabilities expressed by their
  configuration and backend;
- remote agents execute inside the remote provider's security boundary.

Callers must not infer capabilities from an agent id alone. `/api/agents`
reports two different kinds of answer per agent, and they must be read
differently. The `static` block is what an adapter declares about itself --
skill delivery mode, persona append and files, human input, resume, knowledge --
and it is passed through as declared, because it describes the adapter rather
than an installed binary and there is no version to compare it against. The goal
half is version-resolved: every adapter that can answer a version probe is asked
at startup, and each goal field is then resolved against the detected version
rather than against the declaration alone. A caller therefore reads, per agent,
the detected harness version and its raw string, plus a per-field goal answer
that distinguishes `unsupported` (the backend has no such concept),
`version-unknown` (nothing could be probed) and `version-too-old` (declared, but
this install predates the threshold). Unknown fails closed: it is never reported
as supported, and never as newest either.

Two consequences of that split are easy to misread. Probes are fired at startup
and are not awaited, so `version` can be null for a moment after boot and goal
fields read `version-unknown` until they land -- a cold cache, not a verdict
about the backend. And adapters with no probe at all, `hermes` and `claude`
among them, report no version permanently; for them `version-unknown` is the
steady state, and they declare no goal support either.

What remains unbuilt is what happens after that answer is known. No shipped
backend declares deterministic gates and no gate outcome event exists, so Mercury
cannot yet report whether a gate passed or failed; the event vocabulary is
deliberately absent rather than declared with no emitter behind it. Budget
enforcement is a separate gap and is listed under *Token and cost budgets*.
`knowledge` is declared but unverified for every shipped backend, so it must not
be treated as a promise.

### PrimeAgent daemon mode

The daemon adapter exists but is not production-ready. Verification against
PrimeAgent 0.8.1 found incompatibilities in framing, command envelope, session
identity and socket selection.

Mock-based daemon tests do not prove real-daemon compatibility. RPC remains the
supported default. See [`daemon-agent-sessions.md`](daemon-agent-sessions.md).

### Local repository paths

A `repository.localPath` is interpreted on the worker host. The API cannot
verify that a path exists on a different worker host, and Fleet relies on
operator-declared locality.

Prefer a Git URL for portable routing.

### Static dashboard

The dashboard is a small vanilla-JavaScript application with no build step.
This keeps deployment simple but limits component reuse and richer client-side
state management.

### Goal setting has no dashboard surface

The CLI half of the goal client surface is built: `mercuryctl runs create --goal '<json>'` sets a goal
(the same object `--file` carries; the JSON form is canonical per `docs/cli-tui-design.md` §6.2),
`runs goal <run-id>` reads one, and `runs goal-cancel <run-id>` cancels one — cancel remains the only
goal mutation by design (`docs/goals.md` §12). What the CLI can still not do is compose a goal
interactively: there are no `--objective`/`--gates` flag grammars, only the JSON form.

The dashboard half remains unbuilt: the create form is `task`, `repo`, `branch`, `agent`. There is no
goal field, so the Goal column can only ever display a goal that the CLI or an HTTP caller created.
`docs/goals.md` section 13.6 separates what ships from what does not: the `capabilities` field exists
and `mercuryctl agents list` renders the goal column. The dashboard gap was recorded when
[#575](https://github.com/aywengo/mercury/issues/575) closed; whether to build it or record
dashboard goal-setting as deliberately out of scope is still not decided anywhere a contributor
can read.

### Redaction is mitigation

Mercury redacts known patterns and exact credentials it forwards. It cannot
guarantee removal of an unknown secret that it never observed or a value
transformed by a malicious agent.

Minimal credential forwarding and network isolation remain the primary
boundaries.

## Implemented

### Knowledge base (Atlas)

Atlas is a separate, optional service: one HTTP endpoint holding curated project knowledge,
and one replica per Mercury host. It is off unless configured. Setting `MERCURY_ATLAS_URL`
(with `MERCURY_ATLAS_HOST_ID`, `MERCURY_ATLAS_PROJECT` and a contributor `MERCURY_ATLAS_TOKEN`)
turns on the whole path; without it the host behaves exactly as it did before and no knowledge
module is loaded. `MERCURY_ATLAS_ADMIN_TOKEN` gates the curation endpoints.

Live and covered by tests:

- `knowledge_outbox` with its pusher, and `knowledge_replica` with a monotonic per-project
  cursor plus a bootstrap path for a host that has no cursor yet;
- deterministic pack selection at Run creation and `run_knowledge` storage, so two hosts holding
  the same replica select the same notes for the same Run;
- materialisation into neutral workspace files at Run start, and the PrimeAgent skill rendering
  of section 9.3: the pack is written to `.agents/skills/mercury-knowledge/SKILL.md` and passed
  with the `--skill` flag, so it reaches a channel the harness reads unprompted;
- an `AGENTS.md` channel for Hermes, which was measured (v0.21.2) to read `AGENTS.md` from the
  workspace and **not** to read `.mercury/knowledge/NOTES.md`. Like the skill file it is written
  only when the repository does not already own that path;
- tier-1 harvest of `.mercury/notes.jsonl` at finalize, with validation, the K2 rules and the
  section 7.5 bounds. The file is read and validated outside the write transaction -- neither may
  hold a write lock -- and the surviving notes are inserted into the outbox *inside* it, together
  with the transition that completes the Run, so a Run is never COMPLETED with its notes held only
  in memory. Rejection is per line with a stated reason, and a secret match rejects rather than
  scrubs;
- `knowledge.selected`, `knowledge.noted` and `knowledge.rejected` events;
- provenance carried through the replica, so `GET /api/runs/:runId/knowledge` distinguishes an
  operator note from a harvested one and names the contributing host. It previously fabricated
  `{ source: 'agent-reported', hostId: '' }` for every note, which understated trust for the two
  most trusted sources; a note that reached a replica before that column existed reports no
  provenance rather than a plausible one;
- `GET /api/knowledge/status` and `POST /api/knowledge/notes` (admin only), and
  `GET /api/runs/:runId/knowledge` (owner-scoped);
- the `mercury knowledge` subcommands: `status` reports the replica, cursor and outbox depth;
  `identity <url>...` prints the `repo:<hash>` scope key the pack selector computes and reads no
  database, so it works on the host whose configuration is the thing under investigation (a local
  path is answered but reported as host-local, because such a scope works there and matches nothing
  elsewhere); `index <checkout>` parses a checkout's `docs/decisions/` records at HEAD into the
  outbox runless (§6.3's bootstrap path), printing accepted/skipped/rejected and failing when a
  record was rejected; and `flush` drains the outbox to Atlas in one synchronous pass rather than
  waiting for the pusher's timer, and refuses with an explanation when no Atlas is configured;
- retired-row retention on the host (`MERCURY_KNOWLEDGE_RETIRED_RETENTION_MS`).
- the **Fleet reader** (#615): `GET /fleet/knowledge` and the `fleet knowledge` CLI, counts
  only — Fleet can see per-project knowledge health without ever receiving note bodies. Two
  tokens are involved and they are different: the endpoint answers any authenticated Fleet
  caller (`401` without a caller token — it is not public), and Fleet itself queries Atlas with
  an Atlas **reader** token (`FLEET_ATLAS_TOKEN`), which can count notes but can never read one.
  When Atlas is down the endpoint still answers an authenticated caller, `200` with a body that
  says so, because decoration failing must not look like Fleet failing;
- a **soft** placement signal in Fleet (`FLEET_KNOWLEDGE_STALE_MS`, off by default): a host whose
  knowledge replica is older than the threshold ranks below a fresher one, and the decision is
  returned and logged when it changes the outcome. It never excludes a host. That is the whole
  design — refusing to place work because a note is two minutes old would be a Run lost to a cache —
  and it is why a fleet of one stale host still gets the work. Fleet reads the host's
  `GET /api/knowledge/status`, which is admin-only, so an ordinary caller credential yields *no
  opinion* rather than *stale*, and a host running an older Mercury is treated the same way.

The loop is closed end to end **in the direction that has been measured**: knowledge promoted on one
host reaches a Run on another host, and a real model there acts on it. `test/knowledgeTeachE2E.test.ts`
proves the transport against a real Atlas process, and #589 observed the read path on real harnesses
(`run_933c68e4684a498d` with a control at `run_d0f4dc05a8f44a1d`, Hermes at `run_8d8cfc92f22b4fcf`).

The other direction was built and tested but unproven of a real agent; that is now observed. (Was
"has not been seen from a real agent", citing `run_e8fe5f095b38438b` — a PrimeAgent Run told to
record a durable fact that finished without writing one. Hermes Agent v0.21.2 then wrote a note on
a real Run (`run_0826c0e5e4ee4f6c`, host `obs-host`): it verified the claim against the live tree,
appended one JSON line to `.mercury/notes.jsonl`, and the worker harvested and pushed it
(`accepted: 1` both hops). The earlier negative result stands as the control — the same task shape
produced no note when the agent was not told to record one — and Phase 4 went further: tier-1
candidates written by real agents were auto-promoted across `obs-host`/`obs-host-b`
(`run_4acabb39e38c4c7d` and three corroborating Runs).)

Rendering is built for PrimeAgent (`--skill`), Hermes (generated `AGENTS.md`) and Claude Code
(generated `CLAUDE.md`, falling back to a pointer line in the stdin task text when the repository tracks
one). The RPC adapters get the `.mercury-context.json` pointer plus prompt lines telling the agent to
read the context file and `.agents/skills/`; everything else gets only the neutral files.
(Pending #687: the *knowledge* line specifically — `buildPrompt()` in
`src/adapters/rpcAgentAdapter.ts` names the context file and the skills directory but does not
yet tell the agent to follow the `knowledge` block the context file carries to the pack file.
#687 adds that one line, to both the initial and the resume prompt.) **Only the PrimeAgent and Hermes channels have been seen on a real Run** -- the
Claude Code channel is new and unobserved, and section 10 says so in its row rather than here. Remote
agents get tier 2 only, because they execute on another machine with no workspace for the worker to
read.

What is **not** built, each re-checked against the tree rather than carried over from an earlier
revision of this page:

- **Atlas deletes nothing unless an operator asks it to.** A maintenance sweep runs hourly
  (`ATLAS_SWEEP_INTERVAL_MS`): it retires stale candidates and prunes replay-guard rows. Deletion is
  available — `POST /v1/projects/:project/notes/:noteId/delete`, and `ATLAS_RETIRED_TOMBSTONE_AGE_MS`
  for the sweep — and it is off by default, so retired notes accumulate until an operator opts in.
  Deletion is a **tombstone**, not a `DELETE`: it writes a final revision carrying a `seq`, so a
  replica advancing by cursor learns the note is gone instead of serving destroyed text forever.
  [#562](https://github.com/aywengo/mercury/issues/562) is closed: it landed the sweep and left
  deletion out, because the protocol could not express a safe deletion at all.
  [#590](https://github.com/aywengo/mercury/issues/590) is closed too — it specified the tombstone, and
  this page describes it as shipped. What is still unbuilt is a retention **policy**: how long a retired
  note is worth keeping is open question 6 of `docs/knowledge-base.md` §18, which is exactly why the
  default is off rather than 180 days.
- **Atlas refuses to start on a database that already holds two live notes for one claim.** A
  partial UNIQUE index enforces the one-live-note-per-claim rule (`atlas/db.ts`; migration v2 added
  it with `WHERE tier != 'retired'`, and migration v3 widened it to
  `WHERE tier NOT IN ('retired', 'deleted')` so a tombstone does not hold its claim hostage
  forever), and a precheck names the colliding note ids rather than surfacing a raw constraint
  error. It will not
  resolve the collision for you: retiring one side is an operator decision, because Atlas does not
  pick a winner. Databases written before that migration can contain the collision, so an upgrade
  may need that manual step.
- **Gate outcomes are not reported.** No shipped harness declares deterministic gates and no gate
  outcome event exists, so the later phases of the knowledge design that would learn from gate
  results have nothing to read. The event vocabulary is deliberately absent rather than declared
  with no emitter behind it.
- **Hermes goal support** remains blocked upstream: the adapter has no version probe, so goal
  fields for `hermes` report `version-unknown` as a steady state.

The `knowledge` flag in the `static` block of `/api/agents` is an adapter's own declaration about
itself and is unverified for every shipped backend. It is not evidence that a particular installed
harness reads the files Mercury writes.

Design and invariants: [`knowledge-base.md`](knowledge-base.md).

### Distribution

Five channels, all built by the release workflow in `release.yml`; what each artifact
contains and how it is produced is owned by
[`distribution.md`](distribution.md):

| Channel | Command |
| --- | --- |
| Git checkout | `git clone https://github.com/aywengo/mercury.git`, then `npm ci` (which compiles `dist/` as part of installing) |
| npm | `npm install -g @aywengo/mercury` |
| GitHub Release | bundle asset attached to the `host-v*` tag |
| Homebrew | `brew tap aywengo/mercury https://github.com/aywengo/mercury` then `brew install mercury-ai` |
| Host installer | `curl -fsSL https://github.com/aywengo/mercury/releases/latest/download/install.sh \| bash`, or `npx @aywengo/mercury host install`; guided setup + doctor, see [`host-installer.md`](host-installer.md); asset ships with the next host release (0.1.0/0.1.1 predate it) |

`mercury-ai` is the formula name because homebrew-core already owns `mercury`: that is the
Mercury language compiler, and installing it fetches roughly a gigabyte of a different
project. The formula lives in this repository and is generated by the release job from the
digest of the artifact it just built, so it cannot drift from the release.

Whether anything has been published yet is not recorded here; see
[Releases](https://github.com/aywengo/mercury/releases).

### Operator CLI

`mercuryctl` is implemented and ships in the host package, so
`npm install -g @aywengo/mercury` puts it on `PATH`; it has no version of its own
and no tag of its own. It drives Runs over the public HTTP API: `agents list`;
`runs list`, `show`, `create`, `events`, `watch`, `input`, `cancel`, `retry`;
`config profiles`, `config current`; shell completion. Operator guide:
[`client.md`](client.md).

## Designed but not implemented

### Operator TUI

The terminal UI is Milestone 5 of the client design. It is deliberately not
built: the design gates it on demonstrated need for a TUI over the CLI and
dashboard, and that need has not been demonstrated. See
[`cli-tui-design.md`](cli-tui-design.md) for the architecture, protocol
contracts and milestone roadmap.

### Crew

Crew is being designed as four staged products:

1. builtin Role Presets;
2. generic per-run MCP with enforceable policy;
3. Git-backed preset distribution and owner drafts;
4. bounded Workflow Templates.

Milestone A (builtin Role Presets: registry, Run resolution and snapshots,
read API, dashboard Roles page) is implemented and reviewed; see
[`crew/roadmap.md`](crew/roadmap.md) for what shipped in each phase. Per-run
MCP, Git-backed preset distribution and owner drafts, and Workflow Templates
remain design-only.

### OIDC/SSO

Replacing token-to-owner mappings with a real identity provider remains open.
It should be designed together with durable/shared browser sessions when more
than one API process is required.

### Destination-aware egress

Named network destinations remain design-only. Do not treat recorded
`allowedNetworks` strings as enforced allowlists.

## Recommended priority

1. Add identity and shared API state only when multi-user or multi-API
   deployment requires it.
2. Add destination-aware network policy before generic HTTP MCP. This gates Crew
   Milestone B: `allowedNetworks` names do not yet restrict destinations, so
   per-run MCP would be advertised on top of a boundary that does not hold.
3. Reverify and repair daemon mode only if resident PrimeAgent sessions provide
   concrete value over RPC.
4. Implement Crew in the dependency order documented in its roadmap. Its Phase 0
   correctness prerequisites and Milestone A (Role Presets, Phases 1-3) are
   complete; Milestone B waits on item 2 above.

## Sources of truth

- behavior and invariants: [`ARCHITECTURE.md`](../ARCHITECTURE.md);
- first-run instructions: [`QUICKSTART.md`](../QUICKSTART.md);
- deployment: [`deploy/README.md`](../deploy/README.md);
- daemon verification: [`daemon-agent-sessions.md`](daemon-agent-sessions.md);
- Crew phases: [`crew/roadmap.md`](crew/roadmap.md);
- current test outcome: `npm test`, not a stored count.
