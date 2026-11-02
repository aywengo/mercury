// Redaction of agent artifacts at rest (issue #944, follow-up to the #942 token leak).
//
// The event redactor covers `events.payload_json`, but a Run's agent-side artifacts are written
// into the workspace unredacted: session transcripts (`.mercury-sessions/*.jsonl`) and
// kernel-state snapshots (`session-artifacts/*/kernel-state.dill`). Both held the revoked
// GH_TOKEN in plain text during #942. Git exclusion (#943) stops them being committed; it does
// not stop the agent reading them back, or workspace tooling shipping them. The worker is the
// choke point: after the agent process is gone, every artifact under the Run's workspace is
// scrubbed of the values Mercury itself declared or forwarded.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

// Strict decoder: a single invalid byte throws, which is the classification the review on
// #965 asked for. `toString('utf8')` would silently replace invalid sequences with U+FFFD and
// write that corruption back to disk when a secret is found.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Text vs binary classification. A file is text only when it is strictly valid UTF-8 AND
 * contains no NUL byte: a NUL-free file with an invalid UTF-8 sequence (many small pickles,
 * protocol-0 pickles, compressed or encoded blobs) is binary, because routing it through the
 * text path would rewrite the whole file with U+FFFD replacements far from the secret.
 */
function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  try {
    strictUtf8.decode(buf);
    return false;
  } catch {
    return true;
  }
}

/** Files larger than this are skipped with a logged warning instead of read whole (review on
 * #965: readFileSync doubles a large kernel snapshot in memory during the swap). */
export const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;

export interface RedactArtifactsOptions {
  maxFileBytes?: number;
  /** Called when a file is skipped for size, so the caller can log it with the runId. */
  onSkip?: (path: string, size: number) => void;
}

/**
 * Encoded copies of a secret that appear in transcripts without the raw value (review on
 * #965): base64 of the raw value, and base64 of the `x-access-token:<value>` pair git uses in
 * URLs. Other encodings (percent-encoding in arbitrary positions, hex) remain a documented
 * limitation, matching the event redactor's floor.
 */
function encodedVariants(values: string[]): string[] {
  const out = new Set(values);
  for (const v of values) {
    out.add(Buffer.from(v, 'utf8').toString('base64'));
    out.add(Buffer.from('x-access-token:' + v, 'utf8').toString('base64'));
  }
  return [...out];
}

/** ENOENT is the only error a traversal may read as "nothing here": a file or directory that
 * vanished mid-pass holds no content to leak. Every other code means the pass did not read
 * everything, and that must surface instead of being stamped complete (#976). */
function enoent(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === 'ENOENT';
}

export interface ArtifactRedactionFailure {
  /** The directory or file the pass could not read or write. */
  path: string;
  /** The errno code (EACCES, EIO, ...) when the runtime gave one. */
  code?: string;
}

export interface ArtifactRedactionResult {
  /** Files whose content was rewritten. */
  scrubbed: number;
  /** Entries the pass could not read or write: non-empty means the pass is INCOMPLETE and a
   * caller that stamps runs must withhold its stamp (#976). */
  failures: ArtifactRedactionFailure[];
}

/**
 * Recursively scrub every file under the artifact dirs. Returns the pass result: the number of
 * files changed, and the entries the pass could not read or write.
 *
 * An entry the pass cannot read (EACCES on an unreadable subdirectory) or write is COLLECTED,
 * not thrown: the pass continues through the accessible files and the remaining artifact roots,
 * so readable secrets are still scrubbed, and `failures` reports the gap. A caller that stamps
 * runs must only stamp a complete pass (#976).
 */
export function redactRunArtifacts(
  workspacePath: string,
  secrets: string[],
  options: RedactArtifactsOptions = {},
): ArtifactRedactionResult {
  const failures: ArtifactRedactionFailure[] = [];
  const fail = (path: string, err: unknown): void => {
    failures.push({ path, code: (err as { code?: string } | undefined)?.code });
  };
  const values = secrets.filter((s) => s.length > 0);
  if (values.length === 0) return { scrubbed: 0, failures };
  // The needle set covers encoded copies (base64 of the value and of the x-access-token pair),
  // so a transcript that only carries the credential in a git URL survives no better than one
  // carrying it raw.
  const needles = encodedVariants(values);
  // Text artifacts use the same chain as events: declared values plus the provider-key shapes,
  // so a bare key echoed into a transcript is caught even when no literal was declared.
  const redactor = createRedactor(needles);
  const maxFileBytes = options.maxFileBytes ?? MAX_ARTIFACT_FILE_BYTES;
  let scrubbed = 0;
  for (const dir of ARTIFACT_DIRS) {
    const root = join(workspacePath, dir);
    scrubbed += walk(root, (path) => {
      let buf: Buffer;
      try {
        const size = statSync(path).size;
        if (size > maxFileBytes) {
          options.onSkip?.(path, size);
          return false;
        }
        buf = readFileSync(path);
      } catch (err) {
        if (enoent(err)) return false; // vanished between readdir and read: nothing to scrub
        fail(path, err); // unreadable file: collect and continue, the pass is incomplete (#976)
        return false;
      }
      if (isBinary(buf)) {
        let out: Buffer | null = null;
        for (const secret of needles) {
          const next = redactBytes(out ?? buf, secret);
          if (next) out = next;
        }
        if (out) {
          try {
            writeFileSync(path, out);
          } catch (err) {
            if (!enoent(err)) fail(path, err); // vanished before the write: the secret left with it
            return false;
          }
        }
        return out !== null;
      }
      const text = buf.toString('utf8');
      const redacted = redactor.redact(text);
      if (redacted !== text) {
        try {
          writeFileSync(path, redacted, 'utf8');
        } catch (err) {
          if (!enoent(err)) fail(path, err);
          return false;
        }
        return true;
      }
      return false;
    });
  }
  return { scrubbed, failures };

  function walk(dir: string, fn: (path: string) => boolean): number {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (enoent(err)) return 0; // no artifacts of this kind: nothing to do
      // A directory the pass could not read is NOT "no artifacts": collect it, continue with
      // the accessible siblings and the remaining artifact roots, and let the caller withhold
      // the stamp on the incomplete pass (#976).
      fail(dir, err);
      return 0;
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
