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

run_under_pty() {
  # Drive a command under a pty with the answer pre-placed on the terminal, portable
  # across script(1) flavors: util-linux takes `-c CMD FILE` (a trailing command after
  # the file is an argument-count error), BSD takes `FILE CMD...` and has no -c.
  local cmd="$1"
  if script -q -c "true" /dev/null </dev/null >/dev/null 2>&1; then
    script -q -c "$cmd" /dev/null </dev/null
  else
    script -q /dev/null "$cmd" </dev/null
  fi
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
  # No log file, no npm INSTALL call. `npm prefix -g` (the writable-prefix check,
  # #649 §4) is a query, not an install; the recorded calls must not contain one.
  [ ! -f "$XDG_STATE_HOME/mercury/install.log" ]
  if [ -f "$TEST_DIR/npm-calls.txt" ]; then
    ! grep -q " install " "$TEST_DIR/npm-calls.txt"
  fi
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
  # The confirmation reads /dev/tty since #646 (stdin may be the script stream under
  # curl | bash), so the decline must be driven through a pty. Without script(1) this
  # environment cannot answer the prompt; the no-tty test below covers the failure path.
  if ! command -v script >/dev/null 2>&1; then
    skip "script(1) not available"
  fi
  # script(1) differs across platforms (BSD: `script file [command...]`; util-linux:
  # at most one command argument), so the driver is a single wrapper script that
  # places the answer on the pty BEFORE the installer's prompt reads it.
  printf '#!/bin/sh\nprintf "n\\n" > /dev/tty\nexec bash "$INSTALL_SH" --version 9.9.9\n' > "$TEST_DIR/decline-driver.sh"
  chmod +x "$TEST_DIR/decline-driver.sh"
  run run_under_pty "$TEST_DIR/decline-driver.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Aborted."* ]]
  # No npm INSTALL call before the abort (the prefix query is not an install, #649 §4).
  if [ -f "$TEST_DIR/npm-calls.txt" ]; then
    ! grep -q " install " "$TEST_DIR/npm-calls.txt"
  fi
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
# --- confirmation input source (#646) ---------------------------------------

@test "piped script (curl | bash style): --dry-run runs untouched end to end" {
  stub_ok_prereqs
  run bash -c "cat '$INSTALL_SH' | bash -s -- --dry-run"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Nothing was touched."* ]]
}

@test "piped script without a terminal: fails loudly instead of eating script lines (#646)" {
  # CI has no controlling tty; skip where one exists (the script would correctly
  # prompt on /dev/tty there and the test cannot drive it). OPEN /dev/tty rather than
  # stat-ing it: the node is always permission-readable, even with no controlling
  # terminal (Copilot review on #655).
  if (exec 3</dev/tty) 2>/dev/null; then
    skip "needs an environment without a controlling terminal (CI)"
  fi
  stub_ok_prereqs
  run bash -c "cat '$INSTALL_SH' | bash -s --"
  [ "$status" -eq 1 ]
  [[ "$output" == *"no terminal to confirm the install"* ]]
  # The failure is logged, not a misread script line.
  grep -q '"no tty for confirmation; --yes required"' "$XDG_STATE_HOME/mercury/install.log"
}

@test "piped script with a pty: the prompt reads /dev/tty, not the script stream (#646)" {
  # A faithful curl | bash reproduction: the installer runs as `bash -s` with its
  # STDIN fed from a FIFO carrying the script text — fd 0 is that pipe, NOT a
  # terminal, exactly the curl | bash shape (running the FIFO as a script file would
  # leave stdin on the pty and miss the bug — Copilot review on #655). The answer
  # lands on the pty first; the abort log proves the confirmation was answered from
  # the terminal and the script ran to the end without skipping code.
  if ! command -v script >/dev/null 2>&1; then
    skip "script(1) not available"
  fi
  stub_ok_prereqs
  cat "$INSTALL_SH" > "$TEST_DIR/fake-curl.txt"
  # script(1) flavors: BSD execs the command directly (no shell — a pipeline string
  # fails with "No such file or directory"), util-linux takes -c. A driver FILE works
  # for both and owns the choreography.
  printf '#!/bin/sh\nprintf "n\\n" > /dev/tty\nmkfifo "$FAKE_PIPE"\ncat "$FAKE_CURL" > "$FAKE_PIPE" &\nexec bash -s -- --version 9.9.9 < "$FAKE_PIPE"\n' > "$TEST_DIR/piped-driver.sh"
  chmod +x "$TEST_DIR/piped-driver.sh"
  export FAKE_CURL="$TEST_DIR/fake-curl.txt"
  export FAKE_PIPE="$TEST_DIR/fake-curl-pipe"
  run run_under_pty "$TEST_DIR/piped-driver.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Aborted."* ]]
  # The confirmation was answered from the tty: the script ran to the clean abort.
  grep -q '"install-aborted"' "$XDG_STATE_HOME/mercury/install.log"
  # The script did not skip lines: the last logged event is the clean abort.
  tail -1 "$XDG_STATE_HOME/mercury/install.log" | grep -q 'install-aborted'
}

@test "the prompt goes to /dev/tty, not stdout — a redirected stdout cannot hide it (#646)" {
  if ! command -v script >/dev/null 2>&1; then
    skip "script(1) not available"
  fi
  stub_ok_prereqs
  # stdout is redirected to a file; the prompt must still reach the operator (the
  # tty) and the confirmation must still be answered from there, never from stdin.
  # (Aborted. and the banner are stdout — they land in the file; only the prompt
  # must come out on the tty, which script(1) captures into $output.)
  printf '#!/bin/sh\nprintf "n\\n" > /dev/tty\nexec bash "$INSTALL_SH" --version 9.9.9 > "$REDIRECT_OUT"\n' > "$TEST_DIR/redirect-driver.sh"
  chmod +x "$TEST_DIR/redirect-driver.sh"
  export REDIRECT_OUT="$TEST_DIR/stdout-captured.txt"
  run run_under_pty "$TEST_DIR/redirect-driver.sh"
  [ "$status" -eq 0 ]
  grep -q '"install-aborted"' "$XDG_STATE_HOME/mercury/install.log"
  # The prompt reached the tty (script captured it) even with stdout redirected:
  [[ "$output" == *"Proceed with the install"* ]]
  # ...and the prompt did NOT go to stdout: the file has the banner/abort, not the question.
  grep -q "Mercury Host installer" "$REDIRECT_OUT"
  grep -q "Aborted." "$REDIRECT_OUT"
  if grep -q "Proceed with the install" "$REDIRECT_OUT"; then
    echo "REGRESSION: the prompt went to redirected stdout; a piped caller would see no prompt"
    return 1
  fi
}

# --- npm hand-off ----------------------------------------------------------

@test "npm install failure propagates the exit code" {
  stub_ok_prereqs
  stub npm 'exit 42'
  run bash "$INSTALL_SH" --yes
  [ "$status" -eq 42 ]
  [[ "$output" == *"npm install failed"* ]]
}

@test "an unwritable npm global prefix falls back to $HOME/.local (decision 7, #649 §4)" {
  stub node 'echo v24.0.0'
  stub curl 'exit 0'
  stub git 'exit 0'
  stub date 'echo 2026-09-18T00:00:00Z'
  # npm reports a root-owned prefix; a real [ -w ] on it fails for this user.
  stub npm 'case "$1" in prefix) echo /usr/local ;; *) echo "npm $@" >>"$TEST_DIR/npm-calls.txt"; exit 0 ;; esac'
  mkdir -p "$TEST_DIR/state/mercury"  # log dir; the [ -w ] check needs nothing else
  run bash "$INSTALL_SH" --yes --version 0.1.1
  [ "$status" -eq 0 ]
  grep -q -- "--prefix" "$TEST_DIR/npm-calls.txt"
  grep -q "$HOME/.local" "$TEST_DIR/npm-calls.txt"
  [[ "$output" == *".local/bin"* ]]  # the PATH hint is printed
}

@test "a writable npm global prefix needs no --prefix (decision 7, #649 §4)" {
  stub_ok_prereqs
  # npm reports a prefix inside TEST_DIR, which the stub setup made writable.
  stub npm 'case "$1" in prefix) echo "$TEST_DIR/writable-prefix" ;; *) echo "npm $@" >>"$TEST_DIR/npm-calls.txt"; exit 0 ;; esac'
  mkdir -p "$TEST_DIR/writable-prefix"
  run bash "$INSTALL_SH" --yes --version 0.1.1
  [ "$status" -eq 0 ]
  ! grep -q -- "--prefix" "$TEST_DIR/npm-calls.txt"
}

@test "--dry-run names the honest actions (#649 §4): no checksum step, hint not hand-off" {
  stub_ok_prereqs
  run bash "$INSTALL_SH" --dry-run
  [ "$status" -eq 0 ]
  [[ "$output" != *"verify the installed package checksum"* ]]
  [[ "$output" == *"no separate checksum step"* ]]
  [[ "$output" == *"it does not run the wizard"* ]]
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
