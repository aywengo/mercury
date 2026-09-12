import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
// Imported per test rather than at module scope. A static import of a symbol that does not exist
// yet fails the whole FILE at load time, which hides every other test -- including the choke-point
// count below, whose whole job is to report the real number of unbounded git calls on a branch that
// has no fix. Dynamic import lets each test fail on its own merits.
async function loadWm(): Promise<typeof import('../src/workspace/workspaceManager.ts')> {
  return await import('../src/workspace/workspaceManager.ts');
}
import { tempDir } from './helpers.ts';

// Eleven execFile('git', ...) calls, none with a timeout (issue #509). A hung git is not
// distinguishable from a slow worker except after the fact, and the worker has a Run deadline it
// cannot enforce on a child that will not die.
//
// The more dangerous half is not slowness, it is git asking a question. The worker is a detached
// daemon with no controlling terminal, so a credential prompt goes nowhere and the call blocks
// forever.

const execFileP = promisify(execFile);

/** An HTTP listener that accepts and then never answers -- the shape of a hung remote. */
async function blackHole(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(() => { /* deliberately never responds */ });
  // server.close() waits for OPEN connections, and the entire point of this fixture is that the
  // connection stays open until git is killed. Without destroying the sockets here the test's own
  // teardown blocks forever -- which it did, on the first run, for the full 600 s command timeout.
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/repo.git`,
    close: () => new Promise<void>((resolve) => {
      for (const sock of sockets) sock.destroy();
      server.close(() => resolve());
    }),
  };
}

/**
 * Bound a call from OUTSIDE, so a missing internal deadline shows up as a failing test rather than a
 * hanging suite.
 *
 * This is not decoration. Run against a branch without the fix, the create() test below hung for the
 * full command timeout, because the code under test had no timeout to enforce and nothing else was
 * watching. A regression test that hangs instead of failing is worse than no test: it looks like
 * infrastructure and gets skipped.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_res, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms -- no internal deadline is enforcing it`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('a git call that exceeds its deadline is killed and the error says which one', async () => {
  const black = await blackHole();
  const dest = tempDir('mercury-git-hang-');
  try {
    const { runGit } = await loadWm();
    const started = Date.now();
    // Bounded from outside as well: this test asserts the internal deadline fires, so if that
    // deadline is removed the call would otherwise never return and the test would hang instead of
    // failing. A mutation that deletes the timeout must produce a red test, not a stuck runner.
    await assert.rejects(
      () => withDeadline(
        runGit(['clone', '--quiet', black.url, dest], { timeoutMs: 1_500 }),
        15_000,
        'runGit against an unresponsive remote',
      ),
      (err: Error) => {
        assert.ok(!/did not finish within/.test(err.message),
          'the deadline came from the test harness, not from runGit');
        // "workspace creation failed" from a worker stuck for an hour is the status quo this issue
        // exists to remove, so the message is part of the fix rather than a nicety.
        assert.match(err.message, /git clone/, 'error must name the subcommand');
        assert.match(err.message, /1500 ms/, 'error must name the deadline that expired');
        assert.match(err.message, /MERCURY_GIT_TIMEOUT_MS/, 'error must name the knob to raise');
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20_000, `the deadline was not enforced, took ${elapsed} ms`);
  } finally { await black.close(); }
});

test('the git env block actually reaches git, rather than only existing in source', async () => {
  // GIT_EDITOR and GIT_PAGER are the two variables git reports back to us, so they are observable
  // rather than asserted-from-the-same-file. A unit test of the constant would pass even if the env
  // were never passed to execFile.
  const { runGit } = await loadWm();
  const editor = runGit(['var', 'GIT_EDITOR']);
  return editor.then(({ stdout }) => {
    assert.equal(stdout.trim(), 'true',
      'GIT_EDITOR did not reach git, so an editor prompt could block the worker');
  });
});

test('a credential challenge fails fast instead of leaving git waiting on a terminal', async () => {
  // What is actually being asserted is the CONTRACT: against an authentication challenge the call
  // returns, quickly, with an error. It must not sit waiting for input nobody can give it.
  //
  // The exact wording is platform-dependent and CI proved it. On macOS git reaches for the terminal
  // and says "terminal prompts disabled". On Linux CI, GIT_ASKPASS=/bin/true answers with an empty
  // username first, so git never needs the terminal and says "Authentication failed". Both are the
  // hardened outcome; asserting one string over-fits the test to one OS, which is exactly what it did.
  //
  // Honest limit: in a non-interactive environment an UNHARDENED git also fails rather than blocking,
  // because there is no terminal to open. So this test proves "does not block, fails with an auth
  // error" and does not, by itself, prove GIT_TERMINAL_PROMPT is what saved us on Linux. The
  // GIT_EDITOR test above covers "the env block really reaches git" cross-platform, and the deadline
  // test above covers "a blocked call is killed".
  const { runGit } = await loadWm();
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="x"', 'content-type': 'text/plain' });
    res.end('auth required');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const started = Date.now();
    const err = await runGit(
      ['clone', `http://127.0.0.1:${port}/repo.git`, tempDir('mercury-git-prompt-')],
      { timeoutMs: 15_000 },
    ).then(() => null, (e: Error & { stderr?: string }) => e);
    assert.ok(err, 'an unauthenticated clone must fail');
    const text = `${err!.message ?? ''}\n${err!.stderr ?? ''}`;
    assert.match(
      text,
      /terminal prompts disabled|Authentication failed|could not read (?:Username|Password)/,
      `git neither refused to prompt nor failed authentication -- it did something unexpected: ${text.slice(0, 200)}`,
    );
    // The point of the whole issue: bounded, not blocked. 15 s is the internal deadline; anything
    // near it means git stalled and the deadline rescued us rather than git refusing to ask.
    assert.ok(Date.now() - started < 10_000,
      'the call ran close to the deadline, so git was waiting on something rather than refusing');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the configured deadline is honoured rather than the built-in default', async () => {
  const black = await blackHole();
  const { WorkspaceManager } = await loadWm();
  const mgr = new WorkspaceManager({
    baseDir: tempDir('mercury-git-cfg-'),
    mode: 'git-worktree',
    gitNetworkTimeoutMs: 1_200,
  });
  try {
    const started = Date.now();
    // create() is the real entry point; going through it proves the config is threaded to the call
    // sites rather than only available on the exported helper.
    // The rejection must come from the code under test, not from this test's own safety net.
    // assert.rejects() accepts ANY rejection, so on a branch with no internal deadline the outer
    // withDeadline fires at 15 s, assert.rejects is satisfied, and the test passes for exactly the
    // wrong reason -- which is what it did on first running against base.
    await assert.rejects(
      () => withDeadline(
        mgr.create({
          id: 'run_cfg', agent: 'fake', task: 'x',
          repository: { url: black.url, baseBranch: 'main' },
          repositories: [],
        } as never),
        15_000,
        'WorkspaceManager.create() against an unresponsive remote',
      ),
      (err: Error) => {
        assert.ok(!/did not finish within/.test(err.message),
          'the deadline came from the test harness, not from WorkspaceManager: no internal deadline fired');
        return true;
      },
    );
    assert.ok(Date.now() - started < 20_000, 'the configured network deadline was not applied');
  } finally { await black.close(); }
});

test('no git call bypasses the choke point', () => {
  // The fix is a choke point, so the property worth pinning is that it stays the only door. A new
  // execFile('git', ...) added elsewhere would silently have no timeout and no prompt guard.
  const src = readFileSync(new URL('../src/workspace/workspaceManager.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/execFile\w*\(\s*'git'/g)];
  assert.equal(calls.length, 1,
    `git must be spawned in exactly one place (runGit); found ${calls.length}`);
  const other = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.ok(!/execFile\w*\(\s*'git'/.test(other));
});
