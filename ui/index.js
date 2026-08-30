// Run list page: login, create run, list + filter + poll.

import { api, login, logout, currentUser, esc, fmtTime, fmtDuration, statusClass, repoLabel, shortId } from './app.js';

const $ = (id) => document.getElementById(id);

let user = null; // { ownerId, isAdmin } from /api/auth/me, or null (login screen)

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('logout-btn').classList.add('hidden');
  $('user-label').textContent = '';
}

async function loadAgents() {
  try {
    const { agents } = await api('/api/agents');
    if (!Array.isArray(agents)) return; // defensive: keep the static options
    const select = $('agent');
    select.innerHTML = '';
    for (const a of agents) {
      const opt = document.createElement('option');
      opt.value = a;
      opt.textContent = a;
      select.appendChild(opt);
    }
  } catch {
    // keep the static options as a fallback
  }
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
  $('user-label').textContent = user?.isAdmin ? 'admin' : user?.ownerId || '';
  loadAgents();
  loadRuns();
}

$('login-btn').addEventListener('click', async () => {
  const token = $('token-input').value.trim();
  if (!token) return;
  try {
    user = await login(token); // exchanges the token for an HttpOnly session cookie
    $('token-input').value = '';
    if (location.pathname !== '/') { location.href = '/'; return; }
    showApp();
  } catch (err) {
    showError('Login failed: ' + err.message);
  }
});
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
$('logout-btn').addEventListener('click', logout);

function showError(msg) {
  const box = $('error-box');
  box.textContent = msg;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 5000);
}

$('create-btn').addEventListener('click', async () => {
  const task = $('task').value.trim();
  if (!task) { showError('Task is required'); return; }
  const repoPath = $('repo').value.trim();
  const repository = repoPath ? { localPath: repoPath, baseBranch: $('branch').value.trim() || 'main' } : {};
  const body = { task, repository, agent: $('agent').value };
  try {
    const res = await api('/api/runs', { method: 'POST', json: true, body: JSON.stringify(body) });
    $('task').value = '';
    location.href = '/run.html?run=' + encodeURIComponent(res.runId);
  } catch (err) {
    showError('Create failed: ' + err.message);
  }
});

$('refresh-btn').addEventListener('click', loadRuns);
$('status-filter').addEventListener('change', loadRuns);

let pollTimer = null;
async function loadRuns() {
  const status = $('status-filter').value;
  const q = status ? '?status=' + encodeURIComponent(status) + '&limit=100' : '?limit=100';
  try {
    const data = await api('/api/runs' + q);
    renderRuns(data.runs || []);
  } catch (err) {
    showError(err.message);
  }
}

function renderRuns(runs) {
  const tbody = $('runs-body');
  $('empty').classList.toggle('hidden', runs.length > 0);
  tbody.innerHTML = runs.map((r) => {
    const dur = fmtDuration(r.startedAt, r.completedAt);
    return `<tr>
      <td class="mono"><a href="/run.html?run=${encodeURIComponent(r.id)}">${esc(shortId(r.id))}</a></td>
      <td class="task"><div class="task-text">${esc(r.task)}</div></td>
      <td class="mono">${esc(repoLabel(r.repository))}</td>
      <td>${esc(r.agent)}</td>
      <td><span class="badge ${statusClass(r.status)}">${esc(r.status)}</span></td>
      <td class="muted">${esc(fmtTime(r.createdAt))}</td>
      <td class="muted">${esc(dur)}</td>
    </tr>`;
  }).join('');
}

// poll every 3s (list endpoint has no SSE; per-run stream exists on the detail page)
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (user && !document.hidden) loadRuns(); }, 3000);
}

(async () => {
  try {
    user = await currentUser(); // null when no valid session cookie
  } catch {
    user = null;
  }
  if (user) showApp();
  else showLogin();
  startPolling();
})();
