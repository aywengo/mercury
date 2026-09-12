import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv, tempDir } from './helpers.ts';
import { AgentCapabilityRegistry } from '../src/adapters/capabilities.ts';
import { RpcAgentRegistry } from '../src/adapters/rpcAgentRegistry.ts';
import type { AgentAdapter } from '../src/domain/types.ts';
import { renderAgents } from '../client/commands/agents.ts';
import type { AgentsResponse } from '../client/api/protocol.ts';

// /api/agents grew a second half (issue #508). `agents` stays a bare string array -- the dashboard's
// loadAgents() bails on a non-array -- and `capabilities` grew a `static` block carrying the
// non-version-gated declarations. The one that matters operationally is `skills`: it says whether a
// backend is handed workspace paths or skill NAMES, and handing names to the wrong kind of backend is
// a hard failure that reads like a bad skill choice.

function makeApi(env: ReturnType<typeof makeEnv>) {
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([['tok-alice', 'alice']]),
    adminToken: null,
  });
  return { app, close: () => stream.stop() };
}

async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const { port } = server.address() as import('node:net').AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('GET /api/agents reports static.skills for every registered agent', async () => {
  const env = makeEnv({ workerEnabled: false });
  const api = makeApi(env);
  try {
    const srv = await listen(api.app);
    try {
      const body = await (await fetch(`${srv.url}/api/agents`, {
        headers: { authorization: 'Bearer tok-alice' },
      })).json() as AgentsResponse;
      assert.ok(Array.isArray(body.agents), 'agents must stay a bare array; the dashboard bails otherwise');
      const caps = body.capabilities ?? {};
      assert.ok(Object.keys(caps).length > 0, 'the capabilities half must not be empty');
      const missing = Object.entries(caps)
        .filter(([, c]) => !c.static?.skills)
        .map(([id]) => id);
      assert.deepEqual(missing, [], `agents advertising no skills delivery: ${missing.join(', ')}`);
      // Asserted against whatever the server actually registered, not a guessed id: the test env
      // ships only `fake`, which executes nothing and so honestly declares 'none'. The five
      // code-defined adapters (prime-agent, hermes, claude, daemon, fake) are pinned with their
      // measured values in test/agentCapabilities.test.ts.
      const def = body.defaultAgent;
      assert.ok(caps[def], `the default agent ${def} must appear in capabilities`);
      assert.equal(caps[def].static?.skills, 'none',
        'the test default is the fake adapter, which consumes no skills');
    } finally { await srv.close(); }
  } finally { api.close(); env.close(); }
});

test('a declarative RPC agent JSON with a capabilities block surfaces it verbatim', async () => {
  // Acceptance 4: the block must survive JSON file -> registry -> adapter -> HTTP, with no step
  // dropping it because it only knew about goals.
  const dir = tempDir('mercury-rpc-caps-');
  writeFileSync(join(dir, 'custom.json'), JSON.stringify({
    id: 'custom',
    description: 'declarative agent with declared capabilities',
    command: process.execPath,
    args: [],
    protocol: { modeFlag: '--mode', modeValue: 'rpc' },
    eventMap: {},
    capabilities: { skills: 'nativeNames', humanInput: true, personaAppend: false },
  }));
  const adapters = new RpcAgentRegistry(dir).load();
  const adapter = adapters['custom'];
  assert.ok(adapter, 'the registry did not load the config');
  assert.deepEqual(adapter.capabilities.static, { skills: 'nativeNames', humanInput: true, personaAppend: false });
});

test('an adapter with no static block omits the key rather than sending an empty object', () => {
  // `{ static: {} }` would tell a client "this agent has no capabilities" when the truth is "nobody
  // said". Absent and false are different claims throughout this surface.
  const env = makeEnv({ workerEnabled: false });
  try {
    const caps = env.runService.listAgentCapabilities();
    for (const [id, c] of Object.entries(caps)) {
      if (c.static !== undefined) {
        assert.ok(Object.keys(c.static).length > 0, `${id}: static present but empty`);
      }
    }
    // A declarative adapter whose config declares nothing must produce no static key at all.
    const dir = tempDir('mercury-rpc-nocaps-');
    writeFileSync(join(dir, 'bare.json'), JSON.stringify({
      id: 'bare', description: 'no capabilities declared', command: process.execPath, args: [],
      protocol: { modeFlag: '--mode', modeValue: 'rpc' }, eventMap: {},
    }));
    const bare = new RpcAgentRegistry(dir).load()['bare'];
    assert.deepEqual(bare.capabilities, {}, 'an undeclared config must advertise nothing');
    assert.ok(!('static' in bare.capabilities), 'static must be absent, not empty');
  } finally { env.close(); }
});

test('mercuryctl agents list renders the SKILLS column', () => {
  const ctx = { json: false, noColor: true } as never;
  const response = {
    agents: ['primeagent', 'hermes', 'legacy'],
    defaultAgent: 'primeagent',
    capabilities: {
      primeagent: { version: null, versionRaw: null, goals: { supported: false }, static: { skills: 'workspacePaths' } },
      hermes: { version: null, versionRaw: null, goals: { supported: false }, static: { skills: 'nativeNames' } },
      legacy: { version: null, versionRaw: null, goals: { supported: false } },
    },
  } as unknown as AgentsResponse;
  const out = renderAgents(response, ctx, false);
  assert.match(out, /SKILLS/, 'the table must label the column, not just add a cell');
  assert.match(out, /workspacePaths/);
  assert.match(out, /nativeNames/);
  // An older server sends no static block. That is unknown, NOT 'none' -- rendering silence as 'none'
  // would tell an operator to stop using skills on an agent that supports them.
  const lines = out.split('\n');
  const legacyLine = lines.find((l) => l.startsWith('legacy')) ?? '';
  assert.match(legacyLine, /unknown/, 'an unreported delivery mode must render as unknown');
  assert.ok(!/none/.test(legacyLine), `silence must not render as 'none': ${legacyLine}`);
});

test('every SHIPPED declarative agent config declares how it receives skills (issue #521)', () => {
  // This test exists because the one it replaces did not read the files it was named after.
  //
  // The old test was called "the skills value is not invented for pi/omp" and wrote a synthetic
  // fixture into a temp dir with `capabilities: { skills: 'nativeNames' }`, then asserted on the
  // fixture. It never opened rpc-agents/pi.json. The shipped file declared NO capabilities at all, so
  // /api/agents advertised pi and omp with an unknown delivery mode -- the silent `undefined` #508
  // exists to prevent -- while this test stayed green and its name asserted the opposite. A test
  // named after a shipped artifact must read the shipped artifact.
  //
  // Shipped JSON configs are shipped artifacts. They reach /api/agents exactly as a code adapter
  // does, so the "every adapter states a delivery mode" rule has to cover them too.
  const dirs = ['rpc-agents', 'local-agents', 'remote-agents'];
  const modes = new Set(['workspacePaths', 'nativeNames', 'none']);
  let checked = 0;
  for (const dir of dirs) {
    const abs = join(import.meta.dirname, '..', dir);
    if (!existsSync(abs)) continue;
    for (const file of readdirSync(abs).filter((f) => f.endsWith('.json'))) {
      const cfg = JSON.parse(readFileSync(join(abs, file), 'utf8')) as {
        id?: string; capabilities?: { skills?: string };
      };
      const label = `${dir}/${file}`;
      // The id must match the filename: the registry keys adapters by the `id` field, so a file named
      // pi.json declaring id "p1" would be advertised under a name nobody can find in the repo.
      assert.equal(cfg.id, file.replace(/\.json$/, ''), `${label}: id must match the filename`);
      assert.ok(cfg.capabilities, `${label}: no capabilities block; /api/agents advertises an unknown delivery mode`);
      assert.ok(modes.has(cfg.capabilities.skills ?? ''),
        `${label}: capabilities.skills=${JSON.stringify(cfg.capabilities.skills)} is not one of ${[...modes].join(' | ')}`);
      checked++;
    }
  }
  // A guard that silently checks nothing is worse than no guard: it reports confidence with no evidence.
  assert.ok(checked >= 2, `expected the shipped rpc-agents configs to be checked, found ${checked}`);
});

test('the shipped pi/omp configs say workspacePaths, because the prompt points them at the workspace', () => {
  // Measured, not assumed. Two facts make this the only correct value:
  //   1. worker.ts calls writeSkills() for EVERY Run regardless of adapter, so the files are there.
  //   2. rpcAgentAdapter buildPrompt() tells the harness: "The selected skills are available under
  //      .agents/skills/ -- read the relevant SKILL.md files and follow their guidance."
  // The skills array in .mercury-context.json carries id/version/hash as CONTEXT, not as names to
  // resolve. Declaring `nativeNames` here would be actively harmful: under #507 that makes
  // RunService.create() skip skill selection entirely, silently stripping skills from every pi/omp Run.
  const reg = new RpcAgentRegistry(join(import.meta.dirname, '..', 'rpc-agents')).load();
  for (const id of ['pi', 'omp']) {
    assert.ok(reg[id], `the shipped ${id} config must load`);
    assert.equal(reg[id].capabilities.static?.skills, 'workspacePaths',
      `${id}: wrong delivery mode; see the comment in this test for what a wrong value costs`);
    // personaAppend stays absent: unverified is a different claim from false.
    assert.equal(reg[id].capabilities.static?.personaAppend, undefined,
      `${id}: personaAppend is unverified and must be absent, not false and certainly not true`);
  }
});

// --- review round: the closed schema guarded the KEY but not the VALUE -------------------------
//
// The PR body justified a closed `capabilities` block by saying a typo in `skills` would silently
// change which skills a Run gets. That claim was only true of the key. `assertNoUnknownKeys` rejects
// `skillz`, and it said nothing at all about `skills: "workspace_paths"` -- the exact snake_case typo
// the sentence was describing. That loaded, was advertised on /api/agents, and a consumer reading it
// got `undefined` and behaved as if nothing had been declared: the silent failure the block exists to
// prevent, reproduced by the block's own justification.

function rpcWith(capabilities: unknown): () => unknown {
  const dir = tempDir('mercury-rpc-badcaps-');
  writeFileSync(join(dir, 'a.json'), JSON.stringify({
    id: 'a', description: 'd', command: process.execPath, args: [],
    protocol: { modeFlag: '--mode', modeValue: 'rpc' }, eventMap: {}, capabilities,
  }));
  return () => new RpcAgentRegistry(dir).load();
}

test('a malformed capabilities.skills value is rejected at load, not advertised', () => {
  // Every one of these used to load silently and surface on /api/agents as a real declaration.
  for (const bad of ['workspace_paths', 'WORKSPACEPATHS', 'workspacesPaths', 123, true, null, [], '']) {
    const label = JSON.stringify(bad);
    assert.throws(rpcWith({ skills: bad }), /capabilities\.skills must be one of/,
      `registry accepted capabilities.skills = ${label} and would advertise it as real`);
  }
  // The three real values still load.
  for (const good of ['workspacePaths', 'nativeNames', 'none']) {
    assert.doesNotThrow(rpcWith({ skills: good }), `rejected the valid value ${good}`);
  }
});

test('a malformed boolean or array capability is rejected at load', () => {
  assert.throws(rpcWith({ personaAppend: 'yes' }), /personaAppend must be a boolean/);
  assert.throws(rpcWith({ humanInput: 1 }), /humanInput must be a boolean/);
  assert.throws(rpcWith({ resume: 'true' }), /resume must be a boolean/);
  assert.throws(rpcWith({ knowledge: {} }), /knowledge must be a boolean/);
  assert.throws(rpcWith({ personaFiles: 'A.md' }), /personaFiles must be an array of strings/);
  assert.throws(rpcWith({ personaFiles: [1, 2] }), /personaFiles must be an array of strings/);
});

test('an empty capabilities block yields no static key rather than an empty one', () => {
  // `{ static: {} }` reads as "this backend declares nothing", which is a claim nobody made. A
  // consumer writing `if (caps.static)` would treat it as a declaration.
  const dir = tempDir('mercury-rpc-emptystatic-');
  writeFileSync(join(dir, 'a.json'), JSON.stringify({
    id: 'a', description: 'd', command: process.execPath, args: [],
    protocol: { modeFlag: '--mode', modeValue: 'rpc' }, eventMap: {}, capabilities: {},
  }));
  const adapter = new RpcAgentRegistry(dir).load()['a'];
  assert.deepEqual(adapter.capabilities, {}, 'an empty block must produce no capabilities at all');
  assert.ok(!('static' in adapter.capabilities), 'static must be absent, not {}');
});

test('the value guard is shared by all three declarative adapters', async () => {
  // Three copies of this check would drift, and the one that drifts is the one nobody notices.
  const { LocalAgentRegistry } = await import('../src/adapters/localAgentRegistry.ts');
  const bad = { skills: 'workspace_paths' };
  const dir = tempDir('mercury-local-badcaps-');
  writeFileSync(join(dir, 'a.json'), JSON.stringify({
    id: 'a', description: 'd', command: process.execPath, args: [],
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'jsonl', stream: true, eventPath: 'type' },
    eventMap: {}, cancel: { signal: 'SIGTERM', graceMs: 100 }, capabilities: bad,
  }));
  assert.throws(() => new LocalAgentRegistry(dir).load(), /capabilities\.skills must be one of/,
    'the local registry accepted a malformed skills value');
});
test('a hand-written adapter declaring an empty static block is omitted from the snapshot', () => {
  // The declarative adapters omit `static` at the source, so a test through them proves nothing about
  // the choke point. This builds the adapter directly: the guard under test lives in snapshot(), and
  // a future adapter class is not required to go through the config schema.
  const lying = {
    capabilities: { static: {} },
    async start() { throw new Error('unused'); },
    async cancel() {},
  } as unknown as AgentAdapter;
  const reg = new AgentCapabilityRegistry({ weird: lying });
  const snap = reg.snapshot();
  assert.ok('weird' in snap, 'the agent must still be listed');
  assert.ok(!('static' in snap.weird),
    `snapshot leaked an empty static block: ${JSON.stringify(snap.weird)}`);
});
