// Shared HTTP plumbing for the bot's scheduler clients (B1-1 #735; FB2b #973).
//
// Both clients — the host one (`process.ts`, `POST /api/runs`) and the Fleet one
// (`fleetClient.ts`, `POST /fleet/runs`) — talk to a Mercury-shaped API over fetch with a bearer
// token, a per-request deadline, and the same capped-backoff health probe. Keeping that in one
// module means a fix to the probe (bounds, backoff) lands for both, and neither client has to
// import the other.

/** Capped backoff for the start-ordering probe (§10): 5 attempts, 15 s cap. */
export const PROBE_ATTEMPTS = 5;
export const PROBE_BACKOFF_CAP_MS = 15_000;

/**
 * GET /healthz until it answers 2xx, with capped backoff. Throws only after the last attempt.
 * A `--once` run and a long-lived bot share this: a bot that starts before its API is useless
 * until the API is up, and a silent retry loop hides that.
 */
export async function probeHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return;
      lastErr = new Error(`/healthz answered ${res.status}`);
    } catch (err) {
      lastErr = err as Error;
    }
    if (attempt < PROBE_ATTEMPTS) {
      const delay = Math.min(2 ** (attempt - 1) * 1000, PROBE_BACKOFF_CAP_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`API unreachable after ${PROBE_ATTEMPTS} attempts: ${lastErr?.message ?? 'unknown'}`);
}
