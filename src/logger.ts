// Structured JSON logger with run/worker/event context (Mercury.md section 25).

import type { Redactor } from './domain/redact.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields, msg: string): void;
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Where a log line goes. Defaults to stdout/stderr; tests pass a collector. */
export type LogSink = (line: string, level: Level) => void;

export function createLogger(redactor: Redactor, minLevel: Level = 'info', sink?: LogSink): Logger {
  const defaultSink: LogSink = (line, level) => {
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  };
  const write = sink ?? defaultSink;

  function emit(level: Level, fields: LogFields, msg: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: redactor.redact(msg),
      ...(redactor.redactJson(fields) as Record<string, unknown>),
    });
    // Routed through the sink rather than written to process.stdout directly. Tests previously
    // monkey-patched process.stdout.write to observe output, which is hazardous: the node test
    // runner patches that same function to report results, so a capture that failed to restore it
    // cleanly swallowed the runner's own output and the file reported "1 test passed" having run
    // none. Observing the logger should not require editing a global the test harness owns.
    write(line, level);
  }

  return {
    debug: (f, m) => emit('debug', f, m),
    info: (f, m) => emit('info', f, m),
    warn: (f, m) => emit('warn', f, m),
    error: (f, m) => emit('error', f, m),
    child: (fields) => {
      const base: LogFields = { ...fields };
      const emitWith = (level: Level, f: LogFields, m: string): void => {
        emit(level, { ...base, ...f }, m);
      };
      return {
        debug: (f, m) => emitWith('debug', f, m),
        info: (f, m) => emitWith('info', f, m),
        warn: (f, m) => emitWith('warn', f, m),
        error: (f, m) => emitWith('error', f, m),
        child: (f) => createLogger(redactor, minLevel).child({ ...base, ...f }),
      };
    },
  };
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
