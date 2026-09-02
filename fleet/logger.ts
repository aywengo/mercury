/**
 * Structured JSON logging for the Fleet service.
 *
 * Same shape as Mercury's log lines on purpose -- one journald query across the fleet -- but a separate
 * implementation, because the coupling rule forbids importing Mercury's logger. Every line goes through the
 * redactor, including the message and every string field, so a caller-supplied string cannot smuggle a
 * secret into a log and neither can an exception message.
 */

import type { Redactor } from './redact.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string, level: Level) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

function redactDeep(value: unknown, redactor: Redactor): unknown {
  if (typeof value === 'string') return redactor.redact(value);
  if (value instanceof Error) return { name: value.name, message: redactor.redact(value.message) };
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redactor));
  if (value && typeof value === 'object') {
    const out: LogFields = {};
    for (const [k, v] of Object.entries(value as LogFields)) out[k] = redactDeep(v, redactor);
    return out;
  }
  return value;
}

export function createLogger(redactor: Redactor, minLevel: Level = 'info', sink?: LogSink): Logger {
  const write: LogSink = sink ?? ((line, level) => {
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(line + '\n');
  });
  const emit = (level: Level, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const rec: LogFields = { ts: new Date().toISOString(), level, msg: redactor.redact(msg) };
    if (fields) Object.assign(rec, redactDeep(fields, redactor) as LogFields);
    try {
      write(JSON.stringify(rec), level);
    } catch {
      // A field with a circular reference must not take the service down while reporting something else.
      write(JSON.stringify({ ts: new Date().toISOString(), level, msg: 'log serialization failed' }), level);
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}
