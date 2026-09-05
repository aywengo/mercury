# Fleet

Fleet manages several independent Mercury instances from one place. It is a federation layer: it talks to
each Mercury over its public HTTP API and never touches a Mercury database or imports Mercury code.

Design: [`docs/fleet-design.md`](../docs/fleet-design.md). All six build phases are shipped: registry and
probe, dispatch, reconciliation, event aggregation, routing, interaction, and the metrics rollup.

Two surfaces, deliberately different:

- **`fleet` (this CLI)** — the host registry, probing, and credential inspection. Local, interactive, no
  network service of its own.
- **`fleet serve` (the service)** — everything that has to outlive the person who started it: submitting
  Runs, routing them, reconciling their state, aggregating events, and the Prometheus rollup. See
  [Service](#service) below.

Version `FLEET_VERSION` lives in [`version.ts`](version.ts) and must match
[`package.json`](package.json). Changelog: [`CHANGELOG.md`](CHANGELOG.md).
`fleet --version` prints `mercury-fleet <version>`. `GET /healthz` includes
`product: "fleet"` and that same version.

## Quick start

```bash
# 1. Child credentials live in a 0600 file, referenced by name. Never a command-line argument: argv is
#    world-readable through ps, and Fleet holds a credential for every Mercury it can reach.
mkdir -p ~/.fleet && chmod 700 ~/.fleet
cat > ~/.fleet/credentials.json <<'JSON'
{ "mac-studio": "<token from that host's MERCURY_API_TOKENS>" }
JSON
chmod 600 ~/.fleet/credentials.json

# 2. Register hosts and look at them.
npm run fleet -- hosts add mac-studio --url https://studio.lan:3000 --credential mac-studio
npm run fleet -- hosts list --live
```

```
ID         STATE      SEEN  WORKERS  RUNS  QUEUE  AGENTS  URL
mac-studio up         0s    1        2     0      5       https://studio.lan:3000
box-lan-2  auth-fail  0s    0        0     3      -       http://box2.lan:3000
    box-lan-2: HTTP 401 from /api/agents: the host is reachable but this credential was rejected.
box-lan-3  down       4m    -        -     -      -       http://box3.lan:3000
```

## Commands

| Command | Does |
| --- | --- |
| `fleet hosts add <id> --url <base> --credential <ref> [--label k=v] [--path <abs>] [--disabled]` | Register a host. `--credential` names a ref; the secret is never an argument. |
| `fleet hosts list [--json] [--live]` | Show hosts with their last probe. `--live` probes first. |
| `fleet hosts probe [<id>] [--json]` | Probe now. Exits non-zero if the host is unusable, so it composes in a readiness check. |
| `fleet hosts enable\|disable <id>` | Include or exclude a host from sweeps. |
| `fleet hosts rm <id>` | Forget a host and its cached probe. |
| `fleet probe --watch` | Sweep every enabled host on `FLEET_PROBE_INTERVAL_MS` until interrupted. |
| `fleet credentials list` | Credential **names** only. Values are never printed by any command. |

## What each state means

The states are deliberately not collapsed into up/down. Each one sends the operator somewhere different,
and a probe that reports "down" for a host that is healthy but rejecting our token wastes the operator's
time on the wrong machine.

| State | Means | Fix |
| --- | --- | --- |
| `up` | Reachable, queue configured, credential accepted. | — |
| `auth-fail` | Host is fine. Our credential is not. | Check the ref in the credential file. |
| `no-worker` | API answers, but its queue is not configured, so it executes nothing. | Start that host's worker. |
| `down` | Nothing listening. | Host, port, or `MERCURY_BIND_HOST`. |
| `timeout` | Something answered too slowly to trust. | Load, or a half-dead process. |
| `not-mercury` | A server is there; it is not a Mercury API. | Wrong port or URL. |
| `http-error` | Unexpected status from a Mercury endpoint. | Check that host's logs. |
| `never-probed` | Registered, not swept yet. | `fleet hosts probe`. |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEET_DB` | `fleet.db` | Fleet's own SQLite database, separate from every Mercury's. |
| `FLEET_CREDENTIALS_FILE` | `~/.fleet/credentials.json` | Must be mode `0600`; Fleet refuses otherwise. |
| `FLEET_PROBE_INTERVAL_MS` | `15000` | Sweep interval for `probe --watch`. |
| `FLEET_PROBE_TIMEOUT_MS` | `5000` | Per-request timeout. A hung host must not stall the sweep. |
| `FLEET_ALLOW_INSECURE_CREDENTIALS` | unset | `1` bypasses the mode check. For filesystems that cannot do `0600`. |

> The default is laptop-shaped on purpose, for development. Fleet runs as a **service**
> ([`docs/fleet-design.md` §15](../docs/fleet-design.md#15-fleet-as-a-service)), and a hardened unit sets
> `ProtectHome=true`, which cannot read anything under a home directory. A service deployment sets
> `FLEET_CREDENTIALS_FILE=/etc/fleet/credentials.json` explicitly instead of relying on this default.

## Service

`fleet serve` runs the HTTP API. It binds `127.0.0.1:3100` by default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `FLEET_BIND_HOST` | `127.0.0.1` | Bind address. |
| `FLEET_PORT` | `3100` | Listen port. |
| `FLEET_API_TOKENS` | unset | `token:owner[:hosts]`, comma-separated. `hosts` scopes a caller to a subset. |
| `FLEET_ADMIN_TOKEN` | unset | A caller that may see and change every host. |
| `FLEET_TLS_CERT` / `FLEET_TLS_KEY` | unset | Both or neither. Required to bind beyond loopback. |
| `FLEET_SWEEP_INTERVAL_MS` | `10000` | How often bindings are reconciled against every host. |
| `FLEET_STREAM_POLL_MS` | `1000` | Poll interval behind the aggregated Run stream. |
| `FLEET_REPO_URLS_FILE` | unset | `localPath` → git URL map used by the router. |

**It refuses to start in an unsafe configuration**, rather than serving and leaving discovery to an audit:
binding beyond loopback without TLS, half a TLS pair, or no caller tokens at all each fail at startup with
the reason. A Fleet token reaches every Mercury in the fleet, so plaintext on a shared network is not a
deployment someone should arrive at by omission.

| Endpoint | Does |
| --- | --- |
| `GET /healthz` | Liveness, with `product: "fleet"` and the version. Unauthenticated. |
| `GET /metrics` | Prometheus rollup across hosts, every series relabelled `host="<hostId>"`. |
| `GET\|POST /fleet/hosts` | List and register hosts. |
| `POST /fleet/hosts/:id/enable`, `.../disable`, `DELETE /fleet/hosts/:id` | Include or exclude a host from sweeps. |
| `POST /fleet/hosts/:id/probe` | Probe one host now. |
| `POST /fleet/runs` | Submit a Run. Name a `host`, or omit it and let the router choose. |
| `GET /fleet/runs` | Every Run across the fleet, one merged view. |
| `GET /fleet/runs/:id` | One Run, with its binding and current child state. |
| `GET /fleet/runs/:id/events`, `.../stream` | Aggregated history and SSE for a fleet Run. |
| `POST /fleet/runs/:id/input`, `.../cancel`, `.../retry` | Answer, cancel, or retry through Fleet. |
| `POST /fleet/probe` | Sweep every enabled host. |

Changing the registry — adding, removing, enabling or disabling a host, and sweeping — requires the admin
token. Reads and Run submission do not, but are scoped: a caller limited to a subset of hosts cannot route
work onto a hidden host, read another host's Run, or learn another host's queue depth from `/metrics`.
Routing failures name every host considered and why each was excluded, because "no host matched" without
reasons is an hour of guessing.

## Two rules this directory is built around

**Nothing here imports from `src/`.** Fleet speaks HTTP so that it can drive a Mercury it did not build.
`fleet/test/coupling.test.ts` enforces this, and includes tests proving the guard can actually fire.

**`hosts` is truth; everything else is cache.** Probe results live in their own table, so deleting them
costs one sweep. That split is what makes a Fleet crash cheap: the registry survives, and nothing Fleet
holds can orphan a Run on a machine nobody is watching.

## Development

```bash
npm run test:fleet    # 187 tests, no network beyond localhost
npm run typecheck     # covers fleet/ as well as src/
```
