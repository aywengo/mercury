// RpcAgentRegistry: loads RpcAgentConfig files from a directory and instantiates
// RpcAgentAdapter instances. JSON config files (zero deps). Directory is set via
// MERCURY_RPC_AGENTS_DIR (default ./rpc-agents).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from './agentAdapter.ts';
import {
  RpcAgentAdapter,
  validateRpcAgentConfig,
  type RpcAgentAdapterOptions,
  type RpcAgentConfig,
} from './rpcAgentAdapter.ts';

export class RpcAgentRegistry {
  private adapters = new Map<string, AgentAdapter>();
  private dir: string;
  private opts: RpcAgentAdapterOptions;

  constructor(dir: string, opts: RpcAgentAdapterOptions = {}) {
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
      let cfg: RpcAgentConfig;
      try {
        cfg = JSON.parse(readFileSync(path, 'utf8')) as RpcAgentConfig;
      } catch (err) {
        throw new Error(`RpcAgentRegistry: failed to parse ${path}: ${(err as Error).message}`);
      }
      try {
        this.register(cfg);
      } catch (err) {
        throw new Error(`RpcAgentRegistry: invalid config ${path}: ${(err as Error).message}`);
      }
    }
    return this.all();
  }

  /** Register a config programmatically (also used by tests). */
  register(cfg: RpcAgentConfig): void {
    validateRpcAgentConfig(cfg);
    this.adapters.set(cfg.id, new RpcAgentAdapter(cfg, this.opts));
  }

  all(): Record<string, AgentAdapter> {
    return Object.fromEntries(this.adapters);
  }
}
