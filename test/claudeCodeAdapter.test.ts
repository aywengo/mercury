// ClaudeCodeAdapter tests against test/fixtures/mock-claude-code.mjs, which replays BYTE-FOR-BYTE
// stdout captured from the real claude 1.0.3 CLI. No API key and no network are needed.
// Covers docs/agent-adapters.md Phase 2 and section 8 acceptance criteria 1-9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCodeAdapter.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';
import { tempDir, tempFile } from './helpers.ts';
import { CLAUDE_MD_FILE, CONTEXT_FILE, GENERATED_PATHS, NOTES_FILE } from '../src/knowledge/materialize.ts';


const MOCK = join(import.meta.dirname, 'fixtures', 'mock-claude-code.mjs');

/** Every spawn the mock recorded, in order. One JSON array per line. */
function readSpawns(file: string): string[][] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
}

function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date().toISOString();
  return {
    id: 'run_claude',
    ownerId: 'alice',
    task: 'Fix the flaky test suite',
    repository: { localPath: '/tmp/repo' },
    workspaceBranch: null,
    workspacePath: null,
    agent: 'claude-code',
    status: 'QUEUED',
    attempt: 1,
    retryOf: null,
    error: null,
    errorKind: null,
    constraints: { maxDurationMs: 60_000, maxRetries: 2 },
    createdAt: now,
    startedAt: null,
    completedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    cancellationRequestedAt: null,
    finalCommits: [],
    prUrl: null,
    ...overrides,
  };
}

function makeContext(task = 'Fix the flaky test suite'): RunContext {
  const run = makeRun({ task });
  return {
    run,
    repository: run.repository,
    workspace: { path: tempDir('mercury-claude-'), branch: 'agent/' + run.id, baseCommit: 'abc', mode: 'copy' },
    skills: [] as ResolvedSkill[],
    constraints: run.constraints,
  };
}

function adapter(opts: Record<string, unknown> = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({ cmd: process.execPath, args: [MOCK], ...opts });
}

async function drain(handle: Awaited<ReturnType<ClaudeCodeAdapter['start']>>) {
  const events: { type: string; payload: unknown }[] = [];
  for await (const ev of handle.events) {
    if (ev.type === '__done__') continue;
    events.push(ev);
  }
  return { events, exit: (await handle.exit) as AgentExit };
}

function types(events: { type: string }[]): string[] {
  return events.map((e) => e.type);
}

test('happy path maps the real stream to Mercury events and completes', async () => {
  const a = adapter();
  const ctx = makeContext();
  const { events, exit } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);

  assert.equal(exit.reason, 'completed', `expected completed, got ${JSON.stringify(exit)}`);
  assert.deepEqual(types(events), [
    'run.started',
    'tool.started',
    'tool.completed',
    'agent.message',
  ]);

  const started = events[0].payload as { sessionId: string | null };
  assert.match(started.sessionId ?? '', /^[0-9a-f-]{36}$/, 'session id comes from the init event');

  const toolStart = events[1].payload as { tool: string; args: unknown };
  assert.equal(toolStart.tool, 'Bash');
  assert.deepEqual(toolStart.args, { command: 'echo hello-from-tool', description: 'Echo hello-from-tool' });

  const msg = events[3].payload as { text: string };
  assert.equal(msg.text, 'It printed: `hello-from-tool`');
});

test('tool.completed recovers the tool name from the earlier tool_use id', async () => {
  // The real tool_result block carries only tool_use_id, never a name. Without the id->name map
  // this event would report tool 'unknown' and the UI could not say what finished.
  const a = adapter();
  const ctx = makeContext();
  const { events } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const done = events.find((e) => e.type === 'tool.completed')!.payload as { tool: string; result: string };
  assert.equal(done.tool, 'Bash', 'name must be recovered, not lost');
  assert.match(done.result, /hello-from-tool/);
});

test('--verbose is ALWAYS passed: stream-json hard-fails without it', async () => {
  // Verified against the real CLI: `-p --output-format stream-json` alone exits 1 with
  // "Error: When using --print, --output-format=stream-json requires --verbose". The design doc
  // never mentions this, so the flag is pinned here rather than trusted to a comment.
  const argvFile = tempFile('claude-argv-', '.json');
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'argv', MOCK_CLAUDE_ARGV_FILE: argvFile } });
  const ctx = makeContext();
  await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const spawns = readSpawns(argvFile);
  assert.equal(spawns.length, 1, 'expected exactly one spawn');
  const argv = spawns[0];
  assert.ok(argv.includes('-p'), 'must be non-interactive');
  assert.ok(argv.includes('stream-json'), 'must request the JSONL stream');
  assert.ok(argv.includes('--verbose'), '--verbose is mandatory for stream-json');
});

test('configured flags reach argv', async () => {
  const argvFile = tempFile('claude-argv-', '.json');
  const a = adapter({
    model: 'claude-sonnet-4-5',
    allowedTools: 'Bash(git:*) Edit',
    disallowedTools: 'Write',
    mcpConfig: '{"mcpServers":{}}',
    skipPermissions: true,
    env: { MOCK_CLAUDE_MODE: 'argv', MOCK_CLAUDE_ARGV_FILE: argvFile },
  });
  const ctx = makeContext();
  await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const spawns = readSpawns(argvFile);
  assert.equal(spawns.length, 1, 'expected exactly one spawn');
  const argv = spawns[0];
  const after = (flag: string) => argv[argv.indexOf(flag) + 1];
  assert.equal(after('--model'), 'claude-sonnet-4-5');
  assert.equal(after('--allowedTools'), 'Bash(git:*) Edit');
  assert.equal(after('--disallowedTools'), 'Write');
  assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
  assert.ok(argv.includes('--dangerously-skip-permissions'));
});

test('skipPermissions is OFF by default: the sandbox-only knob is never implicit', async () => {
  const argvFile = tempFile('claude-argv-', '.json');
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'argv', MOCK_CLAUDE_ARGV_FILE: argvFile } });
  const ctx = makeContext();
  await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const spawns = readSpawns(argvFile);
  assert.equal(spawns.length, 1, 'expected exactly one spawn');
  const argv = spawns[0];
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
});

test('the task goes to stdin and never into argv', async () => {
  // Long tasks must not hit ARG_MAX, and argv is world-readable via ps.
  const argvFile = tempFile('claude-argv-', '.json');
  const envFile = tempFile('claude-env-', '.json');
  const task = 'RECONCILABLE-TASK-TEXT that must arrive on stdin ' + 'x'.repeat(5000);
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'argv', MOCK_CLAUDE_ARGV_FILE: argvFile, MOCK_CLAUDE_ENV_FILE: envFile } });
  const ctx = makeContext(task);
  await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const spawns = readSpawns(argvFile);
  assert.equal(spawns.length, 1, 'expected exactly one spawn');
  const argv = spawns[0];
  const seen = JSON.parse(readFileSync(envFile, 'utf8')) as { task: string };
  assert.ok(!argv.some((x) => x.includes('RECONCILABLE-TASK-TEXT')), 'task must not be in argv');
  // The task arrives first, followed by the run-context pointer (section 9.2). The pointer is the
  // point of the change -- Claude Code's discovery of .mercury-context.json is unverified, so the
  // task text is what tells it the file exists -- but the task itself must arrive verbatim.
  assert.ok(seen.task.startsWith(task), 'task must arrive complete on stdin, before any pointer');
  assert.ok(seen.task.includes('.mercury-context.json'), 'the task text must point at the context file');
});

test('trace env reaches the child', async () => {
  const envFile = tempFile('claude-env-', '.json');
  const a = adapter({ workerId: 'worker-7', env: { MOCK_CLAUDE_MODE: 'argv', MOCK_CLAUDE_ENV_FILE: envFile } });
  const ctx = makeContext();
  await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const seen = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string | null>;
  assert.equal(seen.MERCURY_RUN_ID, ctx.run.id);
  assert.equal(seen.MERCURY_WORKER_ID, 'worker-7');
});

test('is_error true with subtype success and exit 1 settles FAILED, not completed', async () => {
  // THE correctness test for this adapter. The real CLI emits
  //   {"type":"result","subtype":"success","is_error":true,...}   and exits 1
  // Mapping result -> run.completed on subtype alone (what the design doc table implies)
  // would report a failed run as completed.
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'error' } });
  const ctx = makeContext();
  const { exit } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  assert.equal(exit.reason, 'failed');
  assert.equal(exit.code, 1);
  assert.match(exit.message ?? '', /model rejected the request/, 'stderr tail explains the failure');
});

test('is_error true with exit code 0 still settles FAILED', async () => {
  // The only case that proves is_error is read at all. If the adapter settled purely on the exit
  // code, a run whose stream says is_error but whose process exits 0 would be reported completed.
  // (The sibling test with exit 1 cannot prove this: the exit code alone satisfies it.)
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'error_exit0' } });
  const ctx = makeContext();
  const { exit } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  assert.equal(exit.reason, 'failed', `is_error must outrank a clean exit code, got ${JSON.stringify(exit)}`);
});

test('a JSONL object split across two stdout chunks is still parsed', async () => {
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'split' } });
  const ctx = makeContext();
  const { events, exit } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  assert.equal(exit.reason, 'completed');
  assert.ok(types(events).includes('tool.started'), 'the straddled tool_use line must still parse');
});

test('resume passes -r with the session id captured from the stream', async () => {
  // The mock APPENDS argv per spawn, so this asserts the spawn COUNT as well as its flags. That
  // matters: when the file was overwritten in place, a resume whose spawn never happened (EMFILE
  // under full-suite parallelism) left the FIRST spawn's argv on disk and the test reported
  // "resume must pass -r" -- the wrong diagnosis for a spawn that did not occur. Counting spawns
  // separates "did not spawn" from "spawned without the flag".
  const argvFile = tempFile('claude-argv-', '.json');
  const a = adapter({ env: { MOCK_CLAUDE_ARGV_FILE: argvFile } });
  const ctx = makeContext();
  const { events } = await drain(await a.start(ctx));
  const firstId = (events[0].payload as { sessionId: string }).sessionId;
  assert.match(firstId, /^[0-9a-f-]{36}$/);

  const resumed = await a.resume(ctx.run.id, ctx);
  const { events: resumedEvents, exit: resumedExit } = await drain(resumed);
  a.dispose(ctx.run.id);

  // Assert the resume actually RAN before asserting what it was launched with. Under full-suite
  // parallelism a spawn can fail outright; without this the test blames the -r flag for a process
  // that never started, which is what it did for two days.
  assert.equal(
    resumedExit.reason, 'completed',
    `resume did not run (exit ${JSON.stringify(resumedExit)}, ${resumedEvents.length} events) -- `
    + 'the spawn failed, most likely resource pressure from the parallel suite',
  );

  // The child appends argv before it emits anything, so by now the line exists; the short poll only
  // absorbs filesystem latency on a loaded machine rather than papering over a missing spawn.
  let spawns = readSpawns(argvFile);
  for (let i = 0; spawns.length < 2 && i < 40; i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    spawns = readSpawns(argvFile);
  }
  assert.equal(spawns.length, 2, `expected a start spawn and a resume spawn, got ${spawns.length}`);
  assert.ok(!spawns[0].includes('-r'), 'the FIRST spawn is a fresh run and must not resume');
  const argv = spawns[1];
  assert.ok(argv.includes('-r'), 'resume must pass -r');
  assert.equal(argv[argv.indexOf('-r') + 1], firstId, 'and it must be the id from the stream');
  assert.ok(argv.includes('--verbose'), 'resume must still satisfy the stream-json requirement');
});

test('resume without a captured session id fails loudly, not silently from scratch', async () => {
  // Silent retry-from-scratch would lose the conversation while reporting success.
  const a = adapter();
  await assert.rejects(
    () => a.resume('run_never_started', makeContext()),
    /No session id|use retry-from-scratch/,
  );
});

test('cancel settles cancelled and stops the child', async () => {
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'hang' } });
  const ctx = makeContext();
  const handle = await a.start(ctx);
  // let the child start and emit init
  await new Promise((r) => setTimeout(r, 150));
  await a.cancel(ctx.run.id);
  const exit = await handle.exit;
  a.dispose(ctx.run.id);
  assert.equal(exit.reason, 'cancelled');
});

test('terminate settles terminated and stops the child', async () => {
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'hang' } });
  const ctx = makeContext();
  const handle = await a.start(ctx);
  await new Promise((r) => setTimeout(r, 150));
  await a.terminate(ctx.run.id);
  const exit = await handle.exit;
  a.dispose(ctx.run.id);
  assert.equal(exit.reason, 'terminated');
});

test('a missing binary settles failed with 127, it does not throw from start', async () => {
  const a = new ClaudeCodeAdapter({ cmd: '/nonexistent/claude-binary-xyz' });
  const ctx = makeContext();
  const handle = await a.start(ctx);
  const exit = await handle.exit;
  a.dispose(ctx.run.id);
  assert.equal(exit.reason, 'failed');
  assert.equal(exit.code, 127);
});

test('sendInput throws rather than silently dropping input', async () => {
  // claude 1.0.3 has no --input-format. Accepting input and dropping it would advertise a
  // capability the adapter cannot honour (#194) and leave a run waiting forever on input.required.
  const a = adapter();
  await assert.rejects(() => a.sendInput('run_claude', { text: 'go on' } as never), /does not support sendInput/);
});

test('result.result is not re-emitted when assistant text already arrived', async () => {
  // The real result event repeats the final assistant text verbatim. Emitting both would show the
  // same message twice in the timeline.
  const a = adapter();
  const ctx = makeContext();
  const { events } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  const msgs = events.filter((e) => e.type === 'agent.message');
  assert.equal(msgs.length, 1, `expected exactly one agent.message, got ${msgs.length}`);
});

test('result.result IS emitted when no assistant text ever arrived', async () => {
  // The other half: dropping it here would lose the run output entirely.
  const a = adapter({ env: { MOCK_CLAUDE_MODE: 'noresult' } });
  const ctx = makeContext();
  const { events } = await drain(await a.start(ctx));
  a.dispose(ctx.run.id);
  assert.equal(types(events).filter((t) => t === 'agent.message').length, 1);
});


// --- knowledge channel: CLAUDE.md (docs/knowledge-base.md §9.3) -------------------------------
//
// §10's status column claimed this channel existed before any of it was written: the adapter had no
// knowledge code at all, so a Claude Run got a pack materialized into its workspace that nothing told
// the model about. These tests are what makes that sentence true.

function knowledgeContext(opts: { knowledge?: boolean } = {}): { context: RunContext; workspacePath: string } {
  const context = makeContext();
  const workspacePath = context.workspace.path;
  mkdirSync(join(workspacePath, '.mercury', 'knowledge'), { recursive: true });
  // The neutral files are present in BOTH cases, so the negative test proves the adapter stayed out
  // because there was no pack, not because there was nothing to copy.
  writeFileSync(join(workspacePath, NOTES_FILE), '# Project knowledge\npack testhash123 -- 1 note\n');
  if (opts.knowledge) {
    (context as { knowledge?: unknown }).knowledge = { packHash: 'testhash123', path: NOTES_FILE, count: 1 };
  }
  return { context, workspacePath };
}

test('knowledge channel: no tracked CLAUDE.md -> adapter writes CLAUDE.md from NOTES.md', async () => {
  const { context, workspacePath } = knowledgeContext({ knowledge: true });
  const a = adapter();
  await drain(await a.start(context));
  a.dispose(context.run.id);

  const claudeMd = join(workspacePath, CLAUDE_MD_FILE);
  assert.ok(existsSync(claudeMd), 'CLAUDE.md must be written when none was tracked');
  assert.equal(readFileSync(claudeMd, 'utf8'), readFileSync(join(workspacePath, NOTES_FILE), 'utf8'),
    'CLAUDE.md must be byte-identical to NOTES.md so Claude receives the same pack');
});

test('knowledge channel: tracked CLAUDE.md is left byte-identical and the prompt points at the pack', async () => {
  const { context, workspacePath } = knowledgeContext({ knowledge: true });
  const tracked = '# Project CLAUDE.md (tracked by repo)\nDo not overwrite me.\n';
  const claudeMd = join(workspacePath, CLAUDE_MD_FILE);
  writeFileSync(claudeMd, tracked);

  const taskFile = join(tempDir('mercury-claude-task-'), 'task.json');
  const a = adapter({ env: { MOCK_CLAUDE_ENV_FILE: taskFile } });
  await drain(await a.start(context));
  a.dispose(context.run.id);

  assert.equal(readFileSync(claudeMd, 'utf8'), tracked,
    'a tracked CLAUDE.md must survive byte-for-byte (§9.4 forbids Mercury editing a tracked file)');
  const sent = JSON.parse(readFileSync(taskFile, 'utf8')).task as string;
  assert.match(sent, /Fix the flaky test suite/, 'the task itself must still be sent');
  assert.ok(sent.includes(NOTES_FILE),
    `with no CLAUDE.md channel the prompt must name the pack file (§9.3 fallback): ${JSON.stringify(sent)}`);
  // Every path the prompt sends the model to must actually exist. Naming one that does not is the
  // whole failure mode here: `.mercury-context.json` is written by the prime-agent, rpc and daemon
  // adapters, never by the worker, so a Claude Run has no such file. Asserting only that NOTES.md is
  // named does not catch it -- a pointer naming both files passes that, which is how the defect shipped
  // once already.
  //
  // Scoped to `.mercury`-prefixed paths, which is narrower than "every path" and knows it. The pack
  // lives under `.mercury` and the one file that was wrongly named lives there too, so this covers the
  // realistic regressions; a future pointer to some path outside it, e.g. a bare `knowledge/NOTES.md`,
  // would slip past. Widening it further means deciding where a sentence ends and a filename begins,
  // which is a parser this test does not need until someone writes a pointer that needs it.
  const named = [...sent.matchAll(/(?:\.mercury[-/][\w./-]*)/g)].map((m) => m[0]);
  assert.ok(named.length > 0, 'the degraded prompt must name at least one path, or it points at nothing');
  for (const path of named) {
    assert.ok(existsSync(join(workspacePath, path)),
      `the prompt sends the model to ${path}, which does not exist in a Claude workspace`);
  }
});

test('knowledge channel: no knowledge context -> CLAUDE.md is not written', async () => {
  const { context, workspacePath } = knowledgeContext({ knowledge: false });
  const a = adapter();
  await drain(await a.start(context));
  a.dispose(context.run.id);

  assert.ok(!existsSync(join(workspacePath, CLAUDE_MD_FILE)),
    'the adapter must not touch the workspace when no pack was injected for this Run');
});


test('the run-context file is written for every Run, with or without knowledge', async () => {
  // Section 9.2: the context file is the run context, not the knowledge channel. A Run without
  // knowledge still gets one, identical in shape to what the prime/rpc/daemon adapters write, so a
  // harness that reads it sees the same contract whichever adapter ran the Run.
  for (const withKnowledge of [false, true]) {
    const { context, workspacePath } = knowledgeContext({ knowledge: withKnowledge });
    const a = adapter();
    await drain(await a.start(context));
    a.dispose(context.run.id);

    const ctxFile = join(workspacePath, CONTEXT_FILE);
    assert.ok(existsSync(ctxFile), `context file must exist (knowledge=${withKnowledge})`);
    const parsed = JSON.parse(readFileSync(ctxFile, 'utf8')) as Record<string, unknown>;
    assert.equal(parsed.runId, context.run.id);
    assert.equal(parsed.task, context.run.task);
    assert.equal(parsed.workspace, workspacePath);
    assert.equal(parsed.branch, context.workspace.branch);
    assert.equal(parsed.baseCommit, context.workspace.baseCommit);
    assert.deepEqual(parsed.skills, []);
    assert.deepEqual(parsed.repository, context.repository);
    // The knowledge pointer is present only when there is a pack, matching the other adapters.
    assert.equal('knowledge' in parsed, withKnowledge, `knowledge key present iff pack exists (${withKnowledge})`);
  }
});

test('the context file is excluded from git like the rest of the generated pack', async () => {
  // GENERATED_PATHS is what the workspace manager excludes from the git view. If the context file
  // were missing from it, a Run's context -- including the task text -- would land in a user's pull
  // request. This pins the membership so the exclusion cannot silently lose the new file.
  assert.ok(GENERATED_PATHS.includes(CONTEXT_FILE), 'CONTEXT_FILE must be in GENERATED_PATHS');
});
