# Remote client setup

Set up a machine that submits Runs to a Mercury server and watches them, using a PrimeAgent prompt to do
the install, the checkout, and the configuration.

## What this sets up, and what it does not

Mercury has **no client binary**. The remote surface is the HTTP API and the dashboard, and that is what
this doc drives: a machine that authenticates with a token, creates a Run, and tails its events.

It is worth being explicit about the thing this is *not*, because the shape of the question usually assumes
it: **the worker never calls back into Mercury over HTTP.** `src/cli.ts` opens the database directly with
`openDatabase(config.dbPath)`, and the worker's only outbound request of its own is the optional alert
webhook. There is no `MERCURY_API_URL` or equivalent — grep the config and you will not find a server
address for the worker to use.

(One qualification, so the claim is not overstated: `RemoteAgentAdapter` does make outbound HTTP calls, when
a Run is configured to drive a third-party SaaS agent over HTTP. That is traffic to *someone else's agent
API*, never to Mercury, so it does not change the conclusion — but "the worker makes no HTTP requests" would
be wrong.)

So "run the client on a remote host" means *submit and observe*, which works fine. Running the **worker** on
a second host against the same database does not: `MERCURY_DB` is a plain file path, there is no networked
database backend anywhere in the config, and SQLite in WAL mode cannot be shared over a network filesystem
without corrupting. That limitation and its options are written up in
[cross-process-event-push.md](cross-process-event-push.md) section 3.3 — multi-host scale is blocked on
storage, not on event delivery.

## Prerequisites

On the client machine:

| Need | Why |
| --- | --- |
| Node >= 22.18 | Mercury runs TypeScript directly via Node's type stripping (no build step) and stores state in `node:sqlite`. Both are load-bearing, and each sets part of the floor: `node:sqlite` is flag-free from Node 22.13 and type stripping without a flag from Node 22.18, so the requirement is the later of the two. Node 20 will not start; neither will 22.x below 22.18. |
| git | To check out the repository. |
| Network reach to the server | Default server bind is `127.0.0.1:3000`, so a remote client needs the server operator to have set `MERCURY_BIND_HOST`. |
| `bash`, `curl`, `python3` | The client script below is bash, drives every request with `curl`, and uses `python3 -c 'import json'` to build JSON and read `runId` out of the response. Node cannot substitute here without rewriting the script. All three are present on a typical Linux box and macOS; check them before blaming the server. |

`prime-agent` is **not** needed on a client machine. It is only required where the worker runs, because the
worker spawns it as a child process.

On the server, someone must have set:

```bash
MERCURY_BIND_HOST=0.0.0.0        # default 127.0.0.1 refuses remote clients
MERCURY_API_TOKENS=<token>:<owner>   # the token the client will be given
```

**If you set `MERCURY_BIND_HOST=0.0.0.0`, also configure TLS** (`MERCURY_TLS_CERT` + `MERCURY_TLS_KEY`).
The credential is a bearer token; without TLS it crosses the network in plaintext on every request. If TLS
is not configured, keep the client on the same host or behind a tunnel rather than on the open network.

## The PrimeAgent prompt

Paste this to PrimeAgent on the client machine. It installs, checks out, then stops to ask you for the
server address and token before it touches the network.

```text
Set up a Mercury client on this machine. Work in this order, and stop at the checkpoint before contacting
any server.

1. Check the toolchain. Run `node --version` and `git --version`. Node must be 22.18 or newer, because
   Mercury executes TypeScript directly through Node's built-in type stripping and uses the built-in
   node:sqlite module. If Node is missing or older, install a current LTS-or-newer Node using this
   machine's normal package manager, and show me the command before running it. Do not install anything
   with sudo without telling me first.

2. Check out Mercury into ~/mercury with `git clone`. If the directory already exists, run `git -C ~/mercury
   fetch --all --prune` and tell me what branch and commit it is on rather than resetting it.

3. Install dependencies with `npm install` inside ~/mercury. The runtime dependency list is a single
   package, express, and there are no native modules, so this should be quick. If it tries to compile
   anything, stop and tell me, because that means the dependency tree changed.

4. Verify the code runs locally without a server: `npm run typecheck`. Report the result. Do not run
   `npm test` — that is the repository's own suite and takes about half a minute; it is not needed to use
   the client.

5. CHECKPOINT — stop here and ask me for two things, and do not guess or default them:
   - the Mercury server address, as host and port (the server default port is 3000)
   - the API token
   Read the token with a prompt that does not echo it. Never put the token in a command line argument,
   because argv is readable by any process on the machine through ps; pass it through the environment or a
   file with mode 0600 instead. Never write it to a log, a shell history file, or any file you commit.

6. Write ~/mercury-client/submit.sh from the script in docs/remote-client-setup.md, section "The client
   script", and chmod 700 it. It reads MERCURY_URL and MERCURY_TOKEN from the environment. Store those two
   values in ~/mercury-client/env.sh with mode 0600, and add that path to ~/.gitignore if it is not there.

7. Verify connectivity with a read-only call: GET /api/agents with the bearer token. A 200 means the token
   and the address are both right. Interpret the failures distinctly rather than retrying blindly:
   - connection refused or timeout: the address is wrong, or the server is bound to 127.0.0.1
   - 401: the address is right and the token is not
   - 404: something is answering, but it is not the Mercury API
   Do not paper over a 401 by trying the admin token or a different path.

8. Run the client: submit the task I give you, print the returned runId, then follow the event stream until
   the Run reaches a terminal state. Show me each event type as it arrives. If the Run fails, fetch
   GET /api/runs/<runId> and report the error and errorKind fields verbatim.

Report at each numbered step rather than doing all eight and summarizing at the end. If any step fails,
stop and report what you saw instead of trying alternatives.
```

## The client script

This is the script step 6 writes. It is deliberately small: the API is the client, and a wrapper that adds
logic would be a second thing to keep correct.

```bash
#!/usr/bin/env bash
# Mercury client: submit a Run and follow its events.
# Reads MERCURY_URL and MERCURY_TOKEN from the environment. Never takes the token as an argument,
# because argv is world-readable through ps.
set -euo pipefail

: "${MERCURY_URL:?set MERCURY_URL, e.g. https://mercury.internal:3000}"
: "${MERCURY_TOKEN:?set MERCURY_TOKEN (never pass it as a command-line argument)}"
task="${1:?usage: submit.sh \"the task for the agent to do\" <git-url | path-on-the-worker>}"
repo="${2:?usage: submit.sh \"task\" <git-url | path-on-the-worker>}"

# The repository argument is resolved on the WORKER's filesystem, never on this machine. A git URL is the
# normal remote case -- the worker clones it. A bare path only names a directory the worker already has,
# so it is accepted but never guessed: defaulting it to "." would silently submit this client's current
# directory and fail with "localPath not found" on a host that has never seen it.
case "$repo" in
  *://*|git@*|*.git) repo_json="$(MERCURY_REPO="$repo" python3 -c \
      'import json,os; print(json.dumps({"url": os.environ["MERCURY_REPO"]}))')" ;;
  /*) repo_json="$(MERCURY_REPO="$repo" python3 -c \
      'import json,os; print(json.dumps({"localPath": os.environ["MERCURY_REPO"]}))')" ;;
  *) echo "repository must be a git URL or an ABSOLUTE path on the worker (got: $repo)" >&2; exit 2 ;;
esac

auth=(-H "Authorization: Bearer ${MERCURY_TOKEN}")
body_file="$(mktemp)"; trap 'rm -f "$body_file"' EXIT

# Read-only probe, before any Run is created. The status code is captured rather than swallowed by
# `curl -f`, because the three failure modes need different fixes and a generic "cannot reach" message
# sends you debugging the wrong one.
# On a failed connection curl still writes "000" via -w and exits non-zero, so the fallback must
# assign rather than append -- `|| echo 000` produced "000000" and fell through to the default branch.
status="$(curl -sS -o "$body_file" -w '%{http_code}' "${auth[@]}" "${MERCURY_URL}/api/agents" 2>/dev/null)" \
  || status=000
case "$status" in
  200) ;;
  000) echo "cannot reach ${MERCURY_URL}: refused, timed out, or the server is bound to 127.0.0.1" \
         "(the operator must set MERCURY_BIND_HOST)" >&2; exit 1 ;;
  401|403) echo "reachable, but this token was rejected (HTTP ${status}). The address is right and the" \
             "credential is not -- do not try the admin token or another path." >&2; exit 1 ;;
  404) echo "something answered, but it is not the Mercury API (HTTP 404 from /api/agents)" >&2; exit 1 ;;
  *) echo "unexpected HTTP ${status} from /api/agents: $(head -c 200 "$body_file")" >&2; exit 1 ;;
esac

# Build the payload in one place. Values travel through the environment rather than through shell
# quoting, so a task containing quotes, $, backticks or newlines cannot break the JSON or the command.
payload="$(MERCURY_TASK="$task" MERCURY_REPO_JSON="$repo_json" python3 -c \
  'import json, os; print(json.dumps({"task": os.environ["MERCURY_TASK"], "repository": json.loads(os.environ["MERCURY_REPO_JSON"])}))')"

# Idempotency. The key is the payload's content hash and NOTHING ELSE -- deliberately no PID or
# timestamp. An earlier version appended "-$$", which changes every invocation, so re-running after a
# transport failure produced a different key and paid for a second agent execution: the exact double-spend
# this header exists to prevent, while the comment claimed the opposite.
#
# Consequence: the same task+repository maps to one Run. Re-running prints the existing runId rather than
# starting a second one. To force a genuinely new Run of an identical task, set MERCURY_IDEMPOTENCY_KEY to
# anything new. Choosing reuse-by-default is deliberate: a surprising reuse is cheap and visible, a silent
# double-spend is neither.
key="${MERCURY_IDEMPOTENCY_KEY:-$(printf '%s' "$payload" | cksum | cut -d' ' -f1)}"

created="$(curl -sS -o "$body_file" -w '%{http_code}' "${auth[@]}" -H 'content-type: application/json' \
  -H "Idempotency-Key: ${key}" --data-binary "$payload" "${MERCURY_URL}/api/runs" 2>/dev/null)" || created=000
if [ "$created" != 201 ] && [ "$created" != 200 ]; then
  echo "submit failed: HTTP ${created} $(head -c 300 "$body_file")" >&2
  exit 1
fi

run_id="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["runId"])' "$body_file")"
echo "run ${run_id} (idempotency key ${key}; set MERCURY_IDEMPOTENCY_KEY to start a separate Run)"

# Follow the event stream: structured, sequenced events rather than a pipe of agent stdout.
curl -sS -N "${auth[@]}" "${MERCURY_URL}/api/runs/${run_id}/stream"
```

## Endpoints the client uses

All of these are behind `requireAuth`. `Authorization: Bearer <token>` is accepted directly, so no login
round trip is needed for scripting; the `mercury_session` cookie path exists for the dashboard.

| Method and path | Use |
| --- | --- |
| `GET /api/agents` | Which agents the server can run. Best connectivity probe: read-only, cheap. |
| `POST /api/runs` | Create a Run. Body takes `task`, `repository`, optional `repositories`, `agent`, `skills`, `constraints`. Returns `201` with `runId`. |
| `GET /api/runs` | List Runs, optionally `?status=`. |
| `GET /api/runs/:id` | One Run, including `error` and `errorKind` when it failed. |
| `GET /api/runs/:id/events` | Event history, paged by cursor. |
| `GET /api/runs/:id/stream` | Live events over SSE. |
| `POST /api/runs/:id/cancel` | Request cancellation. |
| `POST /api/runs/:id/input` | Answer a Run that is waiting on a human. |
| `POST /api/runs/:id/retry` | Retry. A terminal Run is never re-executed; retry creates a new Run with `retryOf`. |

## Troubleshooting

**Connection refused, but the server is running.** The server is almost certainly still on the default
`MERCURY_BIND_HOST=127.0.0.1`. That default is deliberate — it is the safe value for a host that has not
decided to be reachable. Set it explicitly, and read the TLS note above before doing so.

**401 on every call.** The token is not in the server's `MERCURY_API_TOKENS` map, or it was given to a
different owner. The address is fine; do not change it.

**401 only on some calls.** Runs are owner-scoped: a caller sees its own Runs and gets `404`, not `403`, for
someone else's. A `404` on a Run you know exists usually means a different token, not a missing Run.

**The stream opens and then goes quiet.** That is normal while the agent is thinking; events arrive as the
adapter translates them. If it stays quiet, `GET /api/runs/:id` still tells you the current status.

**Everything works from the server host but not from the client.** Check the bind host first, then TLS: an
`http://` client against a TLS-enabled server fails in a way that looks like a network problem.
