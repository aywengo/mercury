/**
 * Preflight floor tests. No Docker daemon: these cover only the version arithmetic, which is the part
 * that can be wrong quietly. Run on its own with `node --test e2e/preflight.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmp, effectiveFloor, parseFloor, PreflightError, REPO_ROOT } from './preflight.ts';

test('parseFloor reads the shapes engines actually uses', () => {
  assert.deepEqual(parseFloor('>=22.18.0'), [22, 18, 0]);
  // testcontainers writes its floor with a space and only two components; a parser that assumed three
  // digits, or no space, would throw on a real dependency.
  assert.deepEqual(parseFloor('>= 22.22'), [22, 22, 0]);
  assert.deepEqual(parseFloor('^22.18.0'), [22, 18, 0]);
  assert.throws(() => parseFloor('lts/*'), /cannot read a Node version/);
});

test('the effective floor is the highest one that applies, and says which', async () => {
  const { floor, from } = await effectiveFloor();
  assert.ok(floor[0] >= 22, `major floor looks wrong: ${floor.join('.')}`);
  // The point of this function: testcontainers needs >= 22.22 while the repository floor is 22.18.0, so
  // a preflight that read only package.json would green-light a Node the suite then fails on.
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')) as { engines: { node: string } };
  const repoFloor = parseFloor(pkg.engines.node);
  // Tuple comparison, not per-component: comparing minors without first pinning the major lets a
  // regression like repo 23.0.0 vs effective 22.99.0 through, because 99 >= 0.
  assert.ok(cmp(floor, repoFloor) >= 0, `effective floor ${floor.join('.')} must not be below the repository floor ${repoFloor.join('.')}`);
  if (from === 'testcontainers engines.node') {
    assert.ok(cmp(floor, repoFloor) > 0,
      'when a dependency is named as the source it must actually be above the repository floor');
  }
  assert.ok(['package.json engines.node', 'testcontainers engines.node'].includes(from),
    `the message must name a real source, got ${from}`);
});

test('a dependency manifest that exists but cannot be parsed is an error, not a shrug', async () => {
  // The first version wrapped the dependency read in a bare catch. That is the dangerous direction: a
  // present-but-malformed manifest means the floor is real and unknown, and ignoring it green-lights a Node
  // the suite then fails on. Only "not installed" may be ignored.
  const dir = await mkdtemp(join(tmpdir(), 'floor-'));
  try {
    await mkdir(join(dir, 'node_modules', 'testcontainers'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=22.18.0' } }));
    await writeFile(join(dir, 'node_modules', 'testcontainers', 'package.json'), '{ not json');
    await assert.rejects(() => effectiveFloor(dir), (err: unknown) =>
      err instanceof PreflightError && /cannot read the testcontainers floor/.test(err.message),
      'a malformed dependency manifest must surface, not be swallowed');
    // Absent dependency stays ignorable: its floor is genuinely not in play.
    await rm(join(dir, 'node_modules', 'testcontainers'), { recursive: true, force: true });
    const { floor, from } = await effectiveFloor(dir);
    assert.deepEqual(floor, [22, 18, 0]);
    assert.equal(from, 'package.json engines.node');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
