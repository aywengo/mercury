import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ATLAS_VERSION, ATLAS_PRODUCT } from '../version.ts';

const ATLAS_DIR = resolve(import.meta.dirname, '..');

test('version: ATLAS_VERSION matches atlas/package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ATLAS_DIR, 'package.json'), 'utf8')) as { version: string };
  assert.equal(ATLAS_VERSION, pkg.version);
});

test('version: ATLAS_PRODUCT equals package.json bin key', () => {
  const pkg = JSON.parse(readFileSync(join(ATLAS_DIR, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  const binKey = Object.keys(pkg.bin)[0];
  assert.equal(ATLAS_PRODUCT, binKey);
});

test('version: ATLAS_PRODUCT is "atlas"', () => {
  assert.equal(ATLAS_PRODUCT, 'atlas');
});
