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
  env: Record<string, string>;
}

export interface SandboxManagerOptions {
  /** Explicit runtime override (MERCURY_SANDBOX_RUNTIME: docker|podman|none). */
  runtime?: string;
  /** Container image for the agent (MERCURY_SANDBOX_IMAGE). */
  image?: string;
}

const DEFAULT_IMAGE = 'node:22-bookworm-slim';

export class SandboxManager {
  private runtime: SandboxRuntime | null = null;
  private image: string;
  private probeDone = false;

  constructor(opts: SandboxManagerOptions = {}) {
    this.image = opts.image ?? process.env.MERCURY_SANDBOX_IMAGE ?? DEFAULT_IMAGE;
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
    if (limits.disk) args.push('--storage-opt', `size=${limits.disk}`);
    // Network policy.
    args.push('--network', networks.length === 0 ? 'none' : 'bridge');
    // Environment passthrough for the agent (API keys etc. are inherited by the
    // worker; the container needs the same env to talk to providers).
    args.push('--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    // Image + inner command.
    args.push(this.image, innerCmd, ...innerArgs);

    return { cmd: rt.path, args, env: {} };
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
