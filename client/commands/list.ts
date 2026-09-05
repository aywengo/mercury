// `mercuryctl runs list` (§6.1, §7.2).
//
// Pagination rule: the server's cursor is OPAQUE. It is passed back verbatim and never parsed,
// compared or constructed locally. The server may encode anything in it -- today a timestamp and an
// id -- and a client that assumed the format would break the moment that changed, while a client
// that treats it as a token keeps working.

import type { Run, RunListResponse } from '../api/protocol.ts';
import { renderTable, makeColorizer, sanitizeForTerminal, ellipsis, statusColor, age } from '../output/human.ts';
import type { CommandContext } from './context.ts';

export function renderRunList(response: RunListResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color, dim } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  if (response.runs.length === 0) return 'no Runs';

  // Every cell is sanitised, not just the task. `agent` in particular is whatever the caller passed to
  // `runs create --agent`, stored verbatim and echoed back here, so on a shared instance one operator's
  // Run can put a control sequence in another operator's terminal. `status` is validated against a fixed
  // enum by the parser and is safe today; sanitising it costs nothing and does not rely on that staying
  // true.
  const rows = response.runs.map((run: Run) => [
    sanitizeForTerminal(run.id),
    sanitizeForTerminal(run.status),
    sanitizeForTerminal(run.agent),
    age(run.startedAt ?? run.createdAt),
    ellipsis(sanitizeForTerminal(run.task.replace(/\s+/g, ' ').trim()), 48),
  ]);
  const table = renderTable(['ID', 'STATUS', 'AGENT', 'AGE', 'TASK'], rows,
    (text, column) => {
      if (column === 1) return color(statusColor(text), text);
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
