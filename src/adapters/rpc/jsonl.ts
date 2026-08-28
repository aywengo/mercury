// Strict LF-only JSONL framing for the prime-agent RPC protocol.
//
// RPC mode uses LF (\n) as the ONLY record delimiter. Payload strings may
// contain other Unicode separators such as U+2028/U+2029, which are valid
// inside JSON strings. Node's readline splits on those and is therefore NOT
// protocol-compliant — this reader splits on \n only (mirrors the reference
// implementation in prime-agent's dist/modes/rpc/jsonl.js).

import { StringDecoder } from 'node:string_decoder';

export function serializeJsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

export interface JsonlReaderOptions {
  /** Hard cap on a single record; longer records are dropped (overflow callback). */
  maxLineLength?: number;
  onLineOverflow?: (line: string) => void;
}

/** Attach an LF-only JSONL reader to a stream. Returns a detach function. */
export function attachJsonlLineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  options: JsonlReaderOptions = {},
): () => void {
  const decoder = new StringDecoder('utf8');
  // Segments of the current, not-yet-terminated line. We never concatenate into
  // a single growing buffer: each chunk is scanned once (offset-advancing
  // indexOf) and segments are joined exactly once when the newline arrives.
  let pending: string[] = [];
  let pendingLength = 0;
  let discardingOverflow = false;

  const emitLine = (line: string): void => {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  };

  const resetPending = (): void => {
    pending = [];
    pendingLength = 0;
  };

  const appendPending = (segment: string): void => {
    if (discardingOverflow || segment.length === 0) return;
    const maxLineLength = options.maxLineLength;
    if (maxLineLength !== undefined && pendingLength + segment.length > maxLineLength) {
      const remaining = Math.max(0, maxLineLength - pendingLength);
      if (remaining > 0) pending.push(segment.slice(0, remaining));
      options.onLineOverflow?.(pending.join(''));
      resetPending();
      discardingOverflow = true;
      return;
    }
    pending.push(segment);
    pendingLength += segment.length;
  };

  const emitFrom = (segment: string): void => {
    if (discardingOverflow) {
      discardingOverflow = false;
      resetPending();
      return;
    }
    appendPending(segment);
    if (discardingOverflow) {
      discardingOverflow = false;
      return;
    }
    emitLine(pending.join(''));
    resetPending();
  };

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let start = 0;
    let newlineIndex = text.indexOf('\n');
    while (newlineIndex !== -1) {
      emitFrom(text.slice(start, newlineIndex));
      start = newlineIndex + 1;
      newlineIndex = text.indexOf('\n', start);
    }
    if (start < text.length) appendPending(text.slice(start));
  };

  const onEnd = (): void => {
    const tail = decoder.end();
    if (tail.length > 0) appendPending(tail);
    if (!discardingOverflow && pending.length > 0) emitLine(pending.join(''));
    resetPending();
    discardingOverflow = false;
  };

  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    stream.off('data', onData);
    stream.off('end', onEnd);
  };
}
