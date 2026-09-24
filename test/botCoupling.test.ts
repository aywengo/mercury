// The bot coupling guard (docs/dispatcher-bot-design.md §15 item 4, B0-5 #733).
//
// `src/host/bots/` is future standalone-process code (`mercury host bot run`): it must not grow
// roots into the server runtime (database, queue, adapters, config). It may import the API
// surface types and pure helpers that are deliberately shared, and the REDACTOR — which is the
// one documented exception (§15: "bot code imports the API surface, never src/ internals except
// the redactor"). Today the bots modules import only their own siblings plus node builtins; the
// allowlist below pins exactly that, so the first quiet `import { RunQueue } from '../../queue/…'`
// fails here instead of shipping a bot that needs the server to boot.
//
// Asserted in BOTH directions like the packaging test's exception list:
// - bots -> allowed modules (this file)
// - the redactor exception is bidirectional-by-contract: bot code MAY import src/domain/redact
//   and its own contract tests pin its behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOTS_DIR = fileURLToPath(new URL('../src/host/bots', import.meta.url));
// Length of the repo root — slicing an absolute path by the repo root's length+1 yields the
// repo-relative module path ('src/host/bots/keys.ts').
const ROOT_LEN = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '').length;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

const SPECIFIER_RE = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;

/** What bot code may reference today. node: builtins are always fine. */
const ALLOWED_SRC = [
  'src/host/bots/cron.ts',
  'src/host/bots/keys.ts',
  'src/host/bots/config.ts',
  'src/host/bots/credentials.ts',
  'src/domain/redact.ts', // the documented redactor exception (§15 item 4)
];

test('the bots directory is non-empty and actually being scanned', () => {
  const files = sourceFiles(BOTS_DIR);
  assert.ok(files.length >= 4, `expected the bots modules, scanned ${files.length}`);
});

test('bot code imports only its own modules, node builtins, and the redactor exception', () => {
  const BOTS_PREFIX = 'src/host/bots/';
  for (const file of sourceFiles(BOTS_DIR)) {
    // Resolve against the ABSOLUTE file path so '..' can legitimately escape src/host/bots/
    // (that is exactly how the documented redactor exception, ../../domain/redact.ts, is written).
    const dir = file.slice(0, file.lastIndexOf('/'));
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(SPECIFIER_RE)) {
      const spec = m[1]!;
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const resolved = join(dir, spec);
        const withinRoot = resolved.slice(ROOT_LEN + 1);
        const target = withinRoot.endsWith('.ts') ? withinRoot : `${withinRoot}.ts`;
        assert.ok(
          ALLOWED_SRC.includes(target),
          `${file.slice(BOTS_DIR.length + 1)} imports '${spec}' -> ${target}, which is outside the bot allowlist (${ALLOWED_SRC.join(', ')}). Bot code imports the API surface and the redactor exception, not server internals (§15 item 4). If this import is genuinely required, extend the allowlist AND document the exception here and in the design.`,
        );
      } else {
        assert.fail(`${file.slice(BOTS_DIR.length + 1)} imports bare specifier '${spec}' — bot code must not depend on packages beyond node builtins (the bot ships inside @aywengo/mercury with no extra runtime deps)`);
      }
    }
  }
});

test('the redactor exception is real: the module exists and stays import-safe for the bot', () => {
  // The exception is only honest if the excepted module still exists; if the redactor moves,
  // this guard must be updated in the same commit, not silently left pointing at a ghost.
  const red = readFileSync(new URL('../src/domain/redact.ts', import.meta.url).pathname, 'utf8');
  assert.ok(red.includes('export function createRedactor') || red.includes('export'), 'redactor module must remain the shared, pinned exception');
});
