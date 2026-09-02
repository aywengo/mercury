import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, REDACTED } from '../redact.ts';

const CHILD = 'child-secret-abcdef123456';
const CALLER = 'caller-token-xyz789999';

test('a bare child secret is redacted even with no header name to anchor on', () => {
  // This is why the redactor is seeded from the credential store: a pattern pass cannot recognise a secret
  // it has no label for.
  const r = createRedactor([CHILD]);
  const out = r.redact(`fetch failed while sending ${CHILD} to host`);
  assert.ok(!out.includes(CHILD), out);
  assert.ok(out.includes(REDACTED));
});

test('Authorization headers are redacted structurally, keeping the name', () => {
  const r = createRedactor([]);
  const out = r.redact('request failed: Authorization: Bearer abcdef123456789');
  assert.ok(!out.includes('abcdef123456789'), out);
  assert.match(out, /authorization/i, 'the log should still say WHAT leaked');
});

test('a URL with embedded credentials is redacted', () => {
  const r = createRedactor([]);
  const out = r.redact('connect https://user:s3cr3tvalue@host:3000 refused');
  assert.ok(!out.includes('s3cr3tvalue'), out);
});

test('secrets are matched longest-first so a contained short secret cannot leak a tail', () => {
  const short = 'abc12345';
  const long = 'abc12345-extra-secret-part';
  const r = createRedactor([short, long]);
  const out = r.redact(`value=${long}`);
  assert.ok(!out.includes(long) && !out.includes('extra-secret-part'), out);
});

test('short strings are not seeded, to avoid redacting ordinary text', () => {
  const r = createRedactor(['ab']);
  assert.equal(r.seededCount, 0);
  assert.equal(r.redact('ab'), 'ab');
});

test('redaction is idempotent and leaves ordinary text alone', () => {
  const r = createRedactor([CHILD, CALLER]);
  const once = r.redact('worker w1 claimed run r-1');
  assert.equal(once, 'worker w1 claimed run r-1');
  assert.equal(r.redact(once), once);
});

test('the header pattern cannot swallow a whole line', () => {
  // The value class stops at whitespace, so text after the header survives and the log stays readable.
  const r = createRedactor([]);
  const out = r.redact('Authorization: Bearer abcdef123456789 host=studio latency=12ms');
  assert.match(out, /host=studio/);
  assert.match(out, /latency=12ms/);
});
