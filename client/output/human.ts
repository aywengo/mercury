// Human-readable presentation (docs/cli-tui-design.md §10.1, §13).
//
// Run task text, agent messages and error strings are UNTRUSTED: they originate in whatever an
// operator typed and whatever an agent printed, and this client is routinely run inside a terminal
// that interprets control sequences. A Run whose task is `ESC]2;...BEL` would otherwise retitle the
// terminal, and one containing a CSI could move the cursor, clear the screen or inject keystrokes
// into the operator's shell through terminal-side paste handling. So every untrusted string passes
// through sanitizeForTerminal() before it is displayed.
//
// JSON mode deliberately does NOT sanitize: its contract is to preserve data semantics, and a
// consumer that pipes into jq needs the real bytes. The security requirement there is different --
// never add authorization metadata -- and it is met by construction, since JSON output is the server
// payload.

/**
 * Neutralise terminal control sequences in untrusted text.
 *
 * Replaces, rather than deletes: removing a two-byte escape silently joins the words around it, so
 * an attacker could shape the surviving text. A visible marker keeps the manipulation obvious.
 */
export function sanitizeForTerminal(text: string): string {
  return text
    // ESC-initiated sequences: CSI, OSC, and the rest of the Fe escapes. Match the introducer and
    // consume to the terminator so a partial match cannot leave a usable fragment behind.
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])?/g, '\u241b')
    // Remaining C0 controls except tab and newline, which are layout rather than injection.
    // CR is NOT layout here. A terminal returns the cursor to column 0 on CR, so a task text of
    // `legit work\rOK - all tests pass` displays only the attacker's suffix -- the operator sees a
    // clean line that was never there. It was originally excluded alongside \n by analogy, which
    // was wrong: \n advances a line, \r overwrites one.
    .replace(/[\u0000-\u0008\u000b\u000c\r\u000e-\u001f\u007f]/g, '\u2400')
    // C1 controls, which can arrive as raw bytes or as the two-byte UTF-8 form.
    .replace(/[\u0080-\u009f]/g, '\u2400')
    // Bidi overrides: a right-to-left override can make an innocuous-looking string display as
    // something else, which is how a malicious repo name reads as a safe one.
    .replace(/[\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
}

const ANSI = {
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
  reset: '\u001b[0m',
};

export type Colorize = (text: string) => string;

/**
 * Colour is disabled by flag, by --json, by environment, and whenever stdout is not a TTY.
 *
 * The non-TTY rule matters more than the flag: `mercuryctl runs list | less` must not be full of
 * escape codes, and CI captures are never a TTY.
 */
export type ColorName = keyof typeof ANSI;

export function makeColorizer(options: { noColor: boolean; isTty: boolean; json: boolean }): {
  color: (name: keyof typeof ANSI, text: string) => string;
  dim: Colorize;
} {
  const enabled = !options.noColor && !options.json && options.isTty;
  const color = (name: keyof typeof ANSI, text: string): string =>
    enabled ? `${ANSI[name]}${text}${ANSI.reset}` : text;
  return { color, dim: (text: string) => color('dim', text) };
}

const STATUS_COLOR: Record<string, keyof typeof ANSI> = {
  QUEUED: 'dim',
  STARTING: 'cyan',
  RUNNING: 'cyan',
  NEEDS_INPUT: 'yellow',
  COMPLETED: 'green',
  FAILED: 'red',
  CANCELLED: 'dim',
  TIMED_OUT: 'yellow',
};

export function statusColor(status: string): keyof typeof ANSI {
  return STATUS_COLOR[status] ?? 'dim';
}

/**
 * How many columns a string occupies on screen: its characters, minus any SGR decoration.
 *
 * Only SGR (`CSI ... m`) is stripped. Every other escape sequence is already neutralised to a visible
 * marker by sanitizeForTerminal(), so one surviving here would be a bug elsewhere, and this function
 * hiding that bug would be worse than the misalignment it prevents.
 */
export function visibleWidth(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** Pad to a VISIBLE width, leaving decoration the cell already carries intact. */
function padVisible(cell: string, width: number): string {
  const visible = visibleWidth(cell);
  return visible >= width ? cell : `${cell}${' '.repeat(width - visible)}`;
}

/**
 * Render a fixed-column table.
 *
 * Widths are computed from the SANITISED, DISPLAYED text, not the raw text: a cell containing a
 * stripped escape sequence is shorter than the input, and sizing on the input would misalign every
 * following column -- which is exactly how a crafted field makes a table look like it says something
 * it does not.
 *
 * The same rule applies to the caller's OWN decoration, which is why measurement uses visibleWidth()
 * rather than `.length`. A cell function returning `color('green', 'yes')` hands renderTable eight
 * characters nobody sees; padding on `.length` then spends eight columns of that cell's budget on them,
 * the visible text lands eight columns short of its column, and every column to its right shifts left
 * with it. Measured on `mercuryctl agents list` with colour on before this was fixed: the SKILLS column
 * began at visible column 58 in three rows and at 49 in the row whose GOALS cell was green.
 *
 * Two contracts follow from measuring here rather than in each caller:
 *
 * - `decorate` and `decorateHeader` run BEFORE padding, so they may add SGR freely: padVisible() measures
 *   the decorated cell's visible width and pads to the column width, so decoration never shifts the
 *   column. (The order matters for a different reason: a decorator that looks up a key in the cell text,
 *   like statusColor(), must see the unpadded value -- padding first made `statusColor('RUNNING  ')`
 *   miss the key and fall through to the dim default, issue #604.) Truncation still belongs in the row
 *   builder, which is where `runs list` already does it with ellipsis().
 * - Width is counted in UTF-16 code units, not display columns. A CJK ideograph or an emoji occupies two
 *   columns and counts as one, so free-text columns over-align on those; a combining mark counts as one
 *   and occupies none. This is unchanged from before, and it is why the fixed-width columns this matters
 *   for (statuses, ids, capability names) are ASCII by construction. Full grapheme measurement is a
 *   different change with a different cost, and it is not what ragged columns were caused by.
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  decorate: (text: string, column: number) => string = (t) => t,
  decorateHeader: (text: string) => string = (t) => t,
): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );
  const line = (cells: string[], columnize: (text: string, i: number) => string): string =>
    cells
      .map((cell, i) => padVisible(columnize(cell, i), widths[i] ?? visibleWidth(cell)))
      .join('  ')
      .trimEnd();

  // The header style comes from the caller's colourizer, not from a hard-coded ANSI constant. It used to
  // be hard-coded, so `--no-color` left the header coloured and any redirect wrote escape codes into the
  // file -- `runs list > runs.txt` produced a file that did not diff or grep cleanly. Defaulting to no
  // decoration is deliberate: a new caller that forgets to pass one gets plain output rather than
  // colour it never asked for.
  const header = line(headers, (t) => decorateHeader(t));
  const body = rows.map((r) => line(r, (t, i) => decorate(t, i)));
  return [header, ...body].join('\n');
}

/** Truncate on one line without ever cutting in the middle of a surrogate pair. */
export function ellipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = [...text].slice(0, Math.max(0, max - 1)).join('');
  return `${cut}\u2026`;
}

/** Human age, e.g. `3m12s`, from an ISO timestamp. Unknown or future input reads as `-`. */
export function age(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '-';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '-';
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}
