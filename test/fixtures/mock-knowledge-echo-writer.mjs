#!/usr/bin/env node
// An agent process that writes the Run's own task into the tier-1 note file (section 7.1). Used by
// the containerized knowledge scenario (e2e/knowledge.test.ts): the lesson must originate in the
// TEST -- it travels as the task text, over the public API, into a workspace this file has never
// seen -- so nothing about the lesson is baked into the fixture. The claim is the task verbatim;
// the scenario keeps it short enough to fit the claim bound and distinct enough to grep for.
//
// Contract mirrors mock-knowledge-writer.mjs: JSONL events on stdout, `type` field, completed at the
// end. The local-agent adapter (docs/agent-adapters.md section 4) parses that stream; the run then
// finalizes, harvests the note into the outbox, and the worker's pusher sends it to Atlas.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const i = process.argv.indexOf('--task');
const task = i > 0 ? process.argv[i + 1] : '';

if (!task.trim()) {
  emit({ type: 'failed', error: 'no task text reached the agent; the scenario would prove nothing' });
  process.exit(1);
}

emit({ type: 'started' });
mkdirSync(join(process.cwd(), '.mercury'), { recursive: true });
appendFileSync(join(process.cwd(), '.mercury', 'notes.jsonl'),
  `${JSON.stringify({ kind: 'command', scope: 'project', claim: task })}\n`);
emit({ type: 'message', text: `recorded: ${task}` });
emit({ type: 'completed' });
