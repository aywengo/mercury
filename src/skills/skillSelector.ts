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
export const KEYWORDS: Record<string, string[]> = {
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

const boundaryPatterns = new Map<string, RegExp>();
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termMatches(term: string, lowerTask: string): boolean {
  if (term.length > SHORT_TERM_MAX) return lowerTask.includes(term);
  let pattern = boundaryPatterns.get(term);
  if (!pattern) {
    pattern = new RegExp(`(^|[^a-z0-9])${escapeForPattern(term)}($|[^a-z0-9])`);
    boundaryPatterns.set(term, pattern);
  }
  return pattern.test(lowerTask);
}

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
