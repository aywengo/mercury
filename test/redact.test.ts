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
