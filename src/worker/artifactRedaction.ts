// Redaction of agent artifacts at rest (issue #944, follow-up to the #942 token leak).
//
// The event redactor covers `events.payload_json`, but a Run's agent-side artifacts are written
// into the workspace unredacted: session transcripts (`.mercury-sessions/*.jsonl`) and
// kernel-state snapshots (`session-artifacts/*/kernel-state.dill`). Both held the revoked
// GH_TOKEN in plain text during #942. Git exclusion (#943) stops them being committed; it does
// not stop the agent reading them back, or workspace tooling shipping them. The worker is the
// choke point: after the agent process is gone, every artifact under the Run's workspace is
// scrubbed of the values Mercury itself declared or forwarded.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor } from '../domain/redact.ts';

/** The agent-state dirs the redaction pass covers. Kept in step with GENERATED_PATHS. */
export const ARTIFACT_DIRS = ['.mercury-sessions/', 'session-artifacts/'] as const;

/**
 * Replace `secret` (utf-8 bytes) inside `buf` with a marker of the SAME byte length and return
 * the new buffer, or `null` when it does not occur. Same length matters for binary snapshots:
 * a pickle/dill record carries its own length prefix, so an in-place equal-length swap keeps
 * the file parseable while destroying the value. Text files go through createRedactor() instead,
 * so they get the same '[REDACTED]' rendering (labels kept) as events.
 */
function redactBytes(buf: Buffer, secret: string): Buffer | null {
  const needle = Buffer.from(secret, 'utf8');
  if (needle.length === 0 || !buf.includes(needle)) return null;
  // ASCII marker padded to the needle's exact byte length. A needle containing multi-byte
  // characters has a longer byte form than character form; only the byte length is contracted.
  const marker = '[REDACTED]'.padEnd(needle.length, '#').slice(0, needle.length);
  const patch = Buffer.from(marker, 'utf8');
  let out = buf;
  let idx: number;
  while ((idx = out.indexOf(needle)) !== -1) {
    patch.copy(out, idx);
  }
  return out;
}

function isBinary(buf: Buffer): boolean {
  // Same heuristic as git: a NUL byte means binary. Transcripts are JSONL text; kernel
  // snapshots are pickles and contain NULs.
  return buf.includes(0);
}

/** Recursively scrub every file under the artifact dirs. Returns the number of files changed. */
export function redactRunArtifacts(workspacePath: string, secrets: string[]): number {
  const values = secrets.filter((s) => s.length > 0);
  if (values.length === 0) return 0;
  // Text artifacts use the same chain as events: declared values plus the provider-key shapes,
  // so a bare key echoed into a transcript is caught even when no literal was declared.
  const redactor = createRedactor(values);
  let scrubbed = 0;
  for (const dir of ARTIFACT_DIRS) {
    const root = join(workspacePath, dir);
    scrubbed += walk(root, (path) => {
      const buf = readFileSync(path);
      if (isBinary(buf)) {
        let out: Buffer | null = null;
        for (const secret of values) {
          const next = redactBytes(out ?? buf, secret);
          if (next) out = next;
        }
        if (out) writeFileSync(path, out);
        return out !== null;
      }
      const text = buf.toString('utf8');
      const redacted = redactor.redact(text);
      if (redacted !== text) {
        writeFileSync(path, redacted, 'utf8');
        return true;
      }
      return false;
    });
  }
  return scrubbed;

  function walk(dir: string, fn: (path: string) => boolean): number {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0; // no artifacts of this kind: nothing to do
    }
    let count = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) count += walk(path, fn);
      else if (entry.isFile() && fn(path)) count += 1;
      // Symlinks are left alone: the artifact dirs are workspace-local and git-excluded, and
      // following a symlink out of the tree would let a crafted link redirect rewrites.
    }
    return count;
  }
}
