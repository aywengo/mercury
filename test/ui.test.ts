// Dashboard UI smoke tests: static assets served, auth boundary intact,
// and the UI module files parse (browser-side behavior is verified manually/CDP).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import { makeEnv } from './helpers.ts';
import type { Express } from 'express';

const UI_DIR = join(import.meta.dirname, '..', 'ui');

async function listen(app: Express): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

test('UI files exist and are served without auth', async () => {
  for (const f of ['index.html', 'run.html', 'app.js', 'index.js', 'run.js', 'style.css']) {
    assert.ok(existsSync(join(UI_DIR, f)), `missing ui/${f}`);
  }
  const env = makeEnv({ workerEnabled: false });
  try {
    const stream = new EventStream(env.db, env.events, 10);
    stream.start();
    const app = createApp({
      runService: env.runService,
      events: env.events,
      stream,
      apiTokens: new Map([['tok-alice', 'alice']]),
      adminToken: null,
    });
    const srv = await listen(app);
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      // static assets: public
      for (const f of ['', 'run.html', 'app.js', 'style.css']) {
        const res = await fetch(`${base}/${f}`);
        assert.equal(res.status, 200, `GET /${f} should be 200`);
      }
      // API: still auth-gated (no token AND no cookie, or a bogus cookie)
      const noAuth = await fetch(`${base}/api/runs`);
      assert.equal(noAuth.status, 401);
      const bogusCookie = await fetch(`${base}/api/runs`, { headers: { cookie: 'mercury_session=not-a-real-session' } });
      assert.equal(bogusCookie.status, 401);
      const withAuth = await fetch(`${base}/api/runs`, { headers: { authorization: 'Bearer tok-alice' } });
      assert.equal(withAuth.status, 200);
    } finally {
      await srv.close();
      stream.stop();
    }
  } finally {
    env.close();
  }
});

test('UI pages reference the correct assets', () => {
  const index = readFileSync(join(UI_DIR, 'index.html'), 'utf8');
  const run = readFileSync(join(UI_DIR, 'run.html'), 'utf8');
  assert.match(index, /<script type="module" src="\/index\.js">/);
  assert.match(index, /<link rel="stylesheet" href="\/style\.css">/);
  assert.match(run, /<script type="module" src="\/run\.js">/);
  // both pages use the shared helpers
  assert.match(readFileSync(join(UI_DIR, 'index.js'), 'utf8'), /from '\.\/app\.js'/);
  assert.match(readFileSync(join(UI_DIR, 'run.js'), 'utf8'), /from '\.\/app\.js'/);
});

test('UI JS modules parse (syntax check)', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileP = promisify(execFile);
  for (const f of ['app.js', 'index.js', 'run.js']) {
    // node --check validates ESM syntax without executing (no DOM needed)
    await execFileP(process.execPath, ['--check', join(UI_DIR, f)]);
  }
  // app.js must import cleanly (no DOM at import time)
  const mod = await import('../ui/app.js');
  assert.equal(typeof mod.api, 'function');
  assert.equal(typeof mod.sse, 'function');
});

test('run.js pages event history from the returned cursor, not the run maximum (issue #54)', () => {
  // The dashboard has no DOM harness here (this file is smoke-only by convention), so this
  // pins the specific mistake rather than simulating the browser. The API contract that makes
  // the loop correct is covered properly in api.test.ts; this guards against the one-line
  // regression that caused the silent history loss.
  const raw = readFileSync(join(UI_DIR, 'run.js'), 'utf8');
  // Strip comments first: the file documents the old buggy line verbatim, and matching it
  // there made this guard fail on correct code.
  const src = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !/lastSeq\s*=\s*(ev|data|res)\.lastSequence/.test(src),
    'run.js must not advance lastSeq from lastSequence: it is the run TRUE maximum, so a '
      + 'truncated first page makes the UI subscribe past everything it never fetched',
  );
  assert.match(src, /nextCursor/, 'run.js must resume from the per-page cursor');
  assert.match(src, /hasMore/, 'run.js must keep paging while the server reports more');
});

// --- safeUrl: scheme allowlist for rendered URLs (issue #57) ----------------

// ui/ is plain JS and outside the tsconfig program (allowJs is off), so a dynamic import of it is
// untyped and destructuring its exports fails typecheck. Name the shape we depend on explicitly
// rather than widening the program to include browser code.
type SafeUrlModule = { safeUrl: (s: unknown) => string | null };
const loadSafeUrl = async (): Promise<SafeUrlModule['safeUrl']> =>
  ((await import('../ui/app.js')) as unknown as SafeUrlModule).safeUrl;


test('safeUrl accepts absolute http(s) URLs', async () => {
  const safeUrl = await loadSafeUrl();
  assert.equal(safeUrl('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(safeUrl('http://internal.example/pr/1'), 'http://internal.example/pr/1');
  // Surrounding whitespace is normal in hand-edited or template-generated values.
  assert.equal(safeUrl('  https://example.com/pr/2  '), 'https://example.com/pr/2');
});

test('safeUrl blocks javascript: and every other non-http scheme (issue #57)', async () => {
  const safeUrl = await loadSafeUrl();
  const payloads = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',            // scheme is case-insensitive
    '  javascript:alert(1)',          // leading whitespace before the scheme
    'java\tscript:alert(1)',          // tab inside the scheme -- URL parsing strips it
    'java\nscript:alert(1)',          // newline likewise
    'javascript\u0000:alert(1)',      // NUL
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/abc',
    'about:blank',
    'view-source:https://example.com',
  ];
  for (const p of payloads) {
    assert.equal(safeUrl(p), null, `must reject ${JSON.stringify(p)}`);
  }
});

test('safeUrl rejects relative URLs and non-URLs rather than resolving them (issue #57)', async () => {
  const safeUrl = await loadSafeUrl();
  // A base argument to URL() would make these resolve against the dashboard origin and come back
  // as clickable same-origin links. There is deliberately no base.
  for (const rel of ['/pr/1', 'pr/1', './x', '../x', '//evil.example/x', '#x', '?a=b']) {
    assert.equal(safeUrl(rel), null, `relative must be rejected: ${JSON.stringify(rel)}`);
  }
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(safeUrl(empty), null, `empty-ish must be rejected: ${JSON.stringify(empty)}`);
  }
});

test('run.js renders prUrl through safeUrl, not raw esc() (issue #57)', async () => {
  // Source-level guard: the unit tests above prove safeUrl is correct, but not that run.js uses
  // it. This is the same class of gap that let #50 ship an isEventType() nothing called.
  const src = readFileSync(join(UI_DIR, 'run.js'), 'utf8');
  // Strip comments first -- the fix is documented with the vulnerable line quoted verbatim, and a
  // naive match would reject correct code for citing the bug it fixes.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /safeUrl\(r\.prUrl\)/, 'prUrl must be scheme-validated before it reaches href');
  assert.doesNotMatch(
    code,
    /href="\$\{esc\(r\.prUrl\)\}/,
    'href must not be built from esc(r.prUrl) alone -- escaping does not neutralise the scheme',
  );
  assert.match(code, /rel="noopener noreferrer"/, 'target=_blank needs rel=noopener noreferrer');
});

test('safeUrl canonicalises so the displayed URL cannot lie about its host (issue #57)', async () => {
  // Rendering the raw input while linking to the parsed URL is a phishing vector: the two can
  // disagree about the host. URL parsing drops backslashes and control characters, so a value that
  // reads as good.example to a human can have evil.example as its real host.
  const safeUrl = await loadSafeUrl();
  // A NUL before the userinfo separator survives into the parsed authority, so the raw text reads
  // as "x.example..." while the real host is evil.example. (A backslash does NOT do this -- the
  // WHATWG parser browsers use turns it into a path separator. Verified against node's URL, not a
  // general-purpose parser, because the two disagree.)
  const tricky = 'https://x.example\u0000@evil.example/';
  const canonical = safeUrl(tricky);
  assert.ok(canonical, 'still a valid https URL, so it must be linkable');
  assert.notEqual(canonical, tricky, 'must return the parsed form, not echo the input');
  // The raw string hides this; the canonical form does not.
  assert.equal(new URL(canonical).host, 'evil.example', 'canonical form must expose the real host');
  // And the raw text is what a human would have misread: it does not even contain the host as a
  // leading label.
  assert.ok(!tricky.startsWith('https://evil.example'), 'raw text leads with the decoy host');
});

test('run.js renders the canonical URL as the link text, not the raw input (issue #57)', () => {
  const code = readFileSync(join(UI_DIR, 'run.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // Anchor text must be esc(safe); esc(r.prUrl) as the text of a live link is the mismatch.
  assert.match(code, />\$\{esc\(safe\)\}<\/a>/, 'link text must be the canonicalised URL');
  assert.doesNotMatch(code, /rel="noopener noreferrer"[^>]*>\$\{esc\(r\.prUrl\)\}/,
    'a live link must not display the raw untrusted URL');
});
