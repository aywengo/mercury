// REST API + SSE routes (Mercury.md sections 7, 15, 19-21).

import { Router, type Request, type Response } from 'express';
import type { EventStore } from '../events/eventStore.ts';
import type { EventStream } from '../events/eventStream.ts';
import type { RunService } from '../runs/runService.ts';
import type { RunStatus } from '../domain/types.ts';
import { requireAuth } from './auth.ts';

export interface RoutesDeps {
  runService: RunService;
  events: EventStore;
  stream: EventStream;
}

const VALID_STATUSES = new Set<RunStatus>(['QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

export function createRoutes(deps: RoutesDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/agents — registered agent ids for the UI dropdown
  router.get('/agents', (_req: Request, res: Response) => {
    res.json({ agents: deps.runService.listAgents() });
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
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined,
      });
      res.status(201).json({ runId: run.id, status: run.status });
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // GET /api/runs
  router.get('/runs', (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' && VALID_STATUSES.has(req.query.status as RunStatus)
      ? (req.query.status as RunStatus)
      : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const { runs, nextCursor } = deps.runService.list({
      ownerId: req.auth!.ownerId,
      isAdmin: req.auth!.isAdmin,
      status,
      limit,
      cursor,
    });
    res.json({ runs, nextCursor });
  });

  // GET /api/runs/:runId
  router.get('/runs/:runId', (req: Request, res: Response) => {
    const run = deps.runService.get(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
    if (!run) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.json({ run, skills: deps.runService.getSkills(run.id) });
  });

  // POST /api/runs/:runId/input
  router.post('/runs/:runId/input', (req: Request, res: Response) => {
    try {
      deps.runService.submitInput(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin, req.body?.input ?? req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // POST /api/runs/:runId/cancel
  router.post('/runs/:runId/cancel', (req: Request, res: Response) => {
    try {
      const run = deps.runService.cancel(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
      res.json({ runId: run.id, status: run.status });
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // POST /api/runs/:runId/retry
  router.post('/runs/:runId/retry', (req: Request, res: Response) => {
    try {
      const run = deps.runService.retry(req.params.runId, req.auth!.ownerId, req.auth!.isAdmin);
      res.status(201).json({ runId: run.id, status: run.status, retryOf: run.retryOf });
    } catch (err) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
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
    // Parse explicitly rather than with `|| 1000`: that treats a legitimate `?limit=0` as
    // absent and silently expands it to the maximum, which is the opposite of what the
    // caller asked for. Default only when the param is missing or not a number.
    const rawLimit = req.query.limit === undefined ? 1000 : Number(req.query.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 1000;
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
    res.write(`event: hello\ndata: {"runId":"${run.id}","after":${afterSeq}}\n\n`);

    const send = (events: { type: string; sequence: number; payload: unknown }[]): void => {
      for (const ev of events) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    };

    const unsubscribe = deps.stream.subscribe(run.id, afterSeq, send);
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  return router;
}
