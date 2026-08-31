// Sandboxed execution (Mercury.md roadmap #2).
//
// Enforces per-Run `resourceLimits` and `allowedNetworks` by running the agent
// inside a container (docker or podman). The workspace directory is mounted
// read-write so the agent can work on the repo; the container's stdin/stdout
// carry the RPC/daemon protocol unchanged, so the existing adapters work
// without modification.
//
// Policy:
//   - No constraints on the Run  -> no container (fast path, unchanged behavior).
//   - Constraints set, runtime available -> container with limits applied.
//   - Constraints set, no runtime -> run FAILS with a clear error (fail closed;
//     a run that asks for isolation must not silently run unsandboxed).
//
// Network policy (v1): `allowedNetworks: []` (or absent) -> --network none.
// A non-empty allowedNetworks list -> default bridge (egress filtering is a
// future refinement; the list is recorded in the run event log).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Run } from '../domain/types.ts';

const execFileP = promisify(execFile);

export interface SandboxRuntime {
  /** Binary name (docker or podman). */
  name: string;
  /** Full path to the binary, if resolvable. */
  path: string;
}

export interface SandboxCommand {
  cmd: string;
  args: string[];
  /**
   * ADVISORY ONLY, and currently always empty. Every caller (wrapForSandbox in the adapters)
   * destructures `{ cmd, args }` and drops this field, so the container's environment is
   * controlled exclusively by the `--env` flags in `args` -- not by anything set here.
   * Do not start relying on it without first fixing the six call sites.
   */
  env: Record<string, string>;
}

export interface SandboxManagerOptions {
  /** Explicit runtime override (MERCURY_SANDBOX_RUNTIME: docker|podman|none). */
  runtime?: string;
  /** Container image for the agent (MERCURY_SANDBOX_IMAGE). */
  image?: string;
  /**
   * Environment variables forwarded into the container (MERCURY_SANDBOX_ENV,
   * comma-separated). An empty string forwards nothing but PATH.
   */
  envAllowlist?: string[];
  /**
   * Whether the host's storage driver actually honours `--storage-opt size=`
   * (MERCURY_SANDBOX_DISK_LIMITS=true). Off by default -- see buildCommand.
   */
  diskLimitsSupported?: boolean;
}

const DEFAULT_IMAGE = 'node:22-bookworm-slim';

/**
 * Variables forwarded into the sandbox by default.
 *
 * Deliberately narrow. The container exists to run UNTRUSTED agents, so anything in here can
 * be read and abused by the code running inside it. The list is limited to model-inference
 * credentials for one reason: without them a sandboxed run cannot authenticate and dies on its
 * first model call (issue #56 -- the comment promised passthrough while the code forwarded only
 * PATH). Forwarding them means the container CAN spend the operator's inference budget, which
 * is a real trade and the reason this is an allowlist rather than a copy.
 *
 * Explicitly NOT forwarded, even though they are in the worker's environment:
 *   - MERCURY_* (admin tokens, API tokens, the database path, webhook URLs)
 *   - source control credentials (GH_TOKEN, GITHUB_TOKEN, git credentials)
 *   - cloud credentials broader than inference (AWS_*, GCP_*, AZURE_* beyond OpenAI)
 * Copying process.env wholesale would hand an untrusted agent the keys to the whole service.
 * Operators who need more set MERCURY_SANDBOX_ENV explicitly.
 */
const DEFAULT_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AWS_BEARER_TOKEN_BEDROCK',
];

/** Never forwarded regardless of configuration: these compromise Mercury itself. */
const NEVER_FORWARD = [/^MERCURY_/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^GIT_/, /^AWS_SECRET/, /^AWS_ACCESS/];

/**
 * Image requirements the sandbox depends on, and which nothing verifies (issue #56).
 * Kept next to the code that fails without them, because the failure mode is cryptic.
 */
export const IMAGE_REQUIREMENTS = `The sandbox image MUST provide:
  1. the agent binary the run's adapter invokes (for prime-agent, an image containing it on
     PATH -- the default node:22-bookworm-slim does NOT, so sandboxed prime-agent runs fail
     with "executable not found" rather than anything sandbox-related);
  2. a compatible Node runtime for that binary;
  3. git, because the workspace mount is committed from inside the container.
Build a purpose-built image and point MERCURY_SANDBOX_IMAGE at it.`;

export class SandboxManager {
  private runtime: SandboxRuntime | null = null;
  private image: string;
  private envAllowlist: string[];
  private diskLimitsSupported: boolean;
  private probeDone = false;

  constructor(opts: SandboxManagerOptions = {}) {
    this.image = opts.image ?? process.env.MERCURY_SANDBOX_IMAGE ?? DEFAULT_IMAGE;
    // An explicitly empty string means "forward nothing"; only an UNSET variable falls back to
    // the default list. `?? ` alone cannot express that, and operators narrowing the list to
    // nothing is the security-relevant case.
    this.envAllowlist =
      opts.envAllowlist ??
      (process.env.MERCURY_SANDBOX_ENV !== undefined
        ? process.env.MERCURY_SANDBOX_ENV.split(',').map((v) => v.trim()).filter(Boolean)
        : [...DEFAULT_ENV_ALLOWLIST]);
    this.diskLimitsSupported =
      opts.diskLimitsSupported ?? process.env.MERCURY_SANDBOX_DISK_LIMITS === 'true';
    const explicit = opts.runtime ?? process.env.MERCURY_SANDBOX_RUNTIME;
    if (explicit && explicit !== 'none') {
      // Trust the explicit choice; probe lazily on first use.
      this.runtime = { name: explicit, path: explicit };
    }
  }

  /** True when a container runtime is configured and available. */
  async available(): Promise<boolean> {
    if (!this.runtime) return false;
    if (this.probeDone) return true;
    try {
      await execFileP(this.runtime.path, ['--version'], { timeout: 5_000 });
      this.probeDone = true;
      return true;
    } catch {
      this.runtime = null;
      return false;
    }
  }

  /** True when the run requests isolation (constraints that need a container). */
  requiresSandbox(run: Run): boolean {
    const c = run.constraints;
    // `allowedNetworks` present (even as an empty array) requests isolation:
    // empty = no network (--network none), non-empty = bridge. Only an absent
    // field means "no network policy" -> no container.
    return Boolean(c.resourceLimits || c.allowedNetworks !== undefined);
  }

  /**
   * Build the wrapped command that runs `innerCmd innerArgs` inside a container.
   * The workspace is mounted at the same absolute path inside the container so
   * paths in the RPC session file / daemon socket stay valid.
   */
  buildCommand(run: Run, innerCmd: string, innerArgs: string[]): SandboxCommand {
    const rt = this.runtime;
    if (!rt) throw new Error('SandboxManager.buildCommand called without a runtime');
    const ws = run.workspacePath;
    if (!ws) throw new Error('Sandbox requires a workspace path');
    const limits = run.constraints.resourceLimits ?? {};
    const networks = run.constraints.allowedNetworks ?? [];

    const args: string[] = ['run', '--rm', '-i', '--name', `mercury-${run.id.slice(0, 12)}`];
    // Workspace mount (read-write; the agent commits from inside).
    args.push('-v', `${ws}:${ws}`);
    // Resource limits.
    if (limits.cpu) args.push('--cpus', limits.cpu);
    if (limits.memory) args.push('--memory', limits.memory);
    if (limits.disk) {
      // `--storage-opt size=` is only honoured by a few storage drivers (overlay2 on xfs,
      // btrfs, zfs, devicemapper). On the common overlay2-on-ext4 host -- the default docker
      // install on most Debian/Ubuntu boxes -- docker rejects the flag outright and the run
      // dies before the agent starts, with an error that mentions neither disk nor Mercury.
      // Rather than emit a flag that usually breaks, require the operator to say the host
      // supports it, and fail with something actionable when they have not (issue #56).
      if (!this.diskLimitsSupported) {
        throw new Error(
          `Run requests a disk limit (${limits.disk}) but the host storage driver is not declared `
            + 'to support container size limits. `docker run --storage-opt size=` only works on '
            + 'overlay2-on-xfs, btrfs, zfs or devicemapper; on the default overlay2-on-ext4 install '
            + 'docker rejects the flag and the run fails before the agent starts. Set '
            + 'MERCURY_SANDBOX_DISK_LIMITS=true once the host is known to support it, or drop '
            + 'resourceLimits.disk from the run.',
        );
      }
      args.push('--storage-opt', `size=${limits.disk}`);
    }
    // Network policy.
    args.push('--network', networks.length === 0 ? 'none' : 'bridge');
    // Environment passthrough (issue #56). This used to promise API-key inheritance in a
    // comment while forwarding only PATH, so every sandboxed run failed at its first model
    // call with an authentication error that looked like a provider problem.
    //
    // Allowlisted, never a copy of process.env: the container runs untrusted agents, and the
    // worker's environment holds MERCURY_ADMIN_TOKEN, the API tokens and the database path.
    args.push('--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    for (const [key, value] of Object.entries(this.forwardedEnv())) {
      args.push('--env', `${key}=${value}`);
    }
    // Image + inner command.
    args.push(this.image, innerCmd, ...innerArgs);

    return { cmd: rt.path, args, env: {} };
  }

  /**
   * The allowlisted subset of the worker's environment to forward into the container.
   * Only variables that are actually set are forwarded; a name in the allowlist that is
   * unset contributes nothing.
   */
  private forwardedEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of this.envAllowlist) {
      if (NEVER_FORWARD.some((re) => re.test(key))) continue;
      const value = process.env[key];
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** Human-readable description of the sandbox policy for a run (logging/events). */
  describe(run: Run): string {
    const limits = run.constraints.resourceLimits ?? {};
    const networks = run.constraints.allowedNetworks ?? [];
    const parts: string[] = [];
    if (limits.cpu) parts.push(`cpu=${limits.cpu}`);
    if (limits.memory) parts.push(`mem=${limits.memory}`);
    if (limits.disk) parts.push(`disk=${limits.disk}`);
    if (networks.length === 0) parts.push('net=none');
    else parts.push(`net=${networks.join(',')}`);
    return parts.length ? parts.join(' ') : 'none';
  }
}

/** Resolve the sandbox runtime binary path (used by tests and CLI). */
export async function detectRuntime(): Promise<SandboxRuntime | null> {
  for (const name of ['docker', 'podman']) {
    try {
      const { stdout } = await execFileP(name, ['--version'], { timeout: 5_000 });
      if (stdout) return { name, path: name };
    } catch {
      // try next
    }
  }
  return null;
}
