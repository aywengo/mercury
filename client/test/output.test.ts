// Output-layer unit tests (docs/cli-tui-design.md §13, §10.1).
//
// The contract suite proves sanitisation end-to-end for two fields; this proves the sanitiser itself
// against the full set of sequences, because a live server cannot easily be made to carry every
// control character (some are rejected by JSON round-tripping or by validation), and the ones it
// cannot carry are exactly the ones that would be missed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForTerminal, renderTable, ellipsis, age, makeColorizer } from '../output/human.ts';
import { writeJson, eventLine } from '../output/json.ts';

test('CSI sequences cannot survive sanitisation', () => {
  for (const seq of ['\u001b[2J', '\u001b[1;1H', '\u001b[?25l', '\u001b[38;5;196m', '\u001b[K']) {
    const out = sanitizeForTerminal(`a${seq}b`);
    assert.ok(!out.includes('\u001b'), `escape survived ${JSON.stringify(seq)}`);
    assert.ok(!out.includes('[2J') || seq !== '\u001b[2J', 'the CSI body survived intact');
  }
});

test('OSC sequences, both terminators, cannot retitle the terminal', () => {
  // The xterm title-setting sequence ends with BEL; some terminals accept ST instead. Both must be
  // consumed -- matching only BEL leaves a usable sequence for the other terminator.
  const bel = sanitizeForTerminal('x\u001b]0;pwned\u0007y');
  const st = sanitizeForTerminal('x\u001b]0;pwned\u001b\\y');
  for (const out of [bel, st]) {
    assert.ok(!out.includes('\u001b'), 'escape survived');
    assert.ok(!out.includes(']0;'), 'OSC introducer survived');
  }
  assert.ok(bel.includes('x') && bel.includes('y'), 'surrounding text must be preserved');
});

test('single-character Fe escapes are neutralised', () => {
  // ESC c (reset), ESC 7 (save cursor) and friends are one byte after ESC, with no body.
  for (const ch of ['c', '7', '8', 'D', 'M']) {
    assert.ok(!sanitizeForTerminal(`a\u001b${ch}b`).includes('\u001b'), `ESC ${ch} survived`);
  }
});

test('a lone trailing ESC is neutralised rather than left to swallow the next write', () => {
  // A dangling ESC is the dangerous case for a STREAMING renderer: the next event's first bytes
  // would be interpreted as that sequence's body.
  assert.ok(!sanitizeForTerminal('ends badly \u001b').includes('\u001b'));
});

test('NUL and the C0 controls other than tab/newline are replaced', () => {
  const out = sanitizeForTerminal('a\u0000b\u0007c\rd\ne\tf\u007fg');
  assert.ok(!/[\u0000\u0007\r\u007f]/.test(out), 'a C0 control survived');
  // Tab and newline are layout, not injection; stripping them would destroy table and log output.
  assert.ok(out.includes('\n') && out.includes('\t'), 'tab/newline should pass through');
});

test('C1 controls are replaced', () => {
  assert.ok(!/[\u0080-\u009f]/.test(sanitizeForTerminal('a\u009b\u008fb')));
});

test('bidi overrides are removed so a name cannot display as something else', () => {
  // The classic: RLO makes `gold.<RLO>gnp.jexe` render as `exe.png.dlog`.
  const evil = 'run\u202efdc\u202c-name';
  const out = sanitizeForTerminal(evil);
  assert.ok(!out.includes('\u202e') && !out.includes('\u202c'), 'a bidi override survived');
  assert.ok(!sanitizeForTerminal('a\ufeffb').includes('\ufeff'), 'BOM survived');
});

test('sanitisation replaces rather than deletes, so survivors cannot be spliced together', () => {
  // Deleting the escape would join `withd` + `one` into a word the operator never saw typed.
  const out = sanitizeForTerminal('with\u001b[31mdrawn');
  assert.ok(out.includes('with') && out.includes('drawn'));
  assert.notEqual(out.indexOf('drawn') - out.indexOf('with'), 4, 'the escape was deleted, not replaced');
});

test('sanitisation is idempotent', () => {
  const once = sanitizeForTerminal('a\u001b[2Jb\u0007c');
  assert.equal(sanitizeForTerminal(once), once, 'a second pass changed already-clean text');
});

test('table columns stay aligned when a cell contains a stripped sequence', () => {
  // Widths must be computed on what is DISPLAYED. Sizing on the raw input leaves the column short by
  // the length of the escape, and every following column shifts -- which is how a crafted field makes
  // a table appear to say something it does not.
  const rows = [
    ['run_a', 'COMPLETED', `task\u001b[31;1mred`],
    ['run_b', 'FAILED', 'plain'],
  ];
  const sanitised = rows.map((r) => r.map(sanitizeForTerminal));
  const table = renderTable(['ID', 'STATUS', 'TASK'], sanitised);
  const lines = table.split('\n');
  const colStart = (line: string, index: number): number => {
    let pos = 0;
    for (let i = 0; i < index; i += 1) pos = line.indexOf(lines[0].split(/\s{2,}/)[i], pos) + 1;
    return line.indexOf(sanitised[0][index] === '' ? 'STATUS' : sanitised[index === 0 ? 0 : 0][0], pos);
  };
  // Simpler and sufficient: the STATUS column must begin at the same offset on every body row.
  const offsets = lines.slice(1).map((l) => l.indexOf('COMPLETED') >= 0 ? l.indexOf('COMPLETED') : l.indexOf('FAILED'));
  assert.equal(offsets[0], offsets[1], `columns misaligned: ${JSON.stringify(lines)}`);
  void colStart;
});

test('ellipsis never splits a surrogate pair', () => {
  // Cutting between the halves of an astral character yields U+FFFD, which then round-trips as a
  // different string than the server sent.
  const text = 'ab\u{1f600}cd';
  for (let max = 1; max <= text.length + 2; max += 1) {
    const cut = ellipsis(text, max);
    assert.ok(!cut.includes('\uFFFD'), `cut ${max} produced a lone surrogate: ${JSON.stringify(cut)}`);
  }
});

test('age renders durations and treats bad input as unknown', () => {
  const now = Date.parse('2026-01-01T12:00:00.000Z');
  assert.equal(age('2026-01-01T11:59:30.000Z', now), '30s');
  assert.equal(age('2026-01-01T11:57:48.000Z', now), '2m12s');
  assert.equal(age('2026-01-01T09:45:00.000Z', now), '2h15m');
  assert.equal(age('2025-12-28T12:00:00.000Z', now), '4d0h');
  // A clock skew that puts the timestamp in the future must not render a negative duration.
  assert.equal(age('2026-01-01T13:00:00.000Z', now), '0s');
  assert.equal(age(null, now), '-');
  assert.equal(age('not a date', now), '-');
});

test('colour is off when stdout is not a TTY, so pipes stay clean', () => {
  const c = makeColorizer({ noColor: false, isTty: false, json: false });
  assert.equal(c.color('red', 'FAILED'), 'FAILED');
  const t = makeColorizer({ noColor: false, isTty: true, json: false });
  assert.notEqual(t.color('red', 'FAILED'), 'FAILED');
  // --json must disable decoration even on a TTY: escape codes inside a JSON string break jq.
  const j = makeColorizer({ noColor: false, isTty: true, json: true });
  assert.equal(j.color('red', 'FAILED'), 'FAILED');
  const n = makeColorizer({ noColor: true, isTty: true, json: false });
  assert.equal(n.color('red', 'FAILED'), 'FAILED');
});

test('JSON output is exactly one value and event lines are self-contained', () => {
  let buf = '';
  writeJson((t) => { buf += t; }, { a: 1, b: [2, 3] });
  assert.equal(buf, '{"a":1,"b":[2,3]}\n');
  assert.deepEqual(JSON.parse(buf), { a: 1, b: [2, 3] });
  assert.ok(eventLine({ sequence: 1 }).endsWith('\n'));
  assert.equal(eventLine({ sequence: 1 }).split('\n').length, 2, 'an event line must contain no inner newline');
});
