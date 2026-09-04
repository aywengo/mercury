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

// ---------------------------------------------------------------------------
// Issue #214: bare (unlabelled) secrets passed straight through.
//
// Every pattern above required a `name: value` label, so the realistic leak shape -- an agent
// running `env`, `printenv` or `gh auth token` and putting a bare key in a tool result -- was never
// redacted. A test that only exercises `KEY=value` stays green through exactly this hole.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { makeEnv } from './helpers.ts';

const BARE_ANTHROPIC = 'the key is sk-ant-api03-glIGSvAYIeOmfA9AeadWMQilRsVjiJhmfHQkYHHMOxHesYuFP here';

test('a bare, unlabelled provider key is redacted (issue #214)', () => {
  const r = createRedactor([]);
  const out = r.redact(BARE_ANTHROPIC);
  assert.ok(!out.includes('sk-ant-api03'), `bare key survived redaction: ${out}`);
  assert.ok(out.includes('[REDACTED]'), 'redaction marker present');
  assert.ok(out.includes('the key is'), 'surrounding prose preserved');
  assert.ok(out.includes('here'), 'trailing prose preserved');
});

test('every provider Mercury forwards has a shape that redacts (issue #214)', () => {
  const r = createRedactor([]);
  const samples: Array<[string, string]> = [
    ['Anthropic', 'sk-ant-api03-' + 'A'.repeat(60)],
    ['OpenAI', 'sk-' + 'a'.repeat(48)],
    ['OpenAI project', 'sk-proj-' + 'a'.repeat(48)],
    ['Google/Gemini', 'AIza' + 'A'.repeat(35)],
    ['Groq', 'gsk_' + 'a'.repeat(48)],
    ['xAI', 'xai-' + 'a'.repeat(48)],
    ['OpenRouter', 'sk-or-v1-' + 'a'.repeat(40)],
    ['Hugging Face', 'hf_' + 'a'.repeat(34)],
    ['GitHub classic', 'ghp_' + 'A'.repeat(36)],
    ['GitHub fine-grained', 'github_pat_' + 'A'.repeat(22) + '_' + 'b'.repeat(20)],
    ['Slack', 'xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx'],
  ];
  for (const [name, key] of samples) {
    const out = r.redact(`output: ${key}`);
    assert.ok(!out.includes(key), `${name} key was NOT redacted: ${out}`);
  }
});

test('labelled forms still redact and still name the credential (issue #214)', () => {
  const r = createRedactor([]);
  // The label is kept deliberately: an operator must be able to tell WHICH credential leaked.
  assert.match(r.redact('ANTHROPIC_API_KEY=sk-ant-api03-' + 'A'.repeat(60)),
    /^ANTHROPIC_API_KEY=\s*\[REDACTED\]$/);
  assert.equal(r.redact('password: hunter2'), 'password: [REDACTED]');
});

test('provider shapes do not redact ordinary Run data (issue #214)', () => {
  const r = createRedactor([]);
  // What actually flows through events: diffs, commits, test output. A false positive here is not
  // cosmetic -- it destroys the data operators debug with.
  const ordinary = [
    'commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
    'runId dd0c721174f4 sessionId 8db3edb7-f93b-453a-aa53-9c3b0880d02c',
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'const tokenBucket = await store.acquire("sk") // short slug, not a key',
    'npm package: @scope/sketch-kit@2.1.0',
    'diff --git a/src/sku/inventory.ts b/src/sku/inventory.ts',
    'base64 payload: SGVsbG8gV29ybGQgdGhpcyBpcyBub3QgYSBzZWNyZXQgYXQgYWxs',
    'https://example.com:8443/path?q=1',
    'ssh://git@github.com/org/repo.git',
    'MERCURY_SANDBOX_ENV=ANTHROPIC_API_KEY,OPENAI_API_KEY',
    // Added after an independent sweep over real captured event data (Claude stream-json lines,
    // /metrics exposition text) plus the shapes most likely to appear in a Run's tool output.
    'ghcr.io/aywengo/mercury@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'Authorization header eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN CERTIFICATE-----\nMIIDXTCCAkWgAwIBAgIJALmOhFHbXJHhMA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV\n-----END CERTIFICATE-----',
    'const SKU_PREFIX = "sk-"; // stock-keeping-unit prefix, not a key',
    '.token-bucket__sk--large { padding: 0 1rem }',
    "SELECT count(*) FROM events WHERE type = 'tool.completed' AND payload LIKE '%token%'",
    'level=info ts=2026-09-04T08:03:30Z caller=worker.go:212 runId=dd0c721174f4 durationMs=141',
    'mercury_event_wakeups_total{source="socket"} 41',
  ];
  for (const line of ordinary) assert.equal(r.redact(line), line, `false positive on: ${line}`);
});

// ---------------------------------------------------------------------------
// The exact-value layer: redact what the sandbox actually forwards.
// ---------------------------------------------------------------------------

import {
  DEFAULT_ENV_ALLOWLIST,
  forwardedCredentialValues,
  resolveEnvAllowlist,
  subThresholdForwardedCredentials,
  MIN_CREDENTIAL_LEN,
} from '../src/sandbox/sandboxManager.ts';

test('forwardedCredentialValues picks up forwarded provider keys by value', () => {
  const KEY = 'sk-ant-api03-' + 'A'.repeat(60);
  const values = forwardedCredentialValues({ ANTHROPIC_API_KEY: KEY, HOME: '/root' }, null);
  assert.deepEqual(values, [KEY]);
});

test('a short env value is not treated as a secret (no mass redaction)', () => {
  // Dev setups routinely set these to placeholders. Matching "test" as a substring would blank the
  // word "test" out of every event and log line the system produces.
  const values = forwardedCredentialValues({ OPENAI_API_KEY: 'test', HF_TOKEN: 'short' }, null);
  assert.deepEqual(values, [], `short placeholder values were treated as secrets: ${values}`);
});

test('MERCURY_SANDBOX_ENV set to empty forwards nothing, so nothing is derived', () => {
  const KEY = 'sk-ant-api03-' + 'A'.repeat(60);
  assert.deepEqual(forwardedCredentialValues({ ANTHROPIC_API_KEY: KEY }, []), []);
  assert.deepEqual(resolveEnvAllowlist(''), []);
});

test('a custom allowlist derives its own provider, not just the defaults', () => {
  const KEY = 'secret-value-from-a-custom-provider-1234';
  const values = forwardedCredentialValues(
    { MY_PROVIDER_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant-' + 'B'.repeat(40) },
    ['MY_PROVIDER_KEY']);
  assert.deepEqual(values, [KEY], 'only the configured variable is in scope');
});

test('the redactor scrubs exactly the set the sandbox forwards (no drift, issue #214)', () => {
  // The invariant that makes this a fix rather than a longer blocklist: for every variable the
  // sandbox may forward, its value must not survive redaction. A second hand-maintained list in the
  // redactor would drift, and the drift would be SILENT -- events would look redacted.
  const env: Record<string, string> = {};
  for (const name of DEFAULT_ENV_ALLOWLIST) env[name] = `${name.toLowerCase()}-` + 'x'.repeat(40);
  const values = forwardedCredentialValues(env, null);
  assert.equal(values.length, DEFAULT_ENV_ALLOWLIST.length,
    `derived ${values.length} values for ${DEFAULT_ENV_ALLOWLIST.length} forwarded names`);
  const r = createRedactor(values);
  // Shape of a real leak: `printenv` output landing in a tool.completed payload.
  const toolOutput = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
  const out = r.redact(toolOutput);
  for (const v of values) assert.ok(!out.includes(v), `a forwarded value survived: ${v.slice(0, 12)}...`);
});

test('a bare key in a real tool result is scrubbed from the persisted event (issue #214)', () => {
  // The end-to-end claim at the outer entry point. Unit tests of redact() prove the pattern; this
  // proves events actually pass through it, so the fix is not decorative.
  const KEY = 'sk-ant-api03-' + 'Q'.repeat(60);
  const env = makeEnv({
    workerEnabled: false,
    redactor: createRedactor(forwardedCredentialValues({ ANTHROPIC_API_KEY: KEY }, null)),
  });
  try {
    const run = env.runService.create({ ownerId: 'alice', task: 'x', agent: 'fake' });
    env.events.append(run.id, 'tool.completed', {
      tool: 'Bash',
      result: `HOME=/root\nPATH=/usr/bin\nANTHROPIC_API_KEY=${KEY}\n`,
    });
    const rows = env.events.list(run.id);
    const persisted = JSON.stringify(rows[rows.length - 1].payload);
    assert.ok(!persisted.includes(KEY), `live key persisted into the events table: ${persisted.slice(0, 160)}`);
    assert.ok(persisted.includes('[REDACTED]'), 'redaction marker persisted');
    assert.ok(persisted.includes('HOME=/root'), 'harmless tool output preserved for debugging');
  } finally {
    env.close();
  }
});

test('the CLI wires forwarded credentials into the redactor (issue #214)', () => {
  // Static guard, same reasoning as adapterExitSettlement.test.ts: the unit tests prove the pieces,
  // and nothing stops a refactor from rebuilding the redactor as createRedactor(config.secrets) and
  // leaving every piece green while the exact-value layer silently vanishes from production.
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(
    cli,
    /createRedactor\(\s*\[[^)]*forwardedCredentialValues/s,
    'cli.ts must pass forwardedCredentialValues() into createRedactor()',
  );
});

test('a forwarded credential too short to redact is REPORTED, not silently skipped (issue #214)', () => {
  // Declining to redact a 12-char key is the right call, but a silent gap here is indistinguishable
  // from a working redactor. The gap has to be loud.
  const env = { OPENAI_API_KEY: 'shorty-key-12', ANTHROPIC_API_KEY: 'sk-ant-' + 'A'.repeat(60) };
  assert.deepEqual(subThresholdForwardedCredentials(env, null), ['OPENAI_API_KEY']);
  // and it is still not added to the redaction set
  assert.deepEqual(forwardedCredentialValues(env, null), [env.ANTHROPIC_API_KEY]);
});

test('the startup warning names the variable without leaking its value (issue #214)', () => {
  // A warning ABOUT a secret that prints the secret would be a worse bug than the one being fixed.
  const KEY = 'tiny-key-42';
  const vars = subThresholdForwardedCredentials({ HF_TOKEN: KEY }, null);
  const line = JSON.stringify({ vars, minLength: MIN_CREDENTIAL_LEN });
  assert.ok(vars.includes('HF_TOKEN'), 'the variable is named');
  assert.ok(!line.includes(KEY), `the warning would print the secret value: ${line}`);
});

test('a forwarded value with stray whitespace is still redacted (issue #214)', () => {
  // Keys pasted from a dashboard often carry a trailing newline. The threshold decides on the
  // trimmed form, but the UNTRIMMED value is what must match, or the key leaks via its own padding.
  const KEY = 'sk-ant-' + 'A'.repeat(50) + '\n';
  const values = forwardedCredentialValues({ ANTHROPIC_API_KEY: KEY }, null);
  assert.deepEqual(values, [KEY], 'the untrimmed value is the redaction target');
  const out = createRedactor(values).redact(`dump: ${KEY}`);
  assert.ok(!out.includes('sk-ant-'), `padded key survived redaction: ${JSON.stringify(out)}`);
});

test('the CLI warns about credentials it will forward but cannot redact (issue #214)', () => {
  // The length floor is a deliberate gap, so it has to be visible. Without this guard a refactor
  // can delete the warning and every unit test stays green while operators run with an unscrubbed
  // key in scope and no idea.
  const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  assert.match(cli, /subThresholdForwardedCredentials\(process\.env, config\.sandboxEnv\)/,
    'cli.ts must compute the sub-threshold forwarded credentials');
  assert.match(cli, /logger\.warn\(\s*\{\s*vars: tooShort/,
    'cli.ts must warn, naming the variables');
  // and must not print the values
  assert.doesNotMatch(cli, /vars:\s*\[[^\]]*tooShort[^\]]*values/s,
    'the warning must carry names only, never the secret values');
});
