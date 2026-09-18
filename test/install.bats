#!/usr/bin/env bats
#
# bats test suite for install.sh (docs/host-installer.md M6).
#
# install.sh is bash 3.2-compatible and must stay that way (macOS ships 3.2.57).
# These tests exercise the script through its real entry point with stubbed
# prerequisites on PATH, so flag parsing, the prerequisite gate, the confirmation
# prompt, the npm hand-off and the structured log are all verified as executed.
#
# Run: bats test/install.bats   (or via CI: npm run test:install)

# A scratch HOME/XDG per test so the log file never leaks between tests.
setup() {
  TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/install-bats.XXXXXX")"
  export TEST_DIR
  export HOME="$TEST_DIR/home"
  export XDG_STATE_HOME="$TEST_DIR/state"
  export XDG_CONFIG_HOME="$TEST_DIR/config"
  mkdir -p "$HOME"
  # Stub bin dir: every prerequisite is a fake that records its argv.
  STUB_BIN="$TEST_DIR/bin"
  mkdir -p "$STUB_BIN"
  export PATH="$STUB_BIN:$PATH"
  export INSTALL_SH="$BATS_TEST_DIRNAME/../install.sh"
}

teardown() {
  # minimal_path may have replaced PATH with the stub bin (which lives inside
  # TEST_DIR); restore a real PATH first so cleanup can find rm.
  export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
  rm -rf "$TEST_DIR"
}

# --- helpers ---------------------------------------------------------------

stub() {
  # stub <name> <script>: create an executable fake on STUB_BIN.
  local name="$1" script="$2"
  printf '#!/bin/sh\n%s\n' "$script" >"$STUB_BIN/$name"
  chmod +x "$STUB_BIN/$name"
}

stub_ok_prereqs() {
  # Real node/curl/git/npm would work too, but stubs keep the test hermetic and
  # fast: node reports a floor-passing version, npm records its argv and succeeds.
  stub node 'echo v24.0.0'
  stub curl 'exit 0'
  stub git 'exit 0'
  stub npm 'echo "npm $@" >>"$TEST_DIR/npm-calls.txt"; exit 0'
  stub date 'echo 2026-09-18T00:00:00Z'
}

# A hermetic PATH: only the core utils install.sh needs (as symlinks to /usr/bin)
# plus whatever stubs the test added. The real node/curl/git/npm are NOT reachable,
# so "missing" tests are honest: the tool is genuinely absent from PATH.
minimal_path() {
  local tool src
  for tool in uname date mkdir awk printf sh bash chmod rm ln mktemp grep; do
    if [ ! -e "$STUB_BIN/$tool" ]; then
      if [ -e "/bin/$tool" ]; then src="/bin/$tool"; else src="/usr/bin/$tool"; fi
      # A wrapper script rather than a symlink: macOS sandboxing refuses symlinks
      # into temp dirs ("Operation not permitted"), scripts are fine.
      printf '#!/bin/sh\nexec %s "$@"\n' "$src" >"$STUB_BIN/$tool"
      chmod +x "$STUB_BIN/$tool"
    fi
  done
  export PATH="$STUB_BIN"
}

# --- flags -----------------------------------------------------------------

@test "--help prints usage and exits 0" {
  run bash "$INSTALL_SH" --help
  [ "$status" -eq 0 ]
  [[ "$output" == *"usage: install.sh"* ]]
}

@test "unknown flag exits 1 with a message" {
  run bash "$INSTALL_SH" --bogus
  [ "$status" -eq 1 ]
  [[ "$output" == *"unknown flag"* ]]
}

@test "--version without a value exits 1" {
  run bash "$INSTALL_SH" --version
  [ "$status" -eq 1 ]
  [[ "$output" == *"--version needs a value"* ]]
}

# --- dry-run ---------------------------------------------------------------

@test "--dry-run prints the action list and touches nothing" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" == *"Nothing was touched."* ]]
  [[ "$output" == *"detect OS/arch"* ]]
  [[ "$output" == *"install @aywengo/mercury@latest"* ]]
  # No log file, no npm call.
  [ ! -f "$XDG_STATE_HOME/mercury/install.log" ]
  [ ! -f "$TEST_DIR/npm-calls.txt" ]
}

@test "--dry-run --version 0.1.1 pins the version in the action list" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --dry-run --version 0.1.1
  [ "$status" -eq 0 ]
  [[ "$output" == *"@aywengo/mercury@0.1.1"* ]]
}

# --- platform gate ---------------------------------------------------------

@test "unsupported OS exits 1" {
  stub uname 'echo FreeBSD'
  run bash "$INSTALL_SH" --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported platform"* ]]
}

@test "unsupported arch exits 1" {
  # uname is called twice: once for OS (Darwin), once for arch (mips).
  stub uname 'if [ -f "$TEST_DIR/uname-count" ]; then echo mips; else touch "$TEST_DIR/uname-count"; echo Darwin; fi'
  run bash "$INSTALL_SH" --dry-run
  [ "$status" -eq 1 ]
  [[ "$output" == *"unsupported platform"* ]]
}

# --- prerequisite gate -----------------------------------------------------

@test "missing node exits 1 before touching anything" {
  minimal_path
  stub curl 'exit 0'
  stub git 'exit 0'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"Node >= 22.18.0"* ]]
  # The failure is recorded in the structured log (a failed install leaves a trail).
  [ -f "$XDG_STATE_HOME/mercury/install.log" ]
  grep -q '"event":"install-failed"' "$XDG_STATE_HOME/mercury/install.log"
}

@test "node below the floor exits 1" {
  minimal_path
  stub node 'echo v22.17.0'
  stub curl 'exit 0'
  stub git 'exit 0'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"too old"* ]]
}

@test "node at the floor (22.18.0) passes" {
  minimal_path
  stub node 'echo v22.18.0'
  stub curl 'exit 0'
  stub git 'exit 0'
  stub npm 'exit 0'
  stub date 'echo 2026-09-18T00:00:00Z'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 0 ]
}

@test "missing curl exits 1" {
  minimal_path
  stub node 'echo v24.0.0'
  stub git 'exit 0'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"curl is required"* ]]
}

@test "missing git exits 1" {
  minimal_path
  stub node 'echo v24.0.0'
  stub curl 'exit 0'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 1 ]
  [[ "$output" == *"git is required"* ]]
}

# --- confirmation ----------------------------------------------------------

@test "declining the prompt aborts with exit 0" {
  stub_ok_prereqs
  run bash -c "echo n | bash '$INSTALL_SH'"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Aborted."* ]]
  [ ! -f "$TEST_DIR/npm-calls.txt" ]
}

@test "--yes skips the prompt and installs" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 0 ]
  [[ "$output" == *"Mercury host installed"* ]]
  [ -f "$TEST_DIR/npm-calls.txt" ]
}

@test "--non-interactive skips the prompt" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --non-interactive
  [ "$status" -eq 0 ]
  [[ "$output" == *"Mercury host installed"* ]]
}

# --- npm hand-off ----------------------------------------------------------

@test "npm install failure propagates the exit code" {
  stub_ok_prereqs
  stub npm 'exit 42'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 42 ]
  [[ "$output" == *"npm install failed"* ]]
}

@test "npm receives the pinned version" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --yes --version 0.1.1
  [ "$status" -eq 0 ]
  grep -q "@aywengo/mercury@0.1.1" "$TEST_DIR/npm-calls.txt"
}

# --- structured log --------------------------------------------------------

@test "a successful install writes start and complete log lines" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 0 ]
  [ -f "$XDG_STATE_HOME/mercury/install.log" ]
  grep -q '"event":"install-start"' "$XDG_STATE_HOME/mercury/install.log"
  grep -q '"event":"install-complete"' "$XDG_STATE_HOME/mercury/install.log"
}

@test "a failed prerequisite writes an install-failed log line" {
  stub node 'echo v22.17.0'
  stub curl 'exit 0'
  stub git 'exit 0'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 1 ]
  [ -f "$XDG_STATE_HOME/mercury/install.log" ]
  grep -q '"event":"install-failed"' "$XDG_STATE_HOME/mercury/install.log"
}

# --- json_escape -----------------------------------------------------------

@test "json_escape escapes control characters as \uXXXX" {
  # Extract just the json_escape function (up to its closing brace) and run it.
  # Sourcing the whole script would execute main().
  run bash -c '
    awk "/^json_escape\(\)/,/^}$/" "$1" > "$2/func.sh"
    . "$2/func.sh"
    printf "%s" "$(json_escape "$(printf "a\tb\n\x01")")"
  ' _ "$INSTALL_SH" "$TEST_DIR"
  [ "$status" -eq 0 ]
  [[ "$output" == *"\\u0001"* ]]
  [[ "$output" == *"\\u0009"* ]]
  [[ "$output" == *"\\u000a"* ]]
}

@test "log lines are valid JSON" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 0 ]
  # Every line must parse as JSON (python3 is present on both CI and macOS).
  python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    for line in f:
        json.loads(line)
' "$XDG_STATE_HOME/mercury/install.log"
}
