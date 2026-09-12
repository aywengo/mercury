import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';

// A Run stores a skill snapshot -- content, files, version and hash -- in run_skills, and
// getSkills() returns it in full. Until #506 the worker ignored it:
//
//   skills.resolve(runService.getSkills(run.id).map((s) => s.id))
//
// Mapping to ids and re-resolving reads whatever the registry holds AT EXECUTION TIME, so the
// snapshot was written and then thrown away. Two consequences, both covered below:
//
//   1. Editing a skill changed what an already-queued Run executed. The Run's own record said one
//      version and the workspace received another.
//   2. Deleting a skill made resolveOne() throw, so the Run failed to start and could not even be
//      retried -- the retry path passed ids through create() too.
//
// The pre-existing test ('skills are snapshotted per run') asserts the DB rows carry hash and
// content. That is true and irrelevant: it never executes a Run, so it proves the snapshot is
// stored, not that it is used.

const SENTINEL = 'SENTINEL-EDITED-AFTER-THE-RUN-WAS-CREATED';

function writeSkill(root: string, id: string, version: string, body: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\nversion: ${version}\ndescription: Fixture skill for #506.\ncapabilities: [testing]\n---\n\n${body}\n`,
  );
}

function skillFile(workspacePath: string, id: string): string {
  return readFileSync(join(workspacePath, '.agents', 'skills', id, 'SKILL.md'), 'utf8');
}

function eventsOf(env: ReturnType<typeof makeEnv>, runId: string, type: string): any[] {
  return env.events.list(runId).filter((e: any) => e.type === type);
}

test('a queued Run executes the skill bytes it was created with, not the live registry', async () => {
  const skillsDir = tempDir('mercury-skills-506-');
  writeSkill(skillsDir, 'alpha', '1.0.0', 'ORIGINAL BODY');
  const repo = makeGitRepo(tempDir('mercury-repo-506-'));
  const env = makeEnv({ workerEnabled: false, skillsDir, repoDir: repo });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'do the thing',
      agent: 'fake',
      skills: ['alpha'],
      repository: { localPath: repo, baseBranch: 'main' },
    });

    // Diverge the live registry AFTER creation and BEFORE the worker materialises skills. The
    // worker is not started yet, so this is ordered, not racy.
    writeSkill(skillsDir, 'alpha', '9.9.9', SENTINEL);

    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 15_000);

    const written = skillFile(env.runs.get(run.id)!.workspacePath!, 'alpha');
    assert.ok(written.includes('ORIGINAL BODY'), 'the Run executed bytes its parent never saw');
    assert.ok(!written.includes(SENTINEL), 'live registry content leaked into the workspace');
    assert.ok(written.includes('1.0.0'), 'workspace skill lost the pinned version');
  } finally {
    env.close();
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test('skill.selected and skill.started report the same version and hash', async () => {
  const skillsDir = tempDir('mercury-skills-506b-');
  writeSkill(skillsDir, 'alpha', '1.0.0', 'ORIGINAL BODY');
  const repo = makeGitRepo(tempDir('mercury-repo-506b-'));
  const env = makeEnv({ workerEnabled: false, skillsDir, repoDir: repo });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'do the thing',
      agent: 'fake',
      skills: ['alpha'],
      repository: { localPath: repo, baseBranch: 'main' },
    });
    // Diverge before execution: the two event pairs must still agree with each other, because both
    // must come from the snapshot. Before #506 skill.selected read the snapshot and skill.started
    // read the registry, so the Run's own event stream contradicted itself.
    writeSkill(skillsDir, 'alpha', '9.9.9', SENTINEL);

    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'COMPLETED', 15_000);

    const selected = eventsOf(env, run.id, 'skill.selected');
    const started = eventsOf(env, run.id, 'skill.started');
    assert.equal(selected.length, 1);
    assert.equal(started.length, 1);
    assert.equal(started[0].payload.version, selected[0].payload.version,
      'skill.started reported a different version than skill.selected');
    assert.equal(started[0].payload.version, '1.0.0');
    const stored = env.runService.getSkills(run.id)[0];
    assert.equal(selected[0].payload.hash, stored.hash);
    assert.equal(started[0].payload.skill, 'alpha');
  } finally {
    env.close();
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test('a Run whose skill was deleted still executes, and so does its retry', async () => {
  const skillsDir = tempDir('mercury-skills-506c-');
  writeSkill(skillsDir, 'alpha', '1.0.0', 'ORIGINAL BODY');
  const repo = makeGitRepo(tempDir('mercury-repo-506c-'));
  // The Run must end FAILED, not COMPLETED: retry() refuses a completed Run by design, and a
  // retried Run is exactly the path #506 broke.
  const env = makeEnv({
    workerEnabled: false, skillsDir, repoDir: repo, maxRetries: 1,
    // A task failure, not an infrastructure one: maybeAutoRetry() returns early for anything but
    // infrastructure, so the Run stays FAILED at attempt 1 and the manual retry below is legal.
    fakeScript: [{ fail: true }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'do the thing',
      agent: 'fake',
      skills: ['alpha'],
      repository: { localPath: repo, baseBranch: 'main' },
    });
    // Deletion is the harsher case: resolveOne() throws ValidationError, so re-resolving did not
    // merely substitute content, it stopped the Run from starting at all.
    rmSync(join(skillsDir, 'alpha'), { recursive: true, force: true });

    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 15_000);
    assert.ok(skillFile(env.runs.get(run.id)!.workspacePath!, 'alpha').includes('ORIGINAL BODY'),
      'a Run whose skill was deleted could not start at all');

    // Retry must carry the parent's snapshot. Passing ids would hit the same throw, so a Run whose
    // skill had been deleted could never be retried.
    const retried = env.runService.retry(run.id, 'alice', true);
    const parentSnap = env.runService.getSkills(run.id);
    const childSnap = env.runService.getSkills(retried.id);
    assert.deepEqual(childSnap, parentSnap, 'the retry did not inherit the parent snapshot verbatim');

    env.worker.start();
    await waitFor(() => env.runs.get(retried.id)!.status === 'FAILED', 15_000);
    assert.ok(skillFile(env.runs.get(retried.id)!.workspacePath!, 'alpha').includes('ORIGINAL BODY'),
      'the retried Run executed something other than the parent snapshot');
  } finally {
    env.close();
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test('a retry re-resolves nothing even when the skill still exists but changed', async () => {
  const skillsDir = tempDir('mercury-skills-506d-');
  writeSkill(skillsDir, 'alpha', '1.0.0', 'ORIGINAL BODY');
  const repo = makeGitRepo(tempDir('mercury-repo-506d-'));
  const env = makeEnv({
    workerEnabled: false, skillsDir, repoDir: repo, maxRetries: 1,
    // A task failure, not an infrastructure one: maybeAutoRetry() returns early for anything but
    // infrastructure, so the Run stays FAILED at attempt 1 and the manual retry below is legal.
    fakeScript: [{ fail: true }],
  });
  try {
    const run = env.runService.create({
      ownerId: 'alice',
      task: 'do the thing',
      agent: 'fake',
      skills: ['alpha'],
      repository: { localPath: repo, baseBranch: 'main' },
    });
    env.worker.start();
    await waitFor(() => env.runs.get(run.id)!.status === 'FAILED', 15_000);

    writeSkill(skillsDir, 'alpha', '2.0.0', SENTINEL);
    const retried = env.runService.retry(run.id, 'alice', true);
    const snap = env.runService.getSkills(retried.id);
    assert.equal(snap[0].version, '1.0.0', 'the retry picked up the edited version');
    assert.ok(!snap[0].content.includes(SENTINEL), 'the retry picked up edited content');
    assert.equal(snap[0].hash, env.runService.getSkills(run.id)[0].hash);
  } finally {
    env.close();
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test('a NEW Run naming a deleted skill still fails loudly', () => {
  // The fix must not widen into "unknown skills are silently fine". A fresh Run has no snapshot to
  // fall back on, so a typo or a removed skill stays a hard error at create time.
  const skillsDir = tempDir('mercury-skills-506e-');
  writeSkill(skillsDir, 'alpha', '1.0.0', 'ORIGINAL BODY');
  const env = makeEnv({ workerEnabled: false, skillsDir });
  try {
    rmSync(join(skillsDir, 'alpha'), { recursive: true, force: true });
    assert.throws(
      () => env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake', skills: ['alpha'] }),
      /Skill not found/,
    );
  } finally {
    env.close();
    rmSync(skillsDir, { recursive: true, force: true });
  }
});

test('the worker reads the snapshot rather than the registry (source-level wiring)', () => {
  // The behavioural tests above cover the happy path and deletion. This pins the shape, so the
  // regression cannot return in a form the behavioural tests happen to miss -- for example by
  // re-introducing a resolve() call for a second consumer.
  const src = readFileSync(new URL('../src/worker/worker.ts', import.meta.url), 'utf8');
  assert.ok(
    /getSkills\(run\.id\)/.test(src),
    'the worker must read the Run snapshot through getSkills(run.id)',
  );
  assert.ok(
    !/skills\.resolve\(/.test(src),
    'the worker must not re-resolve skill ids against the live registry',
  );
  assert.ok(existsSync(new URL('../src/worker/worker.ts', import.meta.url)));
});
