# Harness capabilities and best-fit placement

Status: **design only.** Nothing here is implemented.

This document exists because the point of Crew plus Fleet is **heterogeneous**:
PrimeAgent, Hermes, Pi, Oh my Pi and Claude on one fleet, each used where it is
strongest, each keeping its own configuration. That goal is not implementable
today, and the reason is a single missing field.

## 1. What already works

Mercury already registers foreign harnesses without per-agent code.
`rpc-agents/*.json` declares any CLI in the RPC JSONL protocol family:

```
rpc-agents/omp.json  id=omp  description="Oh my Pi (omp.sh) - coding agent with
                                 IDE wired in (Stencil Labs)"
                     command=omp  protocol{modeFlag,modeValue,ignoreEventTypes}
                     input{enabled:true}  resume{enabled:true}
rpc-agents/pi.json   id=pi   description="Pi Agent (pi.dev) - minimal terminal
                                 coding harness (Earendil)"
```

Built-in ids are `primeagent`, `fake`, `hermes`, `claude`; declarative ids add
`pi` and `omp`. Each harness authenticates through its **own** credential store
(`~/.pi/agent/`, `~/.omp/`, `~/.hermes/`, `~/.prime/`). The registry README states
this explicitly: "no Mercury secret plumbing needed."

That last property is worth defending. Mercury is not a configuration manager for
five vendors, and it should not become one.

## 2. The blocking gap

`GET /api/agents` returns, verified against a live 0.1.0 host:

```json
{"agents":["primeagent","fake","hermes","claude","omp","pi"],"defaultAgent":"primeagent"}
```

Bare names. The `description`, `input.enabled` and `resume.enabled` that the
registry already holds are not exposed, and there is no notion of strengths
anywhere. Fleet therefore cannot place work by best fit; it can only match a name
a caller typed. Every statement about "use Hermes for ops and PrimeAgent for code"
is currently unenforceable, because nothing on the wire says which is which.

## 3. Design: a declared capability and affinity descriptor

Extend the agent descriptor with two machine-readable blocks.

**Capabilities** — what this harness can do. A closed vocabulary, because an open
vocabulary degrades into prose and prose cannot be matched:

- `persona.append` — accepts appended system prompt (`primeagent` yes; `hermes`
  via profile file; `pi`/`omp` unknown until probed)
- `persona.workspaceFile` — reads persona from a workspace file
  (`AGENTS.md`, `SOUL.md`, `CLAUDE.md`)
- `humanInput` — maps to `input.required` (already `input.enabled`)
- `resume` — already `resume.enabled`
- `mcp`, `subagents`, `modelSelection`
- `skills.workspacePaths` — accepts skills as materialized workspace paths
  (PrimeAgent) versus `skills.nativeNames` — resolves skills in the harness' own
  store (Hermes). These are **not** interchangeable, and treating them as one
  `skills` flag is what makes Hermes unable to run any Run at all; see
  [`teams.md`](teams.md) §3. A harness with neither capability must receive no
  skills rather than a guess.

**Affinity** — where operators believe it is strong, as enumerated task domains:
`code-edit`, `code-review`, `ops-infra`, `long-autonomous`, `retrieval-heavy`,
`interactive`. Declared with a `source` field (`operator`, `vendor`, `measured`).

Be honest about affinity, per the `README.md` enforcement principle: **Mercury does
not measure agent quality.** Affinity is a declared preference with provenance,
never a score Mercury invented. Surfacing it as `source: "operator"` keeps a guess
from reading as a benchmark.

## 4. Placement

Fleet places a Run in two stages, and the split matters:

1. **Hard filter.** Required capabilities must exist on the target harness and
   host. Missing a required capability rejects placement — fail closed
   (invariant 9), never silently downgrade to a harness that will ignore the
   persona.
2. **Soft rank.** Affinity match, then capacity from `GET /healthz/workers`,
   then labels and locality.

Placement must be **explainable**: record and return the reason
(`capabilities matched, affinity code-edit via pi, capacity 2 idle workers`). A
scheduler that moves work to a harness nobody expected, with no stated reason, is
not debuggable by an operator at 3am.

## 5. Config ownership boundary

| Concern | Owner |
| --- | --- |
| Harness credentials, model provider config | the harness, in its own store |
| Persona, instruction, skills, constraints | Mercury Agent Template, snapshotted on the Run |
| Rendering a template into harness-native form | the adapter (`src/adapters/`) |
| Which harness to use for a given task | Fleet placement, from declared capability + affinity |

A template must never embed a path into `~/.hermes`, `~/.pi` or `~/.prime`. Those
are host state, not portable template content, and shipping them would both leak
host layout and break the moment two operators differ.

## 6. Consequences for the Fleet protocol

- `/api/agents` needs a richer response. It is inside the existing
  `fleet/src/child.js` allowlist, so this is a response-shape change, not a new
  route — but it is still a compatibility change.
- There is **no version negotiation or capability handshake** between Fleet and a
  host today. Fleet identifies a host only by whether `/healthz` answers. A
  changed `/api/agents` shape therefore fails at first use against an old host.
  Add a version or capability field to `/healthz` as part of this work, not after.
- Fleet stays HTTP/JSON. Capability discovery does not justify a transport change;
  it is one more small JSON read at roughly the existing 15s probe cadence.

## 7. Open questions

1. Who authors affinity, and does a wrong affinity need a correction loop?
2. Should unknown capabilities fail closed or fail visible-but-unranked? Fail
   closed is safer for personas and harsher for new harnesses.
3. Do `pi` and `omp` accept appended persona at all? Unverified. Probe before
   promising mixed-harness teams that include them.
