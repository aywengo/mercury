import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../src/domain/redact.ts';

test('redacts literal secrets', () => {
  const r = createRedactor(['super-secret-value']);
  assert.equal(r.redact('token is super-secret-value here'), 'token is [REDACTED] here');
});

test('redacts bearer tokens', () => {
  const r = createRedactor([]);
  assert.equal(r.redact('Authorization: Bearer abc123.def456'), 'Authorization: [REDACTED]');
});

test('redacts api keys and passwords', () => {
  const r = createRedactor([]);
  assert.equal(r.redact('api_key=sk-12345'), 'api_key= [REDACTED]');
  assert.equal(r.redact('password: hunter2'), 'password: [REDACTED]');
});

test('redacts nested JSON values', () => {
  const r = createRedactor(['hush']);
  const out = r.redactJson({ a: 'hush', b: { c: 'keep hush quiet' }, d: ['hush'] });
  assert.deepEqual(out, { a: '[REDACTED]', b: { c: 'keep [REDACTED] quiet' }, d: ['[REDACTED]'] });
});

test('redacts URL-embedded credentials (issue #43)', () => {
  const r = createRedactor([]);
  const out = r.redact('clone https://user:supersecret@example.com/repo.git now');
  assert.ok(!out.includes('supersecret'), 'credential removed');
  assert.ok(out.includes('[REDACTED]'), 'redacted marker present');
  assert.ok(out.includes('example.com/repo.git'), 'host and path preserved');
});

test('URL-credential pattern has no false positives (issue #43)', () => {
  const r = createRedactor([]);
  // host:port, user-only, ssh, plain https, windows path, TODO comment — untouched
  assert.equal(r.redact('https://example.com:8443/path?q=1'), 'https://example.com:8443/path?q=1');
  assert.equal(r.redact('https://user@github.com/org/repo.git'), 'https://user@github.com/org/repo.git');
  assert.equal(r.redact('ssh://git@github.com/org/repo.git'), 'ssh://git@github.com/org/repo.git');
  assert.equal(r.redact('https://gitlab.com/group/proj.git'), 'https://gitlab.com/group/proj.git');
  assert.equal(r.redact('C:\\Users\\me\\repo'), 'C:\\Users\\me\\repo');
  assert.equal(r.redact('// TODO: fix this'), '// TODO: fix this');
});

// Issue #73 L11 (the half of it that is a defect rather than a feature request).
//
// Everything above tests the Redactor in isolation. Nothing tested that the LOGGER actually calls
// it -- and the redaction only protects anything at the point it is applied. If createLogger()
// dropped the redactor.redact() call, or a future refactor logged a raw field alongside a redacted
// one, every test here would stay green while secrets went to journald in plaintext.

import { createLogger } from '../src/logger.ts';

/**
 * Collect what a Logger writes, without touching process.stdout/stderr.
 *
 * The earlier version of this helper monkey-patched process.stdout.write. That is hazardous rather
 * than merely inelegant: the node test runner patches the same function to report results, so a
 * capture that left a stub in place swallowed the runner's own output and the file reported
 * "1 test passed" having executed none of its tests. A sink parameter observes the logger without
 * editing a global the harness owns.
 */
function captureLogs(fn: (log: ReturnType<typeof createLogger>) => void): string {
  const lines: string[] = [];
  fn(createLogger(createRedactor(['hunter2']), 'debug', (line) => lines.push(line)));
  return lines.join('');
}

test('the logger redacts secrets in the message text', () => {
  const out = captureLogs((log) => log.info({}, 'connecting with token hunter2 now'));
  assert.ok(out.length > 0, 'the logger must write something');
  assert.ok(!out.includes('hunter2'), `secret reached the log unredacted: ${out.trim()}`);
  assert.ok(out.includes('[REDACTED]'), 'the redaction marker should be present');
});

test('the logger redacts secrets in structured fields', () => {
  const out = captureLogs((log) => log.warn({ repo: 'https://user:hunter2@example.com/x.git' }, 'clone failed'));
  assert.ok(!out.includes('hunter2'), `secret in a field reached the log unredacted: ${out.trim()}`);
});

test('the logger redacts through child() as well as the root logger', () => {
  // child() builds its own emit path with merged fields, so it is a separate place the redactor
  // could be dropped. Per-run loggers are children, which is where run data actually gets logged.
  const out = captureLogs((log) => log.child({ runId: 'run_1' }).error({ error: 'auth hunter2 rejected' }, 'run failed'));
  assert.ok(!out.includes('hunter2'), `secret via child() reached the log unredacted: ${out.trim()}`);
});

test('redaction is applied at every level, not just the ones tested above', () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const out = captureLogs((log) => log[level]({ k: 'hunter2' }, 'plain message'));
    assert.ok(!out.includes('hunter2'), `secret leaked at level ${level}: ${out.trim()}`);
  }
});
