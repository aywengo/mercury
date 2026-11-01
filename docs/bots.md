# Dispatcher bots

A dispatcher bot is a host-resident process that turns a schedule into Mercury Runs. Each bot has an
alias, one config file and one token; each dispatch is an ordinary Run owned by `bot-<alias>`, so the
dashboard, events, cancel/retry and retention work unchanged. One process runs per alias.

Design: [`dispatcher-bot-design.md`](dispatcher-bot-design.md). Security review:
[`bots-bounds-review.md`](bots-bounds-review.md).

**Status.** B0 (contracts) and B1 (the scheduler) shipped. B4 (#915) shipped the `host setup` bots
step, the `host doctor` bots section, the §14 review and this page. Event triggers (B2, #907–#909)
and the LLM brain (B3, #912) are **not** implemented: the config schema refuses `triggers` and
`brain`, and the wizard writes scheduler-only bots.

## Install a bot

`mercury host setup` has an optional bots step (default **no**, like the Laya sidecar). With it on,
one run writes all three pieces:

```text
${XDG_CONFIG_HOME:-~/.config}/mercury/bots/<alias>.json     the starter schedule (0600)
${XDG_CONFIG_HOME:-~/.config}/mercury/bot-credentials.json  the bot's token copy (0600)
${XDG_CONFIG_HOME:-~/.config}/mercury/mercury.env           MERCURY_API_TOKENS=<token>:bot-<alias>
```

Writing both token copies in one step is deliberate (§4.2): the server authorizes the token from
`mercury.env`, the bot presents it from its credentials file, and creating them together is what
stops them from drifting at creation.

```bash
mercury host setup                    # interactive; answer yes to "Set up a dispatcher bot?"
mercury host setup --dry-run          # print the plan and write nothing
mercury host setup --non-interactive --answers answers.json
```

Answers-file keys for this step: `botEnabled`, `botAlias` (`^[a-z][a-z0-9-]{0,31}$`, default
`maint`), `botHarness` (must be one of the enabled `harnesses`), `botPosture` (`scheduler` today).

Rules the step enforces:

- **An existing `<alias>.json` is never overwritten.** A re-run keeps it byte for byte and says so;
  edit the file, or choose another alias.
- **An existing token is reused, never rotated behind your back.** If one copy exists, setup writes
  the other. If the two copies already disagree, setup refuses and names both files: "write both"
  cannot pick a winner.
- **The token is never printed.** The summary shows `<set, N chars>`, and the `mercury.env` diff
  redacts `MERCURY_API_TOKENS` like every other credential.
- **`observer` and `brain` postures are refused** until B2/B3 land, after printing the §8.5
  blast-radius sentence: *An operator enabling the observer scope plus a brain is accepting that a
  hostile Run on this host can influence which declared template the bot dispatches and how it
  answers its own Runs.*
- `--dry-run` writes no bot file and no `mercury.env`.

A re-run is safe: `botEnabled` defaults to yes once `<alias>.json` exists, so pressing enter does
not silently disable a configured bot.

## The config file

One JSON file per bot, named by alias. The starter has one daily task:

```json
{
  "description": "Scheduler-only dispatcher bot created by `mercury host setup` (B4).",
  "schedule": {
    "tasks": [
      {
        "name": "maintenance",
        "cron": "0 3 * * *",
        "tz": "UTC",
        "singleFlight": true,
        "onMiss": "skip",
        "template": {
          "task": "Daily maintenance for {{fire.date}}: review this host's recent Runs ...",
          "agent": "primeagent",
          "constraints": { "maxDurationMs": 3600000, "maxRetries": 0 }
        }
      }
    ]
  }
}
```

The field-by-field reference is §12 of the design. The essentials:

| Field | Meaning |
| --- | --- |
| `schedule.tasks[].cron` | 5-field cron, UTC unless `tz` (`"UTC"`, `"local"`, or a fixed offset) |
| `schedule.tasks[].template` | create-Run fields; `{{fire.date}}`, `{{fire.time}}`, `{{fire.iso}}` are substituted, and `notAfterAt: "HH:MM"` becomes `constraints.notAfter` on the fire's date |
| `schedule.tasks[].singleFlight` | default `true`: skip the fire while a Run of this task is non-terminal (NEEDS_INPUT included) |
| `schedule.tasks[].onMiss` | `skip` (default), `collapse` (fire once for the newest missed minute) or `run` (each missed minute, capped by `maxCatchUp`) |
| `api.url` / `api.timeoutMs` | default `http://127.0.0.1:${MERCURY_PORT:-3000}`, 30 s |
| `api.via` | `"host"` (default) or `"fleet"`: dispatch through Fleet instead of this host, so Fleet decides which host runs the task. `"fleet"` needs a `fleet` token beside `api` in `bot-credentials.json`; `validate` refuses the config without it |

Unknown keys are refused with a "did you mean" suggestion. A real-world example is
[`deploy/nightly-bot.json.example`](../deploy/nightly-bot.json.example).

```bash
mercury host bot validate --alias <alias>
```

Offline: it checks the config, the credentials file (mode and shape) and the two-copy agreement,
makes no network call, and never prints a token.

## The two token copies

| Copy | File | Read by |
| --- | --- | --- |
| server side | `MERCURY_API_TOKENS` in `mercury.env` (0600) | the API, to authorize `bot-<alias>` |
| bot side | `bot-credentials.json` (0600) | the bot process, to present `Authorization: Bearer` |

Both files must be 0600. The credentials reader refuses a group- or world-readable file rather than
warning; `host doctor` fails when `mercury.env` is readable by others.

**Rotate a token** by removing both copies and re-running setup — never edit one copy:

```bash
mercury host bot service uninstall --alias <alias> --yes   # removes both copies (and the bot)
mercury host setup --yes                                    # writes a fresh pair in one step
```

`uninstall` keeps the bot's Runs in the database (they become readable only to an admin or observer
token). Pass `--reassign-runs <owner>` to transfer them first (needs `MERCURY_ADMIN_TOKEN` and a
reachable API), and `--keep-env` to leave `MERCURY_API_TOKENS` alone.

## Run, observe, dispatch

```bash
mercury host bot run --alias <alias>                 # foreground (what the service runs)
mercury host bot run --alias <alias> --once          # one tick, then exit
mercury host bot status --alias <alias>              # next fires, recent Runs, dispatches/hour
mercury host bot dispatch --alias <alias> --task <name> --dry-run
mercury host bot dispatch --alias <alias> --task <name> --yes
mercury host bot service install --alias <alias>
mercury host bot service uninstall --alias <alias> --yes
```

`status` computes next fires from config and cron (works offline) and reads the Run list from the
API; an unreachable API marks those sections UNAVAILABLE and exits non-zero. `dispatch` derives a
`manual-` idempotency key from the current wall minute, so two invocations in one minute replay to
one Run; `singleFlight` applies exactly as configured. `service install` writes one launchd agent or
systemd user unit per alias.

Every dispatch appears as a Run with `constraints.botTask` set, and the log line is
`bot=<alias> task=<name> fire=<iso> run=<id>`. A skipped fire says why (`singleFlight`, `onMiss`,
`maxCatchUp=0`).

## Doctor

`mercury host doctor` gains one line per configured alias:

```text
bot maint: PASS — config ok, token ok, 1 task, next maintenance in 4h12m, last action run-abc task=maintenance COMPLETED, dispatches last hour: 1
bot coord: FAIL — token in /home/op/.config/mercury/bot-credentials.json is not registered in MERCURY_API_TOKENS (expected owner 'bot-coord')
bots: PASS — /home/op/.config/mercury/mercury.env is mode 600
```

Each check is bounded and fail-closed; any FAIL line makes the doctor exit non-zero. The checks are
the config, the credentials file, the two-copy agreement, a writable state file, `nextFire`, and the
read-only status view with the bot's own token. A rejected token reads `token rejected (401); check
bot-credentials.json`. No bot configured means no section at all.

The status view reports the **last action** (Run id, task, status, created time) and the
dispatches-in-the-last-hour count. The derived dispatch key is not stored on the Run, so the doctor
cannot print it: a scheduled fire's key is `bot-<alias>:<task>:w<wall minute>` from the log line's
`task` and `fire`, and `host bot dispatch` prints the manual key directly. The bot log names every
`singleFlight` skip and its reason.

## Upgrading

- A package upgrade leaves `<alias>.json`, `bot-credentials.json`, `mercury.env` and the state file
  untouched; restart the bot service (`host bot service install --alias <alias>` is idempotent) after
  upgrading.
- A new release that changes the config schema refuses an old file with a named field; run
  `host bot validate` before restarting.
- The state file (`${XDG_STATE_HOME:-~/.local/state}/mercury/bots/<alias>.state.json`) only records
  the last tick, for `onMiss`. Deleting it is safe: non-double-dispatch comes from the derived
  idempotency key, not from the file.

## Security

The bot is the first host component that could send Mercury content to an external service (B3). The
bounds that ship today are reviewed one by one in [`bots-bounds-review.md`](bots-bounds-review.md),
each with the test that fails without it; rows that land with B2/B3 say so. Two rules matter most:

- the bot token is never in argv, logs, prompts or the event stream, and `MERCURY_API_TOKENS` is
  redacted from every diff;
- the wizard never sets up an observer or admin token, and refuses the observer/brain postures until
  their code exists.
