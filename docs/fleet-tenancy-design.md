# Fleet tenancy: projects over hosts

Status: **Specification.** Nothing in this document is implemented. Following the convention of
[fleet-design.md section 15](fleet-design.md#15-fleet-as-a-service): the present tense below describes
the intended model, and only section 2 describes behaviour, which was verified against the tree at the
time of writing.

This document answers open question 2 of [`docs/fleet-design.md`](fleet-design.md): *"Fleet inherits
per-caller host allowlists but no tenancy model."*

## 1. Problem

An allowlist answers one question: **which hosts may this caller act on.** Tenancy asks a different
one: **which hosts, Runs, metrics and knowledge belong together.** The two overlap and are not the
same, and the gap is reachable today in three ordinary situations:

- **Two teams, one Fleet.** A caller token scoped to `*` — convenient for the operator who set it up —
  can route work onto every host, read every Run, and scrape every host's metrics. Narrowing it later
  means enumerating hosts in the token string and re-issuing it whenever the fleet grows.
- **One team, many hosts, several products.** Host allowlists partition by *machine*, but the thing
  people actually want partitioned is the *product*: its hosts, its Runs, its dashboards, its
  knowledge. Enumerating machines is a poor proxy for belonging, and it rots.
- **Shared infrastructure.** A build machine legitimately serving two projects cannot be marked as
  belonging to either, and nothing records which project a finished Run was placed under.

Labels cannot close this gap (section 8). The missing concept is a partition hosts can *belong* to,
 enforced by Fleet against the caller rather than declared by the caller.

## 2. Where isolation stands today

Verified against `fleet/auth.ts`, `fleet/server.ts`, `fleet/routing.ts`, `fleet/bindings.ts`,
`fleet/registry.ts`, `fleet/db.ts` and `fleet/config.ts`:

| Mechanism | What it actually does | What it does not do |
| --- | --- | --- |
| `FLEET_API_TOKENS` (`token:owner[:hosts]`, `fleet/auth.ts`) | Bearer authentication; per-caller host allowlist; omitting the host list grants **nothing**; `*` grants everything | No partition of hosts among callers; `owner` is a self-declared string |
| `visibleHosts()` (`fleet/server.ts`) | The single choke point for caller-facing host visibility: admins and `*` see everything, others are filtered by allowlist. Routing candidates, run lists, run reads, events and metric series all derive from it | Nothing partition-shaped exists to filter by |
| Hidden-host semantics | A host outside the caller's set is `404`, not `403` (§15.3); routing exclusion lists name only hosts actually considered | — |
| Host labels + routing selectors (`fleet/routing.ts`) | Caller-*chosen* preference filter over operator-declared labels | Nothing requires a label to exist, to be unique, or to be exclusive; a `*` caller ignores them by construction |
| `fleet_runs` (`fleet/bindings.ts`) | Records `host_id`, `owner_id`, the binding, and a status cache | No project, no product, no tenant field of any kind |
| `HostRegistry.remove` (`fleet/registry.ts`) | Refuses to delete a host with bound Runs; `force` is explicit | No equivalent guard for *reassigning* a host (the concept does not exist) |
| Atlas read (`FLEET_ATLAS_*`, `fleet/atlas.ts`) | Exactly **one** project per Fleet process, one summary, no per-caller view | Cannot show project P to the P team and project Q to the Q team |

The structural observation that makes tenancy cheap: **caller-facing visibility already flows through
one function.** Everything a caller can see or do is derived from `visibleHosts()`. A partition that
narrows that function's output inherits every scoped surface at once — routing, run lists, run reads,
event streams, metrics — without each surface growing its own tenancy rule.

## 3. The one rule

> **Tenancy narrows; it never grants.**

A project can only remove hosts from a caller's view, never add one. The composition with the
existing allowlist is an intersection, so no token gains access it did not have, and a Fleet with no
projects behaves exactly as it does today — the migration story is a side effect of the rule rather
than a special case.

Two consequences are load-bearing:

- **Assignment removes; a grant puts back.** Assigning a host to a project takes it out of the
  default pool. Only a caller granted that project sees it again. The failure mode of getting this
  backwards — grants that widen — is how a tenancy boundary erodes one convenience at a time.
- **A Run's placement is fixed at bind time.** One Run, one host, for life (§14.4 of the Fleet
  design), and therefore one project for life. Hosts may be reassigned between projects when idle;
  Runs never move with them.

## 4. The model

Three facts, all stored in Fleet's own database. Children stay unmodified — tenancy is a property of
the caller-facing view, never of a Mercury host. No child ever learns that a project exists.

### 4.1 Project

An operator-assigned partition: a stable id (`alpha`), an optional display name, a creation
timestamp. Flat — no nesting, no hierarchy. A project with no hosts and no members is legal and
useful: it is the placeholder you create before assigning anything to it.

### 4.2 Assignment (host → project)

Each host is in **zero or one** project. `hosts.project_id` is a nullable foreign key; `NULL` means
unassigned. Exclusivity is structural — a column, not a convention — which is the property labels
could never give (section 8).

### 4.3 Membership (caller → project)

`project_members(project_id, owner)` grants a caller identity access to a project. The join key is
`ownerId`, which already exists on every token entry, so:

- **Rotating a token does not touch grants.** The token string changes; the owner does not. Baking
  projects into the token format (a fourth colon field) would couple credential rotation to
  authorization changes — the mistake §9 exists to prevent in the child-credential path.
- **Grants are state, not configuration.** They live in the database next to the registry, managed
  through admin routes and the CLI, inspectable at runtime. An environment variable would make grants
  restart-only and invisible to the API that needs to explain them.

### 4.4 The visibility rule

```
visible(host, caller) =
    caller.isAdmin                      ? all hosts
  : allowlistMatch(caller, host)        ? ( host is unassigned          ? true
                                          : project(host) ∈ grants(caller) )
  :                                       false
```

- **Unassigned is the default pool.** Any allowlisted caller sees unassigned hosts. This is what makes
  adoption non-breaking: with zero assignments, every host is unassigned and every caller's view is
  exactly today's. The rule also keeps the operator flow sane — a freshly registered host is usable
  before anyone files it under a project.
- **Assigned hosts are visible only through a grant** (or to an admin). A `*` token loses access to a
  host the moment it is assigned, and regains it only when granted. That narrowing is the feature.
- The risk is named rather than hidden: a host someone forgot to assign lands in the default pool and
  is visible to every allowlisted caller. That is an *inclusion* error, not a cross-project leak — no
  caller ever sees a host from another project by accident. `hosts list` gains a project column and
  marks unassigned hosts, so the omission is visible in the normal operator view. The strict
  alternative (unassigned invisible to non-admins) is recorded as open question 2.

## 5. What falls out unchanged

Because visibility already flows through one choke point (section 2), these inherit tenancy without
growing rules of their own:

- **Routing.** `routeRun` receives only the caller's visible hosts. Failure reasons enumerate hosts
  the caller may see; a host from another project cannot be named in an exclusion, because it was
  never considered. Explicit placement of a hidden host is `404`, matching the §15.3 decision.
- **Run lists and reads.** `GET /fleet/runs` and `GET /fleet/runs/:id` are already scoped by host
  visibility; project scoping rides the same filter.
- **Events and streams.** Scoped by run visibility, which is scoped by host visibility.
- **Metrics.** `/metrics` already relabels and exposes only the caller's hosts; the rollup code is
  untouched.
- **Idempotency.** Still per-owner; unchanged.
- **Fleet's internals.** The prober, the sweep, dispatch recovery and the metrics scraper run
  server-side with full registry access. Tenancy never restricts what *Fleet* may read from a child —
  only what a *caller* may ask Fleet for. This is the same split as §2 of the Fleet design: Fleet's
  own work is not the caller's view.

## 6. What must change

### 6.1 Schema

One migration in the numbered series in `fleet/db.ts`:

```sql
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,          -- operator-assigned slug, like hosts.id
  name       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner      TEXT NOT NULL,
  PRIMARY KEY (project_id, owner)
);

ALTER TABLE hosts      ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE fleet_runs ADD COLUMN project_id TEXT;   -- snapshot at bind time; audit/display only

CREATE INDEX idx_hosts_project ON hosts(project_id);
```

`projects` and `project_members` are **truth** in the §5 sense: losing them changes who can see what,
so they belong in the same backup class as `hosts` and `fleet_runs`. `fleet_runs.project_id` is a
snapshot recorded at bind time, never updated afterwards, and **never consulted for authorization** —
scoping follows the host's *current* project, live, so there is exactly one fact that decides
visibility. The snapshot exists so `GET /fleet/runs` can say where a Run was placed even after its
host was reassigned, and so an audit can answer "which project paid for this Run".

### 6.2 Registry guards

- `hosts` gains `--project` on add, and an assign/unassign operation.
- **Reassignment refuses while the host has non-terminal bound Runs** — the same rule, and the same
  message shape, as `HostRegistry.remove`: moving a host mid-Run would shift the Run's visibility out
  from under the team that submitted it. `force` is explicit, and records it.
- Deleting a project refuses while hosts are assigned or members are granted; unassign and revoke
  first, or pass force.

### 6.3 API surface

Enumerated additions to the §15.4 table, admin-only except the read:

| Endpoint | Does |
| --- | --- |
| `POST /fleet/projects` | Create (`{ id, name? }`) |
| `GET /fleet/projects` | Admin: every project. Caller: projects they are granted — ids and names only |
| `DELETE /fleet/projects/:id` | Delete, guarded per 6.2 |
| `POST /fleet/projects/:id/hosts` | Assign a host (`{ host }`); refuses while it has non-terminal Runs |
| `DELETE /fleet/projects/:id/hosts/:hostId` | Unassign — back to the default pool |
| `POST /fleet/projects/:id/members` | Grant an owner (`{ owner }`) |
| `DELETE /fleet/projects/:id/members/:owner` | Revoke |

CLI mirrors: `fleet projects add|list|rm`, `fleet projects assign|unassign`, `fleet projects
grant|revoke`; `hosts list` gains a `PROJECT` column.

### 6.4 Startup warning

`parseCallerTokens` already surfaces unrestricted owners for a startup warning. Tenancy adds its own:
when assigned hosts exist and a token owner has no grants, say so and name the owner — the silent
version of this (a team token that quietly sees only the default pool) is exactly the §15.2 class of
failure, where configuration is wrong in a way the process cannot see.

## 7. Adoption sequence

1. **Create projects.** No behaviour change; nothing is assigned yet.
2. **Assign hosts.** Each assignment is the act of partitioning: from that moment, callers without the
   grant lose that host. The assign command reports which owners lose visibility — computable from
   the token allowlists and current grants — so the narrowing is announced, never discovered.
3. **Grant owners.** `fleet projects grant alpha team-a` restores the team's view.

Every step is reversible by unassigning. No token format changes; no restart is needed; a Fleet that
never creates a project never changes behaviour.

## 8. Why not labels

The obvious objection: hosts already carry labels, so why not `project=alpha` plus a selector? Because
every property tenancy needs is the opposite of what labels have:

| Tenancy needs | Labels provide |
| --- | --- |
| Exactly one project per host, enforced by the registry | Multi-valued, optional, no exclusivity |
| A boundary Fleet enforces **against** the caller | A filter the caller **chooses** to pass |
| Invisible hosts are `404`, indistinguishable from absent | A `*` caller sees every labelled host by construction |
| Survives an operator forgetting a selector | Enforcement depends on every caller remembering one |

Labels stay what they are good at: operator-declared facts used as routing preferences. Tenancy is an
authorization property, and authorization that relies on callers cooperating is not authorization.

## 9. What this is not

- **Not authentication.** `owner` remains a self-declared string in `FLEET_API_TOKENS`. Tenancy
  partitions what a token may do; it does not make the identity real (open question 1).
- **Not per-tenant children.** No child configuration, no child API changes, no proxying by project.
  The §9 rule that Fleet never forwards credentials or proxies arbitrary paths stands untouched.
- **Not quotas.** Mercury does not enforce token/cost budgets today (`docs/status.md`); per-project
  quotas would inherit that gap while looking like they close it. Out of scope until budgets are real.
- **Not run migration.** One Run, one host, one project, for life. The snapshot records placement; it
  does not move anything.
- **Not a replacement for separate Fleet instances.** One Fleet per project remains the *stronger*
  boundary — separate process, database, credentials, blast radius. Projects are for one operator, or
  one trust domain, that legitimately manages several products' hosts and wants them partitioned
  inside the tool they already run.

## 10. Build plan

Each phase is independently useful and ships behind its own PR, per the repository's issue loop.

**Phase T0 — model and surface, behaviour-inert (small).** The migration, the `projects` and
`project_members` tables, the admin routes and CLI. Acceptance criterion: with zero projects and zero
assignments, the entire existing suite passes **unmodified** — the inertness is a test, not a claim.

**Phase T1 — scoping engages (medium).** The visibility rule in `visibleHosts()`, `GET /fleet/runs`
scoping, the startup warning, per-caller `GET /fleet/projects`. Tests must prove the negative
directions: a routing exclusion list never names a host outside the caller's visibility; a run bound
to an assigned host is `404` to an ungranted caller, not `403`; metric series for other projects are
absent, not zero; the default pool behaves exactly as the pre-tenancy fleet for ungranted callers.

**Phase T2 — guards and audit (small).** Reassignment and delete guards, the assign command's
lost-visibility report, the `fleet_runs.project_id` snapshot surfaced in run views.

**Phase T3 — per-project Atlas dashboards (future).** Blocked on a per-project reader-token story
(open question 3). Until then the Atlas read stays single-project and unchanged.

## 11. Open questions

1. **Identity.** Tenancy over self-declared owner strings is partition, not identity. Real tenancy
   probably wants the same direction Mercury's status page notes for SSO; Fleet should inherit that,
   not invent a parallel identity system.
2. **Strict unassigned pool.** This document makes unassigned hosts visible to every allowlisted
   caller (inclusion-error risk, section 4.4). The strict alternative hides them from non-admins and
   breaks no legacy tokens only if every host is assigned first. Decide on the first real incident of
   a forgotten assignment, not before there is evidence either way.
3. **Per-project Atlas credentials.** The credentials file is a flat `ref → secret` map; a project→
   reader-token namespace (reserved ref prefix, or a separate file) needs design before T3. Whatever
   the shape, values stay out of argv and out of the database.
4. **Aggregation.** Should `/metrics` also serve per-project rollup series for admins, or is the
   per-host relabelled view filtered per caller enough? No use case has asked for the former yet.
5. **Project on submit.** Callers cannot name a project when submitting — the router already sees only
   their hosts, so a hint would be redundant. Revisit only if a caller legitimately holds grants on
   several projects and wants placement *pinned* to one; explicit host placement already covers the
   deterministic case.
