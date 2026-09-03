// Issue #185, root cause. `app.listen(0)` with no host binds the WILDCARD address. On macOS/BSD a
// wildcard bind SUCCEEDS on a port another process already holds on 127.0.0.1 -- the two sockets
// coexist -- and loopback traffic to that port is delivered to the *specific* bind. A test then
// reads a response from a server it never created. Observed as `200 !== 401` (a test-local mock that
// answers 200 to everything) and as `403 !== 401` (whatever else held the port). The application
// could not have produced either status; it was never asked.
//
// Binding an explicit host closes the hole: the same collision then fails with EADDRINUSE, which is
// a loud error at the point of the bug rather than a wrong answer three lines later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

const TEST_DIR = import.meta.dirname;
const REPO = join(TEST_DIR, '..');
/** Every directory that starts a server in a test, so the rule covers both suites. */
const SUITES = ['test', join('fleet', 'test')];

/**
 * Strip // and /* *\/ comments and string literals, so a guard that scans source sees only code.
 * Without this the guard matched `.listen(0)` inside the prose of its own explanatory comment.
 * Same approach as the stripper in auth.test.ts (issue #140), which handles quotes so `http://`
 * inside a string is not mistaken for a line comment.
 */
function stripCommentsAndStrings(code: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | null = null;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (quote) {
      // Blank the CONTENT but keep the delimiters visible, so a guard can still tell that a string
      // literal was present here (the host argument of listen() is exactly such a string).
      if (c === '\\' && next !== undefined) { i += 2; continue; }
      if (c === quote) { quote = null; out.push('""'); i += 1; continue; }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out.push('"'); i += 1; continue; }
    if (c === '/' && next === '/') { while (i < code.length && code[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

function listenCalls(src: string): { args: string[] }[] {
  const out: { args: string[] }[] = [];
  const re = /\.listen\(([^)]*)\)/g;
  src = stripCommentsAndStrings(src);
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const args = m[1].split(',').map((s) => s.trim());
    out.push({ args });
  }
  return out;
}

test('every port-binding listen() in test/ names an explicit host (issue #185)', () => {
  const offenders: string[] = [];
  for (const dir of SUITES) {
   for (const f of readdirSync(join(REPO, dir)).filter((n) => /\.test\.ts$/.test(n))) {
    const src = readFileSync(join(REPO, dir, f), 'utf8');
    for (const { args } of listenCalls(src)) {
      // Only port-binding calls matter: listen(0) or listen(<number>, ...). Socket-path and no-arg
      // forms (the wakeup listener) are a different API and are skipped.
      if (!/^\d+$/.test(args[0] ?? '')) continue;
      const hasHost = args.slice(1).some((a) => /^['"]/.test(a));
      if (!hasHost) offenders.push(`${dir}/${f}: .listen(${args.join(', ')})`);
    }
   }
  }
  assert.deepEqual(offenders, [], `these bind the wildcard and can be silently shadowed by another\n` +
    `process holding the same port on 127.0.0.1 (see issue #185):\n  ${offenders.join('\n  ')}`);
});

test('an explicit loopback bind makes a port collision loud instead of silent (issue #185)', async () => {
  // The hole is PLATFORM-SPECIFIC, and that is part of the finding: macOS/BSD lets a wildcard bind
  // take a port another process holds on 127.0.0.1, Linux refuses it. That asymmetry is exactly why
  // issue #185 flaked on a macOS laptop and never once appeared in CI -- so this test must not assert
  // the BSD behaviour as universal (an earlier version did, and failed on Linux CI).
  //
  // What IS asserted everywhere: the explicit-host bind is refused on collision. That is the rule the
  // suite relies on, and it holds on both platforms. Which branch the platform took is reported, so
  // the test can never pass by silently skipping the interesting half.
  const holder = createServer((_q, r) => { r.writeHead(200); r.end('holder'); });
  await new Promise<void>((res) => holder.listen(0, '127.0.0.1', () => res()));
  const port = (holder.address() as { port: number }).port;
  try {
    const wild = createServer((_q, r) => { r.writeHead(200); r.end('wildcard'); });
    const wildResult = await new Promise<string>((res) => {
      wild.once('error', (e: NodeJS.ErrnoException) => res(`refused:${e.code ?? 'ERR'}`));
      wild.listen(port, () => res('bound'));
    });
    if (wildResult === 'bound') {
      // BSD/macOS: the hole is live here. Prove the misrouting actually happens.
      const viaLoopback = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      assert.equal(
        viaLoopback, 'holder',
        'wildcard and specific binds coexist on this platform, so loopback traffic must go to the ' +
        'SPECIFIC bind -- that preference is the whole of issue #185',
      );
      console.log(`  platform ${process.platform}: wildcard bind coexists -> shadowing demonstrated`);
      wild.close();
    } else {
      // Linux: the kernel already refuses it. Say so rather than pretending we proved something.
      console.log(`  platform ${process.platform}: wildcard bind ${wildResult} -> ` +
        'shadowing is impossible here, which is why CI never reproduced #185');
    }

    const explicit = createServer((_q, r) => { r.writeHead(200); r.end('explicit'); });
    const code = await new Promise<string>((res) => {
      explicit.once('error', (e: NodeJS.ErrnoException) => res(e.code ?? 'ERR'));
      explicit.listen(port, '127.0.0.1', () => res('bound'));
    });
    assert.equal(code, 'EADDRINUSE', 'with an explicit host the same collision must fail loudly');
  } finally {
    await new Promise<void>((res) => holder.close(() => res()));
  }
});
