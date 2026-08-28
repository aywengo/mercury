// Strict JSONL framing unit tests (prime-agent RPC protocol).
// Node's readline is NOT protocol-compliant (splits on U+2028/U+2029); this
// reader must split on \n only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { attachJsonlLineReader, serializeJsonLine } from '../src/adapters/rpc/jsonl.ts';

function collect(chunks: (string | Buffer)[]): Promise<string[]> {
  const stream = new PassThrough();
  const out: string[] = [];
  attachJsonlLineReader(stream, (line) => out.push(line));
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  return new Promise((resolve) => {
    stream.on('end', () => resolve(out));
  });
}

test('serializeJsonLine appends a single LF', () => {
  assert.equal(serializeJsonLine({ a: 1 }), '{"a":1}\n');
  assert.equal(serializeJsonLine('x'), '"x"\n');
});

test('reader splits multiple records in one chunk', async () => {
  const out = await collect(['{"a":1}\n{"b":2}\n']);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('reader handles records split across chunks', async () => {
  const out = await collect(['{"a":', '1}\n{"b":', '2}\n']);
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('reader strips trailing CR (CRLF input)', async () => {
  const out = await collect(['{"a":1}\r\n']);
  assert.deepEqual(out, ['{"a":1}']);
});

test('reader does NOT split on U+2028/U+2029 inside a JSON string', async () => {
  // readline would split this into two lines; the strict reader must not
  const payload = JSON.stringify({ text: 'line1\u2028line2\u2029end' });
  const out = await collect([payload + '\n']);
  assert.deepEqual(out, [payload]);
});

test('reader handles a trailing record without newline (EOF)', async () => {
  const out = await collect(['{"a":1}']);
  assert.deepEqual(out, ['{"a":1}']);
});

test('reader drops records over maxLineLength and reports overflow', async () => {
  const stream = new PassThrough();
  const out: string[] = [];
  const overflows: string[] = [];
  attachJsonlLineReader(stream, (line) => out.push(line), {
    maxLineLength: 10,
    onLineOverflow: (line) => overflows.push(line),
  });
  stream.write('{"long":"this is way too long"}\n{"ok":1}\n');
  stream.end();
  await new Promise((resolve) => stream.on('end', resolve));
  assert.deepEqual(out, ['{"ok":1}']);
  assert.equal(overflows.length, 1);
});

test('detach stops delivery', async () => {
  const stream = new PassThrough();
  const out: string[] = [];
  const detach = attachJsonlLineReader(stream, (line) => out.push(line));
  stream.write('{"a":1}\n');
  detach();
  stream.write('{"b":2}\n');
  stream.end();
  await new Promise((resolve) => stream.on('end', resolve));
  assert.deepEqual(out, ['{"a":1}']);
});
