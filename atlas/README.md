# Atlas

Atlas is a project knowledge base for Mercury. It holds curated notes submitted by Mercury hosts and serves
them to other hosts. A project's best insights are captured once in Atlas and reused by every host that
learns them, turning individual discoveries into collective knowledge.

Design: [`../docs/knowledge-base.md`](../docs/knowledge-base.md).

## How it works

- **Mercury hosts push what they learn.** When a Run discovers something worth keeping, the host submits a
  claim to Atlas.
- **Atlas curator approves claims.** An Atlas administrator reviews submissions and promotes the ones that
  are correct and broadly useful.
- **Mercury hosts pull what the project promoted.** Hosts periodically fetch the approved notes and use them
  to inform future Runs.

Atlas is one of three products: **Mercury** (the host), **Fleet** (federation layer over many hosts), and
**Atlas** (the project knowledge base).

## Configuration

All settings are environment variables prefixed with `ATLAS_`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATLAS_DB` | `atlas.db` | SQLite database path. |
| `ATLAS_BIND_HOST` | `127.0.0.1` | Bind address. |
| `ATLAS_PORT` | `4100` | Listen port. |
| `ATLAS_TLS_CERT` / `ATLAS_TLS_KEY` | unset | Both or neither. Required to bind beyond loopback. |
| `ATLAS_ADMIN_TOKEN` | unset | Bearer token for management operations. |
| `ATLAS_CONTRIBUTORS_FILE` | `~/.atlas/contributors.json` | Path to the contributors file. |
| `ATLAS_READER_TOKENS` | unset | Comma-separated `token:label:project1+project2` entries. |
| `ATLAS_SECRETS` | unset | Comma-separated secrets to seed the redactor. |
| `ATLAS_MAX_CLAIM_BYTES` | `1024` | Maximum size of a claim in bytes. |
| `ATLAS_MAX_DETAIL_BYTES` | `4096` | Maximum size of a detail in bytes. |
| `ATLAS_MAX_BATCH` | `500` | Maximum number of items in a batch request. |
| `ATLAS_RETIRED_TOMBSTONE_AGE_MS` | unset — never | Age at which the maintenance sweep turns a retired note into a tombstone, emptying its claim, detail and evidence while keeping its identity, its audit trail and a `seq` row replicas can apply. **Unset means Atlas never deletes a note**, and that is the default on purpose: the mechanism is safe, the retention policy is not settled yet. |
| `ATLAS_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, or `error`. |

**It refuses to start in an unsafe configuration**, rather than serving and leaving discovery to an audit:
binding beyond loopback without TLS, half a TLS pair, or other unsafe combinations each fail at startup
with the reason.

## What Atlas is not

- **Not a history store.** Atlas holds the project's best current knowledge, not a record of every
  discovery.
- **Not a retrieval service.** Atlas does not search, rank, or use embeddings. It serves exactly what the
  curator approved.
- **Not a place a model runs.** Atlas holds static notes. The model runs in Mercury; Atlas never executes
  code.
- **Not a secret store.** Do not submit credentials, API keys, or PII. Atlas redacts logs and is not a
  vault.
- **Not a second source of Run truth.** A Run's state lives in Mercury or Fleet. Atlas never contradicts
  that.
- **Not a judge of quality.** The curator decides what to approve. Atlas has no scoring, no feedback loop,
  no automatic filtering.

## Development

```bash
npm run test:atlas     # Run Atlas tests
npm run build:atlas    # Compile TypeScript
npm run atlas -- --help  # Print CLI help
```
