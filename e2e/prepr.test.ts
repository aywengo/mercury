/**
 * Guards for the pre-PR gate itself.
 *
 * These are cheap structural checks, and they exist because the properties they hold are the
 * ones that fail SILENTLY: a stage with no deadline hangs forever instead of failing, a stage
 * whose status is swallowed turns a red gate green, and an image whose dependency layer sits
 * after the source copy rebuilds `npm ci` on every edit -- which reads as "the gate is slow",
 * not as "the Dockerfile is wrong".
 *
 * Needs the docker CLI for the Compose model, like the rest of e2e/.
 */

import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, exitCodeFor, type Result, type Stage } from './prepr.ts';
import { composeModel, E2E_DIR } from './preflight.ts';

function result(stage: Partial<Stage> & { code: number; timedOut?: boolean }): Result {
  return {
    stage: { name: stage.name ?? 'x', hint: '', deadlineMs: 1, argv: [] },
    code: stage.code,
    timedOut: stage.timedOut ?? false,
    ms: 0,
  };
}

test('every prepr stage has its own finite deadline -- no stage may be unbounded', () => {
  assert.ok(STAGES.length >= 3, `expected build, verify and e2e; got ${STAGES.map((s) => s.name)}`);
  for (const stage of STAGES) {
    assert.ok(Number.isFinite(stage.deadlineMs) && stage.deadlineMs > 0,
      `stage "${stage.name}" must have a finite positive deadline, got ${stage.deadlineMs}`);
    assert.ok(stage.argv.length > 0, `stage "${stage.name}" has nothing to run`);
    assert.ok(stage.hint.length > 0, `stage "${stage.name}" must say what to do when it fails`);
  }
});

test('stages run cheapest-first: build, then verify, then the system journey', () => {
  assert.deepEqual(STAGES.map((s) => s.name), ['build', 'verify', 'e2e'],
    'a failure in the cheap stages must not pay for the expensive ones');
});

test('the verify stage runs the existing gate INSIDE the image, in its own project', () => {
  const verify = STAGES.find((s) => s.name === 'verify');
  assert.ok(verify);
  const joined = verify.argv.join(' ');
  assert.match(joined, /run --rm verify/, `verify must run the one-shot service: ${joined}`);
  // A dedicated project is what lets verify be torn down before the system stack starts.
  assert.match(joined, /-p\s+(\S*verify)/, `verify must use its own compose project: ${joined}`);
  assert.ok(verify.cleanup, 'verify must tear its project down even when it passes');
  assert.match(verify.cleanup.join(' '), /down -v/, 'teardown must remove the volume, not just the containers');
});

test('a failing stage decides the exit status, and a timeout is distinguishable', () => {
  assert.equal(exitCodeFor([]), 0, 'no stages run is not a failure here (the loop breaks on failure)');
  assert.equal(exitCodeFor([result({ name: 'build', code: 0 }), result({ name: 'verify', code: 0 })]), 0);
  assert.equal(exitCodeFor([result({ name: 'build', code: 0 }), result({ name: 'verify', code: 2 })]), 2,
    'the failing stage status must be propagated, not flattened to 1');
  assert.equal(exitCodeFor([result({ name: 'build', code: 7 }), result({ name: 'verify', code: 3 })]), 7,
    'the FIRST failure decides the status');
  assert.equal(exitCodeFor([result({ name: 'e2e', code: 143, timedOut: true })]), 124,
    'a killed stage must report a timeout, not the signal-derived code');
});

test('the compose model gives verify no state volume and no restart policy', async () => {
  const model = await composeModel();
  const verify = model.services.verify;
  assert.ok(verify, '`verify` service is missing from e2e/compose.yml');
  assert.ok(!verify.volumes || verify.volumes.length === 0,
    `verify must not mount the runtime state volume; it verifies the checkout, not the runtime: ${JSON.stringify(verify.volumes)}`);
  assert.equal(verify.restart, 'no', 'a one-shot must never restart');
  assert.ok(!verify.ports, 'verify publishes no port');
});

test('the verify service actually runs typecheck and the existing suites', async () => {
  const model = await composeModel();
  const raw = model.services.verify.command ?? [];
  const command = ([] as string[]).concat(typeof raw === 'string' ? [raw] : raw);
  const script = command.join(' ');
  assert.match(script, /npm run typecheck/, `verify must typecheck: ${script}`);
  assert.match(script, /npm test/, `verify must run the existing suites: ${script}`);
  assert.match(script, /set -eu/,
    'without `set -e` a failing typecheck would fall through to the next line and verify would exit 0');
});

test('the image installs dependencies before copying source, so the layer caches', () => {
  // Read the Dockerfile directly: this is a property of its instruction ORDER, and the order is
  // what decides whether `npm ci` re-runs on a source-only edit.
  const dockerfile = readFileSync(`${E2E_DIR}/Dockerfile`, 'utf8');
  // Match INSTRUCTION LINES, not substrings. The Dockerfile explains this ordering in a comment that
  // appears above the copy, so a plain indexOf('npm ci') finds the prose first and reports the
  // install as happening before the manifest -- which is exactly backwards, and was the first version
  // of this guard.
  const lineOf = (re: RegExp): number => dockerfile.split('\n').findIndex((line) => re.test(line));
  const manifest = lineOf(/^COPY\s+package\.json/);
  const install = lineOf(/^RUN\s+npm\s+ci\b/);
  const source = lineOf(/^COPY\s+--chown=node:node\s+\.\s+\./);
  assert.ok(manifest >= 0 && install >= 0 && source >= 0,
    `expected a manifest copy, an install and a source copy; found manifest=${manifest} install=${install} source=${source}`);
  assert.ok(manifest < install && install < source,
    '`npm ci` must sit between the manifest copy and the source copy, or every source edit reinstalls');
  assert.match(dockerfile, /npm ci[^\n]*--ignore-scripts/,
    '`npm ci` must skip scripts: the prepare script builds dist/ before any source exists in that layer');
});

test('the gate stays out of npm test and out of CI', () => {
  const pkg = JSON.parse(readFileSync(`${E2E_DIR}/../package.json`, 'utf8')) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts.prepr, '`npm run prepr` must exist');
  for (const key of ['test', 'test:core', 'test:fleet', 'test:client']) {
    assert.ok(!/e2e/.test(pkg.scripts[key] ?? ''),
      `\`npm run ${key}\` must stay Docker-free, but references e2e: ${pkg.scripts[key]}`);
  }
  // CI must not gain a Docker dependency from this gate.
  const workflows = readFileSync(`${E2E_DIR}/../.github/workflows/ci.yml`, 'utf8');
  assert.ok(!/prepr/.test(workflows), 'CI must not run `prepr` -- it is the local gate');
  assert.ok(!/test:e2e/.test(workflows), 'CI must not run the E2E suite');
});
