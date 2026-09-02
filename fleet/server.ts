/**
 * The Fleet service: an HTTP server over the registry and the prober.
 *
 * The route table is enumerated rather than grown ad hoc (docs/fleet-design.md section 15.4). The rule that
 * matters is that nothing here accepts a URL to fetch: a caller names a host by its registry id and Fleet
 * resolves it. That is what keeps section 9's "do not proxy arbitrary paths to children" true as the surface
 * grows, instead of eroding one convenience at a time.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import type { DatabaseSync } from 'node:sqlite';
import { HostRegistry, RegistryError, type HostView } from './registry.ts';
import { BindingStore, UNKNOWN } from './bindings.ts';
import { createChildClient } from './child.ts';
import { DispatchError, recoverPending, refreshStates, submitRun, type DispatchDeps } from './dispatch.ts';
import { startSweeper, type SweeperHandle, type SweepEvent } from './sweep.ts';
import { listMirroredEvents, type EventMirrorDeps } from './events.ts';
import { startEventStream } from './stream.ts';
import { loadRepoUrlMap, routeRun, RoutingError, type RouteRepository } from './routing.ts';
import { createProber, type Prober } from './prober.ts';
import { CredentialError, type CredentialStore } from './credentials.ts';
import type { Caller } from './auth.ts';
import { parseCallerTokens, hostAllowed } from './auth.ts';
import { authenticate, HttpError, matchRoute, readJsonBody, sendJson, type RequestContext, type Route } from './http.ts';
import type { Logger } from './logger.ts';
import type { FleetConfig } from './config.ts';

export interface FleetServerDeps {
  db: DatabaseSync;
  config: FleetConfig;
  credentials: CredentialStore;
  logger: Logger;
}

export interface FleetServer {
  server: Server;
  prober: Prober;
  routes: Route[];
  /** Reconciliation timer, running from listen() until close(). */
  sweeper: SweeperHandle | null;
  /** Bind, then start the sweep. Resolves once listening. */
  listen: () => Promise<{ host: string; port: number; tls: boolean }>;
  close: () => Promise<void>;
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** The standard Idempotency-Key header, accepted alongside an in-body equivalent. */
function headerIdempotency(ctx: RequestContext): string | null {
  const v = ctx.headers?.['idempotency-key'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function scopedHosts(caller: Caller, registry: HostRegistry): '*' | string[] {
  if (caller.isAdmin || caller.allowedHosts === '*') return '*';
  return caller.allowedHosts;
}

/** Parse a query parameter as a non-negative integer, falling back when it is anything else. */
function nonNegativeInt(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/** Narrow to a plain object without accepting arrays or null, both of which `typeof` would let through. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !v) throw new HttpError(400, `${key} is required and must be a non-empty string`);
  return v;
}

/** Hosts this caller may see. Admins and `*` callers see everything. */
function visibleHosts(registry: HostRegistry, caller: Caller): HostView[] {
  const all = registry.listWithProbe();
  if (caller.isAdmin || caller.allowedHosts === '*') return all;
  return all.filter((h) => caller.allowedHosts.includes(h.id));
}

export function buildRoutes(deps: FleetServerDeps): { routes: Route[]; prober: Prober; dispatch: DispatchDeps } {
  const registry = new HostRegistry(deps.db);
  // Loaded once at startup. A malformed map must fail the process loudly rather than degrade into "no
  // mapping", which would present as routing refusing work it should have accepted.
  const resolveCloneUrl = loadRepoUrlMap(deps.config.repoUrlsFile);
  const dispatch: DispatchDeps = {
    registry,
    bindings: new BindingStore(deps.db),
    child: createChildClient({ timeoutMs: deps.config.probeTimeoutMs }),
    resolveToken: (ref) => deps.credentials.secret(ref),
  };
  const prober = createProber({
    registry,
    resolveToken: (ref) => deps.credentials.secret(ref),
    intervalMs: deps.config.probeIntervalMs,
    timeoutMs: deps.config.probeTimeoutMs,
  });

  const routes: Route[] = [
    {
      method: 'GET', pattern: ['healthz'], public: true,
      handle: (_ctx, res) => sendJson(res, 200, { ok: true, ts: new Date().toISOString() }),
    },
    {
      // Registry reads. A caller sees only the hosts it may act on; naming a host it may not touch is a
      // 403 elsewhere, never a silent substitution.
      method: 'GET', pattern: ['fleet', 'hosts'],
      handle: (ctx, res) => sendJson(res, 200, { hosts: visibleHosts(registry, ctx.caller) }),
    },
    {
      method: 'POST', pattern: ['fleet', 'hosts'], admin: true,
      handle: (ctx, res) => {
        const b = bodyObject(ctx.body);
        // Reject an unknown ref at registration. Accepting a typo defers the failure to a probe that reports
        // auth-fail, which points at the host when the mistake is in this request.
        const ref = str(b, 'credentialRef');
        deps.credentials.secret(ref);
        const host = registry.add({
          id: str(b, 'id'),
          baseUrl: str(b, 'baseUrl'),
          credentialRef: ref,
          labels: (b.labels ?? {}) as Record<string, string>,
          localPaths: (b.localPaths ?? []) as string[],
          enabled: b.enabled !== false,
        });
        sendJson(res, 201, { host });
      },
    },
    {
      method: 'POST', pattern: ['fleet', 'hosts', ':id', 'enable'], admin: true,
      handle: (ctx, res) => {
        const b = bodyObject(ctx.body);
        const host = registry.setEnabled(ctx.params[0]!, b.enabled !== false);
        sendJson(res, 200, { host });
      },
    },
    {
      method: 'DELETE', pattern: ['fleet', 'hosts', ':id'], admin: true,
      handle: (ctx, res) => {
        // ?force=1 discards the bindings to this host's Runs. Offered because refusing outright would give
        // no way forward, but never implied: the default protects the one table that cannot be rebuilt.
        const force = ctx.query.get('force') === '1';
        let removed = false;
        try {
          removed = registry.remove(ctx.params[0]!, { force });
        } catch (err) {
          if (err instanceof RegistryError && /still owns/.test(err.message)) {
            throw new HttpError(409, err.message);
          }
          throw err;
        }
        if (!removed) throw new HttpError(404, 'no such host');
        sendJson(res, 200, { removed: ctx.params[0], forced: force });
      },
    },
    {
      method: 'POST', pattern: ['fleet', 'hosts', ':id', 'probe'], admin: true,
      handle: async (ctx, res) => {
        const id = ctx.params[0]!;
        const host = registry.get(id);
        if (!host) throw new HttpError(404, 'no such host');
        const { probeAndRecord } = await import('./probe.ts');
        const rec = await probeAndRecord({
          hostId: id, baseUrl: host.baseUrl,
          token: deps.credentials.secret(host.credentialRef),
          timeoutMs: deps.config.probeTimeoutMs,
        });
        registry.recordProbe(rec);
        sendJson(res, 200, { probe: rec });
      },
    },
    {
      // Dispatch. The caller names a host; the allowlist is checked against THAT host and a mismatch is 403,
      // never a silent substitution to a host the caller may use.
      method: 'POST', pattern: ['fleet', 'runs'],
      handle: async (ctx, res) => {
        const b = bodyObject(ctx.body);
        const namedHost = typeof b.host === 'string' && b.host ? b.host : undefined;
        // Routing runs over the hosts THIS caller may see, not the whole fleet. A router that could place work
        // on a hidden host would turn an allowlist into a suggestion.
        let decision;
        try {
          decision = routeRun(
          visibleHosts(registry, ctx.caller),
          {
            host: namedHost,
            agent: typeof b.agent === 'string' && b.agent ? b.agent : undefined,
            labels: isRecord(b.labels) ? b.labels as Record<string, string> : undefined,
            repository: isRecord(b.repository) ? b.repository as RouteRepository : undefined,
          },
            { resolveCloneUrl },
          );
        } catch (err) {
          // A routing failure names every host considered and why each was excluded. Swallowing that into a
          // generic 400 is exactly how a five-second mistake becomes an hour of confusion.
          if (err instanceof RoutingError) throw new HttpError(err.status, err.message, undefined, err.exclusions);
          throw err;
        }
        if (!hostAllowed(ctx.caller, decision.hostId)) {
          // Unreachable given the scoping above, kept because a router change must not silently widen access.
          throw new HttpError(403, `caller ${ctx.caller.ownerId} may not submit work to host ${decision.hostId}`);
        }
        const requested: Record<string, unknown> = { ...b, ...(decision.repository ? { repository: decision.repository } : {}) };
        if (!decision.repository) delete requested.repository;
        delete requested.host;
        delete requested.idempotency;
        const idem = typeof b.idempotency === 'string' && b.idempotency
          ? b.idempotency
          : headerIdempotency(ctx);
        // ownerId comes from the authenticated caller, never the body: idempotency scoping is a security
        // boundary, and a caller that could choose it could claim another caller's binding.
        const outcome = await submitRun(dispatch, {
          hostId: decision.hostId, ownerId: ctx.caller.ownerId, requested, clientToken: idem ?? null,
        });
        sendJson(res, outcome.reused ? 200 : 201, {
          fleetRunId: outcome.binding.fleetRunId,
          hostId: outcome.binding.hostId,
          // Say so when the localPath was replaced: a caller who asked for a path and got a clone should be
          // able to see that the constraint was lifted, not discover it from a missing working tree.
          ...(decision.rewroteLocalPath ? { rewroteLocalPath: true } : {}),
          childRunId: outcome.binding.childRunId,
          pending: outcome.pending,
          reused: outcome.reused,
          status: dispatch.bindings.state(outcome.binding.fleetRunId)?.status ?? UNKNOWN,
          ...(outcome.note ? { note: outcome.note } : {}),
        });
      },
    },
    {
      method: 'GET', pattern: ['fleet', 'runs'],
      handle: (ctx, res) => {
        const runs = dispatch.bindings.list(scopedHosts(ctx.caller, registry));
        sendJson(res, 200, { runs });
      },
    },
    {
      method: 'GET', pattern: ['fleet', 'runs', ':id'],
      handle: async (ctx, res) => {
        const id = ctx.params[0]!;
        const binding = dispatch.bindings.get(id);
        if (!binding) throw new HttpError(404, 'no such fleet run');
        if (!hostAllowed(ctx.caller, binding.hostId)) {
          // Same status as "does not exist" would be for a different reason; 403 is honest here because the
          // caller demonstrably knows an id that it may not read.
          throw new HttpError(403, `caller ${ctx.caller.ownerId} may not read runs on host ${binding.hostId}`);
        }
        await refreshStates(dispatch, [binding.hostId]);
        sendJson(res, 200, {
          ...binding,
          state: dispatch.bindings.state(id),
        });
      },
    },
    {
      // GET /fleet/runs/:id/stream -- Fleet-side SSE, a view onto the mirror rather than a second path to the
      // child. Losing this stream costs latency only: the client reconnects with ?after=<cursor> and resumes
      // exactly where it was, because the cursor is the correctness mechanism and SSE is the optimisation.
      method: 'GET', pattern: ['fleet', 'runs', ':id', 'stream'],
      handle: async (ctx, res) => {
        const id = ctx.params[0]!;
        const binding = dispatch.bindings.get(id);
        if (!binding) throw new HttpError(404, 'no such fleet run');
        if (!hostAllowed(ctx.caller, binding.hostId)) {
          throw new HttpError(403, `caller ${ctx.caller.ownerId} may not read runs on host ${binding.hostId}`);
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          // Without this a buffering proxy turns a live stream into one long download.
          'x-accel-buffering': 'no',
        });
        // Flush the headers now. Otherwise a client that connected but receives nothing waits on the socket
        // and cannot tell a working stream from a hung request.
        res.flushHeaders?.();
        startEventStream(res, {
          db: deps.db, bindings: dispatch.bindings, fleetRunId: id,
          pollIntervalMs: deps.config.streamPollMs,
          // Passed in rather than applied afterwards: the backlog is written synchronously, so a handle method
          // would run after the client had already been sent events it asked to skip.
          after: nonNegativeInt(ctx.query?.get('after'), 0),
        });
      },
    },
    {
      // GET /fleet/runs/:id/events?after=<cursor>&limit=<n>
      // Reads Fleet's mirror, so it answers at the freshness of the last sweep rather than this instant, and
      // costs the child nothing. That is deliberate: section 8 makes the cursor the correctness mechanism and
      // polling the baseline, so a client that pages from nextCursor sees every event whether or not a child
      // connection is open.
      method: 'GET', pattern: ['fleet', 'runs', ':id', 'events'],
      handle: async (ctx, res) => {
        const id = ctx.params[0]!;
        const binding = dispatch.bindings.get(id);
        if (!binding) throw new HttpError(404, 'no such fleet run');
        if (!hostAllowed(ctx.caller, binding.hostId)) {
          throw new HttpError(403, `caller ${ctx.caller.ownerId} may not read runs on host ${binding.hostId}`);
        }
        // Parsed as integers before anything reaches SQLite. `after=Infinity` and `limit=2.5` are both
        // accepted by Number() and both produce pagination nobody can reason about -- and Infinity is a
        // perfectly truthy value, so the usual `|| 0` fallback would not have caught it.
        const after = nonNegativeInt(ctx.query?.get('after'), 0);
        // Bounded rather than trusted: an unbounded limit would let one caller pull an entire mirrored
        // transcript into memory in one request.
        const limit = Math.min(nonNegativeInt(ctx.query?.get('limit'), 200) || 200, 1000);
        sendJson(res, 200, listMirroredEvents(deps.db, id, after, limit));
      },
    },
    {
      method: 'POST', pattern: ['fleet', 'probe'], admin: true,
      handle: async (_ctx, res) => {
        const results = await prober.sweepOnce();
        sendJson(res, 200, { probed: results.length, hosts: registry.listWithProbe() });
      },
    },
  ];

  return { routes, prober, dispatch };
}

export function createFleetServer(deps: FleetServerDeps): FleetServer {
  const { routes, prober, dispatch } = buildRoutes(deps);
  const registry = new HostRegistry(deps.db);
  // Built from the same dispatch the routes use, so mirroring resolves hosts and tokens exactly the way
  // dispatch and reconciliation do rather than through a second, subtly different wiring.
  const eventMirror: EventMirrorDeps = {
    db: deps.db,
    bindings: dispatch.bindings,
    registry: dispatch.registry,
    child: dispatch.child,
    resolveToken: dispatch.resolveToken,
  };
  // Parsed once, not per request: the token set is fixed at startup, and re-splitting it on every call
  // would let a caller's request rate scale the cost of an operation that never changes.
  const authDeps = { callers: parseCallerTokens(deps.config.apiTokens), adminToken: deps.config.adminToken };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const matched = matchRoute(routes, req.method ?? 'GET', path);
    if (!matched) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const { route, params } = matched;
    try {
      let caller: Caller = { ownerId: 'anonymous', isAdmin: false, allowedHosts: [] };
      if (!route.public) {
        const resolved = authenticate(req, authDeps);
        if (!resolved) {
          sendJson(res, 401, { error: 'authentication required' });
          return;
        }
        caller = resolved;
        if (route.admin && !caller.isAdmin) {
          sendJson(res, 403, { error: 'administrator token required' });
          return;
        }
      }
      const body = route.method === 'POST' ? await readJsonBody(req) : {};
      await route.handle({ caller, params, query: url.searchParams, headers: req.headers, body, log: deps.logger }, res);
    } catch (err) {
      // All three are the caller's mistake rather than a server fault, so all three are 4xx. CredentialError
      // in particular names a credential_ref that is not in the file -- returning 500 for that sends the
      // operator to the service logs when the answer is in their own request body.
      if (err instanceof HttpError || err instanceof RegistryError || err instanceof CredentialError) {
        const status = err instanceof HttpError ? err.status : 400;
        sendJson(res, status, {
          error: err.message,
          ...(err instanceof HttpError && err.details !== undefined ? { details: err.details } : {}),
        });
        return;
      }
      // The logger redacts, so an exception message carrying a header cannot reach the log intact.
      deps.logger.error('request failed', { method: req.method, path, err: err as Error });
      sendJson(res, 500, { error: 'internal error' });
    }
  };

  const tls = Boolean(deps.config.tlsCert && deps.config.tlsKey);
  const server = tls
    ? https.createServer(
        { cert: readFileSync(deps.config.tlsCert!), key: readFileSync(deps.config.tlsKey!) },
        handler,
      )
    : createServer(handler);
  // A dashboard holding an open stream must not stall `systemctl stop` until SIGKILL.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;

  const sweeperRef: { handle: SweeperHandle | null } = { handle: null };
  return {
    server,
    prober,
    routes,
    get sweeper() {
      return sweeperRef.handle;
    },
    async listen() {
      // Startup order from section 15.6: credentials were loaded by the caller, the database is open, and
      // reconciliation happens here. Binding LAST means a client can never get a response from an endpoint
      // that has not finished loading the registry.
      const hosts = registry.list();
      // Recovery BEFORE binding, per section 15.6: a client must not be able to ask about a Run while the
      // set of Runs is still being worked out. Pending bindings are those where Fleet asked a child for a Run
      // and never recorded the answer -- typically because Fleet died in between.
      const pending = dispatch.bindings.pending();
      if (pending.length > 0) {
        const rec = await recoverPending(dispatch);
        deps.logger.info('recovered pending bindings', {
          found: pending.length, resolved: rec.resolved, stillPending: rec.stillPending,
        });
      }
      deps.logger.info('fleet starting', {
        hosts: hosts.length,
        bindHost: deps.config.bindHost,
        port: deps.config.port,
        tls,
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.config.port, deps.config.bindHost, () => resolve());
      });
      const addr = server.address();
      prober.start();
      // Sweep once immediately so the first GET /fleet/hosts is not all "never-probed".
      void prober.sweepOnce().catch((err: Error) => deps.logger.error('initial sweep failed', { err }));

      // Reconciliation on its own timer, from startup, whether or not anyone is asking (section 7). A sweep
      // driven by reads would report exactly the staleness it exists to prevent: a Run that finishes while the
      // dashboard is closed would stay RUNNING until somebody opens the page again.
      sweeperRef.handle = startSweeper(dispatch, {
        intervalMs: deps.config.sweepIntervalMs,
        // Event metadata rides with reconciliation rather than on a third timer: both walk the same set of
        // live bindings, and a Run worth a status read is worth an event page.
        events: eventMirror,
        onEvent: (event: SweepEvent) => {
          // LOST is an operator event, not a Run outcome: the binding asserts a Run exists and the child
          // denies it. Loud in the log; a webhook belongs with the alerting work in a later phase.
          deps.logger.error('binding lost: child has no such Run', {
            fleetRunId: event.fleetRunId, hostId: event.hostId, childRunId: event.childRunId,
            detail: event.detail,
          });
        },
        onError: (err: unknown) => deps.logger.error('reconciliation sweep failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        }),
      });
      return {
        host: deps.config.bindHost,
        port: typeof addr === 'object' && addr ? addr.port : deps.config.port,
        tls,
      };
    },
    async close() {
      // In-flight probes are abandoned, not awaited: the sweep writes cache rows and cache is cheap to lose.
      prober.stop();
      // Stopped before the socket closes so a pass cannot start against a half-torn-down process and write a
      // cache row after the database is on its way out.
      sweeperRef.handle?.stop();
      sweeperRef.handle = null;
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

export { hostAllowed };
