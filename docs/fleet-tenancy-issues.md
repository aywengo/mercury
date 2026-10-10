# Mercury — Fleet tenancy issue set (projects over hosts)

**Filed 2026-10-09** by the nightly rung-4 path (docs → proposals, `docs/nightly-self-development.md` §6):
the issue set only, no implementation. Written against `main` at `dd3743b`, for
[`fleet-tenancy-design.md`](fleet-tenancy-design.md) §10.3 (the T0–T2 issue and PR sequence).
Nothing upstream blocks T0; T3 stays unfiled — it is gated on the design's open question 3
(the per-project Atlas credential shape).

Each issue follows the `issue-fix-loop` contract: one issue → one PR, regression tests, the
shipping PR updates the design doc's status marker in the same commit. All seven await the
operator's `nightly:ready` relabel.

## Status — filed 2026-10-09

| Order | Doc | Issue | Branch (per §10.3) | PR | Merge |
| --- | --- | --- | --- | --- | --- |
| 1 | T0-1 schema + `ProjectStore` | #884 | `feat/fleet-tenancy-store` | | |
| 2 | T0-2 admin routes + CLI | #885 | `feat/fleet-tenancy-surface` | | |
| 3 | T1-1 visibility rule | #886 | `feat/fleet-tenancy-scope` | | |
| 4 | T1-2 startup warning + per-caller projects | #887 | `feat/fleet-tenancy-warning` | | |
| 5 | T1-3 metrics/events negative-direction proof | #888 | `feat/fleet-tenancy-surface-proof` | | |
| 6 | T2-1 guards + lost-visibility report | #889 | `feat/fleet-tenancy-guards` | | |
| 7 | T2-2 bind-time project snapshot | #890 | `feat/fleet-tenancy-audit` | | |
| 8 | T3 per-project Atlas dashboards | not filed (blocked on open question 3) | — | | |

## Ordering rules (from the design doc §10.1–§10.2)

- **T0 is behaviour-inert.** #884's acceptance is the *entire existing suite green unmodified* —
  no test edited, not "tests still pass after edits". With zero projects the Fleet must be
  indistinguishable from the previous binary.
- **#886 (T1-1) is the one behaviour change in the whole rollout.** It carries the review
  requirement: mutation spot-checks on both authorization layers (`hostAllowed()` and the project
  composition bypassed separately), each of which must fail the suite.
- **#889 ships the lost-visibility report** — real partitioning should not start before it,
  per §10.5: assignment announces narrowing, never discovers it.
- **#890 keeps one fact deciding visibility**: `fleet_runs.project_id` is audit/display only;
  authorization follows the host's *current* project, live.
- Every shipping PR also updates §2's inventory row (once behaviour changes), `fleet/README.md`'s
  command table, `docs/README.md`'s blurb and `fleet/CHANGELOG.md` `[Unreleased]` — no install
  offers, per the releaseDocs guard.

## Tree facts checked (2026-10-09, `dd3743b`)

- Fleet migrations are a numbered series ending at **version 5** in `fleet/db.ts`, applied one per
  transaction with a `fleet_meta` version row — the §6.1 migration lands as v6.
- Caller-facing visibility flows through one function, `visibleHosts()` (`fleet/server.ts:101`);
  routing, run lists, run reads, events and metrics all derive from it.
- `HostRegistry.remove` already refuses to delete a host with bound Runs (`fleet/registry.ts`);
  #889 extends that discipline to reassignment, which today cannot be expressed.
- `parseCallerTokens().unrestrictedOwners()` exists (`fleet/auth.ts:30`) and is already used for a
  startup summary (`fleet/cli.ts:298`) — #887 reuses the surface for the tenancy warning.
- No `project` concept exists anywhere in `fleet/`; `fleet/test/coupling.test.ts` pins that
  `fleet/` imports nothing from `src/` — the issue set adds no external imports.
