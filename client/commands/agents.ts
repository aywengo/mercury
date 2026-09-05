// `mercuryctl agents list` (§6.1).
//
// Exists so an operator can discover which agent ids a server accepts before writing a create
// request, and see which one the server picks when the request omits it.

import type { AgentsResponse } from '../api/protocol.ts';
import { renderTable, makeColorizer, sanitizeForTerminal } from '../output/human.ts';
import type { CommandContext } from './context.ts';

export function renderAgents(response: AgentsResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color, dim } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  // Agent ids are server data, and the display layer must not assume server data is benign. Every
  // other command sanitises the strings it prints; this one printed ids straight through, so a server
  // (or a shared deployment whose agent registry someone else configures) could emit an escape sequence
  // that the operator's terminal would obey. Comparison happens on the raw value; only rendering
  // sanitises, so the "default" marker still lines up.
  const rows = response.agents.map((id) =>
    [sanitizeForTerminal(id), id === response.defaultAgent ? 'default' : ''],
  );
  const table = renderTable(['AGENT', ''], rows,
    (text, column) => (column === 0 ? color('cyan', text) : color('dim', text)),
    (text) => dim(text),
  );
  return `${table}\n\n${response.agents.length} agent(s); the server uses ` +
    `${color('cyan', sanitizeForTerminal(response.defaultAgent))} when a Run omits one.`;
}
