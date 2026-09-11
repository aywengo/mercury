// Mercury dashboard — shared helpers (session auth, API, SSE, formatting).
//
// Auth: the browser never stores the API token. The login page POSTs the
// token to /api/auth/login, which sets an HttpOnly `mercury_session` cookie.
// Every request below sends that cookie via `credentials: 'same-origin'`
// (fetch's same-origin default, stated explicitly) — no Authorization header.
// SSE uses fetch + ReadableStream because EventSource cannot set credentials/headers.

export async function login(token) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && body.error ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body; // { ok, ownerId, isAdmin }
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* best effort: the cookie expires server-side regardless */ }
  location.href = '/';
}

// Current session identity, or null when no valid session cookie is present.
export async function currentUser() {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth check failed: HTTP ${res.status}`);
  return res.json();
}

export async function api(path, opts = {}) {
  const headers = {
    ...(opts.json ? { 'content-type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    // session expired/invalid -> back to login
    if (!location.pathname.endsWith('run.html')) location.href = '/';
    throw new Error('authentication failed');
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && body.error ? body.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// ---- SSE via fetch streaming (cookie auth via credentials: 'same-origin') ----
// onEvent(type, data) is called for each event; returns an abort function.
export function sse(url, onEvent, onError) {
  const ac = new AbortController();
  let buffer = '';
  let closed = false;

  (async () => {
    try {
      const res = await fetch(url, { credentials: 'same-origin', signal: ac.signal });
      if (!res.ok) {
        const text = await res.text();
        let msg = `SSE HTTP ${res.status}`;
        try { msg = JSON.parse(text).error || msg; } catch {}
        throw new Error(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // parse SSE frames: event: <type>\ndata: <json>\n\n
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let type = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (type === 'hello') continue;
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          onEvent(type, parsed);
        }
      }
    } catch (err) {
      if (!closed && err.name !== 'AbortError') onError?.(err);
    } finally {
      closed = true;
    }
  })();

  return () => { closed = true; ac.abort(); };
}

// ---- formatting ----
export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

export function fmtDuration(startIso, endIso) {
  const start = startIso ? Date.parse(startIso) : null;
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!start) return '—';
  const ms = Math.max(0, end - start);
  if (ms < 1000) return ms + 'ms';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Return the URL only if it is safe to put in an href, else null.
 *
 * esc() is necessary but NOT sufficient for a URL context (issue #57). It neutralises the
 * characters that would break out of the attribute, and `javascript:alert(1)` needs none of them:
 * it is a perfectly well-formed attribute value whose scheme is the payload. So escaping the
 * value and validating the scheme are different jobs, and only the second one stops this.
 *
 * prUrl is attacker-reachable: it arrives from a `git.pr` event, which the agent process emits,
 * and the agent operates inside a repository that may itself be untrusted. A stored
 * `javascript:` URL therefore turns the run detail page into XSS against whoever is watching the
 * run.
 *
 * Absolute http(s) only. Relative URLs are rejected on purpose: a PR link is always absolute, and
 * accepting relatives would mean resolving against the dashboard's own origin.
 */
export function safeUrl(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  let url;
  try {
    // No base argument: that is what makes a relative URL throw instead of silently resolving
    // against this page.
    url = new URL(raw);
  } catch {
    return null;
  }
  // Compare the parsed protocol, never the raw string. URL parsing strips tabs and newlines, so
  // `java\tscript:alert(1)` -- which a substring check on the raw text would wave through --
  // arrives here as exactly 'javascript:'.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.href;
}

/**
 * Goal status badge markup. Shared by the list and the run page so the two cannot drift into
 * describing the same status differently.
 *
 * `goals` is the parallel map from the API, keyed by run id. Three states, three renderings:
 *   map has the run  -- the Run has a goal with this status
 *   map, no such key -- the server answered and the Run has no goal
 *   no map at all    -- the server predates goals, so nothing is known
 *
 * The third must not read "no goal". That would assert an absence on the strength of a server
 * that never had the field, which is the same lie as rendering an undetected capability as
 * "unsupported".
 *
 * Returns escaped markup: the status is interpolated through esc() because it becomes an
 * attribute value and element text, and every caller assigns the result to innerHTML.
 */
export function goalBadge(goals, runId) {
  if (goals === undefined) {
    return '<span class="badge goal-unknown" title="server does not report goals">?</span>';
  }
  const status = goals[runId];
  if (!status) return '<span class="badge goal-none" title="this run has no goal">\u2014</span>';
  return `<span class="badge goal-${esc(status)}" title="goal status, independent of run status">${esc(status)}</span>`;
}

/**
 * Goal status as a short label for the run page badge.
 *
 * Same three states as goalBadge. Kept separate from statusClass on purpose: goal status and
 * Run status are orthogonal axes, and sharing a class lookup would invite someone to render one
 * in place of the other.
 */
/**
 * Declared gates as escaped markup for the Run page.
 *
 * Renders the SPEC, never an outcome. Mercury records gate specs and does not execute them
 * (docs/goals.md 5), so this list says what the harness was asked to enforce -- it is not
 * evidence that anything passed. There is deliberately no pass/fail styling and no tick: a
 * green tick next to `npm test` under a COMPLETED Run would be a fabricated result, and the
 * design's whole point is that Mercury does not judge completion.
 *
 * Returns '' when there is nothing to say: no goal, or a goal with no gates. Not a placeholder
 * line, because "no gates" is the ordinary case and a permanent empty section would train the
 * eye to skip it -- which is how the interesting case gets missed too.
 *
 * `command` is caller-supplied text that round-trips through the API and lands in innerHTML, so
 * it goes through esc(). The timeout and retry count are numbers, but they are interpolated via
 * String() through esc() anyway rather than trusted, because they arrive over the wire and a
 * server that sends a string there should produce escaped text, not markup.
 */
/**
 * The harness build that executed a Run, as text (docs/goals.md 13.1).
 *
 * Separate from the agent id on purpose: the agent says which adapter ran, this says which binary
 * it talked to, and the second is the datum whose absence made issue #465 hard to close.
 *
 * Three answers, and the two unknowns are distinguished because they want different actions:
 *   "0.9.4 (prime-agent 0.9.4)"  -- resolved, with the raw output when it differs
 *   "unknown (dev build)"        -- probed and got something unparsable: the probe needs fixing
 *   "unknown"                    -- nothing was probed or recorded: nothing to fix, just no data
 *
 * Returns plain text for textContent, so no escaping is needed or wanted here.
 */
export function harnessLabel(run) {
  if (!run) return 'unknown';
  if (run.agentVersion) {
    const raw = run.agentVersionRaw;
    return raw && raw !== run.agentVersion ? `${run.agentVersion} (${raw})` : String(run.agentVersion);
  }
  if (run.agentVersionRaw) return `unknown (${run.agentVersionRaw})`;
  return 'unknown';
}

export function goalGatesHtml(goal) {
  if (!goal || !Array.isArray(goal.gates) || goal.gates.length === 0) return '';
  const items = goal.gates.map((g) => {
    const timeout = esc(String(g.timeoutMs));
    const retries = Number(g.maxRetries) > 0 ? ` <span class="gate-meta">+${esc(String(g.maxRetries))} retries</span>` : '';
    return `<li><code>${esc(String(g.command))}</code>`
      + `<span class="gate-meta">timeout ${timeout}ms${retries}</span></li>`;
  });
  return `<ul class="goal-gates">${items.join('')}</ul>`;
}

export function goalLabel(goal) {
  if (goal === undefined) return { text: 'goal ?', cls: 'goal-unknown', title: 'server does not report goals' };
  if (goal === null) return { text: 'no goal', cls: 'goal-none', title: 'this run has no goal' };
  // An unmet goal whose Run never started is a different fact from one that ran and never declared
  // success, and the badge used to render them identically -- so the dashboard showed an ordinary
  // infrastructure failure with the same weight as the signal the feature exists to surface
  // (issue #489). Spelled out rather than left to a tooltip: hiding the distinction behind a hover
  // reproduces the problem at one interaction deeper.
  if (goal.status === 'unmet' && goal.attempted === false) {
    return {
      text: 'goal: unmet (never started)',
      cls: 'goal-unmet goal-unattempted',
      title: 'the Run reached a terminal status before the harness ever received the objective',
    };
  }
  return { text: `goal: ${goal.status}`, cls: `goal-${goal.status}`, title: 'goal status (independent of Run status)' };
}


export function statusClass(status) {
  return 'status-' + String(status).toLowerCase();
}

export function repoLabel(repo) {
  if (!repo) return '—';
  return repo.localPath || repo.url || '—';
}

export function shortId(id) {
  return id && id.length > 12 ? id.slice(0, 12) + '…' : id || '—';
}

export function pretty(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
