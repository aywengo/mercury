// Machine-readable output (docs/cli-tui-design.md §10.1).
//
// The contract: a non-streaming JSON command writes EXACTLY ONE JSON value to stdout, and a
// streaming command writes newline-delimited JSON, one complete line per event. Diagnostics never
// go to stdout, because `mercuryctl runs list --json | jq` must parse even when the server is
// unhealthy and the client has plenty to say about it.

/** One JSON value, newline-terminated, nothing else on stdout. */
export function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value)}\n`);
}

/**
 * One event per line, flushed as a complete line before the caller advances its cursor.
 *
 * Truncating mid-line on a kill would corrupt the consumer's last record, so callers write whole
 * lines only.
 */
export function eventLine(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}
