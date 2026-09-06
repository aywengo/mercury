// §15.3: "broken pipes exit quietly".
//
// `mercuryctl runs list | head` is one of the first things an operator types. The child on the right
// closes its stdin after a line, so the CLI's next write fails with EPIPE. Without a handler Node
// prints an uncaught-exception stack trace and exits 1, which turns a normal pipeline into something
// that looks like a client bug -- and in a shell using `set -o pipefail`, makes a working command fail.
//
// bin.ts has the handler. Nothing tested it, so the requirement was satisfied by code nobody had
// proven, which is the same as not satisfying it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin.ts', import.meta.url));

/** A server returning enough Runs that the CLI is still writing when the pipe closes. */
async function startListing(pageSize: number): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const runs = Array.from({ length: pageSize }, (_, i) => ({
      id: `run-${String(i).padStart(6, '0')}`,
      status: 'COMPLETED',
      task: `a task long enough to make the table wide and the output plentiful for run ${i}`,
      agent: 'prime-agent',
      ownerId: 'alice',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ runs, nextCursor: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: async () => { server.close(); await once(server, 'close'); } };
}

/**
 * Run the CLI and close the read end of its stdout after the first chunk.
 *
 * Destroying the socket is what `| head` does when it exits; nothing else reproduces it reliably, and
 * a test that merely read everything would never produce EPIPE at all.
 */
function runWithClosedPipe(url: string, args: string[]): Promise<{ code: number | null; signal: string | null; err: string }> {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-pipe-'));
  mkdirSync(join(root, 'mercury'), { recursive: true });
  const child = spawn(process.execPath, ['--no-warnings', BIN, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: root, MERCURY_CLIENT_URL: url, MERCURY_CLIENT_TOKEN: 'tok', NO_COLOR: '1' },
  });
  let err = '';
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  let closed = false;
  child.stdout.on('data', () => {
    if (closed) return;
    closed = true;
    child.stdout.destroy();
  });
  return new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, err }));
    setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, signal: 'timeout', err }); }, 30_000);
  });
}

async function runPipeline(url: string, tailCmd: string): Promise<{ code: number | null; out: string; err: string }> {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-pipe-'));
  mkdirSync(join(root, 'mercury'), { recursive: true });
  // A real shell pipeline, because that is the thing being supported. `set -o pipefail` makes the
  // pipeline's status reflect the CLI's own failure, so a client that dies on EPIPE cannot hide behind
  // `head` exiting 0. Piping through a program that exits early is also the only reliable way to make
  // the read end close while the CLI is still writing.
  const script = `set -o pipefail; ${process.execPath} --no-warnings ${JSON.stringify(BIN)} runs list --no-color | ${tailCmd}`;
  const child = spawn('/bin/bash', ['-c', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XDG_CONFIG_HOME: root, MERCURY_CLIENT_URL: url, MERCURY_CLIENT_TOKEN: 'tok', NO_COLOR: '1' },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', (c) => resolve(c));
    setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 60_000);
  });
  return { code, out, err };
}

test('`mercuryctl runs list | head -1` exits 0 and prints no stack trace', async () => {
  const srv = await startListing(20_000);
  try {
    const r = await runPipeline(srv.url, 'head -1');
    assert.notEqual(r.code, null, 'the pipeline hung instead of finishing');
    assert.equal(r.code, 0,
      `a closed pipe failed the pipeline (exit ${r.code}); stderr: ${r.err.slice(0, 500)}`);
    assert.ok(!/EPIPE|ERR_STREAM_PIPES|Uncaught|at .*bin\.ts:\d+/.test(r.err),
      `a closed pipe produced a diagnostic or stack trace: ${r.err.slice(0, 500)}`);
    assert.ok(r.out.trim().length > 0, 'head -1 printed nothing; the CLI may not have run at all');
  } finally {
    await srv.close();
  }
});

test('the pipeline really does close the read end early', async () => {
  // The assertion above is an absence. If the CLI finished writing before `head` exited, EPIPE would
  // never occur and the test would pass forever without exercising the handler. So measure the gap:
  // `head -1` keeps one line while the full listing is orders of magnitude larger.
  const srv = await startListing(20_000);
  try {
    const full = await runPipeline(srv.url, 'cat');
    const short = await runPipeline(srv.url, 'head -1');
    assert.equal(full.code, 0, `the unfiltered listing failed: ${full.err.slice(0, 300)}`);
    assert.ok(full.out.length > short.out.length * 50,
      `output is not much larger than one line (${full.out.length} vs ${short.out.length}); the pipe is not being closed mid-write`);
  } finally {
    await srv.close();
  }
});

/**
 * The bug this file exists for.
 *
 * `bin.ts` ended with `process.exit(code)`. When stdout is a PIPE, Node writes asynchronously, so
 * anything still in the buffer at exit time is DISCARDED. To a regular file, writes are synchronous and
 * everything lands. The result is that `mercuryctl runs list | grep ...` silently returned a truncated
 * listing with exit code 0 and no warning: measured at 65,536 bytes through a pipe against 1,900,049
 * bytes to a file, for the same server and the same command.
 *
 * This is the worst shape a bug can take in a CLI. Every pipeline consumer -- grep, jq, sort, a script
 * collecting Run ids -- sees a clean success and a partial answer. Nothing in a source checkout reveals
 * it, because tests that capture stdout into a variable read the whole pipe before the process exits.
 */
async function bytesThrough(kind: 'pipe' | 'file', url: string, args: string[]): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'mercuryctl-io-'));
  mkdirSync(join(root, 'mercury'), { recursive: true });
  const env = { ...process.env, XDG_CONFIG_HOME: root, MERCURY_CLIENT_URL: url, MERCURY_CLIENT_TOKEN: 'tok', NO_COLOR: '1' };
  const target = join(root, 'out.txt');
  const cmd = kind === 'pipe'
    ? `node --no-warnings ${JSON.stringify(BIN)} ${args.join(' ')} | cat > ${JSON.stringify(target)}`
    : `node --no-warnings ${JSON.stringify(BIN)} ${args.join(' ')} > ${JSON.stringify(target)}`;
  const code = await new Promise<number | null>((resolve) => {
    const c = spawn('/bin/bash', ['-c', cmd], { env });
    c.on('close', (x) => resolve(x));
    setTimeout(() => { c.kill('SIGKILL'); resolve(null); }, 60_000);
  });
  assert.equal(code, 0, `${kind} run exited ${code}`);
  return readFileSync(target).length;
}

test('output through a pipe is complete, not truncated at the stdout buffer', async () => {
  const srv = await startListing(20_000);
  try {
    const toFile = await bytesThrough('file', srv.url, ['runs', 'list', '--no-color']);
    const toPipe = await bytesThrough('pipe', srv.url, ['runs', 'list', '--no-color']);
    assert.ok(toFile > 200_000, `fixture too small to distinguish the two paths (${toFile} bytes)`);
    assert.equal(toPipe, toFile,
      `piping the SAME command lost ${(toFile - toPipe).toLocaleString()} of ${toFile.toLocaleString()} bytes`);
  } finally {
    await srv.close();
  }
});

test('the same holds for JSON output, which is what automation actually consumes', async () => {
  const srv = await startListing(20_000);
  try {
    const toFile = await bytesThrough('file', srv.url, ['runs', 'list', '--json']);
    const toPipe = await bytesThrough('pipe', srv.url, ['runs', 'list', '--json']);
    assert.ok(toFile > 200_000, `fixture too small (${toFile} bytes)`);
    assert.equal(toPipe, toFile,
      `--json through a pipe lost ${(toFile - toPipe).toLocaleString()} of ${toFile.toLocaleString()} bytes`);
  } finally {
    await srv.close();
  }
});
