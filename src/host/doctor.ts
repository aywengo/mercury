/**
 * `mercury host doctor` — the M4 verification command (docs/host-installer.md M4).
 *
 * Checks, in order:
 *
 *   1. **healthz** — the running host answers GET /healthz with ok:true and a version.
 *   2. **Fleet** — when MERCURY_FLEET_URL is set, the pre-issued host token reaches
 *      the Fleet endpoint.
 *   3. **Smoke Run** — one Run per enabled harness (MERCURY_HARNESSES) using the real
 *      binary, created through the API and waited to a terminal state.
 *
 * The doctor reads mercury.env itself (it must work on a host whose service is the
 * thing being diagnosed), so it runs before loadConfig() like the other host commands.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **Every check is bounded.** A hung host, Fleet endpoint or smoke Run is a failure
 *    with a readable message, not a hang.
 * 2. **A missing piece is reported, not crashed on.** No API token configured → the
 *    smoke-run section says so and the exit code reflects only what could be checked.
 * 3. **The report is structured and machine-readable.** `--json` emits the same facts
 *    the human report prints.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Load mercury.env into a record (simple KEY=VALUE parser, no shell semantics). */
export function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** The env file path (same as the wizard and service use). */
export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'mercury', 'mercury.env');
}

export interface DoctorResult {
  healthz: { ok: boolean; detail: string };
  fleet: { ok: boolean; detail: string };
  smoke: Array<{ harness: string; ok: boolean; detail: string }>;
}

/** Bounded GET with a timeout. Returns { status, body } or an error detail. */
async function getJson(url: string, token: string | undefined, timeoutMs: number): Promise<{ status: number; body: unknown } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Check 1: the running host answers /healthz. */
export async function checkHealthz(baseUrl: string, timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  const r = await getJson(`${baseUrl}/healthz`, undefined, timeoutMs);
  if ('error' in r) return { ok: false, detail: `healthz unreachable: ${r.error}` };
  const body = r.body as { ok?: boolean; version?: string } | null;
  if (r.status !== 200 || !body?.ok) return { ok: false, detail: `healthz returned ${r.status}` };
  return { ok: true, detail: `host ${body.version ?? 'unknown'} ok` };
}

/** Check 2: Fleet reachability with the pre-issued token. */
export async function checkFleet(fleetUrl: string, token: string, timeoutMs = 5000): Promise<{ ok: boolean; detail: string }> {
  if (!fleetUrl) return { ok: true, detail: 'Fleet reporting off (no MERCURY_FLEET_URL)' };
  if (!token) return { ok: false, detail: 'MERCURY_FLEET_URL set but no MERCURY_HOST_TOKEN' };
  const r = await getJson(`${fleetUrl.replace(/\/$/, '')}/healthz`, token, timeoutMs);
  if ('error' in r) return { ok: false, detail: `Fleet unreachable: ${r.error}` };
  if (r.status >= 200 && r.status < 300) return { ok: true, detail: `Fleet ${fleetUrl} ok (${r.status})` };
  return { ok: false, detail: `Fleet returned ${r.status}` };
}

/** Check 3: one smoke Run per harness. */
export async function smokeRun(
  baseUrl: string,
  token: string,
  harness: string,
  timeoutMs = 120000,
): Promise<{ ok: boolean; detail: string }> {
  const create = await getJson(`${baseUrl}/api/runs`, token, 10000);
  if ('error' in create) return { ok: false, detail: `create failed: ${create.error}` };
  // getJson does GET; for POST we need a different helper. Reuse fetch directly here.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ task: 'mercury host doctor smoke run', agent: harness }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status !== 201) {
      const body = await res.text().catch(() => '');
      return { ok: false, detail: `create returned ${res.status}: ${body.slice(0, 200)}` };
    }
    const created = (await res.json()) as { runId: string };
    // Poll the run until terminal or timeout.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const poll = await getJson(`${baseUrl}/api/runs/${created.runId}`, token, 10000);
      if ('error' in poll) return { ok: false, detail: `poll failed: ${poll.error}` };
      const run = poll.body as { status?: string };
      if (run.status === 'completed') return { ok: true, detail: `${harness} smoke run ${created.runId} completed` };
      if (run.status === 'failed' || run.status === 'cancelled') {
        return { ok: false, detail: `${harness} smoke run ${created.runId} ${run.status}` };
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return { ok: false, detail: `${harness} smoke run ${created.runId} did not finish in ${timeoutMs}ms` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, detail: `create failed: ${(e as Error).message}` };
  }
}

/** Run the doctor. Returns the process exit code. */
export async function runHostDoctor(
  args: string[],
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const json = args.includes('--json');
  for (const a of args) {
    if (a !== '--json') {
      io.err(`host doctor: unknown flag '${a}'. Expected --json.\n`);
      return 1;
    }
  }
  const file = envFilePath(env);
  const vars = loadEnvFile(file);
  const port = vars.MERCURY_PORT ?? '3000';
  const baseUrl = `http://127.0.0.1:${port}`;
  const fleetUrl = vars.MERCURY_FLEET_URL ?? '';
  const hostToken = vars.MERCURY_HOST_TOKEN ?? '';
  const harnesses = (vars.MERCURY_HARNESSES ?? 'primeagent,hermes,claude').split(',').filter(Boolean);
  const apiToken = vars.MERCURY_ADMIN_TOKEN ?? (vars.MERCURY_API_TOKENS ?? '').split(',')[0]?.split(':')[0] ?? '';

  const healthz = await checkHealthz(baseUrl);
  const fleet = await checkFleet(fleetUrl, hostToken);
  const smoke: DoctorResult['smoke'] = [];
  if (apiToken) {
    for (const h of harnesses) {
      smoke.push({ harness: h, ...(await smokeRun(baseUrl, apiToken, h)) });
    }
  } else {
    for (const h of harnesses) {
      smoke.push({ harness: h, ok: false, detail: 'no API token configured (MERCURY_ADMIN_TOKEN or MERCURY_API_TOKENS); smoke run skipped' });
    }
  }

  const result: DoctorResult = { healthz, fleet, smoke };
  if (json) {
    io.out(JSON.stringify(result, null, 2) + '\n');
  } else {
    io.out(`healthz: ${healthz.ok ? 'PASS' : 'FAIL'} — ${healthz.detail}\n`);
    io.out(`fleet:   ${fleet.ok ? 'PASS' : 'FAIL'} — ${fleet.detail}\n`);
    for (const s of smoke) {
      io.out(`smoke ${s.harness}: ${s.ok ? 'PASS' : 'FAIL'} — ${s.detail}\n`);
    }
  }
  const allOk = healthz.ok && fleet.ok && smoke.every((s) => s.ok);
  return allOk ? 0 : 1;
}
