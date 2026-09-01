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
