// Deterministic advisory plan rendering (docs/crew/workflows.md sections 3.1 and 5; issue #809).
//
// Pure: the same snapshot produces byte-identical output -- no timestamps, no random ids, no
// locale-dependent formatting (the registry hash rule). The prompt carries the ordered steps,
// each with its stage id, task and the stage preset's instruction as guidance for that step,
// and states the step bound explicitly. Advisory mode enforces nothing (section 3.1), so the
// wording must never claim Mercury enforces the order: the plan is guidance the agent reports
// against with step events.
//
// The whole rendered plan has a cap (PLAN_MAX_BYTES). Truncation is marked, never silent: a
// template legitimately inside every per-stage bound can still overflow the whole-plan cap,
// and a silently clipped step would be guidance the Run never saw.

import type { ResolvedWorkflow } from '../runs/workflowStore.ts';

/** Hard cap on the rendered plan text. Generous for a 16-stage template with instructions. */
export const PLAN_MAX_BYTES = 64 * 1024;

/** The visible truncation marker, and the machine marker tests can pin. */
export const TRUNCATION_MARKER = '[... plan truncated: exceeded the 65536-byte advisory plan cap ...]';

/**
 * The instruction a stage preset contributes to ITS OWN step (section 3.1.1 rule 5), or the
 * plain default for a stage without a preset (the Run's own agent performs that step).
 */
function stageGuidance(presetInstruction: string | undefined, agentId: string): string {
  if (presetInstruction === undefined) {
    return `Guidance: none -- the stage preset carries no instruction. You are the ${agentId} agent; use your own judgment for how to perform this step.`;
  }
  const trimmed = presetInstruction.trim();
  if (trimmed.length === 0) {
    return `Guidance: none -- the stage preset carries no instruction text. You are the ${agentId} agent; use your own judgment for how to perform this step.`;
  }
  return `Guidance (from the stage preset, for THIS step only):\n${trimmed}`;
}

/**
 * Render the advisory plan for one Run from its stored snapshot.
 *
 * `agentId` names the agent that will execute the Run (resolution happens before rendering),
 * and `presetInstructions` maps stage index -> instruction text (resolved from the stage
 * preset snapshots, not from the live registry). The output is the plan TEXT the worker
 * embeds in the prompt -- deterministic and byte-stable for a given snapshot.
 */
export function renderPlan(
  snapshot: ResolvedWorkflow,
  agentId: string,
  presetInstructions: Record<number, string | undefined>,
): string {
  const stages = snapshot.stages;
  const count = stages.length;
  const lines: string[] = [];
  lines.push(`## Advisory workflow plan: ${snapshot.id} (version ${snapshot.version})`);
  lines.push('');
  lines.push('This plan is ADVICE, not enforcement. Mercury does not verify the order, gates, or'
    + ' completion of these steps. Complete them in order and report each one with a step event'
    + ' (step.started / step.completed / step.failed) so the host can display progress.');
  lines.push('');
  lines.push(`Steps: ${count} steps, in order; report each with step events. The template declares a`
    + ` maximum of ${snapshot.maxStages} steps; render no more than the ${count} listed here.`);
  lines.push('');
  lines.push(`You are the ${agentId} agent performing all ${count} step${count === 1 ? '' : 's'} yourself.`);
  lines.push('');
  stages.forEach((stage, i) => {
    lines.push(`### Step ${i + 1} of ${count}: ${stage.id}`);
    lines.push('');
    lines.push(`Task: ${stage.task}`);
    lines.push('');
    lines.push(stageGuidance(presetInstructions[i], agentId));
    lines.push('');
  });
  const body = lines.join('\n');
  // Cap the WHOLE plan (section 5: "The whole rendered plan has a cap, and truncation is
  // marked, never silent"). Truncate on a line boundary so a step heading is never cut in
  // half, then append the marker.
  // Truncate in BYTES, not code units: the cap is a byte cap, and a JS string index counts
  // UTF-16 code units, so a multibyte template could render past the promised bound (#842
  // review). The buffer is the unit of measure on both sides -- search and slice stay in
  // bytes, then the decode happens once, at the end.
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= PLAN_MAX_BYTES) return body;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  let cut = PLAN_MAX_BYTES - markerBytes - 1;
  // Walk back to the start of the line that crosses the budget.
  while (cut > 0 && buf[cut] !== 0x0a) cut--;
  return buf.subarray(0, cut).toString('utf8') + '\n' + TRUNCATION_MARKER;
}

/** True when a rendered plan was truncated (the worker records it on the materialized event). */
export function isTruncated(plan: string): boolean {
  // Suffix, not substring (#842 review r5): the renderer appends the marker only at the very
  // end (an untruncated plan ends with a newline), and task or preset text may legitimately
  // contain the marker string.
  return plan.endsWith(TRUNCATION_MARKER);
}
