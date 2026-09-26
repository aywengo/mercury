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

## Tests

`test/nightlySelect.test.ts` pins the ladder on fixture-shaped issues and
timelines: the trust rule, priority/age order, exclusions, the e2e gate, the
claim-before-return ordering, and the racer re-select.
