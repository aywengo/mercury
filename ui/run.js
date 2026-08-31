// Run detail page: info, skills, event timeline, live SSE, cancel/retry/input.

import {
  api, logout, currentUser, esc, fmtTime, fmtDuration, statusClass,
  repoLabel, shortId, pretty, sse,
} from './app.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const runId = params.get('run');

let run = null;
let lastSeq = 0;
let pendingInput = null; // { requestId, method, title, message, options, placeholder, prefill }
let stopSse = null;

let user = null; // { ownerId, isAdmin } from /api/auth/me, or null -> bounce to login

$('logout-btn').addEventListener('click', logout);

function showError(msg) {
  const box = $('error-box');
  box.textContent = msg;
  box.classList.remove('hidden');
}

async function loadRun() {
  const data = await api('/api/runs/' + encodeURIComponent(runId));
  run = data.run;
  renderRun(data.run, data.skills || []);
  // Page through history until caught up (issue #54).
  //
  // The endpoint returns at most 1000 events per call, and `lastSequence` is the run's TRUE
  // maximum -- not the last event in the page. The old code did `lastSeq = ev.lastSequence`,
  // so on a 5000-event run it rendered events 1-1000, set lastSeq = 5000, and subscribed from
  // there: events 1001-4999 were never fetched and never rendered, with no error and nothing
  // on screen to indicate it. Silent history loss on exactly the long-running runs this
  // product exists for.
  //
  // Resume from `nextCursor` (the last sequence actually returned) instead, and keep going
  // while the server says there is more.
  for (;;) {
    const ev = await api('/api/runs/' + encodeURIComponent(runId) + '/events?after=' + lastSeq);
    for (const e of ev.events || []) appendEvent(e);
    const next = typeof ev.nextCursor === 'number' ? ev.nextCursor : lastSeq;
    if (next <= lastSeq) break; // no forward progress: stop rather than spin forever
    lastSeq = next;
    if (!ev.hasMore) break;
  }
  connectSse();
}

function renderRun(r, skills) {
  $('run-id').textContent = r.id;
  $('status-badge').innerHTML = `<span class="badge ${statusClass(r.status)}">${esc(r.status)}</span>`;
  $('run-task').textContent = r.task;
  $('f-agent').textContent = r.agent;
  $('f-attempt').textContent = r.attempt;
  $('f-retryof').textContent = r.retryOf ? `<a href="/run.html?run=${encodeURIComponent(r.retryOf)}">${esc(shortId(r.retryOf))}</a>` : '—';
  $('f-repo').textContent = repoLabel(r.repository);
  $('f-branch').textContent = r.workspaceBranch || r.repository.baseBranch || '—';
  $('f-created').textContent = fmtTime(r.createdAt);
  $('f-started').textContent = fmtTime(r.startedAt);
  $('f-completed').textContent = fmtTime(r.completedAt);
  $('f-duration').textContent = fmtDuration(r.startedAt, r.completedAt);
  $('f-error').innerHTML = r.error ? `<span style="color:var(--red)">${esc(r.error)}</span>` : '—';
  $('f-commits').innerHTML = (r.finalCommits || []).length
    ? r.finalCommits.map((c) => `<div class="mono">${esc(c)}</div>`).join('')
    : '—';
  $('f-pr').innerHTML = r.prUrl ? `<a href="${esc(r.prUrl)}" target="_blank">${esc(r.prUrl)}</a>` : '—';

  $('skills').innerHTML = skills.map((s) =>
    `<span class="skill-chip">${esc(s.id)} <span class="v">v${esc(s.version)}</span></span>`
  ).join('') || '<span class="muted">none</span>';

  const c = r.constraints || {};
  $('f-constraints').innerHTML = [
    ['Max duration', c.maxDurationMs ? Math.round(c.maxDurationMs / 1000) + 's' : '—'],
    ['Max retries', c.maxRetries ?? '—'],
    ['Max tokens', c.maxTokens ?? '—'],
    ['Max cost', c.maxCost ?? '—'],
    ['Resource limits', c.resourceLimits ? pretty(c.resourceLimits) : '—'],
    ['Allowed networks', c.allowedNetworks ? c.allowedNetworks.join(', ') : '—'],
  ].map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  // controls
  const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(r.status);
  const cancellable = ['QUEUED', 'STARTING', 'RUNNING', 'NEEDS_INPUT'].includes(r.status);
  $('cancel-btn').disabled = !cancellable;
  $('retry-btn').disabled = !terminal || r.status === 'COMPLETED';
  $('cancel-btn').classList.toggle('hidden', !cancellable);
  $('retry-btn').classList.toggle('hidden', !(terminal && r.status !== 'COMPLETED'));

  // live indicator
  $('live-indicator').textContent = terminal ? '' : '● live';
}

function appendEvent(e) {
  const tl = $('timeline');
  const row = document.createElement('div');
  row.className = 'tl-row ' + e.type.replace(/[^a-z0-9-]/g, '-');
  const payloadText = pretty(e.payload);
  const payloadHtml = payloadText.length > 300
    ? `<details><summary>payload</summary><pre>${esc(payloadText)}</pre></details>`
    : `<pre>${esc(payloadText)}</pre>`;
  row.innerHTML = `
    <span class="tl-seq">${e.sequence}</span>
    <span class="tl-type">${esc(e.type)}</span>
    <span class="tl-time">${esc(fmtTime(e.timestamp))}</span>
    <span class="tl-payload">${payloadHtml}</span>`;
  tl.appendChild(row);
  tl.scrollTop = tl.scrollHeight;

  // handle input.required -> show input panel
  if (e.type === 'input.required') {
    pendingInput = e.payload || {};
    showInputPanel();
  }
  if (e.type === 'input.received') {
    pendingInput = null;
    $('input-panel').classList.add('hidden');
  }
  if (e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'run.cancelled' || e.type === 'run.timed_out') {
    stopSse?.();
    loadRun(); // refresh final state
  }
}

function connectSse() {
  stopSse?.();
  const url = '/api/runs/' + encodeURIComponent(runId) + '/stream?after=' + lastSeq;
  stopSse = sse(url, (type, data) => {
    if (data && typeof data === 'object' && data.sequence > lastSeq) {
      lastSeq = data.sequence;
      appendEvent(data);
    }
  }, (err) => {
    // transient: reconnect after a short delay
    setTimeout(() => { if (run && !['COMPLETED','FAILED','CANCELLED','TIMED_OUT'].includes(run.status)) connectSse(); }, 2000);
  });
}

// ---- input panel ----
function showInputPanel() {
  const p = pendingInput || {};
  $('input-panel').classList.remove('hidden');
  // Support both RPC-style payloads ({method, title, message, options}) and the
  // legacy fake-agent shape ({question, choices}).
  const method = p.method || (p.choices ? 'select' : 'input');
  $('input-title').textContent = p.title || p.question || 'Input required';
  $('input-message').textContent = p.message || '';
  const ctl = $('input-controls');
  ctl.innerHTML = '';
  const options = p.options || p.choices || [];

  if (method === 'select') {
    for (const opt of options) {
      const b = document.createElement('button');
      b.textContent = opt;
      b.style.marginRight = '8px';
      b.addEventListener('click', () => submitInput({ value: opt }));
      ctl.appendChild(b);
    }
  } else if (method === 'confirm') {
    const yes = document.createElement('button');
    yes.textContent = 'Yes';
    yes.style.marginRight = '8px';
    yes.addEventListener('click', () => submitInput({ value: true }));
    const no = document.createElement('button');
    no.className = 'secondary';
    no.textContent = 'No';
    no.addEventListener('click', () => submitInput({ value: false }));
    ctl.append(yes, no);
  } else {
    const ta = document.createElement('textarea');
    ta.placeholder = p.placeholder || 'type your answer…';
    if (p.prefill) ta.value = p.prefill;
    ta.style.width = '100%';
    const send = document.createElement('button');
    send.textContent = 'Submit';
    send.style.marginTop = '8px';
    send.addEventListener('click', () => submitInput({ value: ta.value }));
    ctl.append(ta, send);
  }
}

async function submitInput(value) {
  try {
    await api('/api/runs/' + encodeURIComponent(runId) + '/input', { method: 'POST', json: true, body: JSON.stringify({ input: value }) });
    $('input-panel').classList.add('hidden');
  } catch (err) {
    showError('Input failed: ' + err.message);
  }
}

// ---- controls ----
$('cancel-btn').addEventListener('click', async () => {
  try {
    await api('/api/runs/' + encodeURIComponent(runId) + '/cancel', { method: 'POST' });
  } catch (err) {
    showError('Cancel failed: ' + err.message);
  }
});

$('retry-btn').addEventListener('click', async () => {
  try {
    const res = await api('/api/runs/' + encodeURIComponent(runId) + '/retry', { method: 'POST' });
    location.href = '/run.html?run=' + encodeURIComponent(res.runId);
  } catch (err) {
    showError('Retry failed: ' + err.message);
  }
});

(async () => {
  try {
    user = await currentUser(); // session cookie check (401 -> null)
  } catch {
    user = null;
  }
  if (!user) { location.href = '/'; return; }
  $('user-label').textContent = user.isAdmin ? 'admin' : user.ownerId;
  $('run-title').textContent = shortId(runId);
  loadRun().catch((err) => showError(err.message));
})();
