import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeRollup, parseExposition, parseLabels, scrapeAll, type ScrapeResult } from '../metrics.ts';

/**
 * The fixture is a byte-exact capture from a real Mercury (`GET /metrics` against `node src/cli.ts server`), not
 * a reconstruction. That distinction is the point: a fixture written from the same assumptions as the parser
 * would agree with it about everything the parser gets wrong.
 */
const REAL = readFileSync(join(import.meta.dirname, 'fixtures', 'child-metrics.txt'), 'utf8');

test('a real child exposition parses with nothing left over', () => {
  const { families, unparsed } = parseExposition(REAL);
  assert.deepEqual(unparsed, [], 'every line of a real scrape must be understood, not skipped');
  const names = families.map((f) => f.name).sort();
  assert.deepEqual(names, [
    'mercury_claimed_runs', 'mercury_run_duration_seconds', 'mercury_run_errors_total',
    'mercury_run_queue_wait_seconds', 'mercury_runs_in_status', 'mercury_runs_total',
    'mercury_sandbox_enabled_total', 'mercury_workers',
  ]);
});

test('a histogram declared with no samples keeps its TYPE and gains no series', () => {
  // mercury_run_duration_seconds is like this on a fresh Mercury. Dropping the declaration would make the
  // metric invisible until the first run finishes; inventing a zero series would report a duration of 0.
  const { families } = parseExposition(REAL);
  const h = families.find((f) => f.name === 'mercury_run_duration_seconds')!;
  assert.equal(h.type, 'histogram');
  assert.equal(h.samples.length, 0);
  const out = mergeRollup([{ hostId: 'box-1', text: REAL, reason: null }]);
  assert.match(out.text, /# TYPE mercury_run_duration_seconds histogram/);
  assert.doesNotMatch(out.text, /mercury_run_duration_seconds_(sum|count|bucket).*box-1/);
  assert.deepEqual(out.dropped, []);
});

test('two hosts merge with one HELP/TYPE block and a host label on every series', () => {
  const out = mergeRollup([
    { hostId: 'box-1', text: REAL, reason: null },
    { hostId: 'studio', text: REAL, reason: null },
  ]);
  assert.deepEqual(out.dropped, []);
  // Duplicate TYPE lines make an entire scrape invalid to Prometheus, so this is the load-bearing assertion.
  const typeLines = out.text.split('\n').filter((l) => l.startsWith('# TYPE mercury_runs_total'));
  assert.equal(typeLines.length, 1, 'TYPE must be declared once across all hosts');
  const samples = out.text.split('\n').filter((l) => l.startsWith('mercury_runs_total{'));
  assert.equal(samples.length, 2);
  assert.ok(samples.every((l) => /host="(box-1|studio)"/.test(l)), samples.join('\n'));
  // The scrape-success gauge covers every host, including healthy ones, so absence cannot be misread.
  for (const h of ['box-1', 'studio']) {
    assert.match(out.text, new RegExp(`mercury_fleet_scrape_success\\{host="${h}"\\} 1`));
  }
});

test('one dead host does not blank the fleet, and says so in the metrics', () => {
  const out = mergeRollup([
    { hostId: 'box-1', text: REAL, reason: null },
    { hostId: 'dead', text: null, reason: 'connect ECONNREFUSED' },
  ]);
  assert.match(out.text, /mercury_fleet_scrape_success\{host="box-1"\} 1/);
  assert.match(out.text, /mercury_fleet_scrape_success\{host="dead"\} 0/);
  assert.match(out.text, /mercury_runs_total\{host="box-1"\} 0/);
  assert.ok(out.dropped.some((d) => d.includes('dead') && d.includes('ECONNREFUSED')));
});

test('a child that disagrees about a TYPE is reported, not silently merged', () => {
  const conflicting = '# TYPE mercury_runs_total gauge\nmercury_runs_total 5\n';
  const out = mergeRollup([
    { hostId: 'box-1', text: REAL, reason: null },
    { hostId: 'weird', text: conflicting, reason: null },
  ]);
  assert.ok(out.dropped.some((d) => d.includes('TYPE mismatch') && d.includes('mercury_runs_total')),
    out.dropped.join('\n'));
  assert.match(out.text, /# TYPE mercury_runs_total counter/, 'the first declaration wins');
});

test('a series already carrying a host label is dropped rather than poisoning the endpoint', () => {
  // Defensive: Mercury never emits this today. Two labels with one name is text Prometheus rejects outright,
  // so one bad series would take the whole rollup down with it.
  const hostile = '# TYPE mercury_runs_total counter\nmercury_runs_total{host="forged"} 9\n';
  const out = mergeRollup([
    { hostId: 'box-1', text: REAL, reason: null },
    { hostId: 'weird', text: hostile, reason: null },
  ]);
  assert.ok(out.dropped.some((d) => d.includes('already carries a host label')));
  assert.doesNotMatch(out.text, /host="forged"/);
  assert.equal((out.text.match(/host="box-1"/g) ?? []).length > 0, true);
});

test('an unrecognised line is reported instead of vanishing', () => {
  const out = mergeRollup([{ hostId: 'box-1', text: 'this is not metrics\n', reason: null }]);
  assert.ok(out.dropped.some((d) => d.includes('unparsed line')), out.dropped.join('\n'));
});

test('a label value containing a quote cannot forge structure', () => {
  // Two cases, because they need different answers. BS is spelled this way so the number of backslashes in the
  // exposition line is stated once and is not left to whoever next edits this file.
  const BS = String.fromCharCode(92);
  const DQ = String.fromCharCode(34);

  // (1) A well-formed value with an escaped quote must survive the round trip. If the parser unescaped and the
  // renderer failed to re-escape, the value would come back as structure.
  const escaped = `# TYPE t counter\nt{status=${DQ}a${BS}${DQ}${DQ}} 1\n`;
  const { families, unparsed } = parseExposition(escaped);
  assert.deepEqual(unparsed, [], JSON.stringify(unparsed));
  assert.deepEqual(families[0]!.samples[0]!.labels, [['status', `a${DQ}`]]);
  const out = mergeRollup([{ hostId: 'h1', text: escaped, reason: null }]);
  const line = out.text.split('\n').find((l) => l.startsWith('t{'))!;
  assert.equal(line, `t{host=${DQ}h1${DQ},status=${DQ}a${BS}${DQ}${DQ}} 1`, line);
  assert.deepEqual(parseLabels(line.slice(2, line.indexOf('}'))), [['host', 'h1'], ['status', `a${DQ}`]]);

  // (2) A malformed line that tries to break out of its quotes must be REFUSED, not parsed into forged labels.
  // Accepting it silently would let one child inject series into the fleet-wide endpoint.
  const hostile = `# TYPE t counter\nt{status=${DQ}a${DQ}}, injected=${DQ}1${DQ}} 1\n`;
  const r = mergeRollup([{ hostId: 'h1', text: hostile, reason: null }]);
  assert.doesNotMatch(r.text, /injected/, 'the forged label must not reach the output');
  assert.ok(r.dropped.some((d) => d.includes('unparsed line')), r.dropped.join('\n'));
});

test('parseLabels handles the shapes a real scrape produces', () => {
  assert.deepEqual(parseLabels(''), []);
  assert.deepEqual(parseLabels('status="RUNNING"'), [['status', 'RUNNING']]);
  assert.deepEqual(parseLabels('le="+Inf",status="FAILED"'), [['le', '+Inf'], ['status', 'FAILED']]);
  assert.deepEqual(parseLabels('a="1",b="2",c="3"'), [['a', '1'], ['b', '2'], ['c', '3']]);
});

async function closedPort(): Promise<number> {
  const { createServer } = await import('node:http');
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as import('node:net').AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('scrapeAll refuses to scrape a host whose credential is missing', async () => {
  const { openFleetDb } = await import('../db.ts');
  const { HostRegistry } = await import('../registry.ts');
  const { createChildClient } = await import('../child.ts');
  const { db } = openFleetDb(':memory:');
  try {
    const registry = new HostRegistry(db);
    // A port that was open and is now closed, so the failure is a real ECONNREFUSED rather than undici
    // rejecting a malformed URL before it ever tried the network.
    const dead = await closedPort();
    registry.add({ id: 'h1', baseUrl: `http://127.0.0.1:${dead}`, credentialRef: 'present' });
    // A host whose credential is missing from the store. It points at a live server that counts requests, so
    // the test can prove Fleet did NOT scrape it anonymously rather than merely asserting a reason string.
    registry.add({ id: 'h2', baseUrl: `http://127.0.0.1:${dead}`, credentialRef: 'missing' });
    const results = await scrapeAll({
      registry,
      child: createChildClient({ timeoutMs: 500 }),
      resolveToken: (ref) => (ref === 'present' ? 'tok' : null),
      timeoutMs: 500,
    }, ['h1', 'h2', 'ghost']);
    assert.deepEqual(
      results.map((r) => [r.hostId, r.text, r.reason]),
      [
        ['h1', null, 'fetch failed: ECONNREFUSED'],
        ['h2', null, 'credential unavailable'],
        ['ghost', null, 'not in the registry'],
      ],
    );
  } finally { db.close(); }
});

test('the child metrics path is at the root, not under /api', async () => {
  // A recorded contract, not a guess: Mercury mounts /metrics at the root. Getting this wrong is silent -- the
  // child answers 404, the scrape reports a rejection, and the rollup shows a host with no metrics forever.
  const { createServer } = await import('node:http');
  const seen: string[] = [];
  const child = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('# TYPE mercury_runs_total counter\nmercury_runs_total 1\n');
  });
  await new Promise<void>((r) => child.listen(0, '127.0.0.1', r));
  const { port } = child.address() as import('node:net').AddressInfo;
  try {
    const { createChildClient } = await import('../child.ts');
    const client = createChildClient({ timeoutMs: 1000 });
    const res = await client.getMetrics({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok' });
    assert.deepEqual(seen, ['/metrics']);
    assert.equal(res.kind, 'ok');
    if (res.kind === 'ok') assert.match(res.value, /mercury_runs_total 1/);
  } finally {
    await new Promise<void>((r) => { child.closeAllConnections?.(); child.close(() => r()); });
  }
});

test('a 404 from the metrics path is a rejection, not an empty success', async () => {
  // If a 404 came back as ok with an empty body, a misconfigured path would look like a healthy host with
  // nothing to report -- the failure would be invisible in exactly the way the scrape_success gauge exists to
  // prevent.
  const { createServer } = await import('node:http');
  const child = createServer((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>((r) => child.listen(0, '127.0.0.1', r));
  const { port } = child.address() as import('node:net').AddressInfo;
  try {
    const { createChildClient } = await import('../child.ts');
    const res = await createChildClient({ timeoutMs: 1000 })
      .getMetrics({ baseUrl: `http://127.0.0.1:${port}`, token: 'tok' });
    assert.equal(res.kind, 'rejected');
    if (res.kind === 'rejected') assert.equal(res.status, 404);
  } finally {
    await new Promise<void>((r) => { child.closeAllConnections?.(); child.close(() => r()); });
  }
});
