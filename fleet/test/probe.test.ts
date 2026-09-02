import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeHost } from '../probe.ts';

interface Behavior {
  health?: { status?: number; body?: unknown; delayMs?: number };
  workers?: { status?: number; body?: unknown; delayMs?: number };
  agents?: { status?: number; body?: unknown; delayMs?: number };
  /** Record what the probe actually sent, so auth behaviour is observed rather than assumed. */
  seen?: Array<{ path: string; auth: string | undefined }>;
}

async function startFakeMercury(behavior: Behavior): Promise<{ url: string; close: () => Promise<void>; seen: NonNullable<Behavior['seen']> }> {
  const seen = behavior.seen ?? [];
  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const cfg = req.url === '/healthz' ? behavior.health
      : req.url === '/healthz/workers' ? behavior.workers
      : req.url === '/api/agents' ? behavior.agents
      : undefined;
    seen.push({ path: req.url ?? '', auth: req.headers.authorization as string | undefined });
    if (!cfg) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (cfg.delayMs) await new Promise((r) => setTimeout(r, cfg.delayMs));
    res.writeHead(cfg.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cfg.body ?? {}));
  };
  const server: Server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const HEALTHY_WORKERS = {
  // camelCase on the wire: activeLeases() maps lease_owner/active_runs/oldest_expires before responding.
  workers: [{ workerId: 'w1', activeRuns: 2, oldestLeaseExpiresAt: 'x' },
            { workerId: 'w2', activeRuns: 3, oldestLeaseExpiresAt: 'y' }],
  queueDepth: 7,
};

test('a healthy host reports ok with summed capacity and its agent list', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true, ts: new Date().toISOString() } },
    workers: { body: HEALTHY_WORKERS },
    agents: { body: { agents: ['prime-agent', 'fake'] } },
  });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 2000 });
    assert.equal(r.outcome, 'ok');
    assert.equal(r.activeRuns, 5, 'activeRuns sums across workers, not the first worker');
    assert.equal(r.queueDepth, 7);
    assert.equal(r.workerCount, 2);
    assert.equal(r.workerId, 'w1,w2');
    assert.deepEqual(r.agents, ['prime-agent', 'fake']);
  } finally { await fake.close(); }
});

test('only /api/agents carries the credential; the health endpoints stay public', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true } }, workers: { body: HEALTHY_WORKERS }, agents: { body: { agents: [] } },
  });
  try {
    await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok-secret-9', timeoutMs: 2000 });
    const byPath = Object.fromEntries(fake.seen.map((s) => [s.path, s.auth]));
    assert.equal(byPath['/healthz'], undefined, 'a probe must not leak the token to a public endpoint');
    assert.equal(byPath['/healthz/workers'], undefined);
    assert.equal(byPath['/api/agents'], 'Bearer tok-secret-9');
  } finally { await fake.close(); }
});

test('a refused credential is auth-fail, not down, and keeps the capacity it learned', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true } }, workers: { body: HEALTHY_WORKERS },
    agents: { status: 401, body: { error: 'authentication required' } },
  });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'wrong', timeoutMs: 2000 });
    assert.equal(r.outcome, 'unauthorized');
    assert.match(r.detail ?? '', /reachable but this credential was rejected/);
    // What must not happen is the diagnosis "this host is unreachable". The word "down" may legitimately
    // appear in the remediation advice ("do not assume the host is down"), so match the claim, not the word.
    assert.ok(!/cannot reach|unreachable|connection refused/i.test(r.detail ?? ''),
      `must not report the host as unreachable: ${r.detail}`);
    assert.equal(r.activeRuns, 5, 'the health data gathered before the 401 is still worth reporting');
  } finally { await fake.close(); }
});

test('a 503 from /healthz/workers means reachable but not serving work', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true } },
    workers: { status: 503, body: { error: 'queue not configured' } },
    agents: { body: { agents: ['prime-agent'] } },
  });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 2000 });
    assert.equal(r.outcome, 'not_serving');
    assert.equal(r.detail, 'queue not configured');
    assert.deepEqual(r.agents, ['prime-agent']);
  } finally { await fake.close(); }
});

test('an older Mercury without /healthz/workers is still usable, with capacity unknown', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true } },  // no workers handler -> 404
    agents: { body: { agents: ['prime-agent'] } },
  });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 2000 });
    // Not not_serving: that would pull a dispatchable host out of rotation over a missing telemetry route.
    assert.equal(r.outcome, 'ok');
    assert.match(r.detail ?? '', /capacity unknown/);
    assert.equal(r.activeRuns, null);
  } finally { await fake.close(); }
});

test('something that is not Mercury is identified as such', async () => {
  const fake = await startFakeMercury({});  // every path 404s
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 2000 });
    assert.equal(r.outcome, 'not_mercury');
    assert.match(r.detail ?? '', /no \/healthz/);
  } finally { await fake.close(); }
});

test('a closed port is unreachable, and the probe never throws', async () => {
  const fake = await startFakeMercury({ health: { body: { ok: true } } });
  const url = fake.url;
  await fake.close();  // nothing listening any more
  const r = await probeHost({ hostId: 'h', baseUrl: url, token: 'tok', timeoutMs: 1000 });
  assert.equal(r.outcome, 'unreachable');
  assert.ok(r.detail, 'a failure must carry something to show the operator');
});

test('a hung endpoint is a timeout, not a crash, and is named differently from a refusal', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true } }, workers: { body: HEALTHY_WORKERS },
    agents: { delayMs: 400, body: { agents: [] } },
  });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 60 });
    assert.equal(r.outcome, 'timeout');
    assert.match(r.detail ?? '', /no response within 60 ms|\/api\/agents failed/);
  } finally { await fake.close(); }
});

test('a non-2xx /healthz is an http_error rather than a guess', async () => {
  const fake = await startFakeMercury({ health: { status: 500, body: { error: 'boom' } } });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 1000 });
    assert.equal(r.outcome, 'http_error');
    assert.equal(r.detail, 'HTTP 500 from /healthz');
  } finally { await fake.close(); }
});

test('a malformed agents payload degrades to no agents instead of failing the probe', async () => {
  const fake = await startFakeMercury({
    health: { body: { ok: true } }, workers: { body: HEALTHY_WORKERS },
    agents: { body: { agents: 'not-an-array' } },
  });
  try {
    const r = await probeHost({ hostId: 'h', baseUrl: fake.url, token: 'tok', timeoutMs: 1000 });
    assert.equal(r.outcome, 'ok');
    assert.deepEqual(r.agents, []);
  } finally { await fake.close(); }
});
