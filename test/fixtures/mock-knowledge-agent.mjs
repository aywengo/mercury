#!/usr/bin/env node
// A real agent process for the acceptance proof. It is a real subprocess that Mercury spawns with the
// workspace as its cwd, exactly as a declarative CLI agent runs in production.
//
// It reads the knowledge pack from disk and reports what it found. It has no other way to learn the
// strings it prints -- they are not in this file, not in its argv, and not in its environment -- so if
// they reach the transcript, they arrived through the pack.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ws = process.cwd();
const notesPath = join(ws, '.mercury', 'knowledge', 'NOTES.md');
const packPath = join(ws, '.mercury', 'knowledge', 'pack.json');

emit({ type: 'started' });
if (existsSync(notesPath)) {
  const md = readFileSync(notesPath, 'utf8');
  emit({ type: 'message', text: `NOTES.md read: ${md.length} bytes` });
  // Echo every claim verbatim. The test asserts a token that exists nowhere else.
  for (const line of md.split('\n')) {
    if (line.startsWith('- **')) emit({ type: 'message', text: line.trim() });
  }
  const pack = JSON.parse(readFileSync(packPath, 'utf8'));
  emit({ type: 'message', text: `packHash=${pack.packHash} count=${pack.notes.length}` });
} else {
  emit({ type: 'message', text: 'NO PACK' });
}
emit({ type: 'completed' });
