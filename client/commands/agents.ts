// `mercuryctl agents list` (§6.1).
//
// Exists so an operator can discover which agent ids a server accepts before writing a create
// request, and see which one the server picks when the request omits it.

import type { AgentsResponse } from '../api/protocol.ts';
import { renderTable, makeColorizer } from '../output/human.ts';
import type { CommandContext } from './context.ts';

export function renderAgents(response: AgentsResponse, ctx: CommandContext, isTty: boolean): string {
  if (ctx.json) return JSON.stringify(response);
  const { color } = makeColorizer({ noColor: ctx.noColor, isTty, json: ctx.json });
  const rows = response.agents.map((id) =>
    id === response.defaultAgent ? [id, 'default'] : [id, ''],
  );
  const table = renderTable(['AGENT', ''], rows, (text, column) =>
    column === 0 ? color('cyan', text) : color('dim', text),
  );
  return `${table}\n\n${response.agents.length} agent(s); the server uses ` +
    `${color('cyan', response.defaultAgent)} when a Run omits one.`;
}
