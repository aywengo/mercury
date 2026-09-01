// Deterministic automatic skill selection (Mercury.md section 12.2).
// Scores how many of a skill's terms appear in the task text; no semantic retrieval.
//
// Scoring is deliberately task-only. It used to add +0.5 for every term that also
// occurred in the skill's own id/description/capabilities, but a term derived from a
// skill's own metadata matches that metadata for every task, so it contributed a
// per-skill constant. A constant cannot rank one task against another; it only
// rewarded skills with verbose metadata. Dropping it makes the score mean
// "terms the task actually asked for".

import { compareSkillIds, type SkillMeta } from './skillRegistry.ts';

// Optional extra trigger terms, keyed by skill id. This is an OVERRIDE that adds
// to a skill's own capabilities, not the source of them -- see termsFor(). It exists
// for terms a capability name does not cover, e.g. 'migrat' matching 'migration'.
//
// Exported so a test can check it against the registry (issue #79). A key naming a
// skill that was renamed or deleted is never consulted at runtime, so without that
// check a stale entry is invisible.
export const KEYWORDS: Readonly<Partial<Record<string, readonly string[]>>> = {
  planning: ['plan', 'roadmap', 'design', 'architecture', 'approach', 'outline'],
  'repository-analysis': ['inspect', 'analy', 'understand', 'explore', 'codebase', 'repository', 'onboard'],
  implementation: ['implement', 'build', 'create', 'add', 'feature', 'fix', 'change', 'write', 'upgrade', 'migrat'],
  testing: ['test', 'suite', 'integration', 'unit', 'verify', 'regression', 'spec'],
  debugging: ['debug', 'bug', 'crash', 'error', 'fail', 'trace', 'root cause', 'broken'],
  'code-review': ['review', 'quality', 'refactor', 'clean'],
  'security-review': ['security', 'vulnerab', 'auth', 'secret', 'injection', 'xss', 'csrf', 'permission'],
  'git-pr': ['pr', 'pull request', 'commit', 'branch', 'merge', 'push'],
};

const FALLBACK = ['planning', 'implementation', 'testing', 'git-pr'];

/**
 * Scoring terms for a skill (issue #78).
 *
 * Capabilities are the primary signal. Every skill declares them in its SKILL.md
 * frontmatter, so a newly added skill is selectable without editing this file.
 * Scoring used to be driven only by the KEYWORDS map above, keyed by skill id, so a
 * skill with no entry scored 0 against every task and could never be selected --
 * silently, with no test to catch it. Four of twelve skills were unreachable that way.
 *
 * Capabilities are hyphenated ('pull-request', 'root-cause') while task text is
 * normally spaced ('open a pull request'), so each hyphenated term also contributes
 * its spaced form.
 */
function termsFor(skill: SkillMeta): string[] {
  const terms = new Set<string>();
  for (const capability of skill.capabilities) {
    const term = capability.toLowerCase().trim();
    if (!term) continue;
    terms.add(term);
    const spaced = term.replace(/-/g, ' ');
    if (spaced !== term) terms.add(spaced);
  }
  for (const keyword of KEYWORDS[skill.id] ?? []) terms.add(keyword.toLowerCase());
  return [...terms];
}

// Terms of three characters or fewer are complete words or abbreviations, not stems,
// and raw substring matching lets them fire inside unrelated ordinary words: the 'ui'
// in 'suite' and 'building', the 'pr' in 'prepare' and 'production', the 'add' in
// 'metadata'. Longer terms stay substring-matched deliberately, because KEYWORDS holds
// stems on purpose. The limit is 3 and not 4 because of one term: 'test'. At 4 it would
// need a word boundary, so 'run the tests' stops matching and testing is reached only
// through FALLBACK -- measured, not assumed. 'analy'->'analysis' and
// 'migrat'->'migration' still survive at 4 or 5; 'test' is what pins the value.
const SHORT_TERM_MAX = 3;

/**
 * Terms that are intentional word PREFIXES rather than complete words (issues #87, #88).
 *
 * These are the only terms substring-matched above SHORT_TERM_MAX. Everything else is a complete
 * word and gets word boundaries, because substring matching a complete word is what made 13 of 13
 * off-domain tasks pick the wrong skill: 'secret' fired inside 'secretary', 'unit' inside
 * 'community', 'merge' inside 'emergency', 'commit' inside 'committee', 'test' inside 'greatest',
 * 'plan' inside 'plant', 'auth' inside 'author'.
 *
 * The old rule was purely length-based (substring above 3 chars), which conflated two different
 * things that happen to be similar lengths: stems like 'migrat' that MUST substring-match to work
 * at all, and complete words like 'test' that must NOT. Length cannot separate them -- 'migrat' is
 * 6 and 'secret' is 6 -- so the distinction has to be stated.
 *
 * Adding a term here is a deliberate choice to accept that it will fire inside unrelated words.
 */
/** Below this length a trailing 's' is part of the term, not a plural marker ('css', 'xss'). */
const PLURAL_STRIP_MIN = 4;

const STEM_TERMS = new Set(['analy', 'migrat', 'vulnerab']);

const boundaryPatterns = new Map<string, RegExp>();
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a term against the lowercased task.
 *
 * Complete words are anchored to word boundaries and tolerate a plural on either side (issue #87):
 * the capability 'runbooks' previously failed to match "write the runbook for restoring from
 * backup" while matching "...the runbooks...", because scoring asked whether the TASK contained
 * the capability, and a singular task can never contain a plural capability. The reverse direction
 * already worked by accident, since 'README' is a substring of 'READMEs'.
 *
 * A stem is matched as a bare substring, which is the whole point of writing it truncated.
 */
export function termMatches(term: string, lowerTask: string): boolean {
  if (term.length > SHORT_TERM_MAX && STEM_TERMS.has(term)) return lowerTask.includes(term);
  let pattern = boundaryPatterns.get(term);
  if (!pattern) {
    // Fold a trailing 's' so one pattern covers both directions of the singular/plural mismatch
    // ('runbooks' must reach a task that says 'runbook'). Only when the remainder is long enough
    // to plausibly be a singular word: 'css' and 'xss' end in 's' but are abbreviations, and
    // stripping gives 'cs' and 'xs' -- terms that never occur, so the pattern would match a bare
    // 'cs' or 'xs' in task text and fire security-review on unrelated words.
    const stripS = term.endsWith('s') && term.length - 1 >= PLURAL_STRIP_MIN;
    const base = stripS ? term.slice(0, -1) : term;
    // (e?s)? requires the 's', so it accepts 'push'/'pushes' and 'runbook'/'runbooks' but NOT a
    // bare 'e': 'plane' does not match 'plan'. It does accept a few non-words ('pushs'), which is
    // harmless in a scoring heuristic; the alternative, a real stemmer, would make selection depend
    // on an algorithm nobody reading the skill file can predict.
    const plural = stripS ? 's?' : '(e?s)?';
    pattern = new RegExp(`(^|[^a-z0-9])${escapeForPattern(base)}${plural}($|[^a-z0-9])`);
    boundaryPatterns.set(term, pattern);
  }
  return pattern.test(lowerTask);
}

/** The scoring terms for a skill (capabilities + hyphen variants + KEYWORDS). */
export function termsForSkill(skill: SkillMeta): string[] { return termsFor(skill); }

export interface SkillSelector {
  select(task: string, available: SkillMeta[], maxSkills: number): string[];
}

export function createSkillSelector(): SkillSelector {
  return {
    select(task, available, maxSkills = 4) {
      const lower = task.toLowerCase();
      const scored: { id: string; score: number }[] = [];
      for (const skill of available) {
        const keywords = termsFor(skill);
        let score = 0;
        for (const kw of keywords) {
          if (termMatches(kw, lower)) score += 1;
        }
        if (score > 0) scored.push({ id: skill.id, score });
      }
      scored.sort((a, b) => b.score - a.score || compareSkillIds(a.id, b.id));
      const picked = scored.slice(0, maxSkills).map((s) => s.id);
      return picked.length > 0 ? picked : FALLBACK.filter((id) => available.some((a) => a.id === id));
    },
  };
}
