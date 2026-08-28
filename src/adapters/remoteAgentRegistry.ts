// RemoteAgentRegistry: loads RemoteAgentConfig files from a directory and
// instantiates RemoteAgentAdapter instances. JSON config files (zero deps).
// Directory is set via MERCURY_REMOTE_AGENTS_DIR (default ./remote-agents).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './agentAdapter.ts';
import {
  RemoteAgentAdapter,
  validateRemoteAgentConfig,
  type RemoteAgentAdapterOptions,
  type RemoteAgentConfig,
} from './remoteAgentAdapter.ts';

export class RemoteAgentRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private dir: string;
  private opts: RemoteAgentAdapterOptions;

  constructor(dir: string, opts: RemoteAgentAdapterOptions = {}) {
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
      let cfg: RemoteAgentConfig;
      try {
        cfg = JSON.parse(readFileSync(path, 'utf8')) as RemoteAgentConfig;
      } catch (err) {
        throw new Error(`RemoteAgentRegistry: failed to parse ${path}: ${(err as Error).message}`);
      }
      try {
        this.register(cfg);
      } catch (err) {
        throw new Error(`RemoteAgentRegistry: invalid config ${path}: ${(err as Error).message}`);
      }
    }
    return this.all();
  }

  /** Register a config programmatically (also used by tests). */
  register(cfg: RemoteAgentConfig): void {
    validateRemoteAgentConfig(cfg);
    this.adapters.set(cfg.id, new RemoteAgentAdapter(cfg, this.opts));
  }

  all(): Record<string, AgentAdapter> {
    return Object.fromEntries(this.adapters);
  }
}
