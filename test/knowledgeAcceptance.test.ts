/**
 * The Phase 2 acceptance proof (docs/knowledge-base.md section 16 phase 2).
 *
 * "Proven by a real Run whose output depends on a promoted note -- a note naming a command the agent
 * would not otherwise have found, and a transcript showing it used it."
 *
 * The chain exercised, with no seam stubbed:
 *
 *   Atlas (real child process, real HTTP) -> puller -> knowledge_replica -> selection at Run creation
 *   -> run_knowledge -> worker materializes the workspace -> a REAL subprocess agent reads the files
 *   -> its transcript contains a token that exists nowhere else
 *
 * What this proves and what it does not, stated plainly. It proves the plumbing carries water: a fact
 * that entered the system as an admin promoting a note reaches the working directory of a real process
 * Mercury spawned, and comes back out through that process's own output. It does NOT prove a language
 * model acted on the note -- the agent here is deterministic on purpose, because a proof that depends on
 * what an LLM chose to read cannot fail reliably, and a test that cannot fail is not evidence. The
 * model-behaviour half needs a harness with an authenticated channel (section 9.3), which is tracked
 * separately rather than quietly assumed here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDatabase } from '../src/db/database.ts';
import { AtlasClient } from '../src/knowledge/client.ts';
import { KnowledgePuller } from '../src/knowledge/puller.ts';
import { ReplicaStore } from '../src/knowledge/replica.ts';
import { LocalAgentRegistry } from '../src/adapters/localAgentRegistry.ts';
import { makeEnv, makeGitRepo, tempDir, waitFor } from './helpers.ts';
import type { KnowledgeSelectionDeps } from '../src/runs/runService.ts';

const REPO = resolve(import.meta.dirname, '..');
const AGENT_SCRIPT = join(REPO, 'test/fixtures/mock-knowledge-agent.mjs');
const ADMIN = 'acceptance-admin-token-01234567';
const CONTRIBUTOR = 'acceptance-contrib-token-012345';
const PROJECT = 'mercury';
const REPO_URL = 'https://github.com/aywengo/mercury.git';

/** The token the note carries. Chosen to be unguessable and absent from every other file in the repo. */
const SECRET_COMMAND = 'glimmer-check --verify-sigil=THRESHOLD-9182-KAPPA';

const QUIET = { info() {}, warn() {}, error() {} } as never;

interface Atlas { url: string; stop(): Promise<void> }

async function startAtlas(dir: string): Promise<Atlas> {
  const contributorsFile = join(dir, 'contributors.json');
  writeFileSync(contributorsFile, JSON.stringify({
    [CONTRIBUTOR]: { hostId: 'host-a', projects: [PROJECT] },
  }), { mode: 0o600 });

  const child: ChildProcess = spawn(process.execPath, [join(REPO, 'atlas/cli.ts'), 'serve'], {
    cwd: REPO,
    env: {
      ...process.env,
      ATLAS_DB: join(dir, 'atlas.db'),
      ATLAS_BIND_HOST: '127.0.0.1',
      ATLAS_PORT: '0',
      ATLAS_ADMIN_TOKEN: ADMIN,
      ATLAS_CONTRIBUTORS_FILE: contributorsFile,
      ATLAS_LOG_LEVEL: 'info', // the listen URL is an info line; 'error' would hang startup detection
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

  return {
    url,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise<void>((done) => { child.once('exit', () => done()); });
    },
  };
}

test('a promoted note reaches a real agent process through the pack', async () => {
  const dir = tempDir('mercury-acceptance-');
  const atlas = await startAtlas(dir);
  try {
    // --- Atlas side: contribute a note, then promote it as an admin. -----------------------------
    const created = await fetch(`${atlas.url}/v1/projects`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: PROJECT, name: 'Mercury', repoIdentities: [REPO_URL] }),
    });
    assert.ok(created.status === 201 || created.status === 409, `project creation got ${created.status}`);

    const contributed = await fetch(`${atlas.url}/v1/projects/${PROJECT}/notes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CONTRIBUTOR}`, 'content-type': 'application/json',
        'idempotency-key': 'acceptance-note-1',
      },
      body: JSON.stringify({
        notes: [{
          projectId: PROJECT, kind: 'command', scope: 'project',
          claim: `Verify the release artefact with \`${SECRET_COMMAND}\``,
          detail: 'The obvious commands do not check the signature; this one does.',
          evidence: [],
          provenance: {
            source: 'agent-reported', hostId: 'host-a', runId: 'run-earlier', agent: 'primeagent',
            harnessVersion: '1.0.0', recordedAt: new Date().toISOString(),
          },
        }],
      }),
    });
    const contributedBody = await contributed.json() as { results: Record<string, string>[]; error?: string };
    assert.equal(contributed.status, 200, `Atlas refused the note: ${JSON.stringify(contributedBody)}`);
    const first = contributedBody.results[0] ?? {};
    const noteId = first.accepted;
    assert.ok(noteId, `expected an accepted note, saw ${JSON.stringify(first)}`);

    const promoted = await fetch(`${atlas.url}/v1/projects/${PROJECT}/notes/${noteId}/promote`, {
      method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'acceptance proof' }),
    });
    assert.equal(promoted.status, 200, 'the note must be promoted for selection to consider it');

    // --- Host side: the real puller, against the real Atlas. -------------------------------------
    const hostDb = openDatabase(':memory:');
    const client = new AtlasClient({ url: atlas.url, token: CONTRIBUTOR, project: PROJECT, hostId: 'host-a', caFile: null, adminToken: null });
    const puller = new KnowledgePuller({ db: hostDb, client, project: PROJECT, intervalMs: 60_000, pageSize: 100, retiredRetentionMs: 604_800_000, log: QUIET });
    const pulled = await puller.pullOnce();
    assert.equal(pulled.failed, false, pulled.lastError ?? '');
    assert.equal(pulled.applied, 1, 'the promoted note landed in the replica');

    const replica = new ReplicaStore(hostDb);
    const selection: KnowledgeSelectionDeps = {
      projectId: PROJECT, replica, packMaxBytes: 32_768, injectByDefault: true,
    };

    // --- Mercury side: a real worker, a real workspace, a real agent subprocess. -----------------
    const repo = makeGitRepo(tempDir('mercury-acceptance-repo-'));
    const agents = new LocalAgentRegistry(tempDir('mercury-acceptance-agents-'));
    agents.register({
      id: 'pack-reader',
      description: 'reads the knowledge pack and reports it',
      command: process.execPath,
      args: [AGENT_SCRIPT],
      taskInput: { mode: 'arg', flag: '--task' },
      output: { format: 'jsonl', stream: true, eventPath: 'type' },
      eventMap: { started: 'step.started', message: 'agent.message', completed: 'done' },
      cancel: { signal: 'SIGTERM', graceMs: 200 },
    });

    const env = makeEnv({
      knowledge: selection, knowledgeProject: PROJECT,
      workspaceMode: 'git-worktree', repoDir: repo,
      adapters: agents.all(),
    });
    try {
      const run = env.runService.create({
        ownerId: 'alice', agent: 'pack-reader',
        task: 'verify the release artefact before publishing it',
        repository: { url: REPO_URL, localPath: repo, baseBranch: 'main' },
      });
      await waitFor(() => ['COMPLETED', 'FAILED'].includes(env.runs.get(run.id)!.status), 60_000);
      const done = env.runs.get(run.id)!;
      assert.equal(done.status, 'COMPLETED', done.error ?? '');

      // The transcript, not the database, is what has to carry the token.
      const messages = env.events.list(run.id, 0, 500)
        .filter((e) => e.type === 'agent.message')
        .map((e) => JSON.stringify((e.payload as { text?: string }).text ?? ''));
      const transcript = messages.join('\n');

      assert.ok(transcript.includes('NO PACK') === false, 'the agent found a pack at all');
      assert.ok(transcript.includes('THRESHOLD-9182-KAPPA'),
        'the token reached the agent through the pack and came back in its own output');
      assert.ok(transcript.includes('glimmer-check'),
        'the command the note named is what the agent reported using');

      // And the pack it read is the pack the Run was recorded as having.
      const stored = env.runService.getKnowledge(run.id);
      assert.ok(stored);
      assert.ok(transcript.includes(stored!.packHash),
        'the hash the agent saw is the hash the Run was created with');
    } finally {
      env.close();
    }
  } finally {
    await atlas.stop();
  }
});
