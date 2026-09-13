/**
 * The host and Atlas must agree, and nothing else checks that they do.
 *
 * `atlas/` may not import `src/` and `src/` may not import `atlas/` (docs/knowledge-base.md section
 * 11.6), so the note record, the repository identity normalization and the claim hash are written
 * TWICE, on purpose, and the typechecker never compares the two copies. A divergence does not crash
 * anything. It files one host's knowledge into another project's base, because the identity is what a
 * project's repo set is matched against; or it splits one claim into two notes on two hosts, so
 * corroboration never reaches the threshold that section 12 promotes on and the note stays a candidate
 * forever. Both look like a knowledge base that is merely quiet.
 *
 * This file is the only place allowed to know both products at once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRepoIdentity as hostNormalize, identityHash as hostHash } from '../src/knowledge/identity.ts';
import { claimHash as hostClaimHash, validateDraft as hostValidate, DEFAULT_BOUNDS } from '../src/knowledge/validation.ts';
import { normalizeRepoIdentity as atlasNormalize, identityHash as atlasHash } from '../atlas/identity.ts';
import { claimHash as atlasClaimHash, validateDraft as atlasValidate, MAX_EVIDENCE } from '../atlas/validation.ts';

const IDENTITY_VECTORS: [string, string | null][] = [
  ['git@github.com:aywengo/mercury.git', 'github.com/aywengo/mercury'],
  ['https://github.com/aywengo/mercury', 'github.com/aywengo/mercury'],
  ['ssh://git@github.com/aywengo/Mercury.git', 'github.com/aywengo/Mercury'],
  ['https://GitHub.com:443/aywengo/mercury/', 'github.com/aywengo/mercury'],
  ['https://user:pw@github.com/aywengo/mercury?x=1#frag', 'github.com/aywengo/mercury'],
  ['https://github.com:8443/aywengo/mercury.git', 'github.com:8443/aywengo/mercury'],
  ['ssh://git@github.com:22/aywengo/mercury', 'github.com/aywengo/mercury'],
  ['github.com:aywengo/mercury', 'github.com/aywengo/mercury'],
  ['/Users/roman/devops/mercury', 'file/Users/roman/devops/mercury'],
  ['not-a-repo', null],
  ['', null],
  ['https://github.com/', null],
];

test('the host and Atlas normalize repository identities identically', () => {
  for (const [input, expected] of IDENTITY_VECTORS) {
    const fromHost = hostNormalize(input);
    const fromAtlas = atlasNormalize(input);
    assert.equal(fromAtlas, fromHost, `the two implementations disagree on ${JSON.stringify(input)}`);
    assert.equal(fromHost, expected, `both are wrong about ${JSON.stringify(input)}`);
    assert.equal(atlasHash(fromAtlas ?? 'x'), hostHash(fromHost ?? 'x'), `hashes disagree for ${input}`);
  }
  // Section 5's example, stated as the outcome it exists to produce.
  const ids = new Set(IDENTITY_VECTORS.slice(0, 3).map(([, out]) => out));
  assert.equal(ids.size, 2, 'three spellings of two repositories must yield two identities, not three and not one');
});

test('the host and Atlas hash a claim identically, so corroboration accumulates', () => {
  const cases: [string, string, string][] = [
    ['fact', 'project', 'Run one test file with `node --test test/x.test.ts`.'],
    ['pitfall', 'repo:0d89bf8e3927930b#src/queue', 'The lease-expiry test  flakes   under load.'],
    ['convention', 'project', '  Migrations are appended, never edited  '],
    ['command', 'project', 'npm test'],
    ['decision', 'project', 'Atlas stores claims, not history'],
  ];
  for (const [kind, scope, claim] of cases) {
    assert.equal(
      atlasClaimHash(kind, scope, claim),
      hostClaimHash(kind, scope, claim),
      `the claim hash disagrees for ${JSON.stringify(claim)}; a divergence means the same claim from two hosts becomes two notes and never corroborates`,
    );
  }
  // Normalization is the substance of the hash, so pin the equivalences rather than only the digests.
  const eq = (a: string, b: string) => assert.equal(hostClaimHash('fact', 'project', a), hostClaimHash('fact', 'project', b));
  eq('trailing period.', 'trailing period');
  eq('collapsed   whitespace', 'collapsed whitespace');
  assert.notEqual(hostClaimHash('fact', 'project', 'same sentence'), hostClaimHash('pitfall', 'project', 'same sentence'),
    'kind is hashed in: the same sentence about two different things is two claims');
});

test('the host and Atlas accept and refuse the same notes, for the same reasons', () => {
  const note = (claim: string, extra: Record<string, unknown> = {}) => ({
    kind: 'fact', scope: 'project', claim, evidence: [],
    provenance: { source: 'agent-reported', hostId: 'host-a', runId: 'r1', agent: 'primeagent', harnessVersion: '1.0.0', recordedAt: new Date().toISOString() },
    repoIdentity: 'github.com/aywengo/mercury',
    ...extra,
  });
  const cases: [string, unknown, boolean, string?][] = [
    ['a plain fact', note('the integration tests need docker compose running'), true],
    ['a decision with evidence', note('Atlas stores claims, not history', { kind: 'decision', evidence: [{ type: 'pr', url: 'https://github.com/aywengo/mercury/pull/487' }] }), true],
    ['a decision without evidence', note('Atlas stores claims, not history', { kind: 'decision' }), false, 'missing-evidence'],
    ['a harness flag', note('load it with --skill planning'), false, 'k2-violation'],
    ['a harness home path', note('profiles live in ~/.hermes/profiles/x'), false, 'k2-violation'],
    ['a model id', note('switched to claude-opus-4-5 for this'), false, 'k2-violation'],
    ['legitimate prose about an adapter', note('The ClaudeCodeAdapter sends the task over stdin'), true],
    ['legitimate prose about migrations', note('Migrations are appended to MIGRATIONS, never edited'), true],
    ['an unknown kind', note('x', { kind: 'vibe' }), false, 'invalid-kind'],
    ['a traversing scope', note('x', { scope: 'repo:0d89bf8e3927930b#/etc/passwd' }), false],
    ['an over-long claim', note('x'.repeat(2000)), false, 'claim-too-long'],
  ];
  for (const [what, draft, ok, reason] of cases) {
    const h = hostValidate(draft as never, DEFAULT_BOUNDS);
    const a = atlasValidate(draft as never, { maxClaimBytes: DEFAULT_BOUNDS.maxClaimBytes, maxDetailBytes: DEFAULT_BOUNDS.maxDetailBytes, maxEvidence: MAX_EVIDENCE });
    assert.equal(h.ok, ok, `the host disagrees about ${what}`);
    assert.equal(a.ok, ok, `Atlas disagrees about ${what}`);
    if (!ok && reason) {
      assert.equal((h as { ok: false; reason: string }).reason, reason, `host gives the wrong reason for ${what}`);
      assert.equal((a as { ok: false; reason: string }).reason, reason, `Atlas gives the wrong reason for ${what}`);
    }
  }
});
