// Deterministic fake agent for tests (Mercury.md section 29).
// Emits a scripted event sequence; supports input requests, cancellation and failure.

import type { AgentAdapter, AgentEvent, AgentExit, AgentHandle, AgentInput, RunContext } from '../domain/types.ts';

export interface FakeStep {
  event?: { type: string; payload?: unknown };
  delayMs?: number;
  input?: { question: string; choices?: string[] };
  fail?: boolean;
  /**
   * Exit to report instead of the scripted default, merged over
   * `{ code: 1, signal: null, reason: 'failed' }`. Lets a test exercise how the worker treats an
   * adapter's own attribution (`errorKind`) without inventing a whole adapter for it.
   */
  exit?: Partial<AgentExit>;
}

export interface FakeAgentConfig {
  script: FakeStep[];
}

export class FakeAgentAdapter implements AgentAdapter {
  private cancelled = new Set<string>();
  private inputs = new Map<string, AgentInput[]>();
  private inputWaiters = new Map<string, (input: AgentInput) => void>();
  private cfg: FakeAgentConfig;

  constructor(cfg: FakeAgentConfig) {
    this.cfg = cfg;
  }

  async start(context: RunContext): Promise<AgentHandle> {
    const runId = context.run.id;
    this.cancelled.delete(runId);
    this.inputs.set(runId, []);
    const script = [...this.cfg.script];

    // Single producer (script runner) -> queue -> single consumer (worker's drive loop).
    const queue: AgentEvent[] = [];
    const waiters: ((ev: AgentEvent) => void)[] = [];
    let done = false;
    let exit: AgentExit | null = null;

    const push = (ev: AgentEvent): void => {
      const waiter = waiters.shift();
      if (waiter) waiter(ev);
      else queue.push(ev);
    };

    const runScript = async (): Promise<void> => {
      for (const step of script) {
        if (this.cancelled.has(runId)) return;
        if (step.delayMs) await sleep(step.delayMs);
        if (this.cancelled.has(runId)) return;
        if (step.input) {
          push({ type: 'input.required', payload: step.input });
          const input = await this.waitForInput(runId);
          if (this.cancelled.has(runId)) return;
          push({ type: 'input.received', payload: input.value });
        }
        if (step.event) push({ type: step.event.type, payload: step.event.payload ?? {} });
      }
    };

    const exitPromise = (async (): Promise<AgentExit> => {
      await runScript();
      if (this.cancelled.has(runId)) {
        exit = { code: 130, signal: 'SIGTERM', reason: 'cancelled' };
      } else if (script.some((s) => s.fail)) {
        exit = { code: 1, signal: null, reason: 'failed' };
      } else if (script.some((s) => s.exit)) {
        exit = { code: 1, signal: null, reason: 'failed', ...script.find((s) => s.exit)!.exit };
      } else {
        exit = { code: 0, signal: null, reason: 'completed' };
      }
      done = true;
      for (const waiter of waiters.splice(0)) waiter({ type: 'agent.message', payload: { text: '[agent exited]' } });
      return exit;
    })();

    async function* events(): AsyncGenerator<AgentEvent> {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else if (done) return;
        else yield await new Promise<AgentEvent>((r) => waiters.push(r));
      }
    }

    return {
      runId,
      events: events(),
      exit: exitPromise,
      terminate: async () => {
        this.cancelled.add(runId);
        this.resolveInputWaiters(runId);
      },
    };
  }

  async sendInput(runId: string, input: AgentInput): Promise<void> {
    const queue = this.inputs.get(runId) ?? [];
    queue.push(input);
    this.inputs.set(runId, queue);
    const waiter = this.inputWaiters.get(runId);
    if (waiter) {
      this.inputWaiters.delete(runId);
      waiter(input);
    }
  }

  /** Release per-run state once the worker is finished with the run (issues #62, #97). */
  dispose(runId: string): void {
    this.inputs.delete(runId);
    this.inputWaiters.delete(runId);
    this.cancelled.delete(runId);
  }

  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    this.resolveInputWaiters(runId);
  }

  private waitForInput(runId: string): Promise<AgentInput> {
    const queue = this.inputs.get(runId) ?? [];
    const existing = queue.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.inputWaiters.set(runId, resolve);
    });
  }

  private resolveInputWaiters(runId: string): void {
    const waiter = this.inputWaiters.get(runId);
    if (waiter) {
      this.inputWaiters.delete(runId);
      waiter({ value: { cancelled: true }, at: new Date().toISOString() });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
