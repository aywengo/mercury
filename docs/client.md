# `mercuryctl` — operator guide

`mercuryctl` is the remote operator client for Mercury Runs. It talks to a Mercury server over its public
HTTP API and nothing else: it does not open the database, does not start a server or worker, and does not
need any server-side configuration to run.

If you want the raw HTTP API instead — no install, or a language the client does not cover — see
[remote-client-setup.md](remote-client-setup.md).

## Install

The client ships in this repository's package. After `npm install @aywengo/mercury`, `mercuryctl` is on
your `PATH`:

```bash
mercuryctl --version
```

Running from a source checkout works the same way, because the sources are TypeScript and Node 22.18+
runs them directly:

```bash
node client/bin.ts --version
```

There is no build step to remember. `npm run build:client` produces the JavaScript that the published
package points at, and the `prepare` script runs it automatically.

## Configure

Three layers, highest precedence first: a flag, then an environment variable, then a profile, then a
built-in default.

The usual setup is one config file and one credentials file, both under `$XDG_CONFIG_HOME/mercury`
(default `~/.config/mercury`):

```bash
mkdir -p ~/.config/mercury && chmod 700 ~/.config/mercury

cat > ~/.config/mercury/config.json <<'JSON'
{
  "currentProfile": "prod",
  "profiles": {
    "prod": { "url": "https://mercury.example.com:3000", "credential": "prod-token" },
    "staging": { "url": "https://staging.example.com:3000", "credential": "staging-token" }
  }
}
JSON

cat > ~/.config/mercury/credentials.json <<'JSON'
{ "prod-token": "REPLACE_ME", "staging-token": "REPLACE_ME_TOO" }
JSON
chmod 600 ~/.config/mercury/credentials.json
```

**The credentials file must be mode `0600`.** A group- or world-readable credentials file is refused
outright rather than read anyway.

**`credential` is a name, never the token.** It is a key into `credentials.json`. Pasting a token there
is refused at read time, because `config current` exists to echo your configuration back to you and would
otherwise print the secret into your terminal and into the bug report you paste from it. The refusal does
not quote the value either.

**There is no `--token` flag, on purpose.** `argv` is readable by every local process through `ps` and is
kept in your shell history. Use `MERCURY_CLIENT_TOKEN` or the credentials file.

For a single server with no config file at all:

```bash
export MERCURY_CLIENT_URL=https://mercury.example.com:3000
export MERCURY_CLIENT_TOKEN=...
mercuryctl runs list
```

Plain HTTP is accepted only for loopback. Any other host must be HTTPS, because the bearer token travels
on every request. There is no certificate-verification escape hatch anywhere in the client.

### Check what the client actually resolved

```bash
mercuryctl config profiles     # every profile in the file, and which one is current
mercuryctl config current      # the resolved settings, and which layer won each one
```

Both work offline and with no credential, so they are the first thing to run when something is
misconfigured. `config current` reports the source of each value:

```text
profile      prod  (profile)
url          https://prod.example.com:3000  (profile)
credential   prod-token  (resolved from file)
timeout      30000ms  (default)
caFile       system trust store
color        on  (default)
config file  /home/you/.config/mercury/config.json
```

The value in brackets is the layer that won, so a setting you cannot explain is a setting you can trace.
Above, nothing came from the environment; if `MERCURY_CLIENT_URL` had been set, `url` would read `(env)`
and that would be the answer to "why is it pointing there".


It never prints a credential value — only the name and where it came from.

## Everyday commands

```bash
mercuryctl agents list                       # what this server can run, and its default
mercuryctl runs list                         # newest first
mercuryctl runs list --status RUNNING        # filter by status
mercuryctl runs list --limit 20 \
                       --cursor "$(mercuryctl runs list --json | jq -r .nextCursor)"
                                             # next page; the cursor is opaque and is printed with the list
mercuryctl runs show <run-id>                # one Run, its skills, and a summary of its events
```

The cursor is **opaque**: pass it back verbatim and never parse it. `--status` is validated on the
client. The server silently ignores a status it does not recognise and
returns an unfiltered list, which is a wrong answer that looks right.

### Create a Run

```bash
# smallest useful form
mercuryctl runs create --task "fix the flaky test in test/queue.test.ts" \
                       --repo https://github.com/acme/widgets.git

# everything else comes from a file, which is the shape the API takes
mercuryctl runs create --file run.json

# read the request from stdin
cat run.json | mercuryctl runs create --file -
```

`--repo` accepts a git URL or a path. A path names a directory on the **worker**, never on your machine; a
bare path is never guessed at, because defaulting it would submit this client's working directory to a
host that has never seen it.

Creating a Run is **not** confirmed. It is the tool's main purpose, and prompting for it trains you to
type `--yes` without reading, which defeats confirmation where it matters.

Every create sends an `Idempotency-Key`, and by default it is a **fresh random UUID per invocation**. That
covers the case that actually bites: the client retries a timed-out create with the *same* key, so a
request that was accepted but not acknowledged cannot become two Runs.

It deliberately does **not** deduplicate two separate invocations. Re-running the same command twice
creates two Runs, because "submit this task again" is a normal thing to mean, and a content-derived key
would silently return the old Run instead.

If a create ends in an *indeterminate* state — the request went out and no answer came back — the client
says so and hands you the key, because that key is the only way to retry without risking a second Run:

```bash
$ mercuryctl runs create --task "..." --repo https://github.com/acme/widgets.git
mercuryctl: create did not complete after 2 attempt(s): socket hang up
The Run may or may not have been created. To retry safely, rerun with:
  --idempotency-key 6f1c0d2e-...
```

A create that is *definitely* rejected (bad request, wrong credentials) is reported as a plain failure and
does not tell you to reuse a key, because there is nothing uncertain to protect.

### Follow a Run

```bash
mercuryctl runs events <run-id>            # persisted history, one page
mercuryctl runs events <run-id> --follow   # history, then keep following
mercuryctl runs watch <run-id>             # follow to a terminal status, and encode the outcome in the exit code
mercuryctl runs events <run-id> --after 42 # resume from a sequence number
```

`runs watch` resumes from the server's `nextCursor`, never from the highest sequence it has seen. On a
truncated page those differ, and resuming from the latter skips every event the cap left out.

Ctrl-C stops **watching**. It never cancels the Run — an ordinary terminal interrupt must not become a
cancellation request.

### Answer, cancel, retry

```bash
mercuryctl runs input <run-id> --value "use option B"
mercuryctl runs input <run-id> --file answers.json
mercuryctl runs cancel <run-id>            # asks first
mercuryctl runs retry  <run-id>            # asks first; creates a NEW Run
```

`cancel` and `retry` are the two commands that prompt, because they are the two that cost something.
Declining exits `2` — stopped locally, nothing sent.

A prompt needs somewhere to prompt *to*, so both of these fail with exit `2` rather than hanging or
guessing:

```bash
mercuryctl runs cancel "$ID"          # stdin is not a terminal (cron, CI, a pipe)
mercuryctl runs cancel "$ID" --json   # machine-readable mode never prompts
```

Add `--yes` in both cases. The check happens **before** any read, which is what makes "this tool never
blocks on a prompt" true rather than usually true.

## Scripting

`--json` prints exactly one JSON value on stdout for every non-streaming command, with no colour and no
prompts. `runs events --follow` and `runs watch` are the exception: they write newline-delimited JSON, one
event per line.

Diagnostics — retries, prompts, the idempotency-key hint — go to **stderr**, so `--json | jq` still parses
when the command needed a retry to succeed.

```bash
# one Run as JSON
mercuryctl runs show "$ID" --json | jq -r '.run.status'

# every failed Run id from the last page
mercuryctl runs list --json | jq -r '.runs[] | select(.status=="FAILED") | .id'

# follow a Run as a stream
mercuryctl runs watch "$ID" --json | jq -c '{type, sequence}'
```

### Exit codes

Automation branches on these. They are stable contract: changing one is a breaking change that needs
compatibility review.

| Code | Meaning |
| --- | --- |
| 0 | succeeded; for `watch`, the Run completed |
| 2 | usage or local configuration error — nothing was sent |
| 3 | authentication failed |
| 4 | Run not found, or not visible to you |
| 5 | lifecycle conflict (e.g. cancelling a terminal Run) |
| 6 | rate limited, and the allowed wait ran out |
| 7 | transport, TLS, timeout or server failure |
| 8 | the event stream could not recover |
| 10 / 11 / 12 | the watched Run failed / was cancelled / timed out |
| 130 | interrupted (SIGINT) |

`runs events` exits `0` whatever the Run's status — it reports history, and a failed Run still has
perfectly good history. Only `runs watch` encodes an outcome, because that is the command you put in a
pipeline. If both encoded outcomes, `mercuryctl runs events "$id" || alert` would fire on every failed Run.

```bash
case $(mercuryctl runs watch "$ID" --json >"$out"; echo $?) in
  0)   echo done ;;
  10)  echo "run failed" ;;
  11)  echo "cancelled" ;;
  12)  echo "timed out" ;;
  130) echo "you stopped watching" ;;
  *)   echo "client or server problem" ;;
esac
```

## A server with a private certificate authority

Set `caFile` in the profile. It is per-profile, so trusting your internal CA for one server does not make
the client trust it for all of them.

```bash
cat > ~/.config/mercury/config.json <<'JSON'
{
  "currentProfile": "internal",
  "profiles": {
    "internal": {
      "url": "https://mercury.corp.example.com:3000",
      "credential": "corp-token",
      "caFile": "/etc/ssl/private/corp-ca.pem"
    }
  }
}
JSON
```

If the CA is wrong rather than missing, the connection fails — it is not downgraded and not trusted
anyway. A self-signed certificate with no `caFile` fails the same way, immediately.

## Shell completion

```bash
mercuryctl completion bash > /etc/bash_completion.d/mercuryctl     # bash
mercuryctl completion zsh  > "${fpath[1]}/_mercuryctl"             # zsh
mercuryctl completion fish > ~/.config/fish/completions/mercuryctl.fish
```

Completion resolves no configuration and makes no request, so it works before anything is set up.

## Troubleshooting

**`no endpoint configured`** — nothing to talk to. Check `mercuryctl config current`; it names the layer
that won. Note that a *declared but empty* `MERCURY_CLIENT_URL` counts as unset, so `MERCURY_CLIENT_URL=${UNSET_VAR:-}`
falls through to your profile rather than overriding it with nothing.

**`refusing plain HTTP for non-loopback host`** — the token would cross the network in clear text. Use
HTTPS, or point at a loopback address you have tunnelled:

```bash
ssh -L 3000:localhost:3000 bastion.example.com
mercuryctl --url http://localhost:3000 runs list
```

**`refusing to read ...: it is readable by group or others (mode 644)`** — `chmod 600` the file. The error
names the file, the offending mode and the fix, and never prints the token.

**exit 7 with a certificate message** — the server's certificate is not signed by a CA you trust. Set
`caFile`; do not look for a skip-verification flag, because there is none.

**`is not available in this build yet`** — your `mercuryctl` is older than the command you typed.
`mercuryctl --version` and `mercuryctl --help` tell you what this build does.

## What this client will not do

- Start or supervise a server or worker. That is `mercury server`, `mercury worker` and `mercuryctl`'s
  own process, which are separate on purpose.
- Read Mercury's database or workspace directories.
- Send a credential in a process argument, print one, or accept one in a config file's `credential` field.
- Fall back to plaintext, or to trusting a certificate it was not told to trust.
- Cancel a Run because you pressed Ctrl-C.
