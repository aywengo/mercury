// ClaudeCodeAdapter tests against test/fixtures/mock-claude-code.mjs, which replays BYTE-FOR-BYTE
// stdout captured from the real claude 1.0.3 CLI. No API key and no network are needed.
// Covers docs/agent-adapters.md Phase 2 and section 8 acceptance criteria 1-9.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claudeCodeAdapter.ts';
import type { AgentExit, Run, RunContext, ResolvedSkill } from '../src/domain/types.ts';
import { tempDir, tempFile } from './helpers.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-claude-code.mjs');

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
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
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
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
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
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
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
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  const seen = JSON.parse(readFileSync(envFile, 'utf8')) as { task: string };
  assert.ok(!argv.some((x) => x.includes('RECONCILABLE-TASK-TEXT')), 'task must not be in argv');
  assert.equal(seen.task, task, 'task must arrive complete on stdin');
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
  // The adapter records argv on EVERY spawn, so: start (records argv #1, captures the id from the
  // init event), then resume (overwrites with argv #2, which must carry -r <that id>).
  const argvFile = tempFile('claude-argv-', '.json');
  const a = adapter({ env: { MOCK_CLAUDE_ARGV_FILE: argvFile } });
  const ctx = makeContext();
  const { events } = await drain(await a.start(ctx));
  const firstId = (events[0].payload as { sessionId: string }).sessionId;
  assert.match(firstId, /^[0-9a-f-]{36}$/);

  const resumed = await a.resume(ctx.run.id, ctx);
  await drain(resumed);
  a.dispose(ctx.run.id);

  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
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
