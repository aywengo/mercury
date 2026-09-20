/**
 * `mercury host doctor` — the M4 verification command (docs/host-installer.md M4).
 *
 * Checks, in order:
 *
 *   1. **healthz** — the running host answers GET /healthz with ok:true and a version.
 *   2. **Smoke Run** — one Run per enabled harness (MERCURY_HARNESSES) using the real
 *      binary, created through the API and waited to a terminal state.
 *
 * (There is no Fleet check: Fleet is pull, not push — issue #645. The host never
 * contacts Fleet, so registration is verified from the Fleet side.)
 *
 * The doctor reads mercury.env itself (it must work on a host whose service is the
 * thing being diagnosed), so it runs before loadConfig() like the other host commands.
 *
 * Three rules this file exists to enforce:
 *
 * 1. **Every check is bounded.** A hung host or smoke Run is a failure
 *    with a readable message, not a hang.
 * 2. **A missing piece is reported, not crashed on.** No API token configured → the
 *    smoke-run section says so and the exit code reflects only what could be checked.
 * 3. **The report is structured and machine-readable.** `--json` emits the same facts
 *    the human report prints.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * A tiny throwaway git repo for smoke runs. Runs need a repository to get a workspace
 * (copy mode requires localPath; git-worktree mode clones a URL), so the doctor keeps
 * one in the state dir. Created once, reused.
 */
export function ensureSmokeRepo(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  const dir = join(base, 'mercury', 'smoke-repo');
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { timeout: 10000 });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'mercury@localhost'], { timeout: 5000 });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Mercury Host'], { timeout: 5000 });
  writeFileSync(join(dir, 'README.md'), '# mercury host smoke repo\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { timeout: 5000 });
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial'], { timeout: 5000 });
  return dir;
}

export interface DoctorResult {
  healthz: { ok: boolean; detail: string };
  /** Second healthz check against the non-loopback bind address (#665). Undefined when
   *  MERCURY_BIND_HOST is unset or loopback — there is nothing extra to verify. */
  bindHealthz?: { address: string; ok: boolean; detail: string };
  smoke: Array<{ harness: string; ok: boolean; detail: string; skipped?: boolean }>;
  /** True when every smoke check was skipped (no API token): the exit code treats it as a failure (#648). */
  allSmokeSkipped: boolean;
  /** True when MERCURY_HARNESSES is set but empty/blank: nothing was configured to verify (#654). */
  noHarnesses: boolean;
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
    return { error: e instanceof Error ? e.message : String(e) };
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

/** Check 2: one smoke Run per harness. */
// (No Fleet check: Fleet is pull, not push — issue #645. The host never contacts Fleet,
// so a host-side "Fleet reachability" probe could only verify that some URL answers
// /healthz, not that this host is registered. Registration is verified from Fleet.)
export async function smokeRun(
  baseUrl: string,
  token: string,
  harness: string,
  timeoutMs = 120000,
  smokeRepo?: string,
): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      // Bounded instruction (#648): an open-ended task lets a real harness wander in the
      // workspace; the smoke check only proves the pipeline runs end to end.
      body: JSON.stringify({ task: 'Reply with the single word DONE. Do not modify any files.', agent: harness, ...(smokeRepo ? { repository: { localPath: smokeRepo } } : {}) }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status !== 201) {
      const body = await res.text().catch(() => '');
      return { ok: false, detail: `create returned ${res.status}: ${body.slice(0, 200)}` };
    }
    const created = (await res.json()) as { runId: string };
    // Poll the run until terminal or timeout. GET /api/runs/:runId returns
    // { run: { status }, skills, goal, knowledge } with UPPERCASE RunStatus values
    // (src/domain/types.ts) — the shape the mock in the tests mirrors (review #635).
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const poll = await getJson(`${baseUrl}/api/runs/${created.runId}`, token, 10000);
      if ('error' in poll) return { ok: false, detail: `poll failed: ${poll.error}` };
      const body = poll.body as { run?: { status?: string } } | null;
      const status = body?.run?.status;
      if (status === 'COMPLETED') return { ok: true, detail: `${harness} smoke run ${created.runId} completed` };
      if (status === 'FAILED' || status === 'CANCELLED' || status === 'TIMED_OUT') {
        return { ok: false, detail: `${harness} smoke run ${created.runId} ${status}` };
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    return { ok: false, detail: `${harness} smoke run ${created.runId} did not finish in ${timeoutMs}ms` };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, detail: `create failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The scheme the API actually serves (#668 round 6): with MERCURY_TLS_CERT +
 *  MERCURY_TLS_KEY the server is https (src/api/server.ts); a hardcoded http://
 *  would produce false failures and wrong registration URLs. */
export function schemeFor(vars: Record<string, string | undefined>): 'https' | 'http' {
  return vars.MERCURY_TLS_CERT && vars.MERCURY_TLS_KEY ? 'https' : 'http';
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
  const allowNoHarnesses = args.includes('--allow-no-harnesses');
  for (const a of args) {
    if (a !== '--json' && a !== '--allow-no-harnesses') {
      io.err(`host doctor: unknown flag '${a}'. Expected --json, --allow-no-harnesses.\n`);
      return 1;
    }
  }
  const file = envFilePath(env);
  const vars = loadEnvFile(file);
  const port = vars.MERCURY_PORT ?? '3000';
  const scheme = schemeFor(vars);
  const baseUrl = `${scheme}://127.0.0.1:${port}`;
  // Trim entries: 'primeagent, claude' (space) must not smoke-run a harness named ' claude'
  // (review of #651). Unknown ids surface as a failed smoke Run, not a crash.
  // MERCURY_HARNESSES set but empty (#654): the default list does NOT apply to an
  // explicit empty value — that is "configured to verify nothing" and is reported.
  const rawHarnesses = vars.MERCURY_HARNESSES;
  const harnesses = (rawHarnesses ?? 'primeagent,hermes,claude').split(',').map((s) => s.trim()).filter(Boolean);
  const noHarnesses = rawHarnesses !== undefined && harnesses.length === 0;
  const apiToken = vars.MERCURY_ADMIN_TOKEN ?? (vars.MERCURY_API_TOKENS ?? '').split(',')[0]?.split(':')[0] ?? '';

  const healthz = await checkHealthz(baseUrl);
  // Issue #665: when the wizard exposed the API on a non-loopback bind address, the
  // loopback check above can pass while the address Fleet will actually use does not
  // answer (wrong interface, firewall). Verify BOTH and report both.
  const bindAddress = vars.MERCURY_BIND_HOST?.trim() ?? '';
  // The skip comparison is case-insensitive (`Loopback` in the file must not trigger a
  // bogus http://Loopback:<port> request — Copilot round 3 on #668); the original
  // spelling is kept for the report and the URL.
  // This check exists to verify the address FLEET will dial (issue #665). Loopback-
  // equivalent addresses (127.0.0.1, ::1, localhost, loopback) are already verified by
  // the main healthz above and are unreachable from Fleet by definition — setup.ts's
  // hand-off tells the operator exactly that (round 7 on #668). 0.0.0.0 is a bind
  // wildcard, not a connectable destination (Copilot round 1 on #668).
  const bindSkipped = ['127.0.0.1', '0.0.0.0', 'loopback', 'localhost', '::1'].includes(bindAddress.toLowerCase());
  const bindHealthz = bindAddress && !bindSkipped
    ? { address: bindAddress, ...(await checkHealthz(`${scheme}://${bindAddress}:${port}`)) }
    : undefined;
  const smoke: DoctorResult['smoke'] = [];
  if (apiToken) {
    const smokeRepo = ensureSmokeRepo(env);
    for (const h of harnesses) {
      smoke.push({ harness: h, ...(await smokeRun(baseUrl, apiToken, h, 120000, smokeRepo)) });
    }
  } else {
    for (const h of harnesses) {
      smoke.push({ harness: h, ok: false, skipped: true, detail: 'no API token configured (MERCURY_ADMIN_TOKEN or MERCURY_API_TOKENS); smoke run skipped' });
    }
  }

  const anySkipped = smoke.length > 0 && smoke.every((s) => s.skipped);
  const result: DoctorResult = { healthz, bindHealthz, smoke, allSmokeSkipped: anySkipped, noHarnesses };
  if (json) {
    io.out(JSON.stringify(result, null, 2) + '\n');
  } else {
    io.out(`healthz: ${healthz.ok ? 'PASS' : 'FAIL'} — ${healthz.detail}\n`);
    if (bindHealthz) {
      io.out(`healthz (bind ${bindHealthz.address}): ${bindHealthz.ok ? 'PASS' : 'FAIL'} — ${bindHealthz.detail}\n`);
    }
    for (const s of smoke) {
      io.out(`smoke ${s.harness}: ${s.ok ? 'PASS' : 'FAIL'} — ${s.detail}\n`);
    }
    if (noHarnesses) {
      io.out(
        allowNoHarnesses
          ? `no harnesses configured (MERCURY_HARNESSES is set but empty in ${file}); ` +
            'nothing smoke-verified (--allow-no-harnesses: accepted for a host that runs none).\n'
          : `no harnesses configured (MERCURY_HARNESSES is set but empty in ${file}); ` +
            'nothing to smoke-verify, so this is a failure, not a pass. ' +
            'Re-run `mercury host setup`, list harnesses in MERCURY_HARNESSES, or pass --allow-no-harnesses.\n',
      );
    }
    if (anySkipped) {
      io.out(
        `every smoke check was skipped (no MERCURY_ADMIN_TOKEN or MERCURY_API_TOKENS in ${file}); ` +
        'nothing was verified, so this is a failure, not a pass. Run `mercury host setup` to write a token.\n',
      );
    }
  }
  // Skipped checks (no API token) do not fail the doctor as failures (review #635),
  // but a fresh-install invocation where EVERY smoke check was skipped must not exit 0
  // either (#648): the M4 gate is "at least one harness Run completed", and "all
  // skipped" verifies nothing while reading as success. Partial skips still pass.
  // The same class for #654: an empty MERCURY_HARNESSES verifies nothing by
  // configuration. It fails unless --allow-no-harnesses says the host runs none.
  const allOk = healthz.ok && (bindHealthz ? bindHealthz.ok : true) && smoke.every((s) => s.ok || s.skipped) && !anySkipped && !(noHarnesses && !allowNoHarnesses);
  return allOk ? 0 : 1;
}
