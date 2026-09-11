// `mercuryctl runs list` (§6.1, §7.2).
//
// Pagination rule: the server's cursor is OPAQUE. It is passed back verbatim and never parsed,
// compared or constructed locally. The server may encode anything in it -- today a timestamp and an
// id -- and a client that assumed the format would break the moment that changed, while a client
// that treats it as a token keeps working.

import type { Run, RunListResponse } from '../api/protocol.ts';
import { renderTable, makeColorizer, sanitizeForTerminal, ellipsis, statusColor, age } from '../output/human.ts';
import type { CommandContext } from './context.ts';
import type { ColorName } from '../output/human.ts';

/** `unmet` is the status an operator is scanning the list to find. */
function goalTone(status: string): ColorName {
  if (status === 'complete') return 'green';
  if (status === 'unmet' || status === 'error') return 'red';
  if (status === 'paused' || status === 'budget_limited') return 'yellow';
  return 'dim';
}

export function renderRunList(response: RunListResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color, dim } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  if (response.runs.length === 0) return 'no Runs';

  // Every cell is sanitised, not just the task. `agent` in particular is whatever the caller passed to
  // `runs create --agent`, stored verbatim and echoed back here, so on a shared instance one operator's
  // Run can put a control sequence in another operator's terminal. `status` is validated against a fixed
  // enum by the parser and is safe today; sanitising it costs nothing and does not rely on that staying
  // true.
  // GOAL sits beside STATUS and never replaces it. A COMPLETED row with an unmet goal must show
  // both words, or the list reproduces the original problem: the process status hiding whether
  // the work was achieved (docs/goals.md 4).
  //
  // Three renderings, matching the protocol's three states. A missing map means the server
  // predates goals and prints `?`; a map without this run means the Run genuinely has no goal
  // and prints `-`. Collapsing those two would claim knowledge the client does not have.
  const goals = response.goals;
  const goalFor = (run: Run): string => {
    if (goals === undefined) return '?';
    const goal = goals[run.id];
    if (!goal) return '-';
    // Spelled out rather than marked with a symbol: a dagger or a dimmed cell is the same trick
    // that hid this in the first place, and a terminal has no hover. `attempted === false` only,
    // so the common reading stays one word -- and absent means unknown, never "never started".
    if (goal.status === 'unmet' && goal.attempted === false) return 'unmet (never started)';
    return goal.status;
  };
  const rows = response.runs.map((run: Run) => [
    sanitizeForTerminal(run.id),
    sanitizeForTerminal(run.status),
    sanitizeForTerminal(goalFor(run)),
    sanitizeForTerminal(run.agent),
    age(run.startedAt ?? run.createdAt),
    ellipsis(sanitizeForTerminal(run.task.replace(/\s+/g, ' ').trim()), 48),
  ]);
  const table = renderTable(['ID', 'STATUS', 'GOAL', 'AGENT', 'AGE', 'TASK'], rows,
    (text, column) => {
      if (column === 1) return color(statusColor(text), text);
      if (column === 2) return color(goalTone(text), text);
      if (column === 0) return color('cyan', text);
      return text;
    },
    (text) => dim(text),
  );
  // The cursor is shown so a script can resume without re-deriving it, but it is never interpreted
  // here -- it is echoed, not parsed.
  const footer = response.nextCursor
    ? `\n\nmore remain; continue with --cursor ${JSON.stringify(response.nextCursor)}`
    : '';
  return `${table}${footer}`;
}
