/**
 * Bounded harness version probe (docs/goals.md section 13.3).
 *
 * Three rules this file exists to enforce:
 *
 * 1. **It never throws.** A missing binary, a binary that writes to stderr, a binary
 *    that hangs, and a binary whose output nobody taught the parser about are all
 *    ordinary conditions in a deployment. Startup calls this detached; a throw would
 *    turn "we cannot tell the version" into "Mercury does not start".
 * 2. **It is bounded.** A hung probe is indistinguishable from a slow one, and an
 *    unbounded wait here blocks capability reporting for every agent.
 * 3. **The raw output is kept even on failure.** When a version is reported wrong, the
 *    raw string is the only evidence of why.
 */

import { execFile } from 'node:child_process';
import { numericCore } from '../domain/goalSupport.ts';
import type { AgentVersionInfo } from '../domain/types.ts';

export interface VersionProbe {
  /** Resolved command path, NOT a bare name on PATH. Two installs of the same harness
   *  on one machine answer differently depending on PATH order, and Mercury must report
   *  the version of the binary it actually execs (docs/goals.md 13.3). */
  cmd: string;
  /** default `['--version']`. */
  args?: string[];
  /** default 5000ms. */
  timeoutMs?: number;
  /** Extract the version from combined output. Defaults to the leading dotted number. */
  parse?: (raw: string) => string | null;
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Default extraction: the leading dotted-decimal run. Adapters whose harness prints
 *  something else own a parser rather than bending this one. */
export function defaultVersionParse(raw: string): string | null {
  const core = numericCore(raw);
  return core.length > 0 ? core.join('.') : null;
}

export async function probeVersion(p: VersionProbe): Promise<AgentVersionInfo> {
  const args = p.args ?? ['--version'];
  const timeoutMs = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const raw = await new Promise<{ out: string | null; error?: string }>((resolve) => {
    execFile(p.cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit is not automatically a failure: several CLIs print their
        // version to stderr, or exit non-zero while doing so. Take the output and let
        // the parser decide; only a missing binary or a timeout is reported as such.
        const combined = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        // `killed`/`signal` live on the error object at runtime but are not in the
        // declared callback type, so narrow once here rather than at each use.
        const failure = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
        // `killed` is set when the timeout fired. `signal` must be tested as a string,
        // NOT against undefined: on a plain non-zero exit Node sets signal to NULL, and
        // `null !== undefined` is true, which would classify every CLI that exits non-zero
        // from --version as a timeout. That is not a hypothetical -- it is how the first
        // version of this check failed its own test.
        const timedOut = failure !== null && (failure.killed === true || typeof failure.signal === 'string');
        if (timedOut) {
          resolve({ out: null, error: `probe timed out after ${timeoutMs}ms: ${p.cmd} ${args.join(' ')}` });
          return;
        }
        if (failure && combined === '') {
          resolve({
            out: null,
            error: failure.code === 'ENOENT' ? `command not found: ${p.cmd}` : `probe failed: ${failure.message}`,
          });
          return;
        }
        resolve({ out: combined });
      });
  });

  if (raw.out === null) return { version: null, raw: null, error: raw.error };
  const version = (p.parse ?? defaultVersionParse)(raw.out);
  if (!version) return { version: null, raw: raw.out, error: `unparsable version output from ${p.cmd}` };
  return { version, raw: raw.out.split('\n')[0]?.slice(0, 200) ?? '' };
}
