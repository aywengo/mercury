// Shared RPC/daemon event translation -> Mercury domain events.
// Used by PrimeAgentAdapter, RpcAgentAdapter and DaemonAgentAdapter.
//
// Event mapping (agent protocol -> Mercury):
//   message_update (text_delta)  -> accumulated; emitted as agent.message on message_end
//   tool_execution_start         -> tool.started
//   tool_execution_end           -> tool.completed | tool.failed
//   extension_ui_request (dialog)-> input.required (select/confirm/input/editor)
//   agent_end                    -> run completion (exit code 0)
//   compaction_* / auto_retry_*  -> agent.message (informational)

import type { AgentEvent } from '../domain/types.ts';

export interface RpcEvent {
  type: string;
  id?: string;
  requestId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  method?: string;
  title?: string;
  message?: string;
  options?: unknown;
  placeholder?: string;
  prefill?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
}

export const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the extension_ui_response payload shared by all agent adapters.
 * Shape: { id, value } / { id, confirmed } / { id, cancelled } (issue #30).
 */
export function buildExtensionUiResponse(
  requestId: string,
  method: string,
  value: unknown,
): Record<string, unknown> {
  if (isRecord(value) && value.cancelled === true) {
    return { id: requestId, cancelled: true };
  }
  if (method === 'confirm') {
    return { id: requestId, confirmed: value === true || value === 'true' || value === 'yes' || value === 'y' };
  }
  return { id: requestId, value };
}

/** Stateful translator: buffers text deltas and tracks the pending dialog request. */
export class EventTranslator {
  private messageBuf = '';
  private pendingInput: { requestId: string; method: string } | null = null;

  /** Translate one raw agent event into zero or more Mercury events. */
  translate(ev: RpcEvent): AgentEvent[] {
    switch (ev.type) {
      case 'message_update': {
        const delta = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
          this.messageBuf += delta.delta;
        }
        return [];
      }
      case 'message_end': {
        const text = this.messageBuf.trim();
        this.messageBuf = '';
        if (!text) return [];
        return [{ type: 'agent.message', payload: { text } }];
      }
      case 'tool_execution_start': {
        return [{
          type: 'tool.started',
          payload: { tool: ev.toolName ?? 'unknown', args: ev.args ?? {} },
        }];
      }
      case 'tool_execution_end': {
        const tool = ev.toolName ?? 'unknown';
        if (ev.isError === true) {
          return [{ type: 'tool.failed', payload: { tool, error: summarizeResult(ev.result) } }];
        }
        return [{ type: 'tool.completed', payload: { tool } }];
      }
      case 'extension_ui_request': {
        const method = typeof ev.method === 'string' ? ev.method : '';
        if (!DIALOG_METHODS.has(method)) return []; // notify/setStatus/etc: fire-and-forget
        const requestId = typeof ev.id === 'string' ? ev.id : '';
        this.pendingInput = { requestId, method };
        return [{
          type: 'input.required',
          payload: {
            requestId,
            method,
            title: ev.title,
            message: ev.message,
            options: ev.options,
            placeholder: ev.placeholder,
            prefill: ev.prefill,
          },
        }];
      }
      case 'agent_end': {
        return [{ type: 'agent.end', payload: { code: ev.result ?? 0 } }];
      }
      case 'compaction_started':
      case 'compaction_completed':
      case 'auto_retry_started':
      case 'auto_retry_completed': {
        return [{ type: 'agent.message', payload: { text: `[agent] ${ev.type}` } }];
      }
      default:
        return [];
    }
  }

  /** The pending dialog request id + method, if any (cleared on sendInput). */
  get pending(): { requestId: string; method: string } | null {
    return this.pendingInput;
  }

  clearPending(): void {
    this.pendingInput = null;
  }
}

function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  if (typeof result === 'string') return result.slice(0, 500);
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return String(result).slice(0, 500);
  }
}
