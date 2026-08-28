// Typed client for prime-agent RPC mode (prime-agent --mode rpc).
//
// RPC mode is the language-agnostic programmatic interface of PrimeAgent:
// strict JSONL commands on stdin, responses + events on stdout. This client
// mirrors the reference implementation shipped in prime-agent
// (dist/modes/rpc/rpc-client.ts) with the lifecycle handling Mercury needs:
// spawn, id-correlated request/response, event dispatch, stderr capture,
// cooperative abort and forceful stop.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { attachJsonlLineReader, serializeJsonLine } from './jsonl.ts';

export interface RpcCommand {
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse<T = unknown> {
  id: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface RpcSessionState {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  model?: unknown;
  thinkingLevel?: string;
  messageCount?: number;
  [key: string]: unknown;
}

export interface RpcClientOptions {
  /** Command to spawn (e.g. "prime-agent"). */
  cmd: string;
  /** Extra args appended after --mode rpc. */
  args?: string[];
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Called for each stderr chunk (for logging). */
  onStderr?: (chunk: string) => void;
  /** Startup readiness delay before declaring the process healthy. */
  readyDelayMs?: number;
  /** Flag that selects the mode (default "--mode"). */
  modeFlag?: string;
  /** Mode value (default "rpc"). */
  modeValue?: string;
}

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
};

const DEFAULT_READY_DELAY_MS = 150;
const STOP_GRACE_MS = 1_000;

export class RpcClient {
  private opts: RpcClientOptions;
  private process: ChildProcessWithoutNullStreams | null = null;
  private stopReadingStdout: (() => void) | null = null;
  private listeners = new Set<(event: RpcEvent) => void>();
  private exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private stderrBuf = '';
  private spawnError: Error | null = null;
  private idleSeen = false;

  constructor(opts: RpcClientOptions) {
    this.opts = opts;
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.spawnError;
  }

  getStderr(): string {
    return this.stderrBuf;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Spawn the RPC process and wait until it is ready (or failed to start). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.process) {
        reject(new Error('Client already started'));
        return;
      }
      const args = [this.opts.modeFlag ?? '--mode', this.opts.modeValue ?? 'rpc', ...(this.opts.args ?? [])];
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.opts.cmd, args, {
          cwd: this.opts.cwd,
          env: { ...process.env, ...this.opts.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.spawnError = err instanceof Error ? err : new Error(String(err));
        reject(this.spawnError);
        return;
      }
      this.process = child;

      let settled = false;

      child.on('error', (err) => {
        // Spawn failure (e.g. ENOENT): reject start(); do NOT emit exit here —
        // the caller's start() catch owns the failure path (exit code 127).
        this.spawnError = err;
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      child.on('close', (code, signal) => {
        this.emitExit(code, signal);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.stderrBuf += text;
        this.opts.onStderr?.(text);
      });

      this.stopReadingStdout = attachJsonlLineReader(child.stdout, (line) => {
        this.handleLine(line);
      });

      const readyDelayMs = this.opts.readyDelayMs ?? DEFAULT_READY_DELAY_MS;
      setTimeout(() => {
        if (settled) return;
        if (child.exitCode !== null) {
          settled = true;
          reject(new Error(`Agent process exited immediately with code ${child.exitCode}. Stderr: ${this.stderrBuf}`));
          return;
        }
        settled = true;
        resolve();
      }, readyDelayMs);
    });
  }

  /** Stop the RPC process: SIGTERM, then SIGKILL after a short grace period. */
  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.stopReadingStdout?.();
    this.stopReadingStdout = null;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.process = null;
    this.pending.clear();
  }

  /** Send a command and await its correlated response. */
  send<T = unknown>(command: RpcCommand, timeoutMs = 30_000): Promise<RpcResponse<T>> {
    if (!this.process?.stdin || this.spawnError) {
      throw new Error(`Client not started (${this.spawnError?.message ?? 'no process'})`);
    }
    const id = `req_${++this.requestId}`;
    const full: RpcCommand = { ...command, id };
    return new Promise<RpcResponse<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderrBuf}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response as RpcResponse<T>);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.process!.stdin!.write(serializeJsonLine(full));
    });
  }

  /** Send a prompt; resolves when accepted/queued (events stream afterwards). */
  prompt(message: string, timeoutMs = 30_000): Promise<RpcResponse> {
    return this.send({ type: 'prompt', message }, timeoutMs);
  }

  /** Abort the current agent operation (cooperative). */
  abort(timeoutMs = 5_000): Promise<RpcResponse> {
    return this.send({ type: 'abort' }, timeoutMs);
  }

  getState(timeoutMs = 10_000): Promise<RpcResponse<RpcSessionState>> {
    return this.send({ type: 'get_state' }, timeoutMs);
  }

  getMessages(timeoutMs = 10_000): Promise<RpcResponse<{ messages: unknown[] }>> {
    return this.send({ type: 'get_messages' }, timeoutMs);
  }

  getSessionStats(timeoutMs = 10_000): Promise<RpcResponse<Record<string, unknown>>> {
    return this.send({ type: 'get_session_stats' }, timeoutMs);
  }

  /**
   * Resolve a pending extension UI dialog (select/confirm/input/editor).
   * The RPC server treats this as fire-and-forget: it resolves the dialog and
   * emits NO response, so we write the line directly without awaiting.
   */
  sendExtensionUiResponse(response: Record<string, unknown>): void {
    if (!this.process?.stdin || this.spawnError) {
      throw new Error(`Client not started (${this.spawnError?.message ?? 'no process'})`);
    }
    this.process.stdin.write(serializeJsonLine({ type: 'extension_ui_response', ...response }));
  }

  /** Resolves when agent_end is received (agent finished processing). */
  waitForIdle(timeoutMs = 60_000): Promise<void> {
    if (this.idleSeen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderrBuf}`));
      }, timeoutMs);
      const unsubscribe = this.onEvent((event) => {
        if (event.type === 'agent_end') {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  private handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return; // non-JSON lines are ignored (raw output is not part of RPC mode)
    }
    if (typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    if (record.type === 'response' && typeof record.id === 'string' && this.pending.has(record.id)) {
      const pending = this.pending.get(record.id)!;
      this.pending.delete(record.id);
      pending.resolve(record as unknown as RpcResponse);
      return;
    }
    if (record.type === 'agent_end') this.idleSeen = true;
    for (const listener of [...this.listeners]) {
      try {
        listener(record as RpcEvent);
      } catch {
        // listener failures must not block other subscribers
      }
    }
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of [...this.exitListeners]) {
      try {
        listener(code, signal);
      } catch {
        // ignore
      }
    }
  }
}
