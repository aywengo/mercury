#!/usr/bin/env node
// A real agent process that learns something and writes it to the tier-1 file, exactly as section 7.1
// describes. The lesson arrives via argv, so it is not baked into this file -- which is what lets the
// test assert that a string existing only in host A's process ends up in host B's transcript.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const i = process.argv.indexOf('--lesson');
const lesson = i > 0 ? process.argv[i + 1] : '';

emit({ type: 'started' });
mkdirSync(join(process.cwd(), '.mercury'), { recursive: true });
appendFileSync(
  join(process.cwd(), '.mercury', 'notes.jsonl'),
  `${JSON.stringify({ kind: 'command', scope: 'project', claim: lesson })}\n`,
);
emit({ type: 'message', text: 'wrote a note about verifying the artefact' });
emit({ type: 'completed' });
