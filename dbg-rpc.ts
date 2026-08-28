
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcAgentAdapter } from './src/adapters/rpcAgentAdapter.ts';

const MOCK = join(import.meta.dirname, 'test', 'fixtures', 'mock-prime-agent-rpc.mjs');
const ws = mkdtempSync(join(tmpdir(), 'dbg-'));
const run = {
  id: 'run_dbg', ownerId: 'alice', task: 'Fix tests', repository: { localPath: '/tmp/repo' },
  workspaceBranch: null, workspacePath: null, agent: 'pi', status: 'QUEUED', attempt: 1,
  retryOf: null, error: null, errorKind: null,
  constraints: { maxDurationMs: 60000, maxRetries: 2 },
  createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
  leaseOwner: null, leaseExpiresAt: null, cancellationRequestedAt: null,
  finalCommits: [], prUrl: null,
};
const context = {
  run,
  repository: run.repository,
  workspace: { path: ws, branch: 'agent/x', baseCommit: 'abc', mode: 'copy' },
  skills: [],
  constraints: run.constraints,
};
const adapter = new RpcAgentAdapter({
  id: 'pi', description: 'pi', command: MOCK, args: [],
  protocol: { modeFlag: '--mode', modeValue: 'rpc' },
  eventMap: {}, input: { enabled: true }, resume: { enabled: true },
});
const handle = await adapter.start(context);
const events = [];
for await (const ev of handle.events) {
  if (ev.type === '__done__') continue;
  events.push(ev);
}
const exit = await handle.exit;
console.log('EXIT:', JSON.stringify(exit));
console.log('EVENTS:', events.map(e => e.type).join(','));
await adapter.cancel(context.run.id).catch(() => {});
