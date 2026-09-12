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
  // Goal support is rendered as three states, not two, because they want different actions
  // from the operator: "too old" means upgrade the harness, "unknown" means fix the probe,
  // and "no" means pick a different agent. Collapsing them into yes/no would hide the one
  // case the operator can actually fix (docs/goals.md 13.5).
  const goalsCell = (id: string): string => {
    const cap = response.capabilities?.[id]?.goals;
    // An older server sends no capabilities block. That is unknown, NOT unsupported --
    // rendering it as "no" would tell the operator a capability is absent when the client
    // simply was not told.
    if (!cap) return dim('unknown');
    if (cap.supported) return color('green', 'yes');
    switch (cap.reason) {
      case 'version-too-old':
        return `no: needs ${sanitizeForTerminal(cap.requiredVersion ?? '?')}, has ${sanitizeForTerminal(cap.detectedVersion ?? '?')}`;
      case 'version-unknown':
        return `unknown: version not detected (needs ${sanitizeForTerminal(cap.requiredVersion ?? '?')})`;
      default:
        return 'no';
    }
  };
  // How a backend receives skills (#508). Rendered because it is the one capability an operator
  // cannot infer from anything else: an agent that takes skill NAMES hard-fails on a Run whose skills
  // exist only as Mercury workspace files, and the failure reads like a bad skill choice rather than
  // a namespace mismatch.
  const skillsCell = (id: string): string => {
    const skills = response.capabilities?.[id]?.static?.skills;
    // Absent means the server did not say, which is unknown rather than 'none'. Rendering an older
    // server's silence as 'none' would tell an operator to stop using skills on an agent that
    // supports them.
    if (!skills) return dim('unknown');
    return sanitizeForTerminal(skills);
  };
  const rows = response.agents.map((id) =>
    [sanitizeForTerminal(id), goalsCell(id), skillsCell(id), id === response.defaultAgent ? 'default' : ''],
  );
  const table = renderTable(['AGENT', 'GOALS', 'SKILLS', ''], rows,
    (text, column) => (column === 0 ? color('cyan', text) : color('dim', text)),
    (text) => dim(text),
  );
  return `${table}\n\n${response.agents.length} agent(s); the server uses ` +
    `${color('cyan', sanitizeForTerminal(response.defaultAgent))} when a Run omits one.`;
}
