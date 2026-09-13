/**
 * A real Mercury API on loopback, backed by a real SQLite queue.
 *
 * Shared by `test/fleetContract.test.ts` (Fleet <-> Mercury over a process boundary) and
 * `test/apiSchemaVersion.test.ts` (the response-shape guard for issue #518). Both need the REAL
 * router and the REAL queue-backed SQL, not a stub: a stub answers with whatever shape its author
 * wrote, which is exactly the thing that must be under test.
 *
 * Lives outside `*.test.ts` so `node --test 'test/*.test.ts'` does not treat it as a suite.
 */
import { closeServer, createApp } from '../src/api/server.ts';
import { EventStream } from '../src/events/eventStream.ts';
import type { AddressInfo } from 'node:net';
import { makeEnv, type TestEnv } from './helpers.ts';

export interface RealMercury {
  env: TestEnv;
  url: string;
  close(): Promise<void>;
}

export interface RealMercuryOptions {
  /** False omits the queue, which reproduces the 503 "queue not configured" path. */
  queue?: boolean;
  /** Bearer credential the API will accept. Must match what callers send. */
  token: string;
}

export async function realMercury(opts: RealMercuryOptions): Promise<RealMercury> {
  const env = makeEnv({ workerEnabled: false });
  const stream = new EventStream(env.db, env.events, 10);
  stream.start();
  const app = createApp({
    runService: env.runService,
    events: env.events,
    stream,
    apiTokens: new Map([[opts.token, 'alice']]),
    adminToken: null,
    // Passing `queue` is what makes /healthz/workers answer with real leases. Omitting it reproduces
    // the 503 "queue not configured" path.
    ...(opts.queue === false ? {} : { queue: env.queue }),
    // /metrics answers 503 without a db handle, so a caller that snapshots /metrics must supply it.
    db: env.db,
  } as Parameters<typeof createApp>[0]);

  // Bind loopback EXPLICITLY. app.listen(0) with no host binds the wildcard, and on macOS/BSD a
  // wildcard bind can coexist with another process already holding 127.0.0.1 on that port, so a
  // request meant for this app is answered by an unrelated server (issue #185). An explicit host
  // makes it EADDRINUSE instead.
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    env,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await closeServer(server);
      stream.stop();
      env.close();
    },
  };
}
