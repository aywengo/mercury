// LocalAgentRegistry: loads LocalAgentConfig files from a directory and
// instantiates LocalAgentAdapter instances. Config files are JSON (zero
// dependencies); the YAML examples in docs/agent-adapters.md are the same
// structure. Directory is set via MERCURY_LOCAL_AGENTS_DIR (default ./local-agents).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './agentAdapter.ts';
import {
  LocalAgentAdapter,
  validateLocalAgentConfig,
  type LocalAgentAdapterOptions,
  type LocalAgentConfig,
} from './localAgentAdapter.ts';

export class LocalAgentRegistry {
  private adapters = new Map<string, AgentAdapter>();

  private dir: string;
  private opts: LocalAgentAdapterOptions;

  constructor(dir: string, opts: LocalAgentAdapterOptions = {}) {
    this.dir = dir;
    this.opts = opts;
  }

  /** Load all *.json config files from the directory. Missing dir = no agents. */
  load(): Record<string, AgentAdapter> {
    this.adapters.clear();
    if (!existsSync(this.dir)) return {};
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(this.dir, file);
      let cfg: LocalAgentConfig;
      try {
        cfg = JSON.parse(readFileSync(path, 'utf8')) as LocalAgentConfig;
      } catch (err) {
        throw new Error(`LocalAgentRegistry: failed to parse ${path}: ${(err as Error).message}`);
      }
      try {
        this.register(cfg);
      } catch (err) {
        throw new Error(`LocalAgentRegistry: invalid config ${path}: ${(err as Error).message}`);
      }
    }
    return this.all();
  }

  /** Register a config programmatically (also used by tests). */
  register(cfg: LocalAgentConfig): void {
    validateLocalAgentConfig(cfg);
    this.adapters.set(cfg.id, new LocalAgentAdapter(cfg, this.opts));
  }

  all(): Record<string, AgentAdapter> {
    return Object.fromEntries(this.adapters);
  }
}
