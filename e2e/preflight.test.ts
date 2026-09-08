/**
 * Preflight floor tests. No Docker daemon: these cover only the version arithmetic, which is the part
 * that can be wrong quietly. Run on its own with `node --test e2e/preflight.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveFloor, parseFloor, REPO_ROOT } from './preflight.ts';

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
  assert.ok(floor[0] > repoFloor[0] || floor[1] >= repoFloor[1], 'floor must never be below the repository floor');
  if (from === 'testcontainers engines.node') {
    assert.ok(floor[1] > repoFloor[1], 'when a dependency raises the floor it must be above the repository floor');
  }
  assert.ok(['package.json engines.node', 'testcontainers engines.node'].includes(from),
    `the message must name a real source, got ${from}`);
});
