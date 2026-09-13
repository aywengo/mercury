/**
 * The Phase 3 acceptance proof (docs/knowledge-base.md section 16 phase 3).
 *
 * "Proven by a Run on host A teaching a Run on host B, through Atlas, in the e2e suite."
 *
 * Two independent hosts, each with its own database and its own worker, sharing nothing but the Atlas
 * service between them. Host A's Run learns something; host B's Run is told it, by a different process on
 * a different database that never saw the first Run. The only path the fact can take is the one this
 * feature is for.
 *
 * Everything is real: real Atlas child process, real HTTP both directions, real workspaces, real agent
 * subprocesses. The agents are deterministic scripts rather than language models on purpose -- see the
 * note in knowledgeAcceptance.test.ts. What is being proved here is that knowledge crosses a host
 * boundary, and that does not need a model to be wrong about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDatabase } from '../src/db/database.ts';
import { AtlasClient } from '../src/knowledge/client.ts';
import { KnowledgePuller } from '../src/knowledge/puller.ts';
import { KnowledgePusher } from '../src/knowledge/pusher.ts';
import { OutboxStore } from '../src/knowledge/outbox.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { LocalAgentRegistry } from '../src/adapters/localAgentRegistry.ts';
import { DEFAULT_BOUNDS } from '../src/knowledge/validation.ts';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { KnowledgeSelectionDeps } from '../src/runs/runService.ts';

const REPO = resolve(import.meta.dirname, '..');
const READER = join(REPO, 'test/fixtures/mock-knowledge-agent.mjs');
const WRITER = join(REPO, 'test/fixtures/mock-knowledge-writer.mjs');
const ADMIN = 'teach-admin-token-0123456789ab';
const TOKEN_A = 'teach-contributor-token-0123';
const TOKEN_B = 'learned-contributor-token-01';
const PROJECT = 'mercury';
const REPO_URL = 'https://github.com/aywengo/mercury.git';

/** The fact. It exists in no file in this repository; host A's agent invents it at runtime. */
const LESSON = 'verify the artefact with glimmer-check --sigil=BRIDGEHOST-55217';

const QUIET = { info() {}, warn() {}, error() {} } as never;

interface Atlas { url: string; stop(): Promise<void> }

async function startAtlas(dir: string): Promise<Atlas> {
  const contributorsFile = join(dir, 'contributors.json');
  writeFileSync(contributorsFile, JSON.stringify({
    [TOKEN_A]: { hostId: 'host-a', projects: [PROJECT] },
    [TOKEN_B]: { hostId: 'host-b', projects: [PROJECT] },
  }), { mode: 0o600 });

  const child: ChildProcess = spawn(process.execPath, [join(REPO, 'atlas/cli.ts'), 'serve'], {
    cwd: REPO,
    env: {
      ...process.env, ATLAS_DB: join(dir, 'atlas.db'), ATLAS_BIND_HOST: '127.0.0.1', ATLAS_PORT: '0',
      ATLAS_ADMIN_TOKEN: ADMIN, ATLAS_CONTRIBUTORS_FILE: contributorsFile,
      // The listen URL is an info line. Setting this to 'error' makes startup detection hang for its
      // full timeout, which reads exactly like a hung test.
      ATLAS_LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const url = await new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('atlas did not report a listen URL within 20s')), 20_000);
    const onData = (c: Buffer): void => {
      const m = /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(c.toString());
      if (m) { clearTimeout(timer); done(m[1]!); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', () => { clearTimeout(timer); fail(new Error('atlas exited before listening')); });
  });
  return { url, stop: async () => {
    child.kill('SIGTERM');
    await new Promise<void>((done) => { child.once('exit', () => done()); });
  } };
}

/** A declarative agent that reads the pack and prints what it found. */
function readerRegistry(dir: string) {
  const reg = new LocalAgentRegistry(tempDir('mercury-bridge-agents-'));
  reg.register({
    id: 'pack-reader', description: 'reads the pack', command: process.execPath, args: [READER],
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'jsonl', stream: true, eventPath: 'type' },
    eventMap: { started: 'step.started', message: 'agent.message', completed: 'done' },
    cancel: { signal: 'SIGTERM', graceMs: 200 },
  });
  return reg;
}

/** A declarative agent that writes what it learned into the tier-1 file, then exits. */
function writerRegistry(dir: string) {
  const reg = new LocalAgentRegistry(tempDir('mercury-bridge-agents-'));
  reg.register({
    id: 'note-writer', description: 'writes a note', command: process.execPath,
    args: [WRITER, '--lesson', LESSON],
    taskInput: { mode: 'arg', flag: '--task' },
    output: { format: 'jsonl', stream: true, eventPath: 'type' },
    eventMap: { started: 'step.started', message: 'agent.message', completed: 'done' },
    cancel: { signal: 'SIGTERM', graceMs: 200 },
  });
  return reg;
}

test('a Run on host A teaches a Run on host B, through Atlas', async () => {
  const dir = tempDir('mercury-bridge-');
  const atlas = await startAtlas(dir);
  try {
    const created = await fetch(`${atlas.url}/v1/projects`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: PROJECT, name: 'Mercury', repoIdentities: [REPO_URL] }),
    });
    assert.ok(created.status === 201 || created.status === 409);

    // ---------- HOST A: a Run learns something and reports it. ----------
    const repoA = makeGitRepo(tempDir('mercury-bridge-repoA-'));
    const outboxA = new OutboxStore(openDatabase(join(dir, 'hostA.db')));
    const envA = makeEnv({
      workspaceMode: 'git-worktree', repoDir: repoA,
      knowledge: { projectId: PROJECT, replica: new ReplicaStore(openDatabase(':memory:')), packMaxBytes: 32_768, injectByDefault: false },
      knowledgeProject: PROJECT,
      knowledgeHarvest: { project: PROJECT, hostId: 'host-a', bounds: { ...DEFAULT_BOUNDS } },
      knowledgeOutbox: outboxA,
      adapters: writerRegistry(dir).all(),
    });

    let lessonNoteId = '';
    try {
      const runA = envA.runService.create({
        ownerId: 'alice', agent: 'note-writer', task: 'figure out how to verify the artefact',
        repository: { url: REPO_URL, localPath: repoA, baseBranch: 'main' },
      });
      await waitFor(() => ['COMPLETED', 'FAILED'].includes(envA.runs.get(runA.id)!.status), 60_000);
      assert.equal(envA.runs.get(runA.id)!.status, 'COMPLETED', envA.runs.get(runA.id)!.error ?? '');

      const noted = envA.events.list(runA.id, 0, 200).find((e) => e.type === 'knowledge.noted');
      assert.ok(noted, 'host A recorded that its Run taught something');
      assert.equal(outboxA.depth(), 1, 'the note is queued on host A');

      // Push host A's outbox to Atlas over real HTTP.
      const pusherA = new KnowledgePusher({
        outbox: outboxA,
        client: new AtlasClient({ url: atlas.url, token: TOKEN_A, project: PROJECT, hostId: 'host-a', caFile: null, adminToken: null }),
        project: PROJECT, intervalMs: 1000, batch: 100, log: QUIET,
      });
      const pushed = await pusherA.pushOnce();
      assert.equal(pushed.failed, false, pushed.lastError ?? '');
      assert.equal(pushed.accepted, 1, `Atlas accepted it: ${JSON.stringify(pushed)}`);
      assert.equal(outboxA.depth(), 0, 'the outbox drains once Atlas acknowledges');

      // Find the note and promote it, as an admin would.
      const feed = await fetch(`${atlas.url}/v1/projects/${PROJECT}/notes?since=0&tier=all`, {
        headers: { authorization: `Bearer ${TOKEN_A}` },
      });
      const feedBody = await feed.json() as { notes: { noteId: string; claim: string }[] };
      const found = feedBody.notes.find((n) => n.claim.includes('BRIDGEHOST-55217'));
      assert.ok(found, 'the lesson is in Atlas');
      lessonNoteId = found!.noteId;
    } finally {
      envA.close();
    }

    // ---------- HOST B: a different host, a different database, a different Run. ----------
    // Nothing is shared with host A but the Atlas URL. A fresh in-memory database starts with an empty
    // replica, so the ONLY way the lesson can reach host B is by being pulled.
    const repoB = makeGitRepo(tempDir('mercury-bridge-repoB-'));
    const hostBDb = openDatabase(':memory:');
    const replicaB = new ReplicaStore(hostBDb);
    const pullerB = new KnowledgePuller({
      db: hostBDb,
      client: new AtlasClient({ url: atlas.url, token: TOKEN_B, project: PROJECT, hostId: 'host-b', caFile: null, adminToken: null }),
      project: PROJECT, intervalMs: 60_000, pageSize: 100, log: QUIET,
    });
    const firstPull = await pullerB.pullOnce();
    assert.equal(firstPull.failed, false, firstPull.lastError ?? '');
    assert.equal(firstPull.bootstrapped, true, 'a brand-new host takes the bootstrap path');
    assert.equal(replicaB.count(PROJECT), 0, 'a candidate note is not yet something a Run should be told');

    const promoted = await fetch(`${atlas.url}/v1/projects/${PROJECT}/notes/${lessonNoteId}/promote`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'corroborated in review' }),
    });
    assert.equal(promoted.status, 200);

    const secondPull = await pullerB.pullOnce();
    assert.equal(secondPull.failed, false, secondPull.lastError ?? '');
    assert.equal(replicaB.count(PROJECT), 1, 'the promoted lesson is now in host B\'s replica');

    const selection: KnowledgeSelectionDeps = {
      projectId: PROJECT, replica: replicaB, packMaxBytes: 32_768, injectByDefault: true,
    };
    const envB = makeEnv({
      workspaceMode: 'git-worktree', repoDir: repoB,
      knowledge: selection, knowledgeProject: PROJECT,
      adapters: readerRegistry(dir).all(),
    });
    try {
      const runB = envB.runService.create({
        ownerId: 'bob', agent: 'pack-reader', task: 'verify the release artefact',
        repository: { url: REPO_URL, localPath: repoB, baseBranch: 'main' },
      });
      await waitFor(() => ['COMPLETED', 'FAILED'].includes(envB.runs.get(runB.id)!.status), 60_000);
      assert.equal(envB.runs.get(runB.id)!.status, 'COMPLETED', envB.runs.get(runB.id)!.error ?? '');

      const transcript = envB.events.list(runB.id, 0, 500)
        .filter((e) => e.type === 'agent.message')
        .map((e) => JSON.stringify((e.payload as { text?: string }).text ?? ''))
        .join('\n');

      assert.ok(transcript.includes('BRIDGEHOST-55217'),
        'host B\'s agent reported a fact it could only have received from host A, through Atlas');
      assert.ok(transcript.includes('glimmer-check'));
      assert.ok(!transcript.includes('NO PACK'));
    } finally {
      envB.close();
    }
  } finally {
    await atlas.stop();
  }
});
