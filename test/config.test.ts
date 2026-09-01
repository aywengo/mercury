import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('numeric env vars fall back to defaults when non-numeric (issue #21)', () => {
  const cfg = loadConfig({
    MERCURY_BACKLOG_ALERT_THRESHOLD: 'abc',
    MERCURY_PORT: 'not-a-port',
    MERCURY_POLL_MS: '12.5',
    MERCURY_LEASE_MS: '',
    MERCURY_MAX_RETRIES: 'Infinity',
    MERCURY_GC_INTERVAL_MS: '   ',
  });
  assert.equal(cfg.backlogAlertThreshold, 10); // default, not NaN
  assert.equal(cfg.port, 3000); // default, not NaN
  assert.equal(cfg.pollMs, 12.5); // valid numeric passes through
  assert.equal(cfg.leaseMs, 60_000); // empty string -> default
  assert.equal(cfg.maxRetries, 2); // 'Infinity' parses but is not finite -> default
  assert.equal(cfg.gcIntervalMs, 60 * 60 * 1000); // whitespace-only -> default
  assert.ok(Number.isFinite(cfg.backlogAlertThreshold));
  assert.ok(Number.isFinite(cfg.port));
});

test('numeric env vars parse normally when valid', () => {
  const cfg = loadConfig({
    MERCURY_BACKLOG_ALERT_THRESHOLD: '3',
    MERCURY_PORT: '8080',
    MERCURY_MAX_RETRIES: '0',
  });
  assert.equal(cfg.backlogAlertThreshold, 3);
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.maxRetries, 0);
});

test('MERCURY_TRUST_PROXY defaults to 0 and rejects unsafe values (issue #65)', () => {
  // Trusting the whole X-Forwarded-For chain lets a client invent its own source address and
  // get a fresh rate-limit bucket per request, which is worse than no limiting. So anything
  // that is not a non-negative integer must land on 0 (trust nothing), and a bad value must
  // not crash the API at boot.
  assert.equal(loadConfig({}).trustProxy, 0, 'unset -> trust nothing');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '' }).trustProxy, 0, 'empty -> trust nothing');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '   ' }).trustProxy, 0, 'blank -> trust nothing');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: 'true' }).trustProxy, 0, 'boolean-ish is not a depth');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '1.5' }).trustProxy, 0, 'fractional depth rejected');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '-1' }).trustProxy, 0, 'negative depth rejected');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: 'Infinity' }).trustProxy, 0, 'unbounded depth rejected');
  // Valid depths pass through.
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '0' }).trustProxy, 0);
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '2' }).trustProxy, 2);
});
