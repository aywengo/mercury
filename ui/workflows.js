// Workflows page: browse advisory templates, inspect the steps, create a Run from one.
// The API is the W-3 surface (docs/crew/workflows.md section 14, issue #810): list, detail,
// and POST /api/workflows/:id/runs, which goes through the same W-2 service path as the
// workflow block on POST /api/runs -- same resolution, same snapshot hash.

import { api, login, logout, currentUser, esc } from './app.js';

const $ = (id) => document.getElementById(id);

const wfId = new URLSearchParams(location.search).get('id');
let user = null;

function showError(msg) {
  const box = $('error-box');
  box.textContent = msg;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 6000);
}

function workflowCard(w) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <h3 style="margin:0" class="mono">${esc(w.id)}</h3>
      <span class="badge">${esc(w.mode)}</span>
      <span class="mono muted">v${esc(w.version)} · ${esc(String(w.stageCount))} steps</span>
      <span class="spacer" style="flex:1"></span>
      <a href="/workflows.html?id=${encodeURIComponent(w.id)}"><button class="secondary small">details</button></a>
    </div>
    <p style="margin:4px 0">${esc(w.description)}</p>
    <p class="muted mono" style="margin:2px 0; font-size:12px">${esc(w.contentHash.slice(0, 12))}… · max ${esc(String(w.maxStages))} steps</p>
  `;
  return el;
}

async function loadList() {
  try {
    const data = await api('/api/workflows');
    const host = $('workflows');
    host.innerHTML = '';
    for (const w of data.workflows || []) host.appendChild(workflowCard(w));
    $('empty').classList.toggle('hidden', (data.workflows || []).length > 0);
  } catch (err) {
    showError(err.message);
  }
}

async function loadDetail(id) {
  $('list-view').classList.add('hidden');
  $('detail-view').classList.remove('hidden');
  try {
    const w = await api('/api/workflows/' + encodeURIComponent(id));
    $('wf-id').textContent = w.id;
    $('wf-desc').textContent = w.description;
    $('wf-mode').textContent = w.mode;
    $('wf-meta').textContent = `v${w.version} · ${w.trust} · ${w.contentHash.slice(0, 12)}…`;
    const host = $('wf-steps');
    host.innerHTML = '';
    (w.stages || []).forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'card';
      const preset = s.preset
        ? `${esc(s.preset.id)}${s.preset.version ? ' v' + esc(s.preset.version) : ''}`
        : '<span class="muted">none — the Run agent performs this step</span>';
      const resolved = s.resolvedPreset
        ? `${esc(s.resolvedPreset.role)}${s.resolvedPreset.enabled ? '' : ' (disabled)'}`
        : '<span class="muted">unresolved</span>';
      el.innerHTML = `
        <div class="row" style="margin-bottom:4px">
          <strong>Step ${i + 1}: ${esc(s.id)}</strong>
          <span class="spacer" style="flex:1"></span>
          <span class="muted">preset: ${preset} — ${resolved}</span>
        </div>
        <p style="margin:2px 0">${esc(s.task)}</p>`;
      host.appendChild(el);
    });
    $('run-btn').onclick = () => createRun(w.id);
  } catch (err) {
    showError(err.message);
  }
}

async function createRun(id) {
  const task = $('run-task').value.trim();
  const repo = $('run-repo').value.trim();
  if (!task) { showError('Task is required.'); return; }
  const body = { task };
  if (repo) {
    // HTTP(S) and SSH/scp remotes are URLs; a bare path is a local path (PR #934 review:
    // `git@host:org/repo.git` and `ssh://git@…` as `localPath` fail in worktree mode).
    body.repository = {
      url: /^https?:\/\/|^ssh:\/\/|^[^/@]+@[^:/]+:/.test(repo) ? repo : undefined,
      localPath: /^https?:\/\/|^ssh:\/\/|^[^/@]+@[^:/]+:/.test(repo) ? undefined : repo,
      baseBranch: $('run-branch').value.trim() || 'main',
    };
  }
  try {
    const res = await api('/api/workflows/' + encodeURIComponent(id) + '/runs', { method: 'POST', json: true, body: JSON.stringify(body) });
    location.href = '/run.html?run=' + encodeURIComponent(res.runId);
  } catch (err) {
    showError('Create failed: ' + err.message);
  }
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
  $('user-label').textContent = user?.isAdmin ? 'admin' : user?.ownerId || '';
  if (wfId) loadDetail(wfId);
  else loadList();
}

$('login-btn').addEventListener('click', async () => {
  const token = $('token-input').value.trim();
  if (!token) return;
  try {
    user = await login(token);
    $('token-input').value = '';
    showApp();
  } catch (err) {
    showError('Login failed: ' + err.message);
  }
});
$('token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('login-btn').click(); });
$('logout-btn').addEventListener('click', logout);
$('refresh-btn').addEventListener('click', loadList);

(async () => {
  try { user = await currentUser(); } catch { user = null; }
  if (user) showApp();
  else $('login').classList.remove('hidden');
})();
