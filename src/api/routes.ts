// REST API + SSE routes (Mercury.md sections 7, 15, 19-21).

import { Router, type Request, type Response } from 'express';
import type { EventStore } from '../events/eventStore.ts';
import type { EventStream } from '../events/eventStream.ts';
import type { RunService } from '../runs/runService.ts';
import type { RunStatus } from '../domain/types.ts';
import { isTerminal } from '../domain/stateMachine.ts';
import { requireAuth } from './auth.ts';
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.ts';
import type { Logger } from '../logger.ts';

import type { KnowledgeStatus } from '../knowledge/status.ts';
import type { OperatorNoteOutcome } from '../knowledge/operator.ts';

export interface RoutesDeps {
  runService: RunService;
  events: EventStore;
  stream: EventStream;
  /** Optional; used to record the real cause of a 500, which is never sent to the client. */
  logger?: Logger;
  /**
   * Supplies `GET /api/knowledge/status`. A thunk rather than a store, so this module stays free of
   * database and config plumbing and the route is testable with a fixed answer.
   *
   * Absent means this process has no knowledge surface at all -- the API-only process in a
   * deployment where the worker owns synchronization. The route then answers 404 rather than
   * reporting an empty status, because "no such surface here" and "configured but idle" are
   * different facts and an operator reading the second one would go looking for a broken Atlas.
   */
  knowledgeStatus?: () => KnowledgeStatus;
  /**
   * Validates and queues an operator-authored note. Returns an outcome rather than throwing, because
   * the two refusals mean different things to the caller and only one of them is the caller's fault.
   *
   * Absent means this process does not accept notes; the route answers 404 for the same reason the
   * status route does.
   */
  knowledgeNotes?: (body: unknown) => OperatorNoteOutcome;
}

/**
 * Map a thrown value to a response (issue #66).
 *
 * Recognised domain errors carry their own status and a message that is safe to send. Everything
 * else is an unexpected failure: report 500 with a fixed body and log the real cause. Defaulting
 * the UNKNOWN case to "generic" is the point -- a throw nobody classified cannot leak its
 * internals, whereas the previous `catch { 400 + err.message }` leaked by default.
 */
export function sendError(res: Response, err: unknown, logger?: Logger): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // Unclassified: keep the detail server-side. The logger redacts, so a message containing a
  // token still cannot reach the log in the clear.
  logger?.error(
    {
      err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    'unhandled API error',
  );
  res.status(500).json({ error: 'internal error' });
}

/**
 * Parse a `?limit=` query parameter into a bounded page size.
 *
 * Shared by GET /api/runs and GET /api/runs/:id/events (issue #101) because the two endpoints had
 * drifted: the events endpoint was fixed for `limit=0` while the list endpoint still used
 * `Number(x ?? 50) || 50`. That `|| 50` is the bug -- 0 is falsy, so a caller asking for the
 * SMALLEST page gets a medium one. Defaulting must key off "absent or not a number", never off
 * falsiness.
 *
 * The floor is 1, not 0: a zero-row page has no way to express "there is more", so a client
 * paging on it would either stop early or spin. Clamping to 1 makes the response honest instead.
 */
export function parseLimit(raw: unknown, def: number, max: number): number {
  if (raw === undefined) return def;
  // `?limit=` arrives as the empty string, and Number('') is 0 -- so without this an empty param
  // means "one row" rather than "I did not specify". Whitespace-only is the same case.
  if (typeof raw === 'string' && raw.trim() === '') return def;
  // A repeated param (`?limit=3&limit=5`) arrives as an array; Number() of that is NaN and falls
  // through to the default below, which is the right answer for an ambiguous request.
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

const VALID_STATUSES = new Set<RunStatus>(['QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * Event types after which a run can never append again, so an SSE stream has said everything it
 * has to say. Leaving the socket open on a finished run buys nothing and was the mechanism behind
 * the shutdown hang in #52. Keyed on event TYPES rather than derived from TERMINAL_STATUSES
 * because the stream observes events, not statuses.
 */
const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.timed_out']);

/**
 * How long a stream opened on an ALREADY-terminal run waits for its backlog before closing. The
 * EventStream poller runs at 250ms, so this spans several poll cycles; the backlog normally
 * arrives and closes the stream through send() long before this fires. It exists only for the
 * reconnect case where ?after= is already past the terminal event and nothing more will arrive.
 */
const STREAM_CLOSE_GRACE_MS = 2_000;

export function createRoutes(deps: RoutesDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/agents — registered agent ids for the UI dropdown
  //
  // `capabilities` is a PARALLEL field, deliberately not a reshaping of `agents`. The
  // dashboard's loadAgents() does `if (!Array.isArray(agents)) return;` to keep its static
  // fallback options, so turning `agents` into objects would make it silently discard every
  // server-registered agent and render two hardcoded ones -- a working server showing a
  // shorter list, with no error anywhere. Existing clients keep reading `agents` unchanged
  // (docs/goals.md 13.6).
  router.get('/agents', (_req: Request, res: Response) => {
    res.json({
      agents: deps.runService.listAgents(),
      defaultAgent: deps.runService.defaultAgent(),
      capabilities: deps.runService.listAgentCapabilities(),
    });
  });

  // GET /api/knowledge/status -- admin only (docs/knowledge-base.md section 8.5).
  //
  // Admin rather than owner-scoped because it describes the HOST, not a Run: outbox depth, the
  // configured project, and when this host last pushed. There is no per-owner reading of those, and
  // inventing one would mean deciding which owner may see which other owners' activity.
  //
  // 403 for an authenticated non-admin, not 404. The 404-not-403 rule belongs to Atlas's project
  // routes, where the existence of a project is itself the secret; here the caller is already
  // authenticated and the endpoint's existence is in the API docs, so a 404 would be a lie about
  // what is deployed rather than a protection.
  router.get('/knowledge/status', (req: Request, res: Response) => {
    if (!deps.knowledgeStatus) {
      res.status(404).json({ error: 'knowledge status is not served by this process' });
      return;
    }
    if (!req.auth?.isAdmin) {
      res.status(403).json({ error: 'knowledge status requires an admin token' });
      return;
    }
    res.json(deps.knowledgeStatus());
  });

  // POST /api/knowledge/notes -- admin only (docs/knowledge-base.md sections 11.1 and 16 phase 1).
  //
  // Admin for the same reason the status route is: an operator note lands PROMOTED, so it is the one
  // write path that skips curation. A contributor token must never be able to promote its own notes, and
  // that rule lives in the token class rather than in a check on the note's content.
  //
  // 403 rather than 404 for an authenticated non-admin, matching the status route: the endpoint is in the
  // API docs and the caller is already known, so a 404 would misreport what is deployed.
  router.post('/knowledge/notes', (req: Request, res: Response) => {
    if (!deps.knowledgeNotes) {
      res.status(404).json({ error: 'notes are not accepted by this process' });
      return;
    }
    if (!req.auth?.isAdmin) {
      res.status(403).json({ error: 'operator notes require an admin token' });
      return;
    }
    const outcome = deps.knowledgeNotes(req.body);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error, ...(outcome.reason ? { reason: outcome.reason } : {}) });
      return;
    }
    // 202, not 201: the note is durable here and not yet in Atlas. Claiming 201 would report a
    // contribution that has not happened, and an operator would have no way to learn that the pusher has
    // not run. `queued: false` says an identical note was already waiting, which is a success.
    res.status(202).json({ claimHash: outcome.claimHash, queued: outcome.queued });
  });

  // POST /api/runs
  router.post('/runs', (req: Request, res: Response) => {
    const body = req.body ?? {};
    try {
      const run = deps.runService.create({
        ownerId: req.auth!.ownerId,
        task: body.task,
        repository: body.repository,
        repositories: body.repositories,
        agent: body.agent,
        skills: body.skills,
        constraints: body.constraints,
        // Passed through unresolved: RunService owns validation and resolution, so the
        // rules are identical for HTTP callers and in-process callers.
        goal: body.goal,
        // Forwarded unresolved, exactly as `goal` is. This line was missing when the feature landed, and
        // no test caught it: every other test called runService.create() directly, so the validation was
        // correct, the route was correct, and the block was unreachable over HTTP. Same shape of defect as
        // the knowledgeNotes wiring in #539 -- unit tests of both halves cannot see the seam.
        knowledge: body.knowledge,
        // Same seam, same lesson (docs/crew/role-presets.md section 5): the preset block is
        // forwarded unresolved so HTTP and in-process callers hit identical validation.
        preset: body.preset,
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined,
      });
      res.status(201).json({ runId: run.id, status: run.status });
    } catch (err) {
      sendError(res, err, deps.logger);
    }
  });

  // GET /api/runs
  router.get('/runs', (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' && VALID_STATUSES.has(req.query.status as RunStatus)
      ? (req.query.status as RunStatus)
      : undefined;
    const limit = parseLimit(req.query.limit, 50, 200);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const { runs, nextCursor } = deps.runService.list({
      ownerId: req.auth!.ownerId,
      isAdmin: req.auth!.isAdmin,
      status,
      limit,
      cursor,
    });
    // `goals` is parallel to `runs`, never merged into it: `runs` stays an array of Run, and a
    // goal status must not become reachable as `run.status` (docs/goals.md 4).
    res.json({ runs, nextCursor, goals: deps.runService.goalStatuses(runs.map((r) => r.id)) });
  });

  // GET /api/runs/:runId
  router.get('/runs/:runId', (req: Request, res: Response) => {
    const run = deps.runService.get(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
    if (!run) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    // `goal` is a sibling of `run`, not a field on it. See docs/goals.md 4: goal status and Run
    // status are orthogonal axes, and the pair -- Run COMPLETED with goal unmet -- is the thing
    // a reader has to be able to see together. Folding them would let a client read one and
    // believe the other.
    res.json({
      run,
      skills: deps.runService.getSkills(run.id),
      goal: deps.runService.getGoal(run.id),
      // Sibling rather than a field on `run` (same shape as `goal`): the snapshot is immutable
      // per-Run data with its own lifecycle. The full instruction text is included; runtime
      // secrets never enter a snapshot (section 9: "never runtime secrets").
      preset: deps.runService.getPreset(run.id),
      // Sibling rather than a field on `run`, for the same reason `goal` is: the pack is a snapshot with
      // its own lifecycle, and folding it in would make `GET /api/runs` carry a blob nobody lists.
      knowledge: deps.runService.getKnowledge(run.id),
    });
  });

  // POST /api/runs/:runId/input
  router.post('/runs/:runId/input', (req: Request, res: Response) => {
    try {
      deps.runService.submitInput(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin, req.body?.input ?? req.body);
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, deps.logger);
    }
  });

  // POST /api/runs/:runId/cancel
  router.post('/runs/:runId/cancel', (req: Request, res: Response) => {
    try {
      const run = deps.runService.cancel(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
      res.json({ runId: run.id, status: run.status });
    } catch (err) {
      sendError(res, err, deps.logger);
    }
  });

  // GET /api/runs/:runId/goal
  //
  // The dedicated read from docs/goals.md 8. Note what it is NOT for: it returns the goal on its
  // own, so it cannot show a Run status next to a goal status, which is the pairing the whole
  // feature exists to make visible. `GET /api/runs/:runId` returns both and is what any renderer
  // should use; this exists for callers that only need the goal and for the documented contract.
  router.get('/runs/:runId/goal', (req: Request, res: Response) => {
    const run = deps.runService.get(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    const goal = deps.runService.getGoal(run.id);
    if (!goal) { res.status(404).json({ error: 'run has no goal' }); return; }
    res.json({ goal });
  });

  // GET /api/runs/:runId/knowledge
  //
  // The pack this Run was created with. Owner-scoped by the same `get` as every other Run read, so a
  // caller who cannot see the Run cannot read its notes -- a pack can contain another team's conventions,
  // and this route is the only way to read them back out of Mercury.
  router.get('/runs/:runId/knowledge', (req: Request, res: Response) => {
    const run = deps.runService.get(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
    if (!run) { res.status(404).json({ error: 'run not found' }); return; }
    const knowledge = deps.runService.getKnowledge(run.id);
    if (!knowledge) { res.status(404).json({ error: 'run was created without a knowledge pack' }); return; }
    res.json({ knowledge });
  });

  // POST /api/runs/:runId/goal/cancel
  //
  // Operator drop. Deliberately NOT a general goal-mutation endpoint: there is no route that can
  // set a status, an objective, or a `complete` (docs/goals.md 12). Cancel is the one action that
  // asserts nothing about whether the work was done.
  router.post('/runs/:runId/goal/cancel', (req: Request, res: Response) => {
    try {
      const goal = deps.runService.cancelGoal(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
      res.json({ goal });
    } catch (err) {
      sendError(res, err, deps.logger);
    }
  });

  // POST /api/runs/:runId/retry
  router.post('/runs/:runId/retry', (req: Request, res: Response) => {
    try {
      const run = deps.runService.retry(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
      res.status(201).json({ runId: run.id, status: run.status, retryOf: run.retryOf });
    } catch (err) {
      sendError(res, err, deps.logger);
    }
  });

  // GET /api/runs/:runId/events
  router.get('/runs/:runId/events', (req: Request, res: Response) => {
    const run = deps.runService.get(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
    if (!run) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    const afterSeq = Number(req.query.after ?? 0) || 0;
    // EventStore.list caps a page at 1000 rows. The cap is fine; what was not fine was
    // telling the client the run's TRUE maximum sequence alongside a truncated page and
    // letting it resume from that (issue #54).
    // Shared parser (issue #101); see parseLimit for why this must not use `|| 1000`.
    const limit = parseLimit(req.query.limit, 1000, 1000);
    const events = deps.events.list(run.id, afterSeq, limit);
    const lastSequence = deps.events.lastSequence(run.id);
    // The resume point is the last sequence actually RETURNED, not the run's maximum. A
    // client that pages from here sees every event; a client that pages from `lastSequence`
    // skips whatever the cap left out.
    const nextCursor = events.length > 0 ? events[events.length - 1].sequence : afterSeq;
    res.json({
      events,
      /** The run's true maximum sequence. Informational (the UI shows "N events"); NOT a
       *  safe resume point when the page is truncated. Use `nextCursor`. */
      lastSequence,
      nextCursor,
      hasMore: nextCursor < lastSequence,
    });
  });

  // GET /api/runs/:runId/stream  (SSE)
  router.get('/runs/:runId/stream', (req: Request, res: Response) => {
    const run = deps.runService.get(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
    if (!run) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    const afterSeq = Number(req.query.after ?? 0) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    // Declared before subscribe() and assigned after, because subscribe() now delivers the backlog
    // SYNCHRONOUSLY: a backlog containing a terminal event calls send() -> end() before this handler
    // has finished wiring. With these as `const` declared further down, end() reached them in their
    // temporal dead zone and threw out of the middle of subscribe() -- which left the response
    // neither written nor ended, and the request hanging rather than failing.
    let unsubscribe: () => void = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let backstop: ReturnType<typeof setTimeout> | undefined;

    const end = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      if (backstop) clearTimeout(backstop);
      unsubscribe();
      // res.end() throws on a destroyed socket, which is the usual reason this path runs at all.
      // Nothing can act on it, and letting it escape here would surface as an uncaught exception.
      try {
        res.end();
      } catch {
        /* already gone */
      }
    };

    /**
     * Tear the stream down WITHOUT flushing, for a client that has proven it will not read.
     *
     * destroy(), not end(): end() queues its closing bytes behind a buffer this client is not
     * draining, so the client never observes the close AND the bytes we are trying to reclaim stay
     * pinned -- which is the entire problem issue #145 describes. destroy() drops the buffer and
     * tears the socket down immediately.
     */
    const abortUnreadable = (): void => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      if (backstop) clearTimeout(backstop);
      unsubscribe();
      try {
        res.destroy();
      } catch {
        /* already gone */
      }
    };

    /**
     * Close the stream and record why. NOT sendError(): that ends in res.status(500).json(), and
     * headers are already on the wire by the time any of these paths can be reached, so calling it
     * here would raise a second failure while trying to report the first. Once headers are out the
     * only correct action is to close, and the log line is the only remaining evidence (issue #143).
     */
    const fail = (err: unknown, where: string): void => {
      deps.logger?.error(
        {
          runId: run.id,
          where,
          // Name+message only, because the logger JSON-serialises fields and Error.message is not
          // enumerable -- a raw { err } logs as {}. The stack goes separately, matching sendError():
          // this is the last evidence a post-headers failure leaves, and a message alone does not say
          // where it came from.
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'SSE stream failed; closing',
      );
      end();
    };

    // Registered after fail() so the closure is never read in its temporal dead zone, and before any
    // write: a response failure surfaces as an 'error' EVENT rather than a throw. Measured on Node 26
    // -- writing to a destroyed socket returns normally, and writing after res.end() returns normally
    // and THEN emits 'error'. An 'error' event with no listener is an uncaught exception, reproduced as
    // process exit 77 on a bare http.ServerResponse. This listener, not the try/catch below, is what
    // stops a broken SSE client from taking the process down (issue #143).
    res.on('error', (err: unknown) => fail(err, 'response stream error'));

    try {
      res.write(`event: hello\ndata: {"runId":"${run.id}","after":${afterSeq}}\n\n`);

      /**
       * Backpressure (issue #145). res.write() returns false once the socket buffer passes its
       * highWaterMark; the old code discarded that, so a client that stopped reading left Node
       * buffering the entire backlog in memory -- one browser tab on a run with a long history was
       * enough. Now: stop writing at the first false, hold at most MAX_PENDING events, resume on
       * 'drain', and close the stream if the client still will not read.
       *
       * The close is driven by ARRIVALS, not by a timer: a client wedged at the cap that receives no
       * further events is left open, holding at most MAX_PENDING events. That is bounded by
       * construction and is the intended steady state for a slow client that may resume; nothing
       * unbounded accumulates while it waits.
       *
       * Closing rather than blocking is deliberate. The producer here is the shared EventStream
       * dispatch loop, and a handler that blocks or grows without bound turns one wedged tab into a
       * server-wide problem. A dropped client reconnects with its own ?after= cursor and resumes;
       * nothing is lost, because an event that was never written was never acknowledged.
       */
      const MAX_PENDING = 1_000;
      const pending: { type: string; sequence: number; payload: unknown }[] = [];
      let paused = false;
      let sawTerminal = false;

      const writeEvent = (ev: { type: string; sequence: number; payload: unknown }): boolean =>
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);

      /** Push as much of the queue as the socket will take. Returns after pausing or emptying. */
      const flushPending = (): void => {
        while (pending.length > 0 && !paused && !closed) {
          const ok = writeEvent(pending[0]);
          // Always dropped: a false return still means the event was accepted into the socket
          // buffer, so keeping it here would send it twice.
          pending.shift();
          if (!ok) {
            paused = true;
            return;
          }
        }
        if (pending.length === 0 && sawTerminal) end();
      };

      const send = (events: { type: string; sequence: number; payload: unknown }[]): void => {
        if (closed) return;
        let overLimit = false;
        for (const ev of events) {
          if (paused) {
            // Checked BEFORE the push so MAX_PENDING is a real ceiling. Checking after the loop let a
            // single 500-row backlog page push the queue well past the cap before anything noticed,
            // which made "at most MAX_PENDING" untrue by up to a page.
            if (pending.length >= MAX_PENDING) {
              overLimit = true;
              break;
            }
            pending.push(ev);
            continue;
          }
          // A false return means "accepted, but please stop" -- the bytes ARE queued. Re-queueing
          // this event duplicates it, which is how the first version of this fix emitted two events
          // twice on a 1,107-event backlog and an existing test caught it.
          if (!writeEvent(ev)) paused = true;
        }
        // A terminal event is the last thing a run ever appends, so the stream has said everything
        // it has to say. But only end once the queue is empty: ending with events still buffered
        // would truncate the history it was mid-way through delivering.
        if (events.some((ev) => TERMINAL_EVENT_TYPES.has(ev.type))) sawTerminal = true;
        if (overLimit) {
          deps.logger?.warn(
            { runId: run.id, pending: pending.length, limit: MAX_PENDING },
            'SSE client is not reading; closing the stream so the backlog is not buffered in memory',
          );
          abortUnreadable();
          return;
        }
        flushPending();
      };

      res.on('drain', () => {
        paused = false;
        flushPending();
      });

      const unsubscribeFn = deps.stream.subscribe(run.id, afterSeq, send);
      unsubscribe = unsubscribeFn;
      // The backlog may already have ended us inside the call above. Nothing below may be armed on a
      // response that is finished: an interval created after end() ran is unreachable by the close
      // handler, and the subscription itself is registered after delivery, so it must be dropped here
      // or every stream that ends during its own backlog leaks a subscriber holding a closure over a
      // finished response.
      if (closed) {
        unsubscribeFn();
        return;
      }
      keepalive = setInterval(() => {
        // No try/catch here on purpose. res.write() does not throw on a destroyed socket or after
        // end(); it reports through the 'error' event, which fail() already handles. A guard that
        // cannot fire is worse than none: it implies a hazard that was measured not to exist.
        //
        // Skipped while paused: a keepalive on a socket that is already over its highWaterMark adds
        // to the very backlog the pause exists to stop growing. The queued events themselves keep the
        // connection interesting, and a client that stays wedged hits MAX_PENDING and is closed.
        if (paused) return;
        res.write(': keepalive\n\n');
      }, 15_000);

      // Backstop for the one case send() cannot see: the client reconnects with ?after= already past
      // the terminal event, so no further event will ever arrive to trigger the end above. Without it
      // the keepalive interval keeps the socket open forever (issue #73 L6) -- which is what made
      // server shutdown need closeAllConnections() to avoid hanging until SIGKILL (issue #52).
      //
      // The condition is "already caught up", not merely "the run is terminal". readAfter() pages at
      // 500 rows, so a terminal run with a long tail can still have history pending when subscribe()
      // returns; arming a fixed timer over an undrained backlog truncates it, cutting the stream off
      // mid-history while still reporting a clean close. Anything still pending is delivered by the
      // poller, and the terminal row inside that backlog ends the stream through send() as usual.
      if (isTerminal(run.status) && afterSeq >= deps.events.lastSequence(run.id)) {
        backstop = setTimeout(end, STREAM_CLOSE_GRACE_MS);
      }

      req.on('close', () => {
        clearInterval(keepalive);
        clearTimeout(backstop);
        unsubscribe();
      });
    } catch (err) {
      // subscribe() delivers its backlog synchronously and rethrows if anything in it throws, so a
      // read failure (a corrupt payload_json row, or a database fault) escapes HERE, after headers
      // are already on the wire. Express' default handler would then try to render a 500 on a sent
      // response. Closing is the only correct action, and the log line is the only evidence left.
      fail(err, 'stream setup');
    }
  });

  return router;
}
