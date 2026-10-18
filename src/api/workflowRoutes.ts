// Workflow Template API (docs/crew/workflows.md section 14, issue #810 -- W-3, advisory only).
//
// Separate routes, deliberately NOT merged into the preset routes: section 14 avoids
// overloading Role Presets, and the staged-mode group endpoints (/api/workflow-runs/*) are
// Phase 9 and do not exist here -- no endpoint, no table, no coordinator (#810 acceptance 4).
//
// Scoping follows the presets/Runs rules:
// - listing and inspecting a template is host configuration, not per-owner data, so every
//   authenticated caller may read it (the /api/presets rule);
// - invalid-template diagnostics are an OPERATOR concern, so ?includeInvalid=1 is admin-gated
//   (the /api/presets?diagnostics=1 rule);
// - creating a Run belongs to the caller: POST .../runs forwards unresolved to
//   RunService.create with the authenticated ownerId, so HTTP and in-process callers hit
//   identical validation (the same seam rule as the preset and workflow blocks on
//   POST /api/runs). Reading the created Run back is owner-scoped by RunService.get, and a
//   foreign Run is 404, not 403.

import { Router } from 'express';
import { requireAuth } from './auth.ts';
import { sendError, type RoutesDeps } from './routes.ts';
import { findServerStampedField, serverStampedFieldMessage } from './serverStampedFields.ts';
import { ValidationError } from '../domain/errors.ts';
import { WorkflowValidationFailure } from '../workflows/workflowRegistry.ts';
import { WorkflowPresetResolutionError } from '../workflows/resolveWorkflow.ts';
import type { LoadedWorkflow } from '../workflows/types.ts';
import type { RepositoryContext, RunConstraints } from '../domain/types.ts';

/** The short list fields; instruction-style text (stage tasks) stays on the detail endpoint. */
function listEntry(w: LoadedWorkflow) {
  return {
    id: w.id,
    version: w.version,
    description: w.description,
    mode: w.mode,
    trust: w.trust,
    contentHash: w.contentHash,
    stageCount: w.stages.length,
    maxStages: w.maxStages,
    source: { kind: w.source.kind, relativePath: w.source.relativePath },
  };
}

export function createWorkflowRoutes(deps: RoutesDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // GET /api/workflows -- browse valid builtin templates.
  //
  // ?includeInvalid=1 adds the invalid entries with their findings, for admins: an invalid
  // template is fixed by editing files on the host, which only an operator can do (the
  // /api/presets?diagnostics=1 rule). When the registry is absent the routes answer 404 with
  // the same "not served by this process" shape the preset routes use.
  router.get('/workflows', (req, res) => {
    const registry = deps.runService.workflowRegistry();
    if (!registry) {
      res.status(404).json({ error: 'workflows are not served by this process' });
      return;
    }
    const out: Record<string, unknown> = { workflows: registry.list().map(listEntry) };
    if (req.query.includeInvalid === '1' || req.query.includeInvalid === 'true') {
      if (!req.auth?.isAdmin) {
        res.status(403).json({ error: 'workflow diagnostics require an admin token' });
        return;
      }
      // Bounded: one entry per invalid template directory, findings as validated (no file
      // contents, no absolute paths -- the registry sanitizes load errors).
      out.invalid = registry.listAll().invalid.map((bad) => ({
        id: bad.id,
        findings: bad.validation,
      }));
    }
    res.json(out);
  });

  // GET /api/workflows/:workflowId -- inspect one template: stages, tasks, and the presets
  // the stages reference (resolved against the live preset registry for display only). The
  // SNAPSHOT a Run carries is what executes; this view is the what-would-I-be-running page.
  router.get('/workflows/:workflowId', (req, res) => {
    const registry = deps.runService.workflowRegistry();
    if (!registry) {
      res.status(404).json({ error: 'workflows are not served by this process' });
      return;
    }
    try {
      const w = registry.get(req.params.workflowId);
      const presets = deps.runService.presetRegistry();
      res.json({
        ...listEntry(w),
        stages: w.stages.map((stage) => {
          let resolved: { id: string; version: string; role: string; enabled: boolean } | null = null;
          if (stage.preset && presets) {
            try {
              const p = presets.get(stage.preset.id);
              resolved = { id: p.id, version: p.version, role: p.role, enabled: p.enabled };
            } catch {
              resolved = null; // an unresolvable reference is shown as unresolved, not hidden
            }
          }
          return { id: stage.id, task: stage.task, preset: stage.preset ?? null, resolvedPreset: resolved };
        }),
      });
    } catch (err) {
      // A template whose files are invalid is a 400 carrying the findings themselves (the
      // /api/presets/:id rule); unknown ids keep the generic 404 mapping.
      if (err instanceof WorkflowValidationFailure) {
        res.status(400).json({ error: err.message, findings: err.findings });
        return;
      }
      sendError(res, err, deps.logger);
    }
  });

  // POST /api/workflows/:workflowId/runs -- create the single advisory Run through the W-2
  // service path. The body is a Run-create body MINUS the workflow selection (the id comes
  // from the URL; an optional workflowVersion pins the definition version). preset and
  // workflow are refused here rather than silently dropped: a caller who sent both chose two
  // mutually exclusive modes and must hear about it, not get workflow.
  router.post('/workflows/:workflowId/runs', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      // Same refusal as POST /api/runs (issue #988 acceptance 1): this route creates Runs too, so a
      // body carrying a server-stamped field must not be quietly ignored here either. Checked before
      // the workflow/preset conflicts so the answer does not depend on which key came first.
      const stamped = findServerStampedField(body);
      if (stamped) throw new ValidationError(serverStampedFieldMessage(stamped));
      if (body.workflow !== undefined) {
        res.status(400).json({ error: 'workflow comes from the URL path; pass workflowVersion to pin a version' });
        return;
      }
      if (body.preset !== undefined) {
        res.status(400).json({ error: 'preset and workflow are mutually exclusive' });
        return;
      }
      // Forward the pin UNRESOLVED: undefined means "no pin" (head), any supplied value --
      // string or not -- reaches RunService.create's strict workflow validation, so a
      // non-string pin is refused rather than silently unpinned.
      const version = body.workflowVersion;
      const run = deps.runService.create({
        ownerId: req.auth!.ownerId,
        // The optional Run-create fields are forwarded UNRESOLVED, exactly as the
        // POST /api/runs route does; RunService owns the strict validation. The `as` casts
        // only restore the declared field types -- `body` is Record<string, unknown> because
        // the request body is untyped.
        task: body.task as string,
        repository: body.repository as RepositoryContext | undefined,
        repositories: body.repositories as RepositoryContext[] | undefined,
        agent: body.agent as string | undefined,
        skills: body.skills as string[] | undefined,
        constraints: body.constraints as Partial<RunConstraints> | undefined,
        goal: body.goal,
        knowledge: body.knowledge,
        model: body.model as string | undefined,
        selection: body.selection,
        workflow: {
          id: req.params.workflowId,
          ...(version !== undefined ? { version: version as string } : {}),
        },
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined,
      });
      res.status(201).json({ runId: run.id, status: run.status });
    } catch (err) {
      // An unknown template is the preset-route convention: a referenced resource that does
      // not exist is a 404 that names it, never a 400 or a 500. WorkflowPresetResolutionError
      // is a ValidationError subclass (400 by default), so the not-found code is mapped here,
      // at the HTTP boundary where the status vocabulary lives.
      if (err instanceof WorkflowPresetResolutionError && err.code === 'WORKFLOW_NOT_FOUND') {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      sendError(res, err, deps.logger);
    }
  });

  return router;
}
