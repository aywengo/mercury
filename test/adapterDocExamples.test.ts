import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Binds the worked example configs in docs/agent-adapters.md to the real validators.
//
// Before this, the doc's examples were prose that nothing executed. Two of six did not load
// (#504), and the doc showed them as YAML while all three registries read only `.json`
// (`if (!file.endsWith('.json')) continue;`) -- so an operator who saved the documented example
// to `agents/devin.yaml` got no adapter and no error at all. The examples are JSON now because
// that is the only format the software accepts; this test is what stops them drifting again.
//
// Same shape as test/goalWireShape.test.ts (#498): the document is the fixture, so a wrong
// example is a failing test rather than a broken boot on someone else's machine.

// Every document that shows an operator an adapter config. Both were prose that nothing executed.
//
// The paths are spelled out inside each readFileSync call rather than mapped over an array on
// purpose: test/ciWorkflow.test.ts resolves the *argument of the read call* to decide which
// documents a suite reads, and a `DOCS.map((rel) => readFileSync(new URL(rel, ...)))` hides them.
// Invisible there, the suite looks like it reads no docs, so nothing requires it to run in
// docs-contract -- and it silently stops running on exactly the markdown-only PRs it guards (#355).
const AGENT_ADAPTERS_DOC = readFileSync(new URL('../docs/agent-adapters.md', import.meta.url), 'utf8');
const AGENTS_DOC = readFileSync(new URL('../docs/agents.md', import.meta.url), 'utf8');

const DOC_TEXT: Record<string, string> = {
  'docs/agent-adapters.md': AGENT_ADAPTERS_DOC,
  'docs/agents.md': AGENTS_DOC,
};

type Validator = (cfg: never) => void;

async function validators(): Promise<Record<'local' | 'rpc' | 'remote', Validator>> {
  const l = await import('../src/adapters/localAgentAdapter.ts');
  const r = await import('../src/adapters/rpcAgentAdapter.ts');
  const m = await import('../src/adapters/remoteAgentAdapter.ts');
  return {
    local: l.validateLocalAgentConfig as unknown as Validator,
    rpc: r.validateRpcAgentConfig as unknown as Validator,
    remote: m.validateRemoteAgentConfig as unknown as Validator,
  };
}

interface Example {
  id: string;
  kind: 'local' | 'rpc' | 'remote';
  cfg: Record<string, unknown>;
}

function docExamples(): Record<string, unknown>[] {
  return rawExamples().map((r) => r.cfg);
}

interface Raw { doc: string; cfg: Record<string, unknown> }

/** Every ```json fence across the docs that parses to an object with a string `id`. */
function rawExamples(): Raw[] {
  const found: Raw[] = [];
  for (const [doc, text] of Object.entries(DOC_TEXT)) {
    for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      const parsed: unknown = JSON.parse(m[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.id === 'string') found.push({ doc, cfg: obj });
      }
    }
  }
  return found;
}

/**
 * Which adapter a config belongs to, from the field that only that adapter's schema defines.
 *
 * A priority cascade, not mutual exclusion: an RPC config legitimately carries `command` *and*
 * `protocol`, so `command` alone does not mean "local". Falling through to "no discriminator" is
 * the case worth failing on -- a misspelled `api`/`protocol` would otherwise drop the example out
 * of validation silently. A config carrying fields for two adapters is caught by the unknown-key
 * check instead, since neither schema defines the other's fields.
 */
function kindOf(cfg: Record<string, unknown>): 'local' | 'rpc' | 'remote' {
  if ('api' in cfg) return 'remote';
  if ('protocol' in cfg) return 'rpc';
  if ('command' in cfg) return 'local';
  throw new Error(
    `"${cfg.id}" carries none of api / protocol / command, so no adapter would claim it`,
  );
}

function examples(): Example[] {
  return rawExamples().map(({ cfg }) => ({ id: String(cfg.id), kind: kindOf(cfg), cfg }));
}

test('the docs carry the worked examples, with unique ids', () => {
  // Count, not just membership: deleting an example silently would shrink coverage to nothing
  // while every remaining assertion still passed.
  const ids = examples().map((e) => e.id);
  // aider/my-agent/pi appear in both documents; the set is the union, deduplicated by id below.
  assert.deepEqual(
    [...new Set(ids)].sort(),
    ['aider', 'devin', 'my-agent', 'omp', 'openhands', 'pi'],
    'the documented adapter example set changed (agent-adapters.md 4.3/5.4/6.4, agents.md)',
  );
  // Uniqueness is per document. The same id legitimately appears twice -- agents.md shows a
  // trimmed intro version, agent-adapters.md the full one -- and requiring those to be identical
  // would be a rule nobody asked for. What must not happen is one document carrying two different
  // configs under the same id.
  const perDoc = new Map<string, string[]>();
  for (const { doc, cfg } of rawExamples()) {
    const list = perDoc.get(doc) ?? [];
    list.push(String(cfg.id));
    perDoc.set(doc, list);
  }
  for (const [doc, ids] of perDoc) {
    assert.equal(new Set(ids).size, ids.length, `${doc} has duplicate example ids: ${ids.join(', ')}`);
  }
});

test('every documented example is written in a format the registries can load', () => {
  // The registries skip anything that is not .json without a word of complaint, so a YAML example
  // is not merely inconvenient -- it produces an agent that does not exist.
  for (const [name, text] of Object.entries(DOC_TEXT)) {
    assert.equal(
      (text.match(/```ya?ml\n/g) || []).length, 0,
      `${name}: adapter examples must be JSON -- all three registries read only *.json and `
      + 'silently skip anything else, so a YAML example yields an agent that does not exist',
    );
  }
});

test('every documented example passes the validator for its adapter', async () => {
  const V = await validators();
  for (const e of examples()) {
    // Assert per example so a failure names the example rather than the loop.
    assert.doesNotThrow(
      () => V[e.kind](e.cfg as never),
      `a documented example ("${e.id}", ${e.kind}) does not load`,
    );
  }
});

test('the guard reports: a broken example fails rather than being skipped', async () => {
  // Without this, the test above could pass by matching zero examples. Prove the machinery
  // rejects a bad config, using each defect class #500 made load-bearing.
  const V = await validators();
  const good = examples();
  assert.ok(good.length >= 8, `expected the documented examples, saw ${good.length}`);

  const nested = structuredClone(good.find((e) => e.id === 'aider')!.cfg) as Record<string, unknown>;
  nested.goalSupport = { sett: '1.0.0' };
  assert.throws(() => V.local(nested as never), /goalSupport\.sett/,
    'a nested typo in a documented example must be reported');

  const missing = structuredClone(good.find((e) => e.id === 'devin')!.cfg) as Record<string, unknown>;
  (missing.poll as Record<string, unknown>).timeoutMs = 0;
  assert.throws(() => V.remote(missing as never), /poll\.intervalMs and poll\.timeoutMs/,
    'the exact defect that shipped in the Devin example must fail the guard');

  const unknown = structuredClone(good.find((e) => e.id === 'pi')!.cfg) as Record<string, unknown>;
  unknown.protcol = unknown.protocol;
  delete unknown.protocol;
  assert.throws(() => V.rpc(unknown as never), /unknown config key protcol/,
    'a misspelled key in a documented example must be reported');
});

test('an example with no discriminator is caught rather than silently unvalidated', () => {
  // kindOf runs before any validator, so a misspelled `api`/`protocol`/`command` would otherwise
  // drop the example out of coverage entirely.
  assert.throws(
    () => kindOf({ id: 'ghost', commnad: 'x' }),
    /carries none of api \/ protocol \/ command/,
  );
  // A real RPC config carries both command and protocol; protocol must win, or the example would
  // be validated against the wrong schema and pass for the wrong reason.
  assert.equal(kindOf({ id: 'pi', command: 'pi', protocol: {} }), 'rpc');
  assert.equal(kindOf({ id: 'aider', command: 'aider' }), 'local');
  assert.equal(kindOf({ id: 'devin', api: {} }), 'remote');
});

test('this suite declares its document reads where the CI guard can see them', () => {
  // test/ciWorkflow.test.ts decides whether this suite must run in docs-contract by resolving the
  // argument of each read call. That resolution handles literals and one level of const/join
  // indirection -- it does NOT see `'../docs/' + name` or a map over an array. When the read is
  // invisible there, this suite looks like it reads no documents, nothing requires it in
  // docs-contract, and it stops running on exactly the markdown-only PRs it exists to guard (#355).
  //
  // So the invariant is asserted here, where breaking it is loud, rather than left to a detector
  // that fails open. Proven by mutation: rewriting a read to `'../docs/' + 'agent-adapters.md'`
  // makes this fail while every other test here still passes.
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const doc of Object.keys(DOC_TEXT)) {
    const rel = `../${doc}`;
    const visible = new RegExp(`readFileSync\\(new URL\\(\s*'${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(self);
    assert.ok(
      visible,
      `${doc} must be read through a literal path inside the readFileSync call, or `
      + 'test/ciWorkflow.test.ts cannot see that this suite reads it and will not require it '
      + 'to run in docs-contract',
    );
  }
});
