#!/bin/bash
# Mercury copilot-relay: the host half of the nightly's review loop.
#
# WHY THIS EXISTS
# The nightly loop runs under the `mercury-nightly` GitHub identity, and that identity cannot
# obtain a Copilot code review. Measured 2026-10-18:
#
#   1. GitHub silently drops the request. `POST /pulls/<n>/requested_reviewers` with
#      {"reviewers": ["copilot-pull-request-reviewer[bot]"]} returns 201 and creates NO
#      `review_requested` event, so the caller cannot even detect the failure -- the bot reviewer
#      never appears in the response's `requested_reviewers`, which stays empty on success too.
#      The same call with the repo owner's token registers and the review arrives.
#      (`gh pr edit --add-reviewer` is worse: it resolves the login over GraphQL and fails outright
#      with "The 'login' field requires one of the following scopes: ['read:org']".)
#   2. The automatic ruleset alternative does not cover it either. The `copilot_code_review`
#      ruleset rule requests a review only "if the author has access to Copilot code review and AI
#      credits", and nightly PRs are authored by `mercury-nightly`.
#
# So the request has to come from an identity that has Copilot access, and it must not come from
# the nightly agent -- handing the agent the owner's token is exactly what the N0-1 identity split
# removed. This relay is the boundary: a host-level agent, owned by the operator, that re-requests
# Copilot on every open PR authored by the nightly whose current head has no Copilot review yet.
# The nightly agent cannot reach this credential.
#
# WHY IT LOOPS INSTEAD OF BEING SCHEDULED
# launchd's SCHEDULED spawns are unreliable on the nightly host: the `gui` domain spends long
# stretches in "on-demand-only mode", where `StartInterval` and `RunAtLoad` do not fire at all.
# launchd says so in its own log --
#
#   launchd[1] [gui/501:] pending spawn, domain in on-demand-only mode: com.mercury.copilot-relay
#
# -- and leaves the job at `pended nondemand spawn = interval` with a frozen `runs` count. That is
# what killed the first version of this relay: it stopped on 2026-10-05 and the 2026-10-18 outage
# (five nightly PRs with no Copilot review for one to three days) was the consequence. A
# `KeepAlive` daemon that loops internally needs exactly ONE spawn, and `launchctl kickstart` can
# always force that; the cadence then belongs to this script, not to launchd.
#
# OBSERVABILITY
# Every pass writes exactly one heartbeat line, so `tail` answers "is it alive?" directly. The
# first version logged only when it acted, and its silence was indistinguishable from a working
# relay with nothing to do.
#
# Usage: copilot-relay.sh [--once] [--watch]
#   --once   one pass, exit non-zero if a request failed (the default; what the tests drive)
#   --watch  loop forever, one pass per interval (what the LaunchAgent runs)
#
# Env knobs exist for the test suite (test/nightlyCopilotRelay.test.ts); the installed agent sets
# only MERCURY_RELAY_WATCH-equivalent --watch.
set -u

STATE_DIR="${MERCURY_RELAY_STATE_DIR:-${HOME}/.local/state/mercury}"
LOG="$STATE_DIR/copilot-relay.log"
mkdir -p "$STATE_DIR"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
REPO="${MERCURY_RELAY_REPO:-aywengo/mercury}"
AUTHOR="${MERCURY_RELAY_AUTHOR:-mercury-nightly}"
OPERATOR="${MERCURY_RELAY_OPERATOR:-aywengo}"
REVIEWER='copilot-pull-request-reviewer[bot]'
GH="${MERCURY_RELAY_GH:-gh}"
INTERVAL="${MERCURY_RELAY_INTERVAL:-1200}"

WATCH=0
for arg in "$@"; do
  case "$arg" in
    --watch) WATCH=1 ;;
    --once) WATCH=0 ;;
    *) log "ERROR: unknown argument '$arg'"; exit 2 ;;
  esac
done

# gh must be the OPERATOR. A silent fall-back to the nightly token would look identical to a
# working relay while requesting nothing, which is the failure this whole script exists to avoid.
# Checked once per pass, so a credential change is noticed rather than cached.
identity_ok() {
  local who
  if ! who="$("$GH" api user --jq .login 2>/dev/null)"; then
    log "ERROR: $GH not authenticated (or not on PATH)"
    return 1
  fi
  if [ "$who" != "$OPERATOR" ]; then
    log "ERROR: gh identity is $who, expected $OPERATOR - refusing (a nightly token cannot request Copilot reviews)"
    return 1
  fi
  return 0
}

# One pass. Returns the number of failed requests through the FAILED global.
FAILED=0
one_pass() {
  FAILED=0
  local prs total=0 requested=0 current=0 failed=0
  identity_ok || { FAILED=1; return 0; }
  if ! prs="$("$GH" api "repos/$REPO/pulls?state=open&per_page=50" \
        --jq '.[] | select(.user.login=="'"$AUTHOR"'") | "\(.number) \(.head.sha)"' 2>/dev/null)"; then
    log "ERROR: listing open PRs failed"
    FAILED=1
    return 0
  fi
  local num head last body code
  while read -r num head; do
    [ -z "$num" ] && continue
    total=$((total + 1))
    last="$("$GH" api "repos/$REPO/pulls/$num/reviews?per_page=50" \
          --jq '[.[] | select(.user.login=="'"$REVIEWER"'") | .commit_id] | last // ""' 2>/dev/null)"
    if [ "$last" = "$head" ]; then
      current=$((current + 1))
      continue
    fi
    body="{\"reviewers\":[\"$REVIEWER\"]}"
    code="$(printf '%s' "$body" | "$GH" api -X POST "repos/$REPO/pulls/$num/requested_reviewers" --input - --include 2>&1 | head -1)"
    case "$code" in
      *" 200"*|*" 201"*) requested=$((requested + 1)); log "PR #$num head ${head:0:7} last-reviewed ${last:0:7} -> re-requested ($code)" ;;
      *) failed=$((failed + 1)); log "ERROR: PR #$num head ${head:0:7} request failed ($code)" ;;
    esac
  done <<< "$prs"
  # The heartbeat. One line per pass, always -- this is what makes a stalled relay visible.
  log "run: $total open PR(s) by $AUTHOR, $requested re-requested, $current already reviewed on head, $failed failed"
  FAILED=$failed
}

if [ "$WATCH" -eq 0 ]; then
  one_pass
  [ "$FAILED" -eq 0 ] || exit 1
  exit 0
fi

log "watch: starting, one pass every ${INTERVAL}s (pid $$)"
while :; do
  one_pass
  # In watch mode a failure is logged and retried next pass. Exiting would make `KeepAlive`
  # restart the daemon immediately, which turns one broken credential into a spin.
  sleep "$INTERVAL"
done
