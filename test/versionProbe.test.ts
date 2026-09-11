/**
 * Bounded harness version probe (docs/goals.md 13.3).
 *
 * Runs real subprocesses against throwaway scripts, because every interesting property
 * here -- a missing binary, output on stderr, a hang, two installs of the same name --
 * is about process behaviour and cannot be tested against a mock.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { tempDir } from './helpers.ts';

import { defaultVersionParse, probeVersion } from '../src/adapters/versionProbe.ts';

const dir = tempDir('verprobe');
function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const stdoutVersion = script('v-stdout', 'echo "0.9.4"');
const stderrVersion = script('v-stderr', 'echo "Hermes Agent v0.20.5 (2026.8.19) \u00b7 upstream 933c209e" 1>&2; exit 1');
const noVersion = script('v-junk', 'echo "usage: thing [--help]"');
const hangs = script('v-hang', 'sleep 30');

// No teardown here: tempDir() registers the directory with the suite-level file tracker
// (issue #73 L8) and it is removed with every other fixture dir. An earlier draft declared
// teardown as a `test`, which runs in declaration order -- so it deleted the fixtures before
// the tests that use them had run, and the failures it produced looked like probe bugs.

test('a version on stdout parses', async () => {
  const info = await probeVersion({ cmd: stdoutVersion });
  assert.equal(info.version, '0.9.4');
  assert.equal(info.error, undefined);
});

test('a version on stderr still parses, even with a non-zero exit', async () => {
  // Several CLIs print --version to stderr, or exit non-zero while doing it. Treating a
  // non-zero exit as "no version" would mark these installs unknown forever.
  const info = await probeVersion({ cmd: stderrVersion });
  assert.equal(info.version, '0.20.5', `raw was ${JSON.stringify(info.raw)}, error ${info.error}`);
});

test('a missing binary reports command-not-found and never throws', async () => {
  // Startup calls this detached. A throw here would turn "we cannot tell the version"
  // into "Mercury does not start".
  const info = await probeVersion({ cmd: join(dir, 'definitely-not-here') });
  assert.equal(info.version, null);
  assert.match(info.error ?? '', /command not found/);
});

test('a hanging probe is bounded and reports a timeout', async () => {
  const started = Date.now();
  const info = await probeVersion({ cmd: hangs, timeoutMs: 400 });
  const elapsed = Date.now() - started;
  assert.equal(info.version, null);
  assert.match(info.error ?? '', /timed out/);
  // Generous: the point is that it returned at all rather than waiting for the 30s sleep.
  assert.ok(elapsed < 8000, `probe took ${elapsed}ms; the bound did not hold`);
});

test('unparsable output keeps the raw string as evidence', async () => {
  const info = await probeVersion({ cmd: noVersion });
  assert.equal(info.version, null);
  assert.match(info.error ?? '', /unparsable/);
  // When a version is reported wrong, the raw output is the only evidence of why.
  assert.match(info.raw ?? '', /usage: thing/);
});

test('the probe asks the configured path, not a bare name resolved through PATH', async () => {
  // The incident this pins: two installs of the same harness on one machine answer
  // differently depending on PATH order. Mercury must report the version of the binary it
  // actually execs, so the probe takes a path and must not re-resolve the name.
  // Two binaries with the SAME base name: one reachable only through PATH, one only by
  // absolute path. If the probe re-resolved a name, both calls would return 1.1.1.
  const shadow = script('same-name', 'echo "9.9.9"');
  const elsewhere = tempDir('verprobe-path');
  const onPath = join(elsewhere, 'same-name');
  writeFileSync(onPath, '#!/bin/sh\necho "1.1.1"\n');
  chmodSync(onPath, 0o755);
  const saved = process.env.PATH ?? '';
  process.env.PATH = `${elsewhere}:${saved}`;
  try {
    const viaPath = await probeVersion({ cmd: 'same-name' });
    const viaAbs = await probeVersion({ cmd: shadow });
    assert.equal(viaPath.version, '1.1.1');
    // Passing the absolute path must select THAT binary, not the PATH one.
    assert.equal(viaAbs.version, '9.9.9', 'absolute path must win over PATH resolution');
  } finally {
    process.env.PATH = saved;
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('defaultVersionParse takes the leading dotted run', () => {
  assert.equal(defaultVersionParse('0.9.4'), '0.9.4');
  assert.equal(defaultVersionParse('v0.20.5 (2026.8.19)'), '0.20.5');
  assert.equal(defaultVersionParse('nothing'), null);
});
