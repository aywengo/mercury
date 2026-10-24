# Running Mercury as a dedicated OS user

A Mercury host that shares an OS user with a person cannot keep the person's credentials away from
its Runs. This is the deployment that fixes that (#1060), and the reason the strict no-profile
default is not enough on its own.

## Why a user, and not an environment variable

CP-4 (`docs/configuration.md`) builds a per-Run environment and gives it to the agent process. That
covers what Mercury starts. It does **not** cover what the agent harness starts: `prime-agent` runs
tool commands in a kernel owned by its own daemon (`$TMPDIR/prime-agent-<uid>/daemon.sock`), which
was started outside the Run and keeps the environment it was started with. A `gh` there reads
`$HOME/.config/gh/hosts.yml`; a `git` there reads the login keychain.

Changing `HOME`/`TMPDIR`/`GH_CONFIG_DIR` for the worker only stops the *accidental* fallback: the
same UID can still read `/Users/<person>/.config/gh/hosts.yml` by absolute path. A separate UID is
the boundary — different home, different keychain, different `~/.prime`, different daemon.

On 2026-10-23 four nightly proposals were filed as the operator because of exactly this.

## What you keep

The person keeps their own login, their own terminal, their own `gh` session and their own
keychain. Nothing about their account changes. Mercury gets a second, ordinary user that owns the
host process, the Runs, the database and the workspaces.

## macOS: the migration

Written for a host where the person is `roman` and the new user will be `mercury`. Adjust paths.
Every step is reversible; the person's own files are copied, never moved.

### 1. Create the user (needs `sudo`)

```bash
sudo sysadminctl -addUser mercury -fullName "Mercury Host" -password - -home /Users/mercury -shell /bin/bash
```

A standard account: no admin, no GUI login needed, no iCloud. `-password -` prompts, so the password
never lands in shell history; it is used once and nothing logs in interactively afterwards.

### 2. Stop the host's services (the person's session)

```bash
for l in host worker bot.nightly laya copilot-relay; do
  launchctl bootout "gui/$(id -u)/com.mercury.$l" 2>/dev/null || true
done
```

Stopping first is what makes the database copy consistent: SQLite in WAL mode is safe to copy only
when no writer is running.

### 3. Give the new user its own state (needs `sudo`)

```bash
sudo install -d -o mercury -g staff -m 700 \
  /Users/mercury/.config/mercury \
  /Users/mercury/.local/state/mercury \
  /Users/mercury/.local/bin \
  /Users/mercury/mercury-workspaces

sudo cp -a /Users/roman/.config/mercury/mercury.env \
           /Users/roman/.config/mercury/credential-profiles.json \
           /Users/roman/.config/mercury/bot-credentials.json \
           /Users/mercury/.config/mercury/
sudo cp -a /Users/roman/.config/mercury/bots /Users/roman/.config/mercury/secrets \
           /Users/mercury/.config/mercury/
sudo cp -a /Users/roman/.local/state/mercury/mercury.db* /Users/mercury/.local/state/mercury/
sudo chown -R mercury:staff /Users/mercury
```

**Do not copy** `~/.config/gh`, `~/.gitconfig`, `~/.netrc`, or anything from the login keychain.
Those are the credentials this migration exists to remove.

### 4. Rewrite the paths inside `mercury.env`

```bash
sudo -u mercury sed -i '' \
  -e 's#^MERCURY_DB=.*#MERCURY_DB=/Users/mercury/.local/state/mercury/mercury.db#' \
  -e 's#^MERCURY_WORKSPACE_BASE=.*#MERCURY_WORKSPACE_BASE=/Users/mercury/mercury-workspaces#' \
  /Users/mercury/.config/mercury/mercury.env
```

Check every remaining absolute path in that file (`grep -n '/Users/roman' ...`): a host that still
points at the person's directories has not migrated.

### 5. Install Mercury and the harness for that user (needs `sudo`)

```bash
sudo -u mercury -H /opt/homebrew/bin/npm install -g @aywengo/mercury@0.2.4 --prefix /Users/mercury/.local
```

`prime-agent` keeps its own releases; copy the release directory and point the launcher at it:

```bash
sudo install -d -o mercury -g staff /Users/mercury/.local/share/prime-agent /Users/mercury/.prime/agent
sudo cp -a /Users/roman/.local/share/prime-agent/releases /Users/mercury/.local/share/prime-agent/
sudo -u mercury -H ln -sfn "$(ls -d /Users/mercury/.local/share/prime-agent/releases/* | tail -1)/prime-agent" \
  /Users/mercury/.local/share/prime-agent/bin/prime-agent
sudo cp -a /Users/roman/.prime/agent/models.json /Users/roman/.prime/agent/auth.json /Users/mercury/.prime/agent/
sudo chown -R mercury:staff /Users/mercury/.local /Users/mercury/.prime
```

Then pin the harness in `mercury.env` so a Run does not depend on `PATH`:

```
MERCURY_PRIMEAGENT_CMD=/Users/mercury/.local/share/prime-agent/bin/prime-agent
```

### 6. Run the services as that user

The installer writes **user** agents (`~/Library/LaunchAgents`), which need a GUI session for that
user. A dedicated service account has none, so use **system** daemons with `UserName` instead —
`/Library/LaunchDaemons/com.mercury.host.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.mercury.host</string>
  <key>UserName</key><string>mercury</string>
  <key>GroupName</key><string>staff</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>/Users/mercury/.local/state/mercury/run-host.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/Users/mercury/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/mercury/.local/state/mercury/host.log</string>
  <key>StandardErrorPath</key><string>/Users/mercury/.local/state/mercury/host.log</string>
</dict>
</plist>
```

The same shape for `com.mercury.worker` (`run-worker.sh`) and `com.mercury.bot.nightly`
(`bots/run-nightly.sh`), each with `UserName mercury`. Then:

```bash
sudo chown root:wheel /Library/LaunchDaemons/com.mercury.*.plist
sudo chmod 644 /Library/LaunchDaemons/com.mercury.*.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.mercury.host.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.mercury.worker.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.mercury.bot.nightly.plist
```

### 7. Decide what a leaking shell should find

The new user has no `gh` login, so a tool shell that escapes the per-Run environment **fails**:
`gh` says it is not logged in, and the Run reports the failure instead of becoming a person. That
is the safe default and the one to keep when in doubt.

If this host exists for one bot identity (design §12), you can instead give the service account that
identity, so the same shell resolves to the bot rather than dying mid-Run:

```bash
sudo -u mercury -H /opt/homebrew/bin/gh auth login --hostname github.com --with-token \
  < /Users/mercury/.config/mercury/secrets/mercury-nightly.pat
sudo -u mercury -H /opt/homebrew/bin/gh auth status     # account mercury-nightly
```

Either choice is a host-level credential; neither is the operator's. The difference is only whether
an escaping shell does the right thing or stops.

### 8. Verify the boundary, not just the uptime

```bash
curl -s http://127.0.0.1:3000/healthz
sudo -u mercury -H /Users/mercury/.local/bin/mercury host doctor     # agent credentials: PASS
sudo -u mercury -H gh auth status                                    # "not logged into any hosts"
```

`agent credentials: PASS` is the assertion that matters: the worker's user has no `gh` login of the
operator's and no `github.com` keychain entry, so a tool shell that falls back cannot become a person.

Then prove it from inside a Run — the probe in #1060's acceptance. Create a Run whose task is one
tool command and read the result:

```bash
curl -s -X POST http://127.0.0.1:3000/runs -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agent":"primeagent","prompt":"Run exactly: gh api user --jq .login ; whoami ; echo \"GH_CONFIG_DIR=$GH_CONFIG_DIR\""}'
```

The identity must be `mercury-nightly` (or the command must fail with "not logged in" if you kept
step 7's safe default), `whoami` must be `mercury`, and never `aywengo`.

### Rollback

The person's files were copied, never moved. Stop the daemons and bring the old agents back:

```bash
for l in host worker bot.nightly; do sudo launchctl bootout system/com.mercury.$l 2>/dev/null || true; done
for l in host worker bot.nightly; do launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.mercury.$l.plist; done
```

The old database was not modified, so the old host resumes where it stopped.

## Linux

The same shape with a system user: `sudo useradd --create-home --shell /usr/sbin/nologin mercury`,
copy the state and rewrite the paths, then install the systemd units from `deploy/` with
`User=mercury` (they already read `/etc/mercury/mercury.env`).

## What this does not fix

- A harness that stores credentials **inside** the workspace, or an agent that writes them to a
  file, still leaks them to the next Run in that workspace. The user boundary is about the host's
  credentials, not about what an agent chooses to write down.
- `~/.netrc` in the new user's home has the same effect as in the person's: keep it absent.
