---
name: nightly
version: 1.0.0
description: Deterministic ladder selection for the unattended nightly loop — decides the next issue from GitHub metadata only (author, labels, timeline label actor), never issue text, then claims it with nightly:in-progress.
capabilities: [nightly, ladder, selection, trust, claim, triage, github, issues]
---

# nightly — ladder selection

`select.ts` decides what tonight's `nightly-next` Run works on. The decision is
CODE over GitHub metadata: author login, label names, and the actor of
`nightly:ready` labeling events from the issue timeline. An agent reading issue
bodies to choose work is the injection surface the trust rule (§5) closes.

## Run

```bash
GH_TOKEN=<token> node .agents/skills/nightly/select.ts --repo aywengo/mercury [--dry-run]
```

Output: exactly one JSON line.

- `{"rung":1,"issue":123,"reason":"..."}` — trusted bugs (`origin:e2e` filed by
  the nightly identity, or `nightly:ready` applied by @aywengo), priority label
  then age. Gated on
  tonight's `nightly-e2e` Run being terminal (`MERCURY_API_URL` +
  `MERCURY_API_TOKEN`; unset = gate passed).
- `{"rung":2,"issue":123,"reason":"..."}` — new @aywengo issues, no labels yet,
  oldest first.
- `{"rung":3,"reason":"..."}` — docs → proposals (§6): the nightly drafts the
  issue set itself; nothing to claim.
- `{"rung":"none","reason":"..."}` — no open issues.

## Trust rule (§5)

An issue is eligible only if authored by @aywengo, filed by the nightly
identity `mercury-nightly` from E2E (the issue's AUTHOR is
`mercury-nightly` AND the current `origin:e2e` label carries that identity as
its timeline actor — a label alone is provenance anyone with triage access can
apply, #764), or labeled `nightly:ready` by @aywengo — the actor comes from the
timeline's labeled events. `nightly:in-progress`, `nightly:blocked` and
`nightly:proposed` exclude an issue outright.

## Claim

The chosen issue is labeled `nightly:in-progress` BEFORE the decision is
printed. The label-add response decides: 2xx means the claim is ours; 422
already-exists means a concurrent or retried nightly won — the selector drops
that issue and re-selects. `--dry-run` prints the decision and writes nothing.

## E2E (`e2e.ts`, N1-2)

```bash
node .agents/skills/nightly/e2e.ts --repo aywengo/mercury [--dry-run] [--state <state-home-dir>]
```

`--state` relocates the flake-state STATE-HOME (the file lands at
`<state-home>/mercury/nightly/e2e-flakes.json`) — useful under CI/cron where
`XDG_STATE_HOME` is not set.

`GH_TOKEN` (or `GITHUB_TOKEN`) is demanded only when GitHub is actually
touched — a green suite and `--dry-run` need no credentials.

Runs `npm run test:e2e` once (the host needs Docker), reruns each failure ONCE
on its own file to separate flakes from defects, then:

- **Real failure** — fingerprinted (sha-256 of test name + normalized error;
  volatile ids, paths, durations and numbers stripped). Open issues are
  searched for the hidden marker `<!-- nightly-e2e-fp:<hash> -->`: a match gets
  a comment with the night's date; no match files a new `origin:e2e` issue
  carrying the marker in the body. Later nights comment, never re-file.
- **Flake** (passes on rerun) — listed in the report, never filed, until the
  same fingerprint has flaked on three DISTINCT nights (state at
  `${XDG_STATE_HOME:-~/.local/state}/mercury/nightly/e2e-flakes.json`); the
  third night files a flaky-test defect citing all three nights — exactly
  once (later nights only report the flake again).

The report is exactly one JSON line `{ pass, fail, real, flakes }`.

## Tests

`test/nightlySelect.test.ts` pins the ladder on fixture-shaped issues and
timelines: the trust rule, priority/age order, exclusions, the e2e gate, the
claim-before-return ordering, and the racer re-select.
