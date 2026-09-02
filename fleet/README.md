# Fleet

Fleet manages several independent Mercury instances from one place. It is a federation layer: it talks to
each Mercury over its public HTTP API and never touches a Mercury database or imports Mercury code.

Design: [`docs/fleet-design.md`](../docs/fleet-design.md). This directory is **Phase 0** — host registry and
probe. There is no dispatch yet; Fleet cannot start a Run.

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

## Two rules this directory is built around

**Nothing here imports from `src/`.** Fleet speaks HTTP so that it can drive a Mercury it did not build.
`fleet/test/coupling.test.ts` enforces this, and includes tests proving the guard can actually fire.

**`hosts` is truth; everything else is cache.** Probe results live in their own table, so deleting them
costs one sweep. That split is what makes a Fleet crash cheap: the registry survives, and nothing Fleet
holds can orphan a Run on a machine nobody is watching.

## Development

```bash
npm run test:fleet    # 48 tests, no network beyond localhost
npm run typecheck     # covers fleet/ as well as src/
```
