import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtensionUiResponse } from '../src/adapters/eventTranslation.ts';

test('buildExtensionUiResponse: value passthrough (issue #30)', () => {
  assert.deepEqual(buildExtensionUiResponse('req1', 'input', 'hello'), { id: 'req1', value: 'hello' });
  assert.deepEqual(buildExtensionUiResponse('req1', 'select', 42), { id: 'req1', value: 42 });
});

test('buildExtensionUiResponse: confirm coercion (issue #30)', () => {
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', true), { id: 'req1', confirmed: true });
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', 'yes'), { id: 'req1', confirmed: true });
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', 'n'), { id: 'req1', confirmed: false });
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', false), { id: 'req1', confirmed: false });
});

test('buildExtensionUiResponse: cancelled passthrough (issue #30)', () => {
  assert.deepEqual(buildExtensionUiResponse('req1', 'input', { cancelled: true }), { id: 'req1', cancelled: true });
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', { cancelled: true }), { id: 'req1', cancelled: true });
});

test('buildExtensionUiResponse: edge cases (issue #30)', () => {
  // { cancelled: 'true' } (string, not boolean) is NOT a cancel — passthrough as value
  assert.deepEqual(buildExtensionUiResponse('req1', 'input', { cancelled: 'true' }), { id: 'req1', value: { cancelled: 'true' } });
  // arrays and null pass through as values
  assert.deepEqual(buildExtensionUiResponse('req1', 'input', [1, 2]), { id: 'req1', value: [1, 2] });
  assert.deepEqual(buildExtensionUiResponse('req1', 'input', null), { id: 'req1', value: null });
  // confirm coercion is lowercase-only ('Y' -> false)
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', 'Y'), { id: 'req1', confirmed: false });
  assert.deepEqual(buildExtensionUiResponse('req1', 'confirm', 'y'), { id: 'req1', confirmed: true });
});
