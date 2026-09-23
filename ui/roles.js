// Roles page: browse builtin presets, inspect one, run a task as a role.

import { api, login, logout, currentUser, esc } from './app.js';

const $ = (id) => document.getElementById(id);

let user = null;

function showError(msg) {
  const box = $('error-box');
  box.textContent = msg;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 6000);
}

// The list carries the short card fields; the detail fetch (on expand) carries the
// instruction and full manifest slices. Splitting them keeps the browse payload small.
function roleCard(p) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <h3 style="margin:0">${esc(p.role)}</h3>
      <span class="badge ${p.enabled ? '' : 'muted'}">${esc(p.enabled ? 'enabled' : 'disabled')}</span>
      <span class="mono muted">${esc(p.id)} · v${esc(p.version)}</span>
      <span class="spacer" style="flex:1"></span>
      <button class="secondary small" data-act="inspect">details</button>
      <button class="small" data-act="toggle-run">Run task as this role</button>
    </div>
    <p style="margin:4px 0">${esc(p.description)}</p>
    <p class="muted mono" style="margin:2px 0; font-size:12px">${esc((p.tags || []).join(' · '))}</p>
    <div class="role-detail hidden" data-detail></div>
    <div class="role-run hidden" data-runform>
      <div class="grid2">
        <div>
          <label class="muted">Task</label><br>
          <textarea data-task rows="3" style="width:100%" placeholder="e.g. Review the auth change for missing rate limits"></textarea>
        </div>
        <div>
          <label class="muted">Repository</label><br>
          <input data-repo type="text" style="width:100%" placeholder="/path/to/repo or git url">
          <label class="muted">Base branch</label><br>
          <input data-branch type="text" style="width:100%" value="main">
        </div>
      </div>
      <p style="margin-top:8px"><button data-act="run">Create run</button></p>
    </div>
  `;
  el.querySelector('[data-act="inspect"]').addEventListener('click', () => toggleDetail(el, p));
  const toggleBtn = el.querySelector('[data-act="toggle-run"]');
  if (p.enabled) {
    toggleBtn.addEventListener('click', () => {
      el.querySelector('[data-runform]').classList.toggle('hidden');
    });
  } else {
    // A disabled preset is rejected by RunService on create; offering the form would be a
    // guaranteed-error path. Disabled is still VIEWABLE (details stay available).
    toggleBtn.disabled = true;
    toggleBtn.title = 'This preset is disabled; an operator must enable it before it can run.';
  }
  el.querySelector('[data-act="run"]').addEventListener('click', () => runAsRole(el, p));
  return el;
}

async function toggleDetail(el, p) {
  const box = el.querySelector('[data-detail]');
  if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
  if (!box.dataset.loaded) {
    try {
      const d = await api('/api/presets/' + encodeURIComponent(p.id));
      // Everything shown comes from the manifest snapshot; esc() on every interpolation.
      const skills = d.skills
        ? `<div class="muted">skills — defaults: ${esc((d.skills.defaults || []).join(', ') || 'none')};
             required: ${esc((d.skills.required || []).join(', ') || 'none')};
             auto-select: ${esc(String(d.skills.autoSelect !== false))}</div>`
        : '<div class="muted">skills — none</div>';
      const agent = d.agent
        ? `${esc(d.agent.id)}${d.agent.required ? ' (required)' : ''}${d.agent.model ? ' · model ' + esc(d.agent.model) : ''}`
        : 'no preference';
      const c = d.constraints || {};
      const cons = Object.entries(c).filter(([, v]) => v !== undefined && v !== null);
      box.innerHTML = `
        <h4 style="margin:10px 0 4px">Instruction <span class="muted mono">${esc(d.instruction ? '' : '(empty)')}</span></h4>
        <pre class="mono" style="white-space:pre-wrap; background:var(--bg, #f6f6f6); padding:8px; border-radius:6px">${esc(d.instruction || '')}</pre>
        <div class="muted">agent — ${agent}</div>
        ${skills}
        <div class="muted">constraints — ${cons.length ? esc(cons.map(([k, v]) => k + '=' + JSON.stringify(v)).join(', ')) : 'none'}</div>
        <div class="muted mono" style="font-size:12px">hash ${esc(d.contentHash)} · trust ${esc(d.trust)}</div>
      `;
      box.dataset.loaded = '1';
    } catch (err) {
      showError('Could not load ' + p.id + ': ' + err.message);
      return;
    }
  }
  box.classList.remove('hidden');
}

async function runAsRole(el, p) {
  const form = el.querySelector('[data-runform]');
  if (form.classList.contains('hidden')) {
    form.classList.remove('hidden');
    return;
  }
  const task = form.querySelector('[data-task]').value.trim();
  if (!task) { showError('Task is required'); return; }
  const repoPath = form.querySelector('[data-repo]').value.trim();
  const repository = repoPath
    ? { localPath: repoPath, baseBranch: form.querySelector('[data-branch]').value.trim() || 'main' }
    : {};
  try {
    const res = await api('/api/runs', {
      method: 'POST', json: true,
      body: JSON.stringify({ task, repository, preset: { id: p.id } }),
    });
    location.href = '/run.html?run=' + encodeURIComponent(res.runId);
  } catch (err) {
    showError('Create failed: ' + err.message);
  }
}

async function loadRoles() {
  try {
    const data = await api('/api/presets');
    const host = $('roles');
    host.innerHTML = '';
    for (const p of data.presets || []) host.appendChild(roleCard(p));
    $('empty').classList.toggle('hidden', (data.presets || []).length > 0);
  } catch (err) {
    showError(err.message);
  }
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('logout-btn').classList.remove('hidden');
  $('user-label').textContent = user?.isAdmin ? 'admin' : user?.ownerId || '';
  loadRoles();
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
$('refresh-btn').addEventListener('click', loadRoles);

(async () => {
  try { user = await currentUser(); } catch { user = null; }
  if (user) showApp();
  else $('login').classList.remove('hidden');
})();
