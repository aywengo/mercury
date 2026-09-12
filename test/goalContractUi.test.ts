/**
 * The dashboard half of issue #497. The API has always returned the contract; nothing rendered
 * it, so an operator could set five fields describing what "met" meant and never read them back.
 *
 * Two properties matter beyond "it appears": the markup must be escaped (contract text is
 * whoever-created-the-Run input flowing into innerHTML), and it must not imply a verdict.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalContractHtml, goalGatesHtml } from '../ui/app.js';

test('the contract renders every field the operator filled in', () => {
  const html = goalContractHtml({
    status: 'unmet',
    contract: {
      outcome: 'all tests pass',
      verification: 'npm test exits 0',
      constraints: 'no new dependencies',
      boundaries: 'do not touch the schema',
      stopWhen: 'two consecutive failures',
    },
  } as never);
  for (const text of ['all tests pass', 'npm test exits 0', 'no new dependencies',
                      'do not touch the schema', 'two consecutive failures']) {
    assert.ok(html.includes(text), `"${text}" was not rendered`);
  }
  assert.ok(html.startsWith('<dl class="goal-contract">'), 'expected a definition list');
});

test('no contract means no markup, so the row stays hidden', () => {
  for (const goal of [undefined, null, {}, { status: 'unmet' }, { status: 'unmet', contract: {} },
                      { status: 'unmet', contract: { outcome: '' } }]) {
    assert.equal(goalContractHtml(goal as never), '', `expected empty markup for ${JSON.stringify(goal)}`);
  }
});

test('contract text is escaped, because it is not trusted input', () => {
  const html = goalContractHtml({ status: 'unmet', contract: { outcome: '<img src=x onerror=alert(1)>' } } as never);
  assert.ok(!html.includes('<img'), 'raw tag reached innerHTML');
  assert.ok(html.includes('&lt;img'), 'the value was not escaped at all');
});

test('the contract does not borrow the gate markup or imply a verdict', () => {
  const goal = { status: 'complete', contract: { outcome: 'all tests pass', verification: 'npm test' } } as never;
  const html = goalContractHtml(goal);
  assert.ok(!html.includes('goal-gates'), 'contract reused the gate list markup');
  for (const mark of ['✓', '✔', 'PASS', 'passed']) {
    assert.ok(!html.includes(mark), `contract markup claimed a verdict with ${mark}`);
  }
});

test('gates and contract render independently of each other', () => {
  // A goal can carry either, both, or neither; neither renderer may swallow the other.
  const both = {
    status: 'active',
    contract: { outcome: 'ship it' },
    gates: [{ command: 'npm test', timeoutMs: 5000, maxRetries: 1 }],
  } as never;
  assert.ok(goalContractHtml(both).includes('ship it'));
  assert.ok(goalGatesHtml(both).includes('npm test'));
  const contractOnly = { status: 'active', contract: { outcome: 'ship it' } } as never;
  assert.equal(goalGatesHtml(contractOnly), '');
  const gatesOnly = { status: 'active', gates: [{ command: 'npm test', timeoutMs: 5000, maxRetries: 0 }] } as never;
  assert.equal(goalContractHtml(gatesOnly), '');
});
