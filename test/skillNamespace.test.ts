import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSkillSelector } from '../src/skills/skillSelector.ts';
import { HermesAgentAdapter } from '../src/adapters/hermesAgentAdapter.ts';
import { makeEnv, tempDir, makeGitRepo } from './helpers.ts';
import type { AgentAdapter, AgentCapabilities, RunContext } from '../src/domain/types.ts';
import type { SkillMeta } from '../src/skills/skillRegistry.ts';

// Two gaps kept Hermes from executing ANY Run (issue #507):
//   1. skillSelector could not return nothing -- an omitted `skills` always yielded >=1 Mercury id.
//   2. HermesAgentAdapter forwarded those ids with `-s <id>`, and Hermes resolves names in its OWN
//      installed store, exiting non-zero on an unknown one within a second.
// Together: every Run created for Hermes was guaranteed to fail, and the failure looked like a
// broken Hermes install rather than a namespace violation.

const AVAILABLE: SkillMeta[] = [
  { id: 'planning', version: '1.0.0', description: 'Break a task into a plan.', capabilities: [] },
  { id: 'testing', version: '1.0.0', description: 'Verify code changes with tests.', capabilities: [] },
  { id: 'deployment', version: '1.0.0', description: 'Deploy the service.', capabilities: [] },
];

test('the selector can answer "nothing" when the backend cannot use Mercury ids', () => {
  const sel = createSkillSelector();
  // A task with no keyword match, fallback suppressed.
  assert.deepEqual(sel.select('Say hello.', AVAILABLE, 4, { allowFallback: false }), [],
    'a namespace-incompatible backend must be able to receive zero skills');
  // And a task that WOULD match: the ids are still unusable, so the caller suppresses selection
  // entirely. This assertion documents why create() skips selection rather than only the fallback.
  assert.ok(sel.select('Add tests and verify the deployment', AVAILABLE, 4, { allowFallback: false }).length > 0,
    'allowFallback:false must not silently disable matching -- that is create()\'s decision');
});

test('the fallback default is unchanged for callers that did not opt out', () => {
  // Acceptance 2 at the selector level. Flipping this default would silently change what every
  // existing PrimeAgent Run executes.
  const sel = createSkillSelector();
  const picked = sel.select('Say hello.', AVAILABLE, 4);
  assert.ok(picked.length > 0, 'an omitted opts must still apply FALLBACK');
  assert.deepEqual(sel.select('Say hello.', AVAILABLE, 4, { allowFallback: true }), picked);
});

test('HermesAgentAdapter never emits -s, whatever the Run carries', async () => {
  // Acceptance 3. Verified through the real argv rather than by grepping the source, so a rename of
  // the internal helper cannot make the guard pass while the flag comes back.
  const adapter = new HermesAgentAdapter({});
  const workspacePath = tempDir('mercury-hermes-argv-');
  const run = {
    id: 'run_h', agent: 'hermes', task: 'x',
    repository: { localPath: workspacePath, baseBranch: 'main' }, repositories: [],
    constraints: { maxDurationMs: 1000, maxRetries: 0 },
  };
  const context = {
    run, repository: run.repository,
    workspace: { path: workspacePath, branch: 'agent/run_h', baseCommit: 'abc', mode: 'copy' },
    constraints: run.constraints,
    skills: [
      { id: 'planning', version: '1.0.0', description: '', capabilities: [], path: '', content: '', files: {}, hash: 'a' },
      { id: 'testing', version: '1.0.0', description: '', capabilities: [], path: '', content: '', files: {}, hash: 'b' },
    ],
  } as unknown as RunContext;
  const argv = (adapter as unknown as {
    buildArgv(ctx: RunContext, resumeId: string | null): string[];
  }).buildArgv(context, null);
  assert.ok(!argv.includes('-s'), `argv still carries -s: ${JSON.stringify(argv)}`);
  // Nothing resembling a skill id leaked in through another flag either.
  assert.ok(!argv.includes('planning') && !argv.includes('testing'),
    `a Mercury skill id reached Hermes argv: ${JSON.stringify(argv)}`);
  assert.deepEqual(argv.slice(0, 4), ['chat', '-Q', '--query-file', '-'], 'the base argv must be intact');
});

/** A minimal adapter whose only interesting property is the capability it declares. */
function stubAdapter(capabilities: AgentCapabilities): AgentAdapter {
  return {
    capabilities,
    async start() { throw new Error('not used'); },
    async cancel() {},
  } as unknown as AgentAdapter;
}

test('a Run for a nativeNames agent with no skills carries zero skills', () => {
  // Acceptance 1, at the persistence layer: zero run_skills rows AND zero skill.selected events.
  const env = makeEnv({
    workerEnabled: false,
    adapters: {
      hermeslike: stubAdapter({ static: { skills: 'nativeNames' } }),
      pathlike: stubAdapter({ static: { skills: 'workspacePaths' } }),
      undeclared: stubAdapter({}),
    },
  });
  try {
    const repo = makeGitRepo(tempDir('mercury-ns-'));
    const hermes = env.runService.create({
      ownerId: 'alice', task: 'Add tests for the parser', agent: 'hermeslike',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    assert.deepEqual(env.runService.getSkills(hermes.id), [],
      'a nativeNames backend was handed Mercury skill ids');
    const selected = env.events.list(hermes.id).filter((e) => e.type === 'skill.selected');
    assert.deepEqual(selected, [], 'skill.selected events were emitted for a zero-skill Run');

    // Acceptance 2: a workspacePaths backend keeps today's behaviour, fallback included.
    const pathlike = env.runService.create({
      ownerId: 'alice', task: 'Add tests for the parser', agent: 'pathlike',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    assert.ok(env.runService.getSkills(pathlike.id).length > 0,
      'a workspacePaths backend lost its automatic skill selection');

    // An adapter that has not declared anything is unaffected -- the change must not reach further
    // than the adapters that actually state a delivery mode.
    const undeclared = env.runService.create({
      ownerId: 'alice', task: 'Add tests for the parser', agent: 'undeclared',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    assert.ok(env.runService.getSkills(undeclared.id).length > 0,
      'an adapter with no declared delivery mode changed behaviour');
  } finally { env.close(); }
});

test('an explicit skills list is still honoured for a nativeNames agent', () => {
  // The fix is about OMITTED skills. A caller who explicitly names skills gets what they asked for;
  // silently dropping an explicit request would be a different bug wearing the first one's clothes.
  const env = makeEnv({
    workerEnabled: false,
    adapters: { hermeslike: stubAdapter({ static: { skills: 'nativeNames' } }) },
  });
  try {
    const repo = makeGitRepo(tempDir('mercury-ns2-'));
    const run = env.runService.create({
      ownerId: 'alice', task: 'x', agent: 'hermeslike', skills: ['testing'],
      repository: { localPath: repo, baseBranch: 'main' },
    });
    assert.deepEqual(env.runService.getSkills(run.id).map((s) => s.id), ['testing']);
  } finally { env.close(); }
});

test('the route passes an explicit empty skills array through unchanged', async () => {
  // Acceptance 5. RunService only honours [] if the route does not coerce it to undefined on the way
  // through the JSON body.
  const { createApp } = await import('../src/api/server.ts');
  const { EventStream } = await import('../src/events/eventStream.ts');
  const env = makeEnv({ workerEnabled: false });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService, events: env.events, stream,
    apiTokens: new Map([['tok', 'alice']]), adminToken: null,
  });
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const { port } = server.address() as import('node:net').AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Say hello', agent: 'fake', skills: [] }),
    });
    // Read the body ONCE. An `assert.ok(cond, `... ${await res.text()}`)` template is evaluated
    // eagerly even when the assertion passes, which consumes the stream and makes the subsequent
    // res.json() throw "Body is unusable" -- a failure that looks like a server bug and is the test.
    const text = await res.text();
    // 201 Created. Asserted loosely over the 2xx pair because the status code is not what this test
    // is about, and pinning one number here would fail it for a change in the wrong file.
    assert.ok(res.status === 200 || res.status === 201, `create failed with ${res.status}: ${text}`);
    const body = JSON.parse(text) as { runId: string };
    assert.deepEqual(env.runService.getSkills(body.runId), [],
      'the route coerced skills:[] to omitted, so the Run carries fallback skills');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    stream.stop(); env.close();
  }
});
test('a "none" backend keeps automatic selection -- only nativeNames is disqualifying', () => {
  // The failure mode decides, not the delivery mode. `none` means the adapter forwards nothing: the
  // ids are recorded and materialised, nothing dies. `nativeNames` means the backend resolves the id
  // in its own store and exits non-zero on an unknown one.
  //
  // This test exists because my first attempt treated `none` as incompatible and the new tests above
  // did NOT catch it -- only the pre-existing suite did, incidentally, because the `fake` adapter
  // declares `none` and every test Run uses it. A regression that survives only by accident is not
  // covered. Mutation: `canUseMercurySkills = skillDelivery !== 'nativeNames'` ->
  // `skillDelivery === 'workspacePaths' || skillDelivery === undefined` was invisible to this file
  // until this test was added.
  const env = makeEnv({
    workerEnabled: false,
    adapters: { inert: stubAdapter({ static: { skills: 'none' } }) },
  });
  try {
    const repo = makeGitRepo(tempDir('mercury-ns-none-'));
    const run = env.runService.create({
      ownerId: 'alice', task: 'Add tests for the parser', agent: 'inert',
      repository: { localPath: repo, baseBranch: 'main' },
    });
    assert.ok(env.runService.getSkills(run.id).length > 0,
      'a "none" backend lost automatic skill selection; `none` is not a fatal delivery mode');
  } finally { env.close(); }
});
