/**
 * Workflows are reachable on a running host (issue #1078).
 *
 * The registry, the validator and the W-3 routes all existed, and nothing built the registry in the
 * composition root: `GET /api/workflows` answered 404 on every host and a Run's `workflow` block was
 * rejected. These tests boot the real CLI server, because the bug lived exactly in the wiring between
 * `src/cli.ts` and `RunService` — a test that constructs `RunService` itself would have missed it,
 * which is how it survived W-3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');

interface Served {
  status: number;
  body: unknown;
}

/** Boot `mercury server` on an ephemeral port, run `fn`, and always stop it. */
async function withServer<T>(envExtra: Record<string, string>, fn: (base: string) => Promise<T>): Promise<T> {
  const dir = tempDir('workflows-wiring-');
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'server'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MERCURY_PORT: String(port),
      MERCURY_BIND_HOST: '127.0.0.1',
      MERCURY_DATA_DIR: join(dir, 'data'),
      MERCURY_WORKSPACE_BASE: join(dir, 'ws'),
      MERCURY_ADMIN_TOKEN: 'tok-admin-0123456789abcdef',
      MERCURY_EMBEDDED_WORKER: 'false',
      ...envExtra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error('server did not become healthy in 30s');
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(base);
  } finally {
    child.kill('SIGKILL');
  }
}

async function get(base: string, path: string): Promise<Served> {
  const r = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer tok-admin-0123456789abcdef' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('a running host serves the builtin workflow templates (#1078)', async () => {
  await withServer({}, async (base) => {
    const listed = await get(base, '/api/workflows');
    assert.equal(listed.status, 200, 'GET /api/workflows must not 404 on a host that ships workflows');
    const ids = ((listed.body as { workflows?: { id: string }[] }).workflows ?? []).map((w) => w.id);
    assert.ok(ids.includes('plan-implement-review'), `expected the builtin template, got ${JSON.stringify(ids)}`);
    const one = await get(base, '/api/workflows/plan-implement-review');
    assert.equal(one.status, 200);
  });
});

test('MERCURY_WORKFLOWS_DIR decides which templates THIS host carries (#1078, FB3)', async () => {
  // The point of the variable: Fleet places a workflow Run on a host that advertises that workflow,
  // so a host must be able to carry a set another host does not.
  const dir = tempDir('workflows-dir-');
  const wf = join(dir, 'only-here');
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(wf, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'only-here',
    version: '1.0.0',
    description: 'A template that exists on this host only.',
    mode: 'advisory',
    stages: [{ id: 'one', task: 'Reply with the single word DONE.' }],
    maxStages: 1,
  }));
  await withServer({ MERCURY_WORKFLOWS_DIR: dir }, async (base) => {
    const listed = await get(base, '/api/workflows');
    assert.equal(listed.status, 200);
    const ids = ((listed.body as { workflows?: { id: string }[] }).workflows ?? []).map((w) => w.id);
    assert.deepEqual(ids, ['only-here'], 'the override directory is the whole set, not an addition');
  });
});
