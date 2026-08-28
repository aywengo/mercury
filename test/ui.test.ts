// Dashboard UI smoke tests: static assets served, auth boundary intact,
// and the UI module files parse (browser-side behavior is verified manually/CDP).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv } from './helpers.ts';
import type { Express } from 'express';

const UI_DIR = join(import.meta.dirname, '..', 'ui');

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

test('UI files exist and are served without auth', async () => {
  for (const f of ['index.html', 'run.html', 'app.js', 'index.js', 'run.js', 'style.css']) {
    assert.ok(existsSync(join(UI_DIR, f)), `missing ui/${f}`);
  }
  const env = makeEnv({ workerEnabled: false });
  try {
    const stream = new EventStream(env.db, env.events, 10);
    stream.start();
    const app = createApp({
      runService: env.runService,
      events: env.events,
      stream,
      apiTokens: new Map([['tok-alice', 'alice']]),
      adminToken: null,
    });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // static assets: public
      for (const f of ['', 'run.html', 'app.js', 'style.css']) {
        const res = await fetch(`${base}/${f}`);
        assert.equal(res.status, 200, `GET /${f} should be 200`);
      }
      // API: still auth-gated (no token AND no cookie, or a bogus cookie)
      const noAuth = await fetch(`${base}/api/runs`);
      assert.equal(noAuth.status, 401);
      const bogusCookie = await fetch(`${base}/api/runs`, { headers: { cookie: 'mercury_session=not-a-real-session' } });
      assert.equal(bogusCookie.status, 401);
      const withAuth = await fetch(`${base}/api/runs`, { headers: { authorization: 'Bearer tok-alice' } });
      assert.equal(withAuth.status, 200);
    } finally {
      await srv.close();
      stream.stop();
    }
  } finally {
    env.close();
  }
});

test('UI pages reference the correct assets', () => {
  const index = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  const run = readFileSync(join(UI_DIR, 'run.html'), 'utf8');
  assert.match(index, /<script type="module" src="\/index\.js">/);
  assert.match(index, /<link rel="stylesheet" href="\/style\.css">/);
  assert.match(run, /<script type="module" src="\/run\.js">/);
  // both pages use the shared helpers
  assert.match(readFileSync(join(UI_DIR, 'index.js'), 'utf8'), /from '\.\/app\.js'/);
  assert.match(readFileSync(join(UI_DIR, 'run.js'), 'utf8'), /from '\.\/app\.js'/);
});

test('UI JS modules parse (syntax check)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  for (const f of ['app.js', 'index.js', 'run.js']) {
    // node --check validates ESM syntax without executing (no DOM needed)
    await execFileP(process.execPath, ['--check', join(UI_DIR, f)]);
  }
  // app.js must import cleanly (no DOM at import time)
  const mod = await import('../ui/app.js');
  assert.equal(typeof mod.api, 'function');
  assert.equal(typeof mod.sse, 'function');
});
