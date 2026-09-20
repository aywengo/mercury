#!/usr/bin/env bash
#
# Mercury Host installer bootstrap (docs/host-installer.md M1).
#
# Thin bash, thick mercury: this script only bootstraps -- detect OS/arch, satisfy
# prerequisites, install the pinned @aywengo/mercury package -- then hands off to
# `mercury host setup` (M3). Harness detection and configuration live in the Node
# code, not here, so "what a valid install looks like" is defined once.
#
# Written for bash 3.2 (macOS ships bash 3.2): no associative arrays, no mapfile,
# no ${var,,}. The installer must not require the thing it installs prerequisites for.
#
# Usage:
#   curl -fsSL https://.../install.sh | bash            # interactive
#   curl -fsSL https://.../install.sh | bash -s -- --dry-run
#   curl -fsSL https://.../install.sh | bash -s -- --version 0.1.1 --yes
#
# Flags:
#   --dry-run          print the exact action list and touch nothing
#   --yes, -y          skip confirmation prompts
#   --version <v>      pin a specific @aywengo/mercury version
#   --non-interactive  no prompts; answers come from env/flags

set -u
# A curl | bash failure inside a pipe must not read as success downstream (issue #650).
# bash 3.0+ supports pipefail, so macOS's /bin/bash is covered.
set -o pipefail

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

# Structured log: ${XDG_STATE_HOME:-~/.local/state}/mercury/install.log
log_dir="${XDG_STATE_HOME:-$HOME/.local/state}/mercury"
log_file="$log_dir/install.log"

json_escape() {
  # JSON string escaping for the structured log: quotes, backslashes and EVERY control
  # character must be escaped or the log line is not valid JSON. bash 3.2 has no
  # ${var//...} for backslash, so the heavy lifting is awk's (POSIX, present on macOS
  # and Linux): backslash and quote first, then any byte < 0x20 as \u00XX.
  printf '%s' "$1" | awk '{
    gsub(/\\/, "\\\\");
    gsub(/"/, "\\\"");
    ctrl = "\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037";
    out = "";
    n = length($0);
    for (i = 1; i <= n; i++) {
      c = substr($0, i, 1);
      p = index(ctrl, c);
      if (p > 0) {
        out = out sprintf("\\u%04x", p);
      } else {
        out = out c;
      }
    }
    # awk splits input on newlines, so a newline in the detail never reaches $0.
    # Re-emit it as \u000a before every record after the first (empty ORS keeps
    # the output free of awk separators).
    if (NR > 1) printf "\\u000a";
    printf "%s", out;
  }'
}

log_line() {
  # One JSON line per event, so a failed install leaves a readable trail.
  local ts ev dt
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)"
  ev="$(json_escape "$1")"
  dt="$(json_escape "$2")"
  printf '{"ts":"%s","event":"%s","detail":"%s"}\n' "$ts" "$ev" "$dt" >>"$log_file"
}

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------

DRY_RUN=0
YES=0
VERSION="latest"
NON_INTERACTIVE=0

usage() {
  cat <<'EOF'
usage: install.sh [--dry-run] [--yes|-y] [--version <v>] [--non-interactive]

  --dry-run          print the exact action list and touch nothing
  --yes, -y          skip confirmation prompts
  --version <v>      pin a specific @aywengo/mercury version
  --non-interactive  no prompts; answers come from env/flags
EOF
}

# Manual flag scan: getopts cannot consume a value for a long option in bash 3.2,
# and mixing the two breaks OPTIND tracking (--version 0.1.1 --dry-run lost the
# --dry-run). Scan argv directly; every flag is a single token except --version.
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --version)
      shift
      if [ $# -lt 1 ]; then
        echo "install.sh: --version needs a value, e.g. --version 0.1.1" >&2
        exit 1
      fi
      VERSION="$1"
      shift
      ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "install.sh: unknown flag $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# OS / arch detection
# ---------------------------------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unsupported" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "x64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) echo "unsupported" ;;
  esac
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

node_meets_floor() {
  # Node >= 22.18.0 (the engines floor, which also guarantees node:sqlite).
  # `node --version` prints v22.18.0; parse major and minor without bash 4 features.
  local ver major minor
  ver="$(node --version 2>/dev/null)" || return 1
  ver="${ver#v}"
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  if [ "$major" -gt 22 ]; then return 0; fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; then return 0; fi
  return 1
}

# ---------------------------------------------------------------------------
# Action list
# ---------------------------------------------------------------------------

actions=""

add_action() {
  actions="$actions
  $1"
}

# Decide where npm installs. Decision 7: user-scoped only. If npm's global prefix is
# not writable by this user (root-owned /usr, common on Linux distros), fall back to
# `$HOME/.local` and tell the operator to add its bin to PATH. Sets:
#   NPM_PREFIX_PATH     the prefix directory ("" = npm's own global prefix)
#   NPM_PREFIX_FALLBACK 1 when the $HOME/.local fallback is used, else 0
#   NPM_PREFIX_DESC     the human-readable description for logs and the action list
# Execution quotes the values; nothing is word-split (#649 §4, Copilot on #661).
decide_npm_prefix() {
  local prefix
  if ! command_exists npm; then
    NPM_PREFIX_PATH=""
    NPM_PREFIX_FALLBACK=0
    NPM_PREFIX_DESC="npm's global prefix (npm not found: the install step fails if this run reaches it)"
    return
  fi
  prefix="$(npm prefix -g 2>/dev/null || echo unknown)"
  # -d (is a dir), -w (writable) and -x (searchable, so npm can create bin/ lib/)
  # must ALL hold; write-without-execute or ACL-only grants would fail at install time.
  if [ "$prefix" != "unknown" ] && [ -d "$prefix" ] && [ -w "$prefix" ] && [ -x "$prefix" ]; then
    NPM_PREFIX_PATH=""
    NPM_PREFIX_FALLBACK=0
    NPM_PREFIX_DESC="npm's global prefix ($prefix)"
  else
    NPM_PREFIX_PATH="$HOME/.local"
    NPM_PREFIX_FALLBACK=1
    NPM_PREFIX_DESC="$HOME/.local (npm's global prefix ${prefix:-lookup failed} is not a writable, searchable directory; add $HOME/.local/bin to PATH)"
  fi
}

build_actions() {
  local os arch
  os="$(detect_os)"
  arch="$(detect_arch)"
  add_action "detect OS/arch: $os/$arch"
  if command_exists node; then
    if node_meets_floor; then
      add_action "check node: ok ($(node --version))"
    else
      add_action "check node: FAILED ($(node --version) is too old; need >= 22.18.0)"
    fi
  else
    add_action "check node: FAILED (not found; need >= 22.18.0)"
  fi
  if command_exists curl; then
    add_action "check curl: ok"
  else
    add_action "check curl: FAILED (missing)"
  fi
  if command_exists git; then
    add_action "check git: ok"
  else
    add_action "check git: FAILED (missing)"
  fi
  # The list must name only what the real run does (#649 §4): the M1 gate is
  # "--dry-run prints the exact action list". The description embeds the same prefix
  # value the real run quotes, so dry-run and execution cannot diverge. The decision is
  # computed ONCE in main (before build_actions) so the plan and the execution share it.
  if [ "$NPM_PREFIX_FALLBACK" = "1" ]; then
    add_action "install @aywengo/mercury@$VERSION with npm install -g --prefix \"$NPM_PREFIX_PATH\" into $NPM_PREFIX_DESC (integrity = npm's registry sha512 check, no separate checksum step)"
  else
    add_action "install @aywengo/mercury@$VERSION with npm install -g into $NPM_PREFIX_DESC (integrity = npm's registry sha512 check, no separate checksum step)"
  fi
  add_action "write $log_file"
  add_action "print the next step: run \`mercury host setup\` (the script exits; it does not run the wizard)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  local os arch
  os="$(detect_os)"
  arch="$(detect_arch)"

  if [ "$os" = "unsupported" ] || [ "$arch" = "unsupported" ]; then
    echo "install.sh: unsupported platform: $(uname -s)/$(uname -m)" >&2
    echo "Mercury supports macOS and Linux on x64 and arm64." >&2
    exit 1
  fi

  # Decision 7 (user-scoped only, no sudo): refuse to run as root. Root's prefix is
  # always "writable", so without this gate the installer would happily do a
  # system-wide install — the exact outcome decision 7 forbids (#649 §4). Fail CLOSED:
  # if `id` is missing we cannot prove this is not root, so refuse (a minimal env that
  # lacks `id` also lacks npm; the operator can re-run in a normal shell).
  uid="$(id -u 2>/dev/null)" || uid=""
  if [ "$uid" = "0" ]; then
    echo "install.sh: refusing to run as root — Mercury's installer is user-scoped only (decision 7; no sudo, no system prefix)." >&2
    echo "install.sh: run it as your normal user; everything lands under \$HOME." >&2
    exit 1
  fi
  if [ -z "$uid" ]; then
    echo "install.sh: cannot determine the user id (id not found) — refusing to install; decision 7 requires a non-root, user-scoped run." >&2
    exit 1
  fi

  # The prefix decision is made once, before the plan is printed, so dry-run, the
  # printed plan, and the real install step all share one computation (#649 §4).
  decide_npm_prefix
  build_actions

  if [ "$DRY_RUN" = "1" ]; then
    echo "install.sh --dry-run"
    echo "$actions"
    echo
    echo "Nothing was touched."
    exit 0
  fi

  # Real run: log the plan first, then execute.
  mkdir -p "$log_dir"
  log_line "install-start" "os=$os arch=$arch version=$VERSION"

  echo "Mercury Host installer"
  echo "$actions"
  echo

  # Prerequisite gate: fail before touching anything.
  if ! command_exists node || ! node_meets_floor; then
    echo "install.sh: Node >= 22.18.0 is required (found $(node --version 2>/dev/null || echo none))." >&2
    log_line "install-failed" "node prerequisite not met"
    exit 1
  fi
  if ! command_exists curl; then
    echo "install.sh: curl is required." >&2
    log_line "install-failed" "curl prerequisite not met"
    exit 1
  fi
  if ! command_exists git; then
    echo "install.sh: git is required (Mercury workspaces are git worktrees)." >&2
    log_line "install-failed" "git prerequisite not met"
    exit 1
  fi

  # Confirmation (skipped with --yes or --non-interactive).
  # Issue #646: under `curl | bash` the script itself IS stdin, so `read` without a
  # redirect consumes the next unread script line as the "answer". Always ask the
  # terminal, never the script stream:
  #   - a controlling terminal (/dev/tty) exists -> prompt there;
  #   - no tty (CI, provisioning) -> the operator cannot answer: require an explicit
  #     --yes/--non-interactive and fail with a clear message instead of reading stdin.
  if [ "$YES" != "1" ] && [ "$NON_INTERACTIVE" != "1" ]; then
    # Ask the terminal, never the script stream. /dev/tty exists and is openable only
    # when there is a controlling terminal (interactive curl | bash); stdin is the
    # script itself under the pipe, so it must not be read for answers (#646).
    # Detect a controlling terminal by OPENING /dev/tty, not stat-ing it: the device
    # node is always permission-readable (mode 666) even with no controlling terminal,
    # while a real open fails with ENXIO there (Copilot review on #655). `[ -t 0 ]`
    # stays first: when stdin IS a terminal (plain interactive run), read it directly.
    # The probe runs in a subshell so a failed open cannot touch this shell's fd 2
    # (a bare `exec 3</dev/tty 2>/dev/null` would leave stderr silenced for the rest
    # of the script — Copilot review on #655).
    if [ -t 0 ] || (exec 3</dev/tty) 2>/dev/null; then
      # The prompt goes to the terminal, not stdout: a caller may have redirected
      # stdout (tee/pipe) while the controlling tty still answers the question, and
      # a prompt lost in a pipe reads as a hang (Copilot review on #655).
      printf "Proceed with the install of @aywengo/mercury@%s? [y/N] " "$VERSION" > /dev/tty
      if [ -t 0 ]; then
        read -r answer
      else
        # The subshell probe left no fd behind; open fresh here, read, close.
        exec 3</dev/tty
        read -r answer <&3
        exec 3<&-
      fi
      case "$answer" in
        y|Y|yes|YES) ;;
        *) echo "Aborted."; log_line "install-aborted" "operator declined"; exit 0 ;;
      esac
    else
      echo "install.sh: no terminal to confirm the install and neither --yes nor --non-interactive was passed." >&2
      echo "install.sh: re-run with --yes to proceed without a prompt (see --dry-run first)." >&2
      log_line "install-failed" "no tty for confirmation; --yes required"
      exit 1
    fi
  fi

  # Install the pinned package into the user's npm prefix (no sudo).
  # M1 scope: the actual npm install. Integrity = npm's own registry sha512
  # verification; the checksum-published-alongside-release step is M6 work.
  # Decision 7 (#649 §4): the prefix decision is made once by decide_npm_prefix —
  # an unwritable global prefix falls back to $HOME/.local (user-scoped, no sudo).
  if command_exists npm; then
    echo "Installing @aywengo/mercury@$VERSION into $NPM_PREFIX_DESC ..."
    if [ "$NPM_PREFIX_FALLBACK" = "1" ]; then
      if [ "$VERSION" = "latest" ]; then
        npm install -g --prefix "$NPM_PREFIX_PATH" "@aywengo/mercury@latest"
      else
        npm install -g --prefix "$NPM_PREFIX_PATH" "@aywengo/mercury@$VERSION"
      fi
    else
      if [ "$VERSION" = "latest" ]; then
        npm install -g "@aywengo/mercury@latest"
      else
        npm install -g "@aywengo/mercury@$VERSION"
      fi
    fi
    rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "install.sh: npm install failed (exit $rc)." >&2
      log_line "install-failed" "npm install exit $rc"
      exit "$rc"
    fi
  else
    echo "install.sh: npm is not installed; cannot install the package." >&2
    log_line "install-failed" "npm not found"
    exit 1
  fi

  log_line "install-complete" "version=$VERSION prefix=$NPM_PREFIX_DESC"

  echo
  echo "Mercury host installed. Next step:"
  echo "  mercury host setup"
  echo "(M3: configuration wizard — admin/API token, Atlas, harnesses.)"
  # Decision 7 fallback: tell the operator how to reach the fallback binary (#649 §4).
  if [ "$NPM_PREFIX_FALLBACK" = "1" ]; then
    echo
    echo "NOTE: the package went to $HOME/.local — make sure $HOME/.local/bin is on PATH:"
    # The hint shows the literal $HOME expression; SC2016 is intended here.
    # shellcheck disable=SC2016
    echo '  export PATH="$HOME/.local/bin:$PATH"'
  fi
}

main "$@"
