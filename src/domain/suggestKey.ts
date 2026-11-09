/**
 * Nearest known key, for the unknown-key refusal (extracted from src/host/bots/config.ts,
 * issue #989 / A0-5).
 *
 * A small bounded levenshtein lives in src/domain/ so every closed-shape validator can share
 * ONE helper instead of carrying a private copy: the bot config schema (its historical home),
 * the create-request validator (createRequest.ts) and the A2A exposed-skill catalog
 * (src/a2a/skills.ts) all refuse unknown keys with the same did-you-mean discipline, and the
 * bot boundary guard (dispatcher-bot-design.md section 15 item 4) admits domain modules.
 */

export function suggestionFor(key: string, known: readonly string[]): string | undefined {
  const distance = (a: string, b: string): number => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return dp[a.length][b.length];
  };
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  // Same cap the config schema uses: past ~3 edits it is a different key, not a typo.
  if (best === undefined || bestDistance > Math.max(2, Math.floor(best.length / 4))) return undefined;
  return best;
}
