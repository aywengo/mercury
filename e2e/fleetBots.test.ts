/**
 * FB3 (#974): a bot on one host dispatches a workflow Run that only another host can serve.
 *
 * This is the tier that proves the whole chain end to end: a bot config with `api.via: "fleet"`, a
 * task template naming a workflow, Fleet's availability filter reading `/api/workflows` off each
 * host, and the Run landing on the host that advertises the template -- then completing there.
 *
 * It runs real processes rather than Docker: two Mercury hosts (server + worker each), one Fleet,
 * and the real `host bot dispatch` CLI. No LLM and no network: the Runs use the fake adapter.
 *
 * Run it with `npm run test:e2e` (it needs no containers) or directly:
 *   node --test --test-timeout=180000 e2e/fleetBots.test.ts
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const ADMIN_A = 'tok-admin-a-0123456789abcdef';
const ADMIN_B = 'tok-admin-b-0123456789abcdef';
const FLEET_CALLER = 'bot-token-0123456789abcdef';
const WORKFLOW_ID = 'only-on-b';

// The E2E harness may only import node builtins, testcontainers and its own files (guard:
// robustness.test.ts, "the harness never imports product code"), so this file carries its own
// tempDir instead of importing test/helpers.ts: same mkdtemp semantics, and the same file-level
// teardown with the same force flag (the fixture git repo marks objects read-only).
const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup must not fail a passing test */ }
  }
});

interface Proc { child: ChildProcess; stop: () => void }

function spawnNode(args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Draining matters: a full pipe buffer blocks the child mid-test and looks like a hang.
  child.stdout?.resume();
  child.stderr?.resume();
  return { child, stop: () => child.kill('SIGKILL') };
}

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function port(): number {
  return 41000 + Math.floor(Math.random() * 2000);
}

interface Host { proc: Proc; base: string; token: string; dir: string }

async function bootHost(name: string, token: string, workflowsDir: string, repoPath: string): Promise<Host> {
  const dir = tempDir(`fleetbots-${name}-`);
  const p = port();
  const base = `http://127.0.0.1:${p}`;
  const env = {
    MERCURY_PORT: String(p),
    MERCURY_BIND_HOST: '127.0.0.1',
    MERCURY_DATA_DIR: join(dir, 'data'),
    MERCURY_WORKSPACE_BASE: join(dir, 'ws'),
    MERCURY_ADMIN_TOKEN: token,
    MERCURY_WORKFLOWS_DIR: workflowsDir,
    MERCURY_DEFAULT_AGENT: 'fake',
  };
  const server = spawnNode([join(ROOT, 'src', 'cli.ts'), 'server'], env);
  await waitFor(async () => {
    try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; }
  }, `${name} healthz`);
  const worker = spawnNode([join(ROOT, 'src', 'cli.ts'), 'worker'], env);
  const proc = { child: server.child, stop: () => { server.stop(); worker.stop(); } };
  return { proc, base, token, dir };
}

test('a bot on host A dispatches a workflow Run that only host B can serve (FB3, #974)', async (t) => {
  // Host B carries one workflow; host A carries none. Same package, different MERCURY_WORKFLOWS_DIR:
  // that variable is what makes "this host serves this template" a per-host fact (#1078).
  const workflowsB = tempDir('fleetbots-wf-');
  mkdirSync(join(workflowsB, WORKFLOW_ID), { recursive: true });
  writeFileSync(join(workflowsB, WORKFLOW_ID, 'workflow.json'), JSON.stringify({
    schemaVersion: 1,
    id: WORKFLOW_ID,
    version: '1.0.0',
    description: 'A template that only host B carries.',
    mode: 'advisory',
    stages: [{ id: 'one', task: 'Say DONE.' }],
    maxStages: 1,
  }));
  const workflowsA = tempDir('fleetbots-wf-a-');   // empty: host A serves no templates

  // A real git repository: the worker asks it for HEAD before handing the workspace to an agent, so
  // a plain directory fails as infrastructure before the agent is ever reached.
  const repo = tempDir('fleetbots-repo-');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.email=e2e@test', '-c', 'user.name=e2e', 'commit', '-qm', 'fixture']]) {
    const res = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  }

  const a = await bootHost('a', ADMIN_A, workflowsA, repo);
  const b = await bootHost('b', ADMIN_B, workflowsB, repo);
  const fleetDir = tempDir('fleetbots-fleet-');
  const credFile = join(fleetDir, 'credentials.json');
  writeFileSync(credFile, JSON.stringify({ a: ADMIN_A, b: ADMIN_B }), { mode: 0o600 });
  const fp = port();
  const fleetBase = `http://127.0.0.1:${fp}`;
  const fleetEnv = {
    FLEET_DB: join(fleetDir, 'fleet.db'),
    FLEET_CREDENTIALS_FILE: credFile,
    FLEET_API_TOKENS: `${FLEET_CALLER}:operator:*`,
    // The probe sweep is an admin route; the same token serves as the admin credential here so the
    // test drives one caller identity rather than two.
    FLEET_ADMIN_TOKEN: FLEET_CALLER,
    FLEET_PORT: String(fp),
    FLEET_BIND_HOST: '127.0.0.1',
  };
  const fleet = spawnNode([join(ROOT, 'fleet', 'cli.ts'), 'serve'], fleetEnv);
  t.after(() => { fleet.stop(); a.proc.stop(); b.proc.stop(); });

  await waitFor(async () => {
    try { return (await fetch(`${fleetBase}/healthz`)).ok; } catch { return false; }
  }, 'fleet healthz');

  // Register both hosts. `--path` is what lets routing explain a localPath Run: a host that has not
  // declared the path is excluded by name rather than silently skipped.
  for (const [id, host] of [['a', a], ['b', b]] as const) {
    const r = await new Promise<number>((resolve, reject) => {
      const c = spawn(process.execPath, [join(ROOT, 'fleet', 'cli.ts'), 'hosts', 'add', id,
        '--url', host.base, '--credential', id, '--path', repo], { cwd: ROOT, env: { ...process.env, ...fleetEnv }, stdio: 'ignore' });
      c.on('error', reject);
      c.on('close', (code) => resolve(code ?? 1));
    });
    assert.equal(r, 0, `hosts add ${id} failed`);
  }

  // One probe sweep populates availability from each host's own /api/workflows.
  const probed = await fetch(`${fleetBase}/fleet/probe`, {
    method: 'POST', headers: { authorization: `Bearer ${FLEET_CALLER}` },
  });
  assert.equal(probed.status, 200);

  const availB = await getJson(`${fleetBase}/fleet/hosts/b/availability`, FLEET_CALLER);
  assert.equal(availB.status, 200);
  assert.match(JSON.stringify(availB.body), new RegExp(WORKFLOW_ID), 'host B must advertise the template it serves');
  const availA = await getJson(`${fleetBase}/fleet/hosts/a/availability`, FLEET_CALLER);
  assert.equal(availA.status, 200);
  assert.doesNotMatch(JSON.stringify(availA.body), new RegExp(WORKFLOW_ID), 'host A must not advertise it');

  // The bot lives on host A and talks to Fleet, not to a Mercury API directly.
  const xdg = tempDir('fleetbots-xdg-');
  mkdirSync(join(xdg, 'mercury', 'bots'), { recursive: true });
  writeFileSync(join(xdg, 'mercury', 'bots', 'e2e.json'), JSON.stringify({
    api: { url: fleetBase, via: 'fleet' },
    schedule: {
      tasks: [{
        name: 'go',
        cron: '0 3 * * *',
        template: {
          task: 'Say DONE.',
          workflow: { id: WORKFLOW_ID },
          repository: { localPath: repo },
        },
      }],
    },
  }));
  writeFileSync(join(xdg, 'mercury', 'bot-credentials.json'), JSON.stringify({
    e2e: { api: ADMIN_A, fleet: FLEET_CALLER },
  }), { mode: 0o600 });

  const dispatchCode = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), 'host', 'bot', 'dispatch',
      '--alias', 'e2e', '--task', 'go', '--yes'], {
      cwd: ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    });
    let out = '';
    c.stdout?.setEncoding('utf8');
    c.stderr?.setEncoding('utf8');
    c.stdout?.on('data', (d: string) => { out += d; });
    c.stderr?.on('data', (d: string) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  if (dispatchCode.code !== 0) {
    const direct = await fetch(`${fleetBase}/fleet/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${FLEET_CALLER}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Say DONE.', workflow: { id: WORKFLOW_ID }, repository: { localPath: repo } }),
    });
    assert.fail(`dispatch failed: ${dispatchCode.out} | direct: ${direct.status} ${await direct.text()}`);
  }

  // Exactly one Run, placed on B by the workflow it names -- not on A, which serves no template.
  const list = await getJson(`${fleetBase}/fleet/runs`, FLEET_CALLER);
  assert.equal(list.status, 200);
  const runs = (list.body as { runs: any[] }).runs;
  assert.equal(runs.length, 1, `expected one fleet run, got ${JSON.stringify(runs)}`);
  assert.equal(runs[0].hostId, 'b', 'the workflow named by the body decides the host');

  let final: any;
  await waitFor(async () => {
    const one = await getJson(`${fleetBase}/fleet/runs/${runs[0].fleetRunId}`, FLEET_CALLER);
    const raw = one.body?.state?.status ?? one.body?.status;
    const status = typeof raw === 'string' ? raw.toLowerCase() : undefined;
    if (status === 'completed') { final = one.body; return true; }
    if (status && ['failed', 'canceled', 'error'].includes(status)) {
      throw new Error(`fleet run ended ${status}: ${JSON.stringify(one.body)}`);
    }
    return false;
  }, 'the fleet run to complete', 60_000).catch(async (err: Error) => {
    const one = await getJson(`${fleetBase}/fleet/runs/${runs[0].fleetRunId}`, FLEET_CALLER);
    const child = one.body?.childRunId ? await getJson(`${b.base}/api/runs/${one.body.childRunId}`, ADMIN_B) : null;
    throw new Error(`${err.message} | binding: ${JSON.stringify(one.body)} | child: ${JSON.stringify(child?.body)}`);
  });
  assert.equal(String(final.state.status).toLowerCase(), 'completed');
  assert.ok(final.childRunId, 'the completed binding must name the child Run');
});
