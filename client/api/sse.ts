// Incremental Server-Sent Events framing parser (docs/cli-tui-design.md §11, §15.1).
//
// Mercury's stream endpoint writes:
//
//   event: hello\ndata: {"runId":"r1","after":0}\n\n
//   event: agent.message\ndata: {"id":...,"sequence":7,...}\n\n
//   : keepalive\n\n
//
// Note there is no `id:` field: the resume cursor is the `sequence` INSIDE the data payload, so
// the parser must hand the data through intact rather than tracking SSE ids.
//
// The parser knows nothing about Runs, sequences or terminal state -- it only turns a byte stream
// into framed events. Chunk boundaries are arbitrary and must not affect the result, which is the
// single most important property here: a frame split across two network reads is the normal case,
// not an edge case.

export interface SseFrame {
  /** The `event:` name, or 'message' when the server omitted it (the SSE default). */
  event: string;
  /**
   * The `data:` payload with multiple data lines joined by '\n', per the SSE spec.
   * Not parsed as JSON here: framing and interpretation are different jobs, and a malformed
   * payload must be attributable to the protocol layer rather than to a parser crash.
   */
  data: string;
}

export interface SseParserOptions {
  /**
   * Cap on buffered, not-yet-framed bytes. A hostile or broken endpoint that streams without ever
   * emitting a blank line must not be able to grow client memory without bound.
   */
  maxBufferBytes?: number;
}

export class SseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseLimitError';
  }
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

export class SseParser {
  private pending = '';
  private dataLines: string[] = [];
  private eventName = '';
  /**
   * True when the previous chunk ended in a bare '\r'. That may be the first half of a '\r\n'
   * terminator split across the network boundary, so the following '\n' must be swallowed rather
   * than producing a spurious empty line -- which would dispatch a phantom empty event.
   */
  private sawCarriageReturn = false;
  private readonly maxBufferBytes: number;

  constructor(options: SseParserOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  }

  /**
   * Feed one decoded chunk and return every frame it completed.
   *
   * A frame is emitted only when its dispatching blank line has been seen, so a caller can advance
   * a cursor after processing each returned frame and still be correct after a crash between chunks.
   */
  push(chunk: string): SseFrame[] {
    if (chunk === '') return [];
    this.pending += chunk;
    if (Buffer.byteLength(this.pending, 'utf8') > this.maxBufferBytes) {
      // Do not keep the buffer: the caller is about to tear the stream down, and retaining it
      // would preserve the very growth this check exists to prevent.
      this.pending = '';
      throw new SseLimitError(`SSE buffer exceeded ${this.maxBufferBytes} bytes without a frame boundary`);
    }

    const frames: SseFrame[] = [];
    let line = '';
    let i = 0;
    while (i < this.pending.length) {
      const ch = this.pending[i]!;
      if (this.sawCarriageReturn) {
        this.sawCarriageReturn = false;
        if (ch === '\n') {
          // Second half of a split CRLF: consume it, the line was already terminated.
          i += 1;
          continue;
        }
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r') {
          // A '\r' terminator always swallows an immediately following '\n', whether that '\n' is in
          // this same chunk or arrives in the next one. Setting the flag only at a chunk boundary
          // (the obvious-looking `i === length - 1` guard) breaks plain CRLF streams outright: the
          // '\r' ends the data line and the '\n' is then read as a SECOND terminator, which
          // dispatches a phantom empty event for every frame.
          this.sawCarriageReturn = true;
        }
        i += 1;
        frames.push(...this.consumeLine(line));
        line = '';
        continue;
      }
      line += ch;
      i += 1;
    }
    // Keep only the unterminated tail. When the chunk ended in '\r' the tail is empty and the
    // terminator decision is deferred to the next chunk.
    this.pending = this.sawCarriageReturn ? '' : line;
    return frames;
  }

  /**
   * Signal end of stream. Any partially framed event is DISCARDED, per the SSE spec: an event
   * without its blank line was never complete, and dispatching it would invent a cursor advance for
   * data the server never finished sending. The observer recovers the missing events from durable
   * history instead, which is why dropping here is safe rather than lossy.
   */
  end(): SseFrame[] {
    const frames: SseFrame[] = [];
    if (this.pending.length > 0) {
      frames.push(...this.consumeLine(this.pending));
      this.pending = '';
    }
    // A trailing field set with no dispatching blank line is dropped, not emitted.
    this.dataLines = [];
    this.eventName = '';
    this.sawCarriageReturn = false;
    return frames;
  }

  private consumeLine(rawLine: string): SseFrame[] {
    // Blank line: dispatch, if anything was accumulated.
    if (rawLine === '') {
      if (this.dataLines.length === 0 && this.eventName === '') return [];
      const frame: SseFrame = {
        event: this.eventName === '' ? 'message' : this.eventName,
        data: this.dataLines.join('\n'),
      };
      this.dataLines = [];
      this.eventName = '';
      return [frame];
    }

    // Comment line (this is how `: keepalive` arrives). Ignored, but it still proves the
    // connection is alive, which is what the observer's idle logic cares about.
    if (rawLine.startsWith(':')) return [];

    const colon = rawLine.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      // A line with no colon is a field name with an empty value, not a comment or a malformed
      // frame; `data` alone means an empty data line.
      field = rawLine;
      value = '';
    } else {
      field = rawLine.slice(0, colon);
      // Exactly one optional leading space is stripped. Stripping more would corrupt payloads
      // whose content legitimately begins with spaces.
      value = rawLine[colon + 1] === ' ' ? rawLine.slice(colon + 2) : rawLine.slice(colon + 1);
    }

    if (field === 'event') this.eventName = value;
    else if (field === 'data') this.dataLines.push(value);
    // `id` and `retry` are intentionally not tracked: Mercury sends neither, and honouring a
    // server-supplied retry would let the endpoint dictate client timing.
    return [];
  }
}
