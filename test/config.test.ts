import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { isAbsolute } from 'node:path';

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
  // Number() accepts these and they are integers >= 0, so an isInteger/`>= 0` guard alone would
  // wave them through -- silently trusting 16 or 1000 hops from what looks like a typo.
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '0x10' }).trustProxy, 0, 'hex must not mean 16 hops');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '1e3' }).trustProxy, 0, 'exponent must not mean 1000 hops');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '0b11' }).trustProxy, 0, 'binary literal rejected');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '+1' }).trustProxy, 0, 'sign prefix rejected');
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '1_000' }).trustProxy, 0, 'numeric separator rejected');
  // Valid depths pass through.
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '0' }).trustProxy, 0);
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ MERCURY_TRUST_PROXY: '2' }).trustProxy, 2);
});

test('workspaceBase resolves to an absolute path at load (issue #703)', () => {
  // The worktree path reaches `git -C <clone> worktree add <path>`, where git resolves a relative
  // target against the CLONE directory, while every Node-side consumer resolves it against the
  // process cwd. A relative base therefore produced two directories answering to one path (the
  // worktree landed inside the clone; the agent ran in an empty cwd-relative directory). The fix
  // is at the load-time choke point: the config must never carry a relative base out the door.
  assert.ok(isAbsolute(loadConfig({}).workspaceBase), 'unset -> the shipped default resolves against cwd');
  assert.ok(isAbsolute(loadConfig({ MERCURY_WORKSPACE_BASE: './workspaces' }).workspaceBase),
    'explicit relative value resolves against cwd too');
  assert.ok(isAbsolute(loadConfig({ MERCURY_WORKSPACE_BASE: '/tmp/abs-workspaces' }).workspaceBase),
    'an absolute value passes through unchanged');
  assert.equal(loadConfig({ MERCURY_WORKSPACE_BASE: '/tmp/abs-workspaces' }).workspaceBase, '/tmp/abs-workspaces');
});

test('MERCURY_DEFAULT_AGENT defaults to fake', () => {
  assert.equal(loadConfig({}).defaultAgent, 'fake');
  assert.equal(loadConfig({ MERCURY_DEFAULT_AGENT: '' }).defaultAgent, 'fake');
  assert.equal(loadConfig({ MERCURY_DEFAULT_AGENT: '   ' }).defaultAgent, 'fake');
  assert.equal(loadConfig({ MERCURY_DEFAULT_AGENT: 'primeagent' }).defaultAgent, 'primeagent');
});
