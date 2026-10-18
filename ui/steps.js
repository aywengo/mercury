// Planned-steps mapping for the Run detail page (docs/crew/workflows.md section 3.1, #810).
//
// Pure and DOM-free so node --test can pin it: run.js renders whatever this returns.
//
// The advisory contract: the plan is prompt guidance, Mercury enforces nothing, and progress
// is what the AGENT reports with step.started / step.completed / step.failed events. The
// panel therefore labels itself "agent-reported - not enforced by Mercury", and a planned
// step with no reported event shows as "not reported" -- never as "skipped" or "failed",
// because Mercury does not know.

/**
 * Map agent-reported step events onto the planned stages by stage id.
 *
 * `stages` is the planned list from the stored snapshot ({ id, ... }, in template order).
 * `events` are the run's step.* events; the stage id is the event payload's `stage` field
 * (payload.stageId and payload.step are accepted as aliases for agents that report under
 * either name, first match wins: stage, stageId, step). Events naming an unknown stage are
 * reported in the result's `unreported` counter's complement -- they stay visible only in the
 * event timeline, so a typo'd stage id cannot silently overwrite a planned step's state.
 *
 * Returns one row per planned stage, in template order:
 *   { id, task?, preset?, status, lastType, lastSequence }
 * with status one of 'not-reported' | 'started' | 'completed' | 'failed'.
 */
export function mapStepEvents(stages, events) {
  const byStage = new Map();
  for (const e of events || []) {
    const type = typeof e?.type === 'string' ? e.type : '';
    if (type !== 'step.started' && type !== 'step.completed' && type !== 'step.failed') continue;
    const p = e.payload && typeof e.payload === 'object' ? e.payload : {};
    const stageId = [p.stage, p.stageId, p.step].find((v) => typeof v === 'string' && v.length > 0);
    if (!stageId) continue;
    const prev = byStage.get(stageId);
    // Later events win; a failed/completed event outranks a bare started event at the same
    // sequence is not a thing events need -- the timeline shows the order, the panel shows
    // the latest state.
    if (!prev || (e.sequence ?? 0) >= (prev.sequence ?? 0)) {
      byStage.set(stageId, { type, sequence: e.sequence ?? 0 });
    }
  }
  return (stages || []).map((s) => {
    const rep = byStage.get(s.id) || null;
    return {
      id: s.id,
      task: s.task,
      preset: s.preset ?? null,
      status: rep ? rep.type.replace('step.', '') : 'not-reported',
      lastSequence: rep ? rep.sequence : null,
    };
  });
}
