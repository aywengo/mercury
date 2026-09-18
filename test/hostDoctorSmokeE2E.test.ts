
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, makeGitRepo, tempDir } from './helpers.ts';
import { createApp, closeServer } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { smokeRun } from '../src/host/doctor.ts';
import type { AddressInfo } from 'node:net';

test('doctor smokeRun detects a COMPLETED run against the real API (review #635 regression)', async () => {
  const repo = makeGitRepo(tempDir('proof-repo-'));
  const env = makeEnv({ workerEnabled: true, workspaceMode: 'git-worktree', repoDir: repo, fakeScript: [{ event: { type: 'agent.message', payload: { text: 'hi' } } }] });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['api-tok', 'alice']]),
    adminToken: null,
    queue: env.queue,
    db: env.db,
  } as Parameters<typeof createApp>[0]);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const create = await fetch(`${url}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer api-tok' },
      body: JSON.stringify({ task: 'smoke', agent: 'fake', repository: { localPath: repo } }),
    });
    const created = await create.json() as { runId: string };
    let status = '';
    let error = '';
    for (let i = 0; i < 50; i++) {
      const poll = await fetch(`${url}/api/runs/${created.runId}`, { headers: { Authorization: 'Bearer api-tok' } });
      const body = await poll.json() as { run: { status: string; error: string | null } };
      status = body.run.status;
      error = body.run.error ?? '';
      if (status === 'COMPLETED' || status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log('REAL run status via API:', status, 'error:', error);
    const r = await smokeRun(url, 'api-tok', 'fake', 8000, repo);
    console.log('SMOKE RESULT:', JSON.stringify(r));
    assert.equal(status, 'COMPLETED', `the run really completed (got ${status}: ${error})`);
    assert.equal(r.ok, true, 'smokeRun should have detected the completed run');
  } finally {
    await closeServer(server);
    stream.stop();
    env.close();
  }
});
