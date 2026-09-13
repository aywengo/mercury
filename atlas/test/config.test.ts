import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAtlasConfig, isLoopback } from '../config.ts';

test('config: defaults', () => {
  const config = loadAtlasConfig({});
  
  assert.equal(config.dbPath, 'atlas.db');
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.port, 4100);
  assert.equal(config.tlsCert, null);
  assert.equal(config.tlsKey, null);
  assert.equal(config.adminToken, null);
  assert.equal(config.maxClaimBytes, 1024);
  assert.equal(config.maxDetailBytes, 4096);
  assert.equal(config.maxBatch, 500);
  assert.equal(config.logLevel, 'info');
});

test('config: isLoopback', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('localhost'));
  assert.ok(isLoopback('::1'));
  assert.ok(isLoopback('[::1]'));
  
  assert.ok(!isLoopback('0.0.0.0'));
  assert.ok(!isLoopback('192.168.1.1'));
  assert.ok(!isLoopback('github.com'));
});

test('config: TLS refusal on non-loopback without cert', () => {
  const env = {
    ATLAS_BIND_HOST: '0.0.0.0',
    ATLAS_PORT: '4100',
  };
  
  assert.throws(() => loadAtlasConfig(env), /refusing to bind/);
});

test('config: TLS allowed on non-loopback with cert and key', () => {
  const env = {
    ATLAS_BIND_HOST: '0.0.0.0',
    ATLAS_PORT: '4100',
    ATLAS_TLS_CERT: '/path/to/cert',
    ATLAS_TLS_KEY: '/path/to/key',
  };
  
  const config = loadAtlasConfig(env);
  assert.ok(config.tlsCert);
  assert.ok(config.tlsKey);
});

test('config: half a TLS configuration is rejected', () => {
  const env1 = {
    ATLAS_TLS_CERT: '/path/to/cert',
    // TLS_KEY is missing
  };
  
  assert.throws(() => loadAtlasConfig(env1), /both be set or both unset/);
  
  const env2 = {
    ATLAS_TLS_KEY: '/path/to/key',
    // TLS_CERT is missing
  };
  
  assert.throws(() => loadAtlasConfig(env2), /both be set or both unset/);
});

test('config: reader token parsing', () => {
  const env = {
    ATLAS_READER_TOKENS: 'token1:label1:proj1+proj2, token2:label2:proj1',
  };
  
  const config = loadAtlasConfig(env);
  assert.equal(config.readerTokens.length, 2);
  assert.equal(config.readerTokens[0]?.token, 'token1');
  assert.equal(config.readerTokens[0]?.label, 'label1');
  assert.deepEqual(config.readerTokens[0]?.projects, ['proj1', 'proj2']);
});

test('config: malformed reader tokens are skipped', () => {
  const env = {
    ATLAS_READER_TOKENS: 'good:label:proj1, bad-without-enough-colons, another-good:label2:proj2',
  };
  
  const config = loadAtlasConfig(env);
  // Should have 2 valid tokens
  assert.equal(config.readerTokens.length, 2);
});

test('config: secrets parsing', () => {
  const env = {
    ATLAS_SECRETS: 'secret1, secret2,  , secret3',
  };
  
  const config = loadAtlasConfig(env);
  // Empty entries should be filtered out
  assert.equal(config.secrets.length, 3);
  assert.deepEqual(config.secrets, ['secret1', 'secret2', 'secret3']);
});

test('config: port 0 is valid (ephemeral)', () => {
  const env = {
    ATLAS_PORT: '0',
  };
  
  const config = loadAtlasConfig(env);
  assert.equal(config.port, 0);
});

test('config: invalid port falls back to default', () => {
  const env1 = {
    ATLAS_PORT: 'not-a-number',
  };
  assert.equal(loadAtlasConfig(env1).port, 4100);
  
  const env2 = {
    ATLAS_PORT: '-1',
  };
  assert.equal(loadAtlasConfig(env2).port, 4100);
  
  const env3 = {
    ATLAS_PORT: '99999',
  };
  assert.equal(loadAtlasConfig(env3).port, 4100);
});

test('config: log level parsing', () => {
  assert.equal(loadAtlasConfig({ ATLAS_LOG_LEVEL: 'debug' }).logLevel, 'debug');
  assert.equal(loadAtlasConfig({ ATLAS_LOG_LEVEL: 'info' }).logLevel, 'info');
  assert.equal(loadAtlasConfig({ ATLAS_LOG_LEVEL: 'warn' }).logLevel, 'warn');
  assert.equal(loadAtlasConfig({ ATLAS_LOG_LEVEL: 'error' }).logLevel, 'error');
  assert.equal(loadAtlasConfig({ ATLAS_LOG_LEVEL: 'invalid' }).logLevel, 'info');
});
