// Deterministic automatic skill selection (Mercury.md section 12.2).
// Keyword scoring against skill capabilities/description; no semantic retrieval.

import type { SkillMeta } from './skillRegistry.ts';

const KEYWORDS: Record<string, string[]> = {
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

export interface SkillSelector {
  select(task: string, available: SkillMeta[], maxSkills: number): string[];
}

export function createSkillSelector(): SkillSelector {
  return {
    select(task, available, maxSkills = 4) {
      const lower = task.toLowerCase();
      const scored: { id: string; score: number }[] = [];
      for (const skill of available) {
        const keywords = KEYWORDS[skill.id] ?? [];
        const haystack = `${skill.id} ${skill.description} ${skill.capabilities.join(' ')}`.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (lower.includes(kw)) score += 1;
          if (haystack.includes(kw)) score += 0.5;
        }
        if (score > 0) scored.push({ id: skill.id, score });
      }
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      const picked = scored.slice(0, maxSkills).map((s) => s.id);
      return picked.length > 0 ? picked : FALLBACK.filter((id) => available.some((a) => a.id === id));
    },
  };
}
