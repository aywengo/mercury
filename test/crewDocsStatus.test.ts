import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Binds the Crew design docs' claims about what Mercury already does to the code (issue #512).
//
// Three docs said `/api/agents` returns "bare names" and that a Run cannot carry zero skills.
// Both were false: the route has returned a `capabilities` map since goals Phase 0a, and
// RunService honours an explicit `skills: []`. Two of the three files were not named in the
// issue -- the acceptance grep found them.
//
// The damage is concrete: someone implementing from docs/crew/ alone would build a second
// capability registry next to src/adapters/capabilities.ts.
//
// Every matcher below is shared between the assertions over the real docs and the self-tests
// that prove those assertions can fail. Three times in this issue set a self-test carried its
// own inline copy of a pattern, which let a weakened pattern pass every test.

const CREW_DIR = new URL('../docs/crew/', import.meta.url);
const CREW_FILES = readdirSync(CREW_DIR).filter((f) => f.endsWith('.md')).sort();

// Literal paths inside each read call: test/ciWorkflow.test.ts resolves the argument of a read
// call to decide which documents a suite reads, and fails open when it cannot see one. Invisible
// there, this suite looks like it reads no docs and stops running on the markdown-only PRs it
// exists to guard (#355).
const HARNESS_CAPS = readFileSync(new URL('../docs/crew/harness-capabilities.md', import.meta.url), 'utf8');
const TEAMS = readFileSync(new URL('../docs/crew/teams.md', import.meta.url), 'utf8');
const README = readFileSync(new URL('../docs/crew/README.md', import.meta.url), 'utf8');
const ROADMAP = readFileSync(new URL('../docs/crew/roadmap.md', import.meta.url), 'utf8');
const TEMPLATES = readFileSync(new URL('../docs/crew/agent-templates.md', import.meta.url), 'utf8');
const PRESETS = readFileSync(new URL('../docs/crew/role-presets.md', import.meta.url), 'utf8');
const MCP_SECURITY = readFileSync(new URL('../docs/crew/mcp-security.md', import.meta.url), 'utf8');
const PRESET_STORE = readFileSync(new URL('../docs/crew/preset-store.md', import.meta.url), 'utf8');
const WORKFLOWS = readFileSync(new URL('../docs/crew/workflows.md', import.meta.url), 'utf8');

const DOCS: Record<string, string> = {
  'docs/crew/README.md': README,
  'docs/crew/agent-templates.md': TEMPLATES,
  'docs/crew/harness-capabilities.md': HARNESS_CAPS,
  'docs/crew/mcp-security.md': MCP_SECURITY,
  'docs/crew/preset-store.md': PRESET_STORE,
  'docs/crew/roadmap.md': ROADMAP,
  'docs/crew/role-presets.md': PRESETS,
  'docs/crew/teams.md': TEAMS,
  'docs/crew/workflows.md': WORKFLOWS,
};

/** docs/crew files that DOCS does not cover. */
function uncovered(): string[] {
  const covered = new Set(Object.keys(DOCS).map((p) => p.replace('docs/crew/', '')));
  return CREW_FILES.filter((f) => !covered.has(f));
}

// The shipped text was "Bare names." with a capital B, so case-insensitivity is load-bearing.
const BARE_NAMES = /bare names?/gi;
const STALE_ZERO_SKILLS =
  /(?:a run (?:must )?be able to carry zero skills\.?\s*today it cannot|cannot be asked for no skills)/gis;

/**
 * Restatements of the same two falsehoods in other words.
 *
 * A reviewer supplied three phrasings the literal patterns above miss -- "returns only agent IDs
 * without capability information", "Mercury does not allow a Run to be submitted with zero skills",
 * "A Run cannot have an empty skill set". Each restates a claim this PR exists to remove, so the
 * literal patterns alone would let the falsehood back in through the back door.
 *
 * Two exclusions keep the matchers from flagging accurate prose, and both were earned: without
 * them the broadened patterns hit four passages in this repo's own docs, three of which are the
 * corrected text. "reports capabilities, not just names" is a correction, not a stale claim; a
 * sentence explaining what `skillSelector` does is describing the fallback, not denying the API.
 *
 * Residual gap, accepted: a denial phrased with none of these words is not caught. Denial in
 * English is not pattern-matchable in general, and a guard that flags honest prose gets deleted
 * rather than obeyed.
 */
const AGENTS_WITHOUT_CAPS =
  /\/api\/agents(?:(?!\n\n)[\s\S]){0,160}?(?:bare names?|without (?:any )?capabilit|no capabilit(?:ication|ies)?\b(?: information)?|\b(?:only|nothing but)\b(?:(?!\.)[\s\S]){0,50}?\b(?:ids?|names?|identifiers?)\b)/gi;
const NOT_A_CORRECTION = /not\s+(?:just|only|merely)/i;

const ZERO_SKILLS_DENIED_BEFORE =
  /(?:(?!\.)[\s\S]){0,80}?(?:zero skills|empty skill set|no skills|at least one skill)(?:(?!\.)[\s\S]){0,80}?(?:cannot|does not allow|is not allowed|must include|always enforces)/gi;
const ZERO_SKILLS_DENIED_AFTER =
  /(?:does not allow|is not allowed|always enforces|must include)(?:(?!\.)[\s\S]){0,80}?(?:zero skills|empty skill set|no skills|at least one skill)/gi;
// Accurate sentences about the fallback name the selector or the explicit path; stale ones do not.
const DESCRIBES_THE_FALLBACK = /skillSelector|selector|explicit|#459/i;

function bareNameClaims(text: string): string[] {
  BARE_NAMES.lastIndex = 0;
  const found = [...text.matchAll(BARE_NAMES)].map((m) => m[0]);
  AGENTS_WITHOUT_CAPS.lastIndex = 0;
  for (const m of text.matchAll(AGENTS_WITHOUT_CAPS)) {
    const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length);
    if (NOT_A_CORRECTION.test(around)) continue;
    found.push(m[0].replace(/\s+/g, ' ').trim().slice(0, 90));
  }
  return found;
}

function zeroSkillClaims(text: string): string[] {
  STALE_ZERO_SKILLS.lastIndex = 0;
  const found = [...text.matchAll(STALE_ZERO_SKILLS)].map((m) => m[0].replace(/\s+/g, ' ').trim());
  for (const re of [ZERO_SKILLS_DENIED_BEFORE, ZERO_SKILLS_DENIED_AFTER]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const around = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90);
      if (DESCRIBES_THE_FALLBACK.test(around)) continue;
      found.push(m[0].replace(/\s+/g, ' ').trim().slice(0, 90));
    }
  }
  return found;
}

test('every markdown file in docs/crew is covered by this guard', () => {
  assert.deepEqual(uncovered(), [],
    `docs/crew files not checked by this suite: ${uncovered().join(', ')}`);
});

test('no Crew doc claims /api/agents returns bare names', () => {
  const offenders: string[] = [];
  for (const [name, text] of Object.entries(DOCS)) {
    for (const claim of bareNameClaims(text)) offenders.push(`${name}: "${claim}"`);
  }
  assert.deepEqual(offenders, [], `stale /api/agents claims:\n${offenders.join('\n')}`);
});

test('no Crew doc claims a Run cannot carry zero skills', () => {
  // The true statement is narrower: an explicit [] is honoured, an omitted one falls back.
  const offenders: string[] = [];
  for (const [name, text] of Object.entries(DOCS)) {
    for (const claim of zeroSkillClaims(text)) offenders.push(`${name}: "${claim}"`);
  }
  assert.deepEqual(offenders, [], `stale zero-skills claims:\n${offenders.join('\n')}`);
});

test('a reader of docs/crew is pointed at the capability code that already exists', () => {
  // The issue's second acceptance criterion, made mechanical: someone implementing from this
  // directory alone must find the existing registry instead of writing another one.
  assert.match(README, /capabilities\.ts/, 'crew/README.md must name src/adapters/capabilities.ts');
  assert.match(HARNESS_CAPS, /capabilities\.ts/, 'harness-capabilities.md must name the existing registry');
});

test('the guard reports: a reintroduced stale claim fails rather than being skipped', () => {
  assert.ok(bareNameClaims('GET /api/agents returns bare names today.').length > 0,
    'lowercase claim not caught');
  assert.ok(bareNameClaims('Bare names. The map is decorative.').length > 0,
    'capitalised claim not caught -- the shipped text was "Bare names."');
  assert.ok(
    zeroSkillClaims('A Run must be able to carry zero skills. Today it cannot, which breaks Hermes.').length > 0,
    'zero-skills claim not caught');
  assert.ok(zeroSkillClaims('`RunService` cannot be asked for no skills.').length > 0,
    'phase-text variant not caught');

  // Reviewer-supplied restatements: same falsehoods, different words. These are what the
  // broadened matchers exist for; the literal patterns above miss all three.
  for (const restated of [
    'GET /api/agents returns only agent IDs without capability information.',
    'Mercury does not allow a Run to be submitted with zero skills. Every Run must include at least one skill.',
    'A Run cannot have an empty skill set; the system always enforces a minimum of one skill.',
  ]) {
    assert.ok(bareNameClaims(restated).length + zeroSkillClaims(restated).length > 0,
      `restated falsehood not caught: "${restated}"`);
  }

  // The accurate phrasings this PR introduced must pass, or the guard gets deleted for crying wolf.
  for (const honest of [
    'An explicit `skills: []` is honoured today; an omitted one still cannot resolve to empty.',
    'Names **plus** a per-agent capability map.',
    '`/api/agents` reports capabilities, not just names.',
    'Because the selector falls back to a fixed set whenever `skills` is omitted, a caller who does not know to send `skills: []` always gets at least one Mercury skill id.',
    '`RunService` *can* be asked for no skills (explicit `[]`, see #459); `skillSelector` still cannot return an empty list.',
  ]) {
    assert.deepEqual([...bareNameClaims(honest), ...zeroSkillClaims(honest)], [],
      `false positive on accurate prose: "${honest}"`);
  }
});

test('the coverage check can actually fail', () => {
  // Proven through the same uncovered() the real assertion uses, so neutering either side fails.
  assert.deepEqual(uncovered(), [], 'baseline: every doc should be covered');
  const saved = DOCS['docs/crew/workflows.md'];
  try {
    delete DOCS['docs/crew/workflows.md'];
    assert.deepEqual(uncovered(), ['workflows.md'],
      'dropping a doc from DOCS must surface as uncovered, not as a silent pass');
  } finally {
    DOCS['docs/crew/workflows.md'] = saved;
  }
});

test('this suite declares its document reads where the CI guard can see them', () => {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const doc of Object.keys(DOCS)) {
    const rel = `../${doc}`;
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(
      new RegExp(`readFileSync\\(new URL\\(\\s*'${escaped}'`).test(self),
      `${doc} must be read through a literal path inside the readFileSync call, or `
      + 'test/ciWorkflow.test.ts cannot see that this suite reads it and will not require it '
      + 'to run in docs-contract',
    );
  }
});


// --- the roadmap's own status, and the two numbers that contradicted other documents ----------------
//
// This suite already guarded the class -- "no Crew doc claims a Run cannot carry zero skills" -- and still
// missed the real regression, because roadmap.md said `"no skills" is inexpressible` and no pattern contained
// that word. Phrasing-specific patterns guard the sentences someone happened to notice, not the claims. So
// these assertions are written against the claims themselves: what phase is done, whether Hermes can run,
// and how big the Hermes skill store is.
//
// Issue #579. The concrete harm: roadmap.md said "Status: design only" and "Until this passes, no template
// or team work is scheduled", while ../status.md and ../phase-0-issues.md both recorded Phase 0 as complete.
// A contributor following the roadmap would re-implement 2-3 days of merged work or wait on a passed gate.

test('roadmap.md states Phase 0 is complete and does not call the whole roadmap design-only', () => {
  assert.match(ROADMAP, /\*\*Status: complete\.?\*\*|\*\*Phase 0 is complete/,
    'roadmap.md must say Phase 0 is complete; two other documents do, and this one is the one a '
    + 'contributor follows to decide what to build');
  // "Status: **design only.**" on its own is the bug: true of Phases 1-11, false of Phase 0.
  const bare = /^Status:\s*\*\*design only\.?\*\*/im.exec(ROADMAP);
  assert.equal(bare, null,
    'roadmap.md opens with an unqualified "design only", which reads as Phase 0 being unbuilt. Qualify it '
    + 'by phase, or defer the overall status to docs/status.md.');
});

// --- Milestone A's stamp must agree across documents (#720) -------------------------------
//
// The milestone stamp moved three times in one week (#719 stamped complete, #720 un-stamped it
// after AC 7/AC 8 were found open, the follow-up set re-stamps when the fixes land). Two documents
// carrying the same fact is exactly how a reader ends up trusting neither, so the stamp itself is
// now cross-checked: whatever the roadmap claims about Milestone A, status.md must say the same.
const STATUS_MD = readFileSync(new URL('../docs/status.md', import.meta.url), 'utf8');

test('the Milestone A stamp in roadmap.md and status.md agree', () => {
  const roadmapComplete = /Milestone A \(Role Presets, Phases 0-3\) is complete/.test(ROADMAP);
  const statusListsMilestone = STATUS_MD.includes('### Role Presets (Crew Milestone A)');
  const followupRefs = STATUS_MD.match(/#7(?:2[1-4])/g) ?? [];
  // BOTH states are fully specified, so neither document can drift half-way:
  //  - "complete": the roadmap stamps it, status.md lists Milestone A under Implemented, and
  //    NO follow-up number from the set remains in status.md's Role Presets section.
  //  - "open": the roadmap withholds the stamp, and status.md MUST both list the milestone and
    //    name the open follow-ups -- omitting the section entirely must fail, not pass.
  if (roadmapComplete) {
    assert.ok(statusListsMilestone,
      'roadmap.md stamps Milestone A complete, but docs/status.md no longer lists it under Implemented');
    assert.deepEqual(followupRefs, [],
      'roadmap.md stamps Milestone A complete, but docs/status.md still references open follow-ups: '
      + JSON.stringify(followupRefs));
  } else {
    assert.ok(statusListsMilestone,
      'roadmap.md withholds the Milestone A stamp, so docs/status.md must still list it under '
      + 'Implemented (it vanished?)');
    assert.ok(followupRefs.length > 0,
      'roadmap.md withholds the Milestone A stamp, so docs/status.md must name the open follow-up '
      + 'issues (#721-#724); it names none, which reads as "complete with no gaps"');
  }
});

test('no Crew doc claims Hermes cannot execute a Run', () => {
  const offenders: string[] = [];
  for (const [name, text] of Object.entries(DOCS)) {
    for (const m of text.matchAll(/Hermes cannot execute any Run/gi)) {
      // "could not" is past tense and is the corrected narrative form, so only the present-tense claim is
      // stale. A present-tense claim inside a passage that goes on to say it was fixed is also fine.
      const around = text.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400);
      if (/does execute Runs|now fixed|has passed|was the gate/i.test(around)) continue;
      offenders.push(`${name}: "${m[0]}"`);
    }
  }
  assert.deepEqual(offenders, [],
    `stale Hermes claims:\n${offenders.join('\n')}\n`
    + 'A Hermes Run completes end to end against a real workspace (docs/phase-0-issues.md, acceptance 4).');
});

test('the Hermes skill-store size is stated once, as the measured figure', () => {
  // teams.md measured 141 on a real v0.21.2 install and gave the breakdown (58 bundled + 83 user).
  // roadmap.md carried a bare 81 for the same fact. Two numbers for one measurement is how a reader
  // ends up trusting neither.
  assert.match(TEAMS, /141 skills[\s\S]{0,40}v0\.21\.2/,
    'teams.md should keep carrying the measured figure with its version, since it is the citation');
  const wrong = Object.entries(DOCS).filter(([, text]) => /\b81 skills\b/.test(text)).map(([n]) => n);
  assert.deepEqual(wrong, [],
    `these cite 81 Hermes skills, which contradicts the measured 141 in teams.md: ${wrong.join(', ')}`);
});