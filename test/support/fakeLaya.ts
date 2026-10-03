/**
 * A scripted fake Laya sidecar (docs/laya-integration-design.md §11): a local HTTP server with the
 * same wire shape as `POST /v1/systemone`, returning a scripted response PER REQUEST and recording
 * everything it received. Tests drive failure scenarios by script, never against real Laya.
 *
 * Every recording is available to the test: requests (parsed body + raw), so a test can assert on
 * what the client actually sent (allowlist fields, redaction).
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LayaRawResponse, LayaRequest } from '../../src/laya/types.ts';

/** What one request to the fake looked like. */
export interface FakeLayaReceived {
  /** HTTP method. */
  method: string;
  /** Request URL (path + query) as received. */
  url: string;
  /** Raw request body bytes. */
  raw: Buffer;
  /** The parsed request body (as far as JSON parsing goes; null when not JSON). */
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

export interface FakeLayaScriptEntry {
  /** HTTP status to answer with (default 200). */
  status?: number;
  /** JSON body to answer with. Takes precedence over rawBody. */
  json?: unknown;
  /** Raw body to answer with (e.g. malformed, over-cap). */
  rawBody?: string;
  /** Delay before answering, ms (timeout scenario). */
  delayMs?: number;
  /** Hang forever (destroy the socket without responding). */
  hang?: boolean;
}

export interface FakeLaya {
  url: string;
  port: number;
  /** Requests received so far, in order. */
  received: FakeLayaReceived[];
  close: () => Promise<void>;
}

/** Start a fake sidecar scripted per request: the Nth request gets script[N] (the LAST entry
 *  repeats for any request beyond the script). Auth: when apiKey is set, requests without the
 *  matching bearer get 401 and are still recorded. */
export async function startFakeLaya(script: FakeLayaScriptEntry[], opts: { apiKey?: string } = {}): Promise<FakeLaya> {
  const received: FakeLayaReceived[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body: unknown = null;
      try { body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null; } catch { /* not JSON */ }
      received.push({ method: req.method ?? '', url: req.url ?? '', raw, body, headers: req.headers });

      const auth = opts.apiKey !== undefined;
      const header = req.headers.authorization ?? '';
      if (auth && header !== `Bearer ${opts.apiKey}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const entry = script[Math.min(received.length - 1, script.length - 1)] ?? {};
      const respond = () => {
        if (entry.hang) {
          // Never respond; the client's deadline must fire.
          return;
        }
        res.statusCode = entry.status ?? 200;
        if (entry.rawBody !== undefined) {
          res.end(entry.rawBody);
        } else if (entry.json !== undefined) {
          res.end(JSON.stringify(entry.json));
        } else {
          res.end('{}');
        }
      };
      if (entry.delayMs !== undefined) {
        setTimeout(respond, entry.delayMs);
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    received,
    // closeIdleConnections first: the doctor's client destroys its request socket after the
    // response (huge-deadline calls must not hold sockets open), and a keep-alive socket in
    // any odd state would otherwise keep server.close() waiting indefinitely.
    close: () => new Promise<void>((resolve) => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** A valid `laya-serve` (0.3.25) response body for the given offered keys (equiprobable over the
 *  keys, first key picked): `answers` keyed by question id, each answer an OBJECT with `choice`,
 *  per-key `probabilities`, `confidence` and the calibrated `answer_confidence`; checkpoint at
 *  root `model`. The question id matches the client's LAYA_QUESTION_ID. */
export function validPick(keys: string[], checkpoint = 'english'): LayaRawResponse {
  const p = 1 / keys.length;
  return {
    model: checkpoint,
    answers: {
      'mercury-dispatch': {
        type: 'choice',
        choice: keys[0],
        probabilities: Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 1 - p * (keys.length - 1) : p])),
        confidence: 0.5,
        answer_confidence: 1 - p * (keys.length - 1),
      },
    },
  };
}
