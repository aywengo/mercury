import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, SseLimitError } from '../api/sse.ts';

// The one property that matters: framing must not depend on how the byte stream was chopped.
// Chunk boundaries are arbitrary and normal, not an edge case -- so this does not sample a few
// convenient splits, it tries EVERY offset in a real capture.

// Transcribed from the server's own template in src/api/routes.ts:
//
//     res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
//
// The payload is produced with JSON.stringify rather than hand-written, because a hand-written
// fixture can encode a wire format the server does not use. It nearly did: a raw newline inside a
// data: line is impossible on the wire, since JSON.stringify escapes it and a literal newline would
// terminate the field. Building it the same way the server does makes the fixture self-checking.
const HELLO = { runId: 'r1', after: 0 };
const EV3 = {
  id: 'e3', runId: 'r1', type: 'agent.message', sequence: 3,
  timestamp: '2026-01-01T00:00:00.000Z',
  // A newline and a colon inside the payload: the newline must arrive escaped, and the colon must
  // not be mistaken for a field delimiter by a parser that splits on the first colon of the LINE.
  payload: { text: 'line one\nline two: still data' },
};
const EV4 = {
  id: 'e4', runId: 'r1', type: 'run.completed', sequence: 4,
  timestamp: '2026-01-01T00:00:01.000Z', payload: {},
};

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const STREAM =
  frame('hello', HELLO) +
  ': keepalive\n\n' +
  frame('agent.message', EV3) +
  frame('run.completed', EV4);

function parseAll(chunks: string[]) {
  const parser = new SseParser();
  const frames = [];
  for (const c of chunks) frames.push(...parser.push(c));
  frames.push(...parser.end());
  return frames;
}

const EXPECTED = [
  { event: 'hello', data: JSON.stringify(HELLO) },
  { event: 'agent.message', data: JSON.stringify(EV3) },
  { event: 'run.completed', data: JSON.stringify(EV4) },
];

test('a whole stream in one chunk frames correctly', () => {
  assert.deepEqual(parseAll([STREAM]), EXPECTED);
});

test('framing is identical at EVERY single split point', () => {
  // The exhaustive version of "chunk boundaries must not matter". A parser that special-cases a
  // trailing newline, or that loses a partial line between chunks, fails at some offset here.
  for (let i = 1; i < STREAM.length; i++) {
    assert.deepEqual(parseAll([STREAM.slice(0, i), STREAM.slice(i)]), EXPECTED, `split at ${i}`);
  }
});

test('framing is identical when fed one character at a time', () => {
  assert.deepEqual(parseAll([...STREAM]), EXPECTED);
});

test('framing is identical for every pair of split points', () => {
  // Two splits catch state machines that recover after one bad boundary but not after two.
  for (let i = 1; i < STREAM.length; i++) {
    for (let j = i + 1; j < STREAM.length; j++) {
      const chunks = [STREAM.slice(0, i), STREAM.slice(i, j), STREAM.slice(j)];
      assert.deepEqual(parseAll(chunks), EXPECTED, `splits at ${i},${j}`);
    }
  }
});

test('a CRLF terminator split across chunks does not produce a phantom event', () => {
  // The classic bug: '\r' ends one chunk and '\n' starts the next. Read naively that is two line
  // terminators, so the blank dispatch line appears twice and an empty event is emitted.
  const crlf = STREAM.replaceAll('\n', '\r\n');
  const at = crlf.indexOf('\r\n\r\n') + 1; // split BETWEEN the \r and the \n
  const frames = parseAll([crlf.slice(0, at), crlf.slice(at)]);
  assert.equal(frames.length, EXPECTED.length, 'phantom frame emitted');
  assert.deepEqual(frames, EXPECTED);
});

test('bare CR line endings frame correctly', () => {
  assert.deepEqual(parseAll([STREAM.replaceAll('\n', '\r')]), EXPECTED);
});

test('keepalive comments are ignored but do not break framing', () => {
  const withKeepalives = STREAM.replace('\n\n', '\n\n: keepalive\n\n: keepalive\n\n');
  assert.equal(parseAll([withKeepalives]).length, EXPECTED.length);
});

test('a stream of only keepalives yields no frames', () => {
  assert.deepEqual(parseAll([': keepalive\n\n', ': keepalive\n\n']), []);
});

test('multiple data lines join with a single newline, per the SSE spec', () => {
  const frames = parseAll(['data: one\ndata: two\ndata: three\n\n']);
  assert.deepEqual(frames, [{ event: 'message', data: 'one\ntwo\nthree' }]);
});

test('a missing event name defaults to message', () => {
  assert.deepEqual(parseAll(['data: x\n\n']), [{ event: 'message', data: 'x' }]);
});

test('exactly one space after the colon is stripped, not all of them', () => {
  // Payloads legitimately begin with spaces; over-stripping corrupts data silently.
  assert.deepEqual(parseAll(['data:   padded\n\n']), [{ event: 'message', data: '  padded' }]);
});

test('a field line with no colon is a field with an empty value', () => {
  assert.deepEqual(parseAll(['data\n\n']), [{ event: 'message', data: '' }]);
});

test('an incomplete event at end of stream is discarded, not emitted', () => {
  // Dispatching it would advance the cursor past data the server never finished sending. The
  // observer recovers those events from durable history instead.
  const frames = parseAll(['event: run.completed\ndata: {"sequence":9}\n']);
  assert.deepEqual(frames, []);
});

test('a field set with no dispatching blank line is dropped by end()', () => {
  const parser = new SseParser();
  parser.push('event: orphan\ndata: partial\n');
  assert.deepEqual(parser.end(), []);
  // And the dropped state must not leak into the next stream reuse.
  assert.deepEqual(parser.push('data: fresh\n\n'), [{ event: 'message', data: 'fresh' }]);
});

test('a frame is emitted only once its blank line arrives', () => {
  // This is what makes cursor advancement safe: the caller can persist the cursor after each
  // returned frame without ever recording an event that was not fully received.
  const parser = new SseParser();
  assert.deepEqual(parser.push('event: run.completed\ndata: {"sequence":1}\n'), []);
  assert.deepEqual(parser.push('\n'), [{ event: 'run.completed', data: '{"sequence":1}' }]);
});

test('an endpoint that never emits a frame boundary cannot grow the buffer without bound', () => {
  const parser = new SseParser({ maxBufferBytes: 64 });
  assert.throws(() => {
    for (let i = 0; i < 100; i++) parser.push('x'.repeat(16));
  }, SseLimitError);
});

test('the buffer limit does not fire for legitimate large payloads', () => {
  const big = 'y'.repeat(200_000);
  const parser = new SseParser();
  const frames = parser.push(`data: ${big}\n\n`);
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.data.length, 200_000);
});
