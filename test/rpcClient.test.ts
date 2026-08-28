// RpcClient tests against the mock prime-agent RPC server (real protocol).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RpcClient } from '../src/adapters/rpc/rpcClient.ts';

const MOCK = join(import.meta.dirname, 'fixtures', 'mock-prime-agent-rpc.mjs');

function makeClient(env: Record<string, string> = {}, args: string[] = []): RpcClient {
  return new RpcClient({
    cmd: MOCK,
    args,
    env,
    readyDelayMs: 50,
  });
}

test('get_state round trip', async () => {
  const client = makeClient({ MOCK_RPC_SESSION_FILE: '/tmp/sess.jsonl' });
  await client.start();
  try {
    const resp = await client.getState();
    assert.equal(resp.success, true);
    assert.equal(resp.data?.sessionFile, '/tmp/sess.jsonl');
  } finally {
    await client.stop();
  }
});

test('prompt streams events; waitForIdle resolves on agent_end', async () => {
  const client = makeClient();
  await client.start();
  const events: string[] = [];
  client.onEvent((ev) => events.push(ev.type));
  try {
    await client.prompt('do something');
    await client.waitForIdle(5_000);
    assert.ok(events.includes('agent_start'));
    assert.ok(events.includes('tool_execution_start'));
    assert.ok(events.includes('tool_execution_end'));
    assert.ok(events.includes('agent_end'));
  } finally {
    await client.stop();
  }
});

test('extension_ui_request/response round trip', async () => {
  const client = makeClient({ MOCK_RPC_MODE: 'input' });
  await client.start();
  const events: string[] = [];
  client.onEvent((ev) => events.push(ev.type));
  // Subscribe BEFORE prompt: the mock writes the prompt response and all events
  // in one stdout chunk, so a listener attached after prompt() resolves would
  // miss extension_ui_request entirely (and hang forever).
  const uiRequest = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('extension_ui_request never arrived')), 5_000);
    const unsub = client.onEvent((ev) => {
      if (ev.type === 'extension_ui_request') {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
  try {
    await client.prompt('need input');
    await uiRequest;
    client.sendExtensionUiResponse({ id: 'ui-1', value: 'hello' });
    await client.waitForIdle(5_000);
    assert.ok(events.includes('agent_end'));
  } finally {
    await client.stop();
  }
});

test('send times out when the server never responds', async () => {
  const client = makeClient({ MOCK_RPC_MODE: 'ignore' });
  await client.start();
  try {
    await assert.rejects(
      () => client.send({ type: 'get_state' }, 200),
      /Timeout waiting for response/,
    );
  } finally {
    await client.stop();
  }
});

test('start rejects when the command does not exist', async () => {
  const client = new RpcClient({ cmd: '/nonexistent/prime-agent', readyDelayMs: 50 });
  await assert.rejects(() => client.start());
});

test('abort command round trip', async () => {
  const client = makeClient();
  await client.start();
  try {
    const resp = await client.abort();
    assert.equal(resp.success, true);
  } finally {
    await client.stop();
  }
});

test('stop is idempotent', async () => {
  const client = makeClient();
  await client.start();
  await client.stop();
  await client.stop(); // must not throw
});
