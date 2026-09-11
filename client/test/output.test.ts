// Output-layer unit tests (docs/cli-tui-design.md §13, §10.1).
//
// The contract suite proves sanitisation end-to-end for two fields; this proves the sanitiser itself
// against the full set of sequences, because a live server cannot easily be made to carry every
// control character (some are rejected by JSON round-tripping or by validation), and the ones it
// cannot carry are exactly the ones that would be missed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForTerminal, renderTable, ellipsis, age, makeColorizer } from '../output/human.ts';
import { renderAgents } from '../commands/agents.ts';
import { renderRunList } from '../commands/list.ts';
import { renderRunDetail } from '../commands/show.ts';
import { renderEventLine } from '../commands/events.ts';
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
test('a hostile agent id cannot inject terminal sequences into `agents list`', () => {
  // Every other command sanitises what it prints. `agents list` printed server-supplied ids straight
  // through, so this is the one place where "the server would never send that" was load-bearing. The
  // display layer must not depend on the source being benign -- that is the entire premise of having a
  // sanitiser. Comparison still happens on the raw id, so the `default` marker is unaffected.
  const hostile = 'prime\u001b]0;pwned\u0007-agent';
  const out = renderAgents(
    { agents: [hostile, 'claude-code'], defaultAgent: hostile },
    { json: false, noColor: true, isTty: false } as never,
    false,
  );
  // The hostile sequence must be dead; the marker must be visible. Note the assertion is about the
  // payload, not about the absence of ESC anywhere -- a colourised header legitimately contains ESC.
  assert.ok(!out.includes('prime\u001b'), `escape survived: ${JSON.stringify(out)}`);
  assert.ok(out.includes('prime\u241b-agent'), 'the escape was not replaced with a visible marker');
  assert.ok(!out.includes('pwned\u0007'), 'the OSC payload reached the terminal intact');
  // The rest of the row is still readable -- sanitising must not destroy the data the operator came for.
  assert.match(out, /claude-code/);
  assert.match(out, /default/);
});
test('`runs list` sanitises every cell, not only the task', () => {
  // `agent` is whatever `runs create --agent` was given, stored verbatim and echoed back. On a shared
  // instance that is one operator writing into another operator's terminal.
  const hostile = 'evil\u001b[2A\u0007agent';
  const run = {
    id: 'run-1', status: 'RUNNING', task: 'ordinary task', agent: hostile,
    repository: { url: 'https://example.com/x.git' },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const out = renderRunList(
    { runs: [run as never], nextCursor: null },
    { json: false, noColor: true, isTty: false } as never,
    false,
  );
  assert.ok(!out.includes('evil\u001b'), `agent cell survived unsanitised: ${JSON.stringify(out)}`);
  assert.ok(out.includes('evil\u241b'), 'agent escape was not replaced with a visible marker');
  assert.match(out, /ordinary task/);
});

test('--no-color and a non-terminal produce no escape codes anywhere, headers included', () => {
  // renderTable used to hard-code ANSI.dim on the header row, ignoring the caller's colour settings.
  // `runs list > runs.txt` therefore wrote escape codes into the file and --no-color did not stop it.
  // The header style now comes from the caller's colourizer, and the default is no decoration.
  const rows = [['run-1', 'RUNNING', 'prime-agent', '3m12s', 'do the thing']];
  const plain = renderTable(['ID', 'STATUS', 'AGENT', 'AGE', 'TASK'], rows);
  assert.ok(!plain.includes('\u001b'), `undecorated table emitted ANSI: ${JSON.stringify(plain)}`);
  const { color, dim } = makeColorizer({ noColor: true, isTty: false, json: false });
  const off = renderTable(['ID', 'STATUS'], rows, (t) => color('cyan', t), (t) => dim(t));
  assert.ok(!off.includes('\u001b'), `--no-color still emitted ANSI: ${JSON.stringify(off)}`);
  const { color: c2, dim: d2 } = makeColorizer({ noColor: false, isTty: true, json: false });
  const on = renderTable(['ID', 'STATUS'], rows, (t) => c2('cyan', t), (t) => d2(t));
  assert.ok(on.includes('\u001b'), 'colour on a real terminal produced no ANSI; the switch is broken');
});
// ---------------------------------------------------------------------------
// The invariant, rather than a list of fields.
//
// A reviewer found that `runs show` printed run.id, run.agent, run.ownerId, run.retryOf, the commit list
// and skill.version unsanitised -- after the author had sanitised `agent` in `runs list` and believed the
// field was handled. Field-by-field audits fail that way: the same field reaches several render paths.
// So this asserts the property instead -- with colour switched off, human output must contain no escape
// byte anywhere -- and applies it to every renderer.
// ---------------------------------------------------------------------------

const HOSTILE = 'a\u001b]0;pwned\u0007b\u001b[31mc\u0007d';
const OFF = { json: false, noColor: true, isTty: false } as never;

function assertNoEscape(label: string, out: string): void {
  assert.ok(!out.includes('\u001b'),
    `${label}: human output with colour off still contains an escape byte: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('\u0007'), `${label}: a BEL survived in ${label}`);
}

test('runs show: no escape byte survives with colour off', () => {
  const run = {
    id: HOSTILE, status: 'RUNNING', agent: HOSTILE, ownerId: HOSTILE, attempt: 1,
    task: HOSTILE, createdAt: HOSTILE, startedAt: HOSTILE, completedAt: null,
    retryOf: HOSTILE, workspaceBranch: HOSTILE, prUrl: HOSTILE,
    error: HOSTILE, errorKind: HOSTILE, finalCommits: [HOSTILE, HOSTILE],
    repository: { url: HOSTILE, localPath: HOSTILE },
  };
  const out = renderRunDetail(
    { run: run as never, skills: [{ id: HOSTILE, version: HOSTILE } as never] },
    OFF, false,
  );
  assertNoEscape('runs show', out);
  // The data is still legible: the control bytes became visible markers rather than vanishing, so the
  // operator can see something was there. The OSC payload is consumed with its introducer, which is the
  // point -- leaving "0;pwned" behind would still be attacker-shaped text.
  assert.match(out, /run\s+a\u241bb\u241bc\u2400d/);
});

test('runs list and agents list: no escape byte survives with colour off', () => {
  const run = {
    id: HOSTILE, status: 'FAILED', agent: HOSTILE, task: HOSTILE,
    repository: { url: 'https://example.com/x.git' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  assertNoEscape('runs list', renderRunList({ runs: [run as never], nextCursor: HOSTILE }, OFF, false));
  assertNoEscape('agents list', renderAgents({ agents: [HOSTILE], defaultAgent: HOSTILE }, OFF, false));
});

test('event lines: no escape byte survives with colour off', () => {
  const event = {
    id: HOSTILE, runId: HOSTILE, type: HOSTILE, sequence: 1,
    timestamp: HOSTILE, payload: { text: HOSTILE, message: HOSTILE, command: HOSTILE },
  };
  assertNoEscape('event line', renderEventLine(event as never, OFF));
});

// --- `agents list` goal column (docs/goals.md 13.5, 13.6) ---------------------

const CAPS_OFF = { json: false, noColor: true, isTty: false } as never;

test('the goal column distinguishes too-old from unknown from unsupported', () => {
  // Three states, three actions: upgrade the harness, fix the probe, or pick another
  // agent. Rendering all three as "no" hides the one the operator can actually fix.
  const out = renderAgents(
    {
      agents: ['primeagent', 'hermes', 'cloud'],
      defaultAgent: 'primeagent',
      capabilities: {
        primeagent: { version: '0.2.7', versionRaw: '0.2.7',
          goals: { supported: false, reason: 'version-too-old', requiredVersion: '0.3.3', detectedVersion: '0.2.7' } },
        hermes: { version: '0.20.5', versionRaw: 'x', goals: { supported: false, reason: 'unsupported' } },
        cloud: { version: null, versionRaw: null,
          goals: { supported: false, reason: 'version-unknown', requiredVersion: '1.0.0' } },
      },
    },
    OFF,
    false,
  );
  assert.match(out, /needs 0\.3\.3, has 0\.2\.7/, `too-old not actionable:\n${out}`);
  assert.match(out, /version not detected/, `unknown not distinguished from "no":\n${out}`);
  // Unsupported is a plain no -- there is nothing to upgrade toward.
  const hermesRow = out.split('\n').find((l) => l.includes('hermes')) ?? '';
  assert.ok(!/needs/.test(hermesRow), `unsupported must not name a threshold:\n${hermesRow}`);
});

test('a server that sends no capabilities block renders unknown, not "no"', () => {
  // An older server simply omits the field. Rendering that as "no" would tell the operator
  // a capability is absent when the client was merely not told -- the same class of lie as
  // advertising a capability the serving path does not honour, pointed the other way.
  const out = renderAgents({ agents: ['primeagent'], defaultAgent: 'primeagent' }, OFF, false);
  assert.match(out, /unknown/, `missing capabilities must render as unknown:\n${out}`);
  assert.ok(!/\bno\b/.test(out.split('\n').find((l) => l.includes('primeagent')) ?? ''),
    'an absent capabilities block must not be reported as unsupported');
});

test('a supported agent renders a bare yes with no noise', () => {
  const out = renderAgents(
    { agents: ['primeagent'], defaultAgent: 'primeagent',
      capabilities: { primeagent: { version: '0.9.4', versionRaw: '0.9.4', goals: { supported: true, detectedVersion: '0.9.4' } } } },
    OFF,
    false,
  );
  const row = out.split('\n').find((l) => l.includes('primeagent')) ?? '';
  assert.match(row, /yes/, row);
  assert.ok(!/needs/.test(row), row);
});

test('a hostile version string cannot inject terminal sequences into the goal column', () => {
  // The goal column prints server-supplied version strings. The agent-id column already
  // sanitises; a new column is exactly where that discipline gets forgotten.
  const hostile = '1.0\u001b]0;pwned\u0007';
  const out = renderAgents(
    { agents: ['x'], defaultAgent: 'x',
      capabilities: { x: { version: hostile, versionRaw: hostile,
        goals: { supported: false, reason: 'version-too-old', requiredVersion: hostile, detectedVersion: hostile } } } },
    OFF,
    false,
  );
  assert.ok(!out.includes('\u001b]0;pwned'), 'escape payload survived the goal column');
  assert.ok(!out.includes('pwned\u0007'), 'OSC payload reached the terminal intact');
});
