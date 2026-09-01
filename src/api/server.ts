// Express application + HTTP server (Mercury.md sections 7, 15, 24).

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EventStore } from '../events/eventStore.ts';
import type { EventStream } from '../events/eventStream.ts';
import type { RunQueue } from '../queue/runQueue.ts';
import type { RunService } from '../runs/runService.ts';
import { createAuthMiddleware } from './auth.ts';
import { createRoutes, sendError } from './routes.ts';
import { createAuthRoutes } from './authRoutes.ts';
import { createRateLimiter } from './rateLimit.ts';
import { createSessionStore, type SessionStore } from './sessions.ts';
import type { Logger } from '../logger.ts';

// Dashboard UI (Mercury.md section 23): static SPA served at /.
// The UI authenticates with a session cookie (POST /api/auth/login);
// the /api routes remain the only data surface.
const UI_DIR = resolve(import.meta.dirname, '..', '..', 'ui');

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface ServerDeps {
  runService: RunService;
  events: EventStore;
  stream: EventStream;
  apiTokens: Map<string, string>;
  adminToken: string | null;
  /** Optional session store override (default: in-memory Map, see sessions.ts). */
  sessions?: SessionStore;
  /** Optional run queue for the /healthz/workers endpoint (worker health, Mercury.md section 25). */
  queue?: RunQueue;
  /** Optional rate-limit overrides (defaults: login 10/min, run creation 30/min). */
  rateLimits?: {
    login?: RateLimitConfig;
    createRun?: RateLimitConfig;
  };
  /**
   * Force `Secure` on the session cookie (MERCURY_COOKIE_SECURE=true). Only needed behind a
   * TLS-terminating proxy that does not forward `X-Forwarded-Proto`; encryption is otherwise
   * detected per request (issue #64).
   */
  cookieSecure?: boolean;
  /**
   * Number of reverse-proxy hops to trust for client-IP attribution (issue #65). Default 0.
   *
   * This is what the rate limiter's correctness depends on: it keys on `req.ip`, and with no
   * trusted proxy Express resolves that to the socket peer -- the proxy itself -- so every
   * client behind that proxy shares a single bucket.
   *
   * A number, deliberately not a boolean. `trust proxy = true` makes Express accept the entire
   * `X-Forwarded-For` chain, so a client can append its own fake hop and get a fresh bucket per
   * request, which is worse than no limiting at all. Depth peels exactly N hops off the right,
   * so a client cannot invent an address that survives the peel.
   */
  trustProxy?: number;
  /** Optional structured logger; used to record the real cause of a 500 (issue #66). */
  logger?: Logger;
}

// Defaults for the two protected route groups (Mercury.md section 24).
const DEFAULT_LOGIN_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 10 }; // 10/min per IP
const DEFAULT_CREATE_RUN_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 30 }; // 30/min per owner+IP

export function createApp(deps: ServerDeps): Express {
  const app = express();
  const sessions = deps.sessions ?? createSessionStore();

  // Set before any middleware that reads req.ip. Default (0 / undefined) leaves Express on its
  // own default of trusting nothing, so a direct bind keeps per-socket limits.
  const trustProxy = deps.trustProxy ?? 0;
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  // Dashboard UI static assets are public (no secrets); data access is gated via /api.
  app.use(express.static(UI_DIR, { index: 'index.html' }));

  app.use(express.json({ limit: '1mb' }));
  // Credential resolution only (bearer token or session cookie); never blocks.
  app.use(createAuthMiddleware(deps.apiTokens, deps.adminToken, sessions));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // Worker health (public like /healthz, Mercury.md section 25): active workers
  // derived from lease ownership plus the current queue backlog depth.
  app.get('/healthz/workers', (_req, res) => {
    if (!deps.queue) {
      res.status(503).json({ error: 'queue not configured' });
      return;
    }
    res.json({
      workers: deps.queue.activeLeases(),
      queueDepth: deps.queue.queuedCount(),
    });
  });

  // Brute-force protection for the token exchange (per IP; login is public).
  const loginLimiter = createRateLimiter({
    group: 'auth-login',
    methods: ['POST'],
    windowMs: deps.rateLimits?.login?.windowMs ?? DEFAULT_LOGIN_LIMIT.windowMs,
    max: deps.rateLimits?.login?.max ?? DEFAULT_LOGIN_LIMIT.max,
  });
  app.post('/api/auth/login', loginLimiter);
  app.use('/api/auth', createAuthRoutes({
    tokens: deps.apiTokens,
    adminToken: deps.adminToken,
    sessions,
    cookieSecure: deps.cookieSecure,
  }));

  // Run-creation limit (per owner+IP; req.auth is already resolved).
  const createRunLimiter = createRateLimiter({
    group: 'create-run',
    methods: ['POST'],
    windowMs: deps.rateLimits?.createRun?.windowMs ?? DEFAULT_CREATE_RUN_LIMIT.windowMs,
    max: deps.rateLimits?.createRun?.max ?? DEFAULT_CREATE_RUN_LIMIT.max,
  });
  app.post('/api/runs', createRunLimiter);

  app.use('/api', createRoutes({ runService: deps.runService, events: deps.events, stream: deps.stream, logger: deps.logger }));

  // Last-resort handler for anything that escaped a route (including middleware and body-parser
  // failures). It used to answer `500 { error: err.message }`, which pushed raw internals --
  // driver text, absolute paths -- to the browser (issue #66). Same mapping as the routes use, so
  // a classified error thrown outside a try/catch still gets its proper status, and anything
  // unclassified gets a fixed body with the real cause logged instead.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    sendError(res, err, deps.logger);
  });

  return app;
}

export interface StartServerOpts {
  /** Bind address. Default 127.0.0.1 (secure default; set 0.0.0.0 to expose). */
  host?: string;
  /** TLS: if provided, serve https with this cert/key (file paths). */
  tls?: { cert: string; key: string };
}

export interface StartedServer {
  close: () => Promise<void>;
  /** Base URL the server listens on (http:// or https://). */
  url: string;
}

/**
 * Grace period between stopping admission and forcing sockets shut (issue #52).
 * Long enough for an ordinary JSON request to finish, short enough that a stalled
 * dashboard tab cannot hold a deploy open -- systemd escalates to SIGKILL at 90s.
 */
const SHUTDOWN_GRACE_MS = 2_000;

/**
 * Close a listening server without waiting forever on long-lived connections.
 *
 * `server.close()` stops admitting new connections but resolves only once every existing
 * one has ended. The SSE run stream (`GET /api/runs/:id/events`) is long-lived BY DESIGN
 * and is never ended from the server side, so awaiting `close()` alone meant that any
 * dashboard with a run open stalled shutdown until systemd escalated to SIGKILL -- and a
 * SIGKILL'd worker then strands its in-flight runs (issue #51).
 *
 * So: stop admitting, give ordinary in-flight requests a short grace period, then force
 * the remaining sockets closed and await the real close. Forcing is what makes shutdown
 * bounded; the grace period is what keeps it from cutting off normal requests.
 */
export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  // unref so a grace timer is never itself a reason for the process to stay alive.
  const grace = new Promise<'grace'>((resolve) => {
    setTimeout(() => resolve('grace'), SHUTDOWN_GRACE_MS).unref?.();
  });
  const winner = await Promise.race([closed.then(() => 'closed' as const), grace]);
  if (winner === 'grace') {
    // Only force when the grace period actually won: if `closed` resolved first there is
    // nothing left to force, and skipping is the honest expression of intent.
    //
    // Copilot flagged this as a crash (ERR_SERVER_NOT_RUNNING making shutdown reject). That
    // does NOT reproduce on the supported range -- engines is node >=23.6, and on v26.7.0
    // closeAllConnections() on an already-closed server is a silent no-op, verified directly.
    // The try/catch stays as cheap insurance against a version where it is not, not because
    // a failure was observed; the accompanying test therefore asserts "does not reject", not
    // "catches a throw it cannot produce".
    try {
      server.closeAllConnections();
    } catch {
      // already fully closed; nothing to force
    }
  }
  await closed;
}

export function startServer(deps: ServerDeps, port: number, opts: StartServerOpts = {}): Promise<StartedServer> {
  const app = createApp(deps);
  const host = opts.host ?? '127.0.0.1';
  let cert: string | undefined;
  let key: string | undefined;
  if (opts.tls) {
    // Read up front so a missing/unreadable file fails fast (before listen).
    cert = readFileSync(opts.tls.cert, 'utf8');
    key = readFileSync(opts.tls.key, 'utf8');
  }
  return new Promise((resolve) => {
    let server: Server;
    if (opts.tls) {
      server = createHttpsServer({ cert, key }, app).listen(port, host, () => {
        resolve({
          close: () => closeServer(server),
          url: `https://${host}:${port}`,
        });
      });
    } else {
      server = app.listen(port, host, () => {
        resolve({
          close: () => closeServer(server),
          url: `http://${host}:${port}`,
        });
      });
    }
  });
}
