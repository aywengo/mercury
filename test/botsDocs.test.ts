// The operator docs' testable claims (docs/bots.md, docs/status.md; B4, #915 acceptance 4).
//
// Same discipline as test/crewDocsStatus.test.ts: assert the claims that can be checked against the
// tree, so a command rename, a schema change or a shipped milestone cannot leave the operator guide
// pointing at behaviour that no longer exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLAST_RADIUS_SENTENCE } from '../src/host/bots/provision.ts';

const ROOT = join(import.meta.dirname, '..');
const BOTS = readFileSync(join(ROOT, 'docs', 'bots.md'), 'utf8');
const STATUS = readFileSync(join(ROOT, 'docs', 'status.md'), 'utf8');
const DESIGN = readFileSync(join(ROOT, 'docs', 'dispatcher-bot-design.md'), 'utf8');
const CLI = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');
const CONFIG = readFileSync(join(ROOT, 'src', 'host', 'bots', 'config.ts'), 'utf8');
const DOCTOR = readFileSync(join(ROOT, 'src', 'host', 'doctor.ts'), 'utf8');
const SETUP = readFileSync(join(ROOT, 'src', 'host', 'setup.ts'), 'utf8');

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

test('docs/bots.md exists, is linked from status.md, and links the bounds review', () => {
  assert.ok(BOTS.startsWith('# Dispatcher bots'), 'docs/bots.md must open as the operator guide');
  assert.ok(STATUS.includes('bots.md'), 'docs/status.md must point at docs/bots.md');
  assert.ok(BOTS.includes('bots-bounds-review.md'), 'the operator guide must link the §14 review');
});

test('every documented bot command exists in the CLI', () => {
  const subs = [...BOTS.matchAll(/mercury host bot ([a-z]+)/g)].map((m) => m[1]!);
  assert.ok(subs.length >= 5, `expected the documented bot commands, found ${subs.join(', ')}`);
  for (const sub of new Set(subs)) {
    assert.ok(CLI.includes(`args[0] === 'bot' && args[1] === '${sub}'`),
      `docs/bots.md documents 'mercury host bot ${sub}', but src/cli.ts has no such subcommand`);
  }
});

test('the documented setup and doctor integration is wired', () => {
  assert.ok(SETUP.includes('planBotProvision'), 'the wizard must plan the bots step');
  assert.ok(SETUP.includes('botEnabled'), 'the wizard answers must carry the bots step');
  assert.ok(DOCTOR.includes('checkBots'), 'host doctor must run the bots section');
  assert.ok(BOTS.includes('mercury host setup'), 'the guide must name the one-command install');
});

test('the scheduler-only status is true: the schema still refuses triggers and brain', () => {
  assert.match(CONFIG, /refuse\(path, 'triggers', 'reserved: triggers are not supported before B2'\)/);
  assert.match(CONFIG, /refuse\(path, 'brain', 'reserved: the brain is not supported before B3'\)/);
  assert.match(BOTS, /B2.*#907–#909/s, 'the guide must name the B2 issues it defers to');
  assert.match(BOTS, /B3.*#912/s, 'the guide must name the B3 issue it defers to');
  assert.ok(BOTS.includes('scheduler-only'), 'the guide must say the shipped bot is scheduler-only');
});

test('the two token copies the guide documents are the two the code reads', () => {
  assert.ok(BOTS.includes('bot-credentials.json'));
  assert.ok(BOTS.includes('MERCURY_API_TOKENS'));
  assert.ok(readFileSync(join(ROOT, 'src', 'host', 'bots', 'credentials.ts'), 'utf8').includes('bot-credentials.json'));
  assert.ok(CONFIG.includes('MERCURY_API_TOKENS') || SETUP.includes('MERCURY_API_TOKENS'));
});

test('the §8.5 blast-radius sentence in the design and the guide is one sentence', () => {
  // The design wraps its prose; compare on normalized whitespace so a re-flow is not drift.
  assert.ok(flat(DESIGN).includes(flat(BLAST_RADIUS_SENTENCE)),
    'the wizard and the guide quote this sentence; it must stay the design\'s sentence, not a paraphrase');
  assert.ok(flat(BOTS).includes(flat(BLAST_RADIUS_SENTENCE)),
    'the guide quotes the sentence; it must stay the design\'s sentence');
});

test('status.md says B4 shipped and still lists B2/B3 as the next step', () => {
  const row = STATUS.split('\n').find((l) => l.startsWith('| **Dispatcher bots**'));
  assert.ok(row, 'status.md lost the Dispatcher bots row');
  assert.match(row!, /B4 setup integration shipped/);
  assert.doesNotMatch(row!, /B4 setup integration \(#915\) proposed/);
  assert.match(row!, /B2 triggers B2-1\.\.B2-3 \(#907–#909\)/);
  assert.match(row!, /B3 brain \(#912\)/);
  assert.match(STATUS, /3\. \*\*Done:\*\* B4 \(#915\)/, 'the critical path must mark B4 done');
  assert.match(STATUS, /### Dispatcher bots B2–B3/);
  assert.doesNotMatch(STATUS, /### Dispatcher bots B2–B4/);
});

test('the design roadmap marks B4 shipped and drops the "drafted only" gate', () => {
  assert.match(DESIGN, /### Milestone B4 — setup integration and hardening — shipped \(#915/);
  // Scope to B4: B2 and B3 are still drafted and keep their own gate sentence.
  const b4 = DESIGN.slice(DESIGN.indexOf('### Milestone B4'), DESIGN.indexOf('## 19. Revision history'));
  assert.doesNotMatch(b4, /Drafted only; nothing starts until an operator relabels it/);
  assert.ok(b4.includes('bots-bounds-review.md'), 'the roadmap must point at the review');
  assert.ok(b4.includes('bots.md'), 'the roadmap must point at the operator guide');
});
