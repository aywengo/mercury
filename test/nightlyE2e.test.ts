// The nightly E2E skill (N1-2, #739): fingerprinting, flake/defect separation, and the
// file-once/comment-never-refile GitHub discipline. All I/O is injected — no Docker, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tempDir } from './helpers.ts';

import {
  localDateString,
  normalizeErrorLine,
  fingerprintOf,
  fpMarker,
  parseFailures,
  parseCounts,
  loadFlakeState,
  saveFlakeState,
  recordFlakeNight,
  runE2eSkill,
  type E2eIo,
  type FlakeState,
} from '../.agents/skills/nightly/e2e.ts';

function tempStateDir(): { dir: string; cleanup: () => void } {
  const dir = tempDir('mercury-nightly-e2e-');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PASSING: E2eIo['run'] = async () => ({ code: 0, output: 'ℹ pass 12\nℹ fail 0' });

/** A spec-reporter output with one failing test (the shape node --test prints). */
function failingOutput(name: string, error: string, file: string, pass = 11): string {
  return [
    '✖ ' + name + ' (1.2ms)',
    'ℹ tests 12',
    `ℹ pass ${pass}`,
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    `test at ${file}:3:1`,
    '✖ ' + name + ' (1.2ms)',
    '  ' + error,
    '  ',
    '      at TestContext.<anonymous> (file:///repo/' + file + ':3:36)',
    '      at Test.runInAsyncScope (node:async_hooks:226:14)',
    '  {',
    '    generatedMessage: false,',
    '    code: \'ERR_ASSERTION\',',
    '  }',
  ].join('\n');
}

/** An io that fails the first suite run with the given failure and passes everything else. */
function ioWithFirstFailure(failure: { name: string; error: string; file: string }): {
  io: E2eIo;
  runs: string[][];
  posts: { path: string; body: unknown }[];
} {
  const runs: string[][] = [];
  const posts: { path: string; body: unknown }[] = [];
  let first = true;
  return {
    runs,
    posts,
    io: {
      async run(argv) {
        runs.push(argv);
        if (first) {
          first = false;
          return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) };
        }
        return { code: 0, output: 'ℹ pass 12\nℹ fail 0' };
      },
      async get(_path) {
        return { body: [], status: 200 };
      },
      async post(path, body) {
        posts.push({ path, body });
        return { body: { number: 901 }, status: 201 };
      },
    },
  };
}

test('normalizeErrorLine strips volatile ids, paths, durations and numbers', async () => {
  const a = normalizeErrorLine('AssertionError [ERR_ASSERTION]: run_fb7a2ee4042849a1 timed out after 30000 ms at /private/tmp/mercury-x/src/a.ts:12:5');
  const b = normalizeErrorLine('AssertionError [ERR_ASSERTION]: run_09005480332e4073 timed out after 45000 ms at /tmp/other-checkout/src/a.ts:99:1');
  assert.equal(a, b, 'same defect, different incident ids/dirs/durations: one fingerprint');
  assert.match(a, /(^|\s)[A-Za-z]/, 'starts with text, not a path');
  assert.equal(/\s\//.test(a), false, 'no absolute (slash-rooted) paths survive');
  assert.match(a, /run_<id>/);
  assert.match(a, /<dur>/);
});

test('normalizeErrorLine reduces Windows backslash paths to basenames too', async () => {
  // The same defect on a Windows checkout and a POSIX checkout must share a fingerprint.
  const win = normalizeErrorLine('AssertionError: numbers diverge at C:\\Users\\me\\repo\\src\\a.ts:12:5');
  const posix = normalizeErrorLine('AssertionError: numbers diverge at /home/me/repo/src/a.ts:12:5');
  assert.equal(win, posix, 'platform-independent normalization');
  assert.match(win, / at a\.ts$/);
  const win2 = normalizeErrorLine('Error: socket hang up at D:\\ci\\ws\\e2e\\system.test.ts:9:9');
  assert.match(win2, / at system\.test\.ts$/);
});

test('fingerprintOf is stable and matches the marker helper', async () => {
  const fp1 = await fingerprintOf('alpha works', 'AssertionError: numbers diverge');
  const fp2 = await fingerprintOf('alpha works', 'AssertionError: numbers diverge');
  assert.equal(fp1, fp2);
  assert.match(fp1, /^[0-9a-f]{16}$/);
  assert.equal(fpMarker(fp1), `<!-- nightly-e2e-fp:${fp1} -->`);
  const fp3 = await fingerprintOf('alpha works', 'AssertionError: numbers DIVERGE');
  assert.notEqual(fp1, fp3, 'a different error is a different defect');
});

test('parseFailures extracts names, errors and files from the spec reporter', () => {
  const out = [
    '✖ alpha works (0.5ms)',
    '✔ beta works (0.1ms)',
    'ℹ pass 1',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at e2e/system.test.ts:42:1',
    '✖ alpha works (0.5ms)',
    '  AssertionError [ERR_ASSERTION]: numbers diverge',
  ].join('\n');
  const failures = parseFailures(out);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.test, 'alpha works');
  assert.equal(failures[0]!.error, 'AssertionError [ERR_ASSERTION]: numbers diverge');
  assert.equal(failures[0]!.file, 'e2e/system.test.ts');
});

test('parseFailures keeps Windows drive-letter paths intact (no drive-colon truncation)', () => {
  const out = [
    '✖ windows defect (0.5ms)',
    'ℹ pass 0',
    'ℹ fail 1',
    '',
    '✖ failing tests:',
    '',
    'test at C:\\ci\\ws\\e2e\\system.test.ts:42:1',
    '✖ windows defect (0.5ms)',
    '  AssertionError: boom',
  ].join('\n');
  const failures = parseFailures(out);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.file, 'C:\\ci\\ws\\e2e\\system.test.ts');
  assert.equal(failures[0]!.error, 'AssertionError: boom');
});

test('parseFailures error-scan stays inside the matching detail entry', () => {
  // Two failures: the error found for each must come from ITS OWN detail entry, never from an
  // earlier/later block (a scan that started at the wrong offset would corrupt fingerprints).
  const out = [
    '✖ first (0.5ms)',
    '✖ second (0.6ms)',
    'ℹ pass 0',
    'ℹ fail 2',
    '',
    '✖ failing tests:',
    '',
    'test at a.test.ts:1:1',
    '✖ first (0.5ms)',
    '  Error: first error',
    '',
    'test at b.test.ts:2:1',
    '✖ second (0.6ms)',
    '  Error: second error',
  ].join('\n');
  const failures = parseFailures(out);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((f) => f.error), ['Error: first error', 'Error: second error']);
  assert.deepEqual(failures.map((f) => f.file), ['a.test.ts', 'b.test.ts']);
});

test('parseCounts reads the summary', () => {
  assert.deepEqual(parseCounts('ℹ pass 12\nℹ fail 3'), { pass: 12, fail: 3 });
  assert.deepEqual(parseCounts('nothing here'), { pass: 0, fail: 0 });
});

test('green suite: no GitHub calls at all', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const posts: unknown[] = [];
    const io: E2eIo = {
      run: PASSING,
      async get() { throw new Error('must not read GitHub on a green suite'); },
      async post(path, body) { posts.push({ path, body }); return { body: {}, status: 201 }; },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.deepEqual(report, { pass: 12, fail: 0, real: [], flakes: [] });
    assert.equal(posts.length, 0);
  } finally {
    cleanup();
  }
});

test('a real failure files ONCE with the marker; the second night COMMENTS (never re-files)', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'the run never starts', error: 'Error: run_fb7a2ee4042849a1 died at /tmp/x/e2e/system.test.ts:9:9', file: 'e2e/system.test.ts' };
    const night1 = ioWithFirstFailure(failure);
    const report1 = await runE2eSkill(night1.io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-24' });
    // The rerun PASSED => this night saw a flake, not a defect... but the rerun here passed, so
    // assert that behavior instead: flake recorded, nothing filed.
    assert.equal(report1.real.length, 0, 'a failure that passes on rerun is not filed');
    assert.equal(report1.flakes.length, 1);
    assert.equal(night1.posts.length, 0, 'first flake night files nothing');

    // Now a run whose rerun FAILS AGAIN with the same error: a real defect.
    const posts: { path: string; body: unknown }[] = [];
    let suiteRun = 0;
    const io: E2eIo = {
      async run() {
        suiteRun += 1;
        // Suite fails; the single-file rerun fails too (same output): a real defect.
        return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) };
      },
      async get() { return { body: [], status: 200 }; },
      async post(path, body) {
        posts.push({ path, body });
        return { body: { number: 777 }, status: 201 };
      },
    };
    const report2 = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-25' });
    assert.equal(report2.real.length, 1);
    assert.equal(report2.real[0]!.action, 'filed');
    assert.equal(report2.real[0]!.issue, 777);
    const created = posts[0]!;
    assert.equal(created.path, '/repos/aywengo/mercury/issues');
    const fp = report2.real[0]!.fingerprint;
    assert.match(String(created.body && (created.body as { body?: string }).body), new RegExp(`nightly-e2e-fp:${fp}`), 'the marker is in the issue body');
    assert.deepEqual((created.body as { labels?: string[] }).labels, ['origin:e2e']);

    // Second night, same fingerprint: comments on 777, does not file again.
    const posts2: { path: string; body: unknown }[] = [];
    const io2: E2eIo = {
      async run() { return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; },
      async get(path) {
        if (path.startsWith('/repos/aywengo/mercury/issues?')) {
          return { body: [{ number: 777, body: `A defect issue.\n${fpMarker(fp)}`, pull_request: undefined }], status: 200 };
        }
        return { body: [], status: 200 };
      },
      async post(path, body) {
        posts2.push({ path, body });
        return { body: {}, status: 201 };
      },
    };
    const report3 = await runE2eSkill(io2, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.equal(report3.real.length, 1);
    assert.equal(report3.real[0]!.action, 'commented');
    assert.equal(report3.real[0]!.issue, 777);
    assert.equal(posts2.length, 1, 'exactly one call: the comment');
    assert.match(String(posts2[0]!.path), /issues\/777\/comments$/);
    assert.equal(posts2.filter((p) => p.path === '/repos/aywengo/mercury/issues').length, 0, 'no re-file');
  } finally {
    cleanup();
  }
});

test('a flake on three distinct nights files a flaky-test defect (state carries the clock)', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'sometimes the lease expires early', error: 'AssertionError: lease expired at 30000ms', file: 'fleet/test/lease.test.ts' };
    const nights = ['2026-09-22', '2026-09-23', '2026-09-24'];
    let filed = 0;
    for (let i = 0; i < nights.length; i++) {
      // Each night: suite fails once, single-file rerun passes (a flake).
      let first = true;
      const posts: { path: string; body: unknown }[] = [];
      const io: E2eIo = {
        async run() {
          if (first) { first = false; return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; }
          return { code: 0, output: 'ℹ pass 12\nℹ fail 0' };
        },
        async get() { return { body: [], status: 200 }; },
        async post(path, body) { posts.push({ path, body }); return { body: { number: 800 + i }, status: 201 }; },
      };
      const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: nights[i]! });
      assert.equal(report.flakes.length, 1);
      filed += posts.filter((p) => p.path === '/repos/aywengo/mercury/issues').length;
      if (i < 2) {
        assert.equal(posts.length, 0, `night ${i + 1}: no issue yet`);
      } else {
        assert.equal(posts.length, 1, 'the third night files');
        const body = String((posts[0]!.body as { body?: string }).body);
        assert.match(body, /3 distinct nights/);
        assert.match(body, /2026-09-22, 2026-09-23, 2026-09-24/);
      }
    }
    assert.equal(filed, 1, 'filed exactly once across the three nights');
    // A FOURTH flake night must not re-file (nights === threshold, not >=).
    let first4 = true;
    const posts4: { path: string; body: unknown }[] = [];
    const io4: E2eIo = {
      async run() {
        if (first4) { first4 = false; return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; }
        return { code: 0, output: 'ℹ pass 12\nℹ fail 0' };
      },
      async get() { return { body: [], status: 200 }; },
      async post(path, body) { posts4.push({ path, body }); return { body: { number: 901 }, status: 201 }; },
    };
    const report4 = await runE2eSkill(io4, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-25' });
    assert.equal(posts4.length, 0, 'night 4: still no filing');
    assert.equal(report4.flakes.length, 1);
    const state = loadFlakeState({ XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' });
    const fp = Object.keys(state)[0]!;
    assert.equal(state[fp]!.nights.length, 4);
  } finally {
    cleanup();
  }
});

test('two flake nights on DIFFERENT fingerprints do not accumulate into a filing', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const f1 = { name: 'test one', error: 'Error: variant one', file: 'a.test.ts' };
    const f2 = { name: 'test two', error: 'Error: variant two', file: 'b.test.ts' };
    for (const [night, failure] of [['2026-09-22', f1], ['2026-09-23', f2]] as const) {
      let first = true;
      const io: E2eIo = {
        async run() {
          if (first) { first = false; return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; }
          return { code: 0, output: 'ℹ pass 12\nℹ fail 0' };
        },
        async get() { return { body: [], status: 200 }; },
        async post() { return { body: { number: 1 }, status: 201 }; },
      };
      await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night });
    }
    const state = loadFlakeState({ XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' });
    for (const fp of Object.keys(state)) assert.equal(state[fp]!.nights.length, 1, 'different defects keep separate clocks');
  } finally {
    cleanup();
  }
});

test('dry-run observes and reports but never touches GitHub (no token needed)', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'real defect', error: 'AssertionError: boom', file: 'e2e/system.test.ts' };
    const calls: { path: string; body?: unknown }[] = [];
    const io: E2eIo = {
      async run() { return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; },
      async get(path) { calls.push({ path }); return { body: [], status: 200 }; },
      async post(path, body) { calls.push({ path, body }); return { body: { number: 1 }, status: 201 }; },
    };
    // No GH_TOKEN at all: dry-run is local observation.
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir }, { repo: 'aywengo/mercury', dryRun: true, night: '2026-09-26' });
    assert.equal(calls.length, 0, 'no GitHub reads OR writes in dry-run');
    assert.equal(report.real.length, 1);
    assert.equal(report.real[0]!.action, 'dry-run');
    assert.equal(report.real[0]!.issue, undefined, 'dry-run does not resolve the issue');
  } finally {
    cleanup();
  }
});

test('a green suite needs no GH_TOKEN either (token demanded only on GitHub I/O)', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const io: E2eIo = {
      run: PASSING,
      async get() { throw new Error('no reads on a green suite'); },
      async post() { throw new Error('no writes on a green suite'); },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.deepEqual(report, { pass: 12, fail: 0, real: [], flakes: [] });
  } finally {
    cleanup();
  }
});

test('a matching open issue is found by exact marker and commented, not re-filed (search page)', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'existing defect', error: 'AssertionError: known', file: 'e2e/system.test.ts' };
    // The fingerprint must be computed the same way the skill does.
    const fp = await fingerprintOf(failure.name, failure.error);
    let commentCalls = 0;
    let createCalls = 0;
    const io: E2eIo = {
      async run() { return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; },
      async get(path) {
        if (path.startsWith('/repos/aywengo/mercury/issues?')) {
          return {
            body: [
              { number: 500, body: 'unrelated' },
              { number: 501, body: `defect body\n<!-- nightly-e2e-fp:${fp} -->\n` },
            ],
            status: 200,
          };
        }
        return { body: [], status: 200 };
      },
      async post(path) {
        if (path.endsWith('/comments')) commentCalls += 1;
        if (path === '/repos/aywengo/mercury/issues') createCalls += 1;
        return { body: {}, status: 201 };
      },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.equal(commentCalls, 1);
    assert.equal(createCalls, 0);
    assert.equal(report.real[0]!.issue, 501);
  } finally {
    cleanup();
  }
});

test('state file: 0600, corrupt file resets the clock instead of crashing', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    saveFlakeState({ XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { abc: { test: 't', error: 'e', nights: ['2026-09-01'] } });
    const p = join(dir, 'mercury/nightly/e2e-flakes.json');
    assert.equal(existsSync(p), true);
    const stat = statSync(p);
    assert.equal(stat.mode & 0o777, 0o600);
    writeFileSync(p, '{not json');
    assert.deepEqual(loadFlakeState({ XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }), {}, 'corrupt state resets, not crashes');
  } finally {
    cleanup();
  }
});

test('loadFlakeState drops wrong-shape entries (arrays, non-objects, bad nights) instead of crashing', () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const p = join(dir, 'mercury/nightly/e2e-flakes.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({
      good: { test: 't', error: 'e', nights: ['2026-09-01'] },
      arr: ['not', 'an', 'entry'],
      str: 'just a string',
      noNights: { test: 't', error: 'e' },
      badNights: { test: 't', error: 'e', nights: [1, 2] },
    }));
    const state = loadFlakeState({ XDG_STATE_HOME: dir });
    assert.deepEqual(Object.keys(state), ['good'], 'only well-shaped entries survive');
    const state2 = loadFlakeState({ XDG_STATE_HOME: dir, GH_TOKEN: 'x' });
    assert.equal(state2['good']!.nights[0], '2026-09-01');
  } finally {
    cleanup();
  }
});

test('recordFlakeNight counts distinct nights, not reruns', () => {
  const state: FlakeState = {};
  assert.equal(recordFlakeNight(state, 'fp', 't', 'e', '2026-09-22'), 1);
  assert.equal(recordFlakeNight(state, 'fp', 't', 'e', '2026-09-22'), 1, 'same night twice is one night');
  assert.equal(recordFlakeNight(state, 'fp', 't', 'e', '2026-09-23'), 2);
  assert.equal(recordFlakeNight(state, 'fp', 't', 'e', '2026-09-24'), 3);
});

test('the suite rerun is a single-file rerun when the failure names a file', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'real defect', error: 'AssertionError: boom', file: 'e2e/system.test.ts' };
    const runs: string[][] = [];
    const io: E2eIo = {
      async run(argv) {
        runs.push(argv);
        return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) };
      },
      async get() { return { body: [], status: 200 }; },
      async post() { return { body: { number: 1 }, status: 201 }; },
    };
    await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: true, night: '2026-09-26' });
    assert.equal(runs.length, 2, 'suite + rerun');
    assert.deepEqual(runs[1], ['node', '--test', 'e2e/system.test.ts'], 'the rerun targets the failing file only');
  } finally {
    cleanup();
  }
});

test('a failed issue search never files (duplication risk) - observation recorded instead', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'real defect', error: 'AssertionError: boom', file: 'e2e/system.test.ts' };
    const posts: { path: string; body: unknown }[] = [];
    const io: E2eIo = {
      async run() { return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; },
      async get() { return { body: 'rate limited', status: 403 }; },
      async post(path, body) { posts.push({ path, body }); return { body: { number: 1 }, status: 201 }; },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.equal(posts.length, 0, 'no filing when the search failed: "no match" is not established');
    assert.equal(report.real.length, 1);
    assert.equal(report.real[0]!.action, 'dry-run');
    assert.equal(report.real[0]!.issue, undefined);
  } finally {
    cleanup();
  }
});

test('localDateString is the LOCAL date, not UTC', () => {
  // A date where UTC has rolled over but local has not: 2026-09-26T00:30 local == 2026-09-25T22:30Z
  // under a UTC+2 offset. Build it from local fields so the assertion is zone-independent:
  const d = new Date(2026, 8, 26, 0, 30, 0); // local Sep 26 00:30
  assert.equal(localDateString(d), '2026-09-26');
  // Padding and field agreement for an arbitrary midday date:
  const d2 = new Date(2027, 0, 5, 12, 0, 0);
  assert.equal(localDateString(d2), '2027-01-05');
  assert.equal(localDateString(d2), `${d2.getFullYear()}-${String(d2.getMonth() + 1).padStart(2, '0')}-${String(d2.getDate()).padStart(2, '0')}`);
});

test('a failed flake filing on the threshold night rolls the night back and the next night retries', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'recurring flake', error: 'AssertionError: flaky lease', file: 'fleet/lease.test.ts' };
    const nights = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
    let filed = 0;
    for (let i = 0; i < nights.length; i++) {
      let first = true;
      const posts: { path: string; body: unknown }[] = [];
      // Night 3 (index 2): the create FAILS (503). Every other create would succeed.
      const failCreate = i === 2;
      const io: E2eIo = {
        async run() {
          if (first) { first = false; return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; }
          return { code: 0, output: 'ℹ pass 12\nℹ fail 0' };
        },
        async get() { return { body: [], status: 200 }; },
        async post(path, body) {
          posts.push({ path, body });
          if (failCreate) return { body: {}, status: 503 };
          return { body: { number: 810 + i }, status: 201 };
        },
      };
      const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: nights[i]! });
      filed += posts.filter((p) => p.path === '/repos/aywengo/mercury/issues' && report.flakes.some((fl) => fl.issue !== undefined)).length;
      if (i === 2) {
        assert.equal(posts.length, 1, 'threshold night attempted the filing');
        assert.equal(report.flakes[0]!.issue, undefined, 'the create failed: no issue recorded');
        const state = loadFlakeState({ XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' });
        const fp = Object.keys(state)[0]!;
        assert.equal(state[fp]!.nights.length, 2, 'the failed night was rolled back off the clock');
      }
      if (i === 3) {
        assert.equal(posts.length, 1, 'the next night RETRIES the filing');
        assert.equal(report.flakes[0]!.issue, 813);
      }
    }
    assert.equal(filed, 1, 'filed exactly once overall');
  } finally {
    cleanup();
  }
});

test('a failed comment post (5xx) records the observation honestly and still reports', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'known defect', error: 'AssertionError: known', file: 'e2e/system.test.ts' };
    const fp = await fingerprintOf(failure.name, failure.error);
    const io: E2eIo = {
      async run() { return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) }; },
      async get(path) {
        if (path.startsWith('/repos/aywengo/mercury/issues?')) {
          return { body: [{ number: 501, body: `defect body\n<!-- nightly-e2e-fp:${fp} -->\n` }], status: 200 };
        }
        return { body: [], status: 200 };
      },
      async post() { return { body: {}, status: 503 }; },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    // One JSON-serializable report line regardless of GitHub failures:
    assert.equal(JSON.parse(JSON.stringify(report)) === null, false);
    assert.equal(report.real.length, 1);
    assert.equal(report.real[0]!.action, 'dry-run', 'a failed comment is an unrecorded observation');
    assert.equal(report.real[0]!.issue, 501);
  } finally {
    cleanup();
  }
});

test('a failing suite with unparseable output records one observation and never files', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    // Non-zero exit, but the output has no spec-reporter failure block at all.
    const calls: { path: string; body?: unknown }[] = [];
    const io: E2eIo = {
      async run() { return { code: 1, output: 'spawn ENOENT: the harness itself crashed' }; },
      async get(path) { calls.push({ path }); return { body: [], status: 200 }; },
      async post(path, body) { calls.push({ path, body }); return { body: { number: 1 }, status: 201 }; },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.equal(calls.length, 0, 'never file based on unparseable output');
    assert.equal(report.real.length, 1);
    assert.equal(report.real[0]!.action, 'dry-run');
    assert.match(report.real[0]!.test, /unparseable/);
  } finally {
    cleanup();
  }
});

test('a real failure fingerprints the RERUN error line when the rerun names the same test', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    const failure = { name: 'shifting defect', error: 'Error: first flavor at a.test.ts:1:1', file: 'e2e/system.test.ts' };
    const rerunOut = [
      '✖ shifting defect (0.4ms)',
      'ℹ pass 0',
      'ℹ fail 1',
      '',
      '✖ failing tests:',
      '',
      'test at e2e/system.test.ts:3:1',
      '✖ shifting defect (0.4ms)',
      '  Error: reproducible flavor',
    ].join('\n');
    const posts: { path: string; body: unknown }[] = [];
    let suite = 0;
    const io: E2eIo = {
      async run() {
        suite += 1;
        if (suite === 1) return { code: 1, output: failingOutput(failure.name, failure.error, failure.file) };
        return { code: 1, output: rerunOut };
      },
      async get() { return { body: [], status: 200 }; },
      async post(path, body) { posts.push({ path, body }); return { body: { number: 950 }, status: 201 }; },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.equal(report.real.length, 1);
    assert.equal(report.real[0]!.action, 'filed');
    // The filed body cites the RERUN's error (the reproducible signature):
    const body = String((posts[0]!.body as { body?: string }).body);
    assert.match(body, /reproducible flavor/);
    assert.doesNotMatch(body, /first flavor/);
  } finally {
    cleanup();
  }
});

test('a failure with no extractable error line is observed, never filed (name-only fingerprints)', async () => {
  const { dir, cleanup } = tempStateDir();
  try {
    // The suite fails; the detail block names the file but the rerun passes (flake path would
    // record the night with an empty error too) — so force the RERUN to fail WITHOUT a parseable
    // error line for the test: rerunFails but parseFailures finds the test with error ''.
    const suiteOut = [
      '✖ nameless failure (0.5ms)',
      'ℹ pass 0',
      'ℹ fail 1',
      '',
      '✖ failing tests:',
      '',
      'test at e2e/system.test.ts:3:1',
      '✖ nameless failure (0.5ms)',
    ].join('\n'); // no error line follows the detail entry
    const posts: { path: string; body: unknown }[] = [];
    let suite = 0;
    const io: E2eIo = {
      async run() {
        suite += 1;
        if (suite === 1) return { code: 1, output: suiteOut };
        // Rerun fails but its detail block carries a DIFFERENT test's error only:
        return { code: 1, output: 'ℹ fail 1\n\n✖ failing tests:\n\ntest at e2e/system.test.ts:3:1\n✖ nameless failure (0.5ms)\n' };
      },
      async get() { return { body: [], status: 200 }; },
      async post(path, body) { posts.push({ path, body }); return { body: { number: 1 }, status: 201 }; },
    };
    const report = await runE2eSkill(io, { XDG_STATE_HOME: dir, GH_TOKEN: 'test-token' }, { repo: 'aywengo/mercury', dryRun: false, night: '2026-09-26' });
    assert.equal(posts.length, 0, 'never file a name-only fingerprint');
    assert.equal(report.real.length, 1);
    assert.equal(report.real[0]!.action, 'dry-run');
    assert.equal(report.real[0]!.error, '');
  } finally {
    cleanup();
  }
});

test('repo validation refuses a non owner/name value', async () => {
  const io: E2eIo = { run: PASSING, async get() { return { body: [], status: 200 }; }, async post() { return { body: {}, status: 201 }; } };
  await assert.rejects(
    () => runE2eSkill(io, {}, { repo: '../escape', dryRun: true, night: '2026-09-26' }),
    /owner\/name/,
  );
});
