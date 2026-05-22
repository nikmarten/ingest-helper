/* ============================================================
   INGEST LIST — Frontend Application
   ============================================================ */

// ============== STATE ==============

const THEME_PALETTES = {
  dark: {
    "--bg":        "#0e0f10",
    "--bg-2":      "#121316",
    "--surface":   "#17181b",
    "--surface-2": "#1c1d21",
    "--surface-3": "#22232a",
    "--line":      "#1f2024",
    "--line-2":    "#26272c",
    "--line-3":    "#32333a",
    "--text":      "#f5f5f7",
    "--text-2":    "#a6a6ad",
    "--text-3":    "#76767e",
    "--text-4":    "#48484f",
    "--text-5":    "#2a2a30",
    "--rec":       "#ff5a4f",
    "--c-waiting":      "#d9b04c",
    "--c-transferring": "#e08660",
    "--c-done":         "#6dc28b",
    "--c-error":        "#ff5a4f",
    "--accent":    "#c19a6b",
  },
  light: {
    "--bg":        "#f5f5f7",
    "--bg-2":      "#ececef",
    "--surface":   "#ffffff",
    "--surface-2": "#f5f5f7",
    "--surface-3": "#ebebef",
    "--line":      "#e5e5e7",
    "--line-2":    "#d4d4d8",
    "--line-3":    "#b8b8c0",
    "--text":      "#1d1d1f",
    "--text-2":    "#515154",
    "--text-3":    "#76767e",
    "--text-4":    "#aeaeb4",
    "--text-5":    "#d8d8dc",
    "--rec":       "#ff3b30",
    "--c-waiting":      "#b88a30",
    "--c-transferring": "#c97050",
    "--c-done":         "#2f8a52",
    "--c-error":        "#ff3b30",
    "--accent":    "#a07d4e",
  },
};

function applyTheme(name) {
  const palette = THEME_PALETTES[name] || THEME_PALETTES.dark;
  const css = `:root {\n${Object.entries(palette).map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n  color-scheme: ${name};\n}`;
  let tag = document.getElementById("__theme_vars");
  if (!tag) {
    tag = document.createElement("style");
    tag.id = "__theme_vars";
    document.head.appendChild(tag);
  }
  tag.textContent = css;
  document.documentElement.dataset.theme = name;
  // Update toggle icon visibility
  const dark = document.getElementById('theme-icon-dark');
  const light = document.getElementById('theme-icon-light');
  if (dark && light) {
    if (name === 'dark') { dark.removeAttribute('hidden'); light.setAttribute('hidden', ''); }
    else { dark.setAttribute('hidden', ''); light.removeAttribute('hidden'); }
  }
  try { localStorage.setItem('theme', name); } catch (e) {}
}

// Apply theme as early as possible — before render
(function bootTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem('theme') || 'dark'; } catch (e) {}
  applyTheme(saved);
})();

const state = {
  role: null, // 'ingest' | 'cutter' | null
  projects: [],
  currentProjectId: null,
  currentProject: null,
  crew: [],
  cameras: [],
  ingests: [],
  view: 'board',
  filters: { status: 'all', day: '', crew: '', search: '' },
  cutterFilter: 'ready', // 'ready' | 'all'
  selectedIngestId: null,
  smartDefaults: { crew_id: null, camera_id: null },
  notificationsEnabled: false,
  knownDoneIds: new Set(),
};

let sse = null;

// ============== API ==============

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type');
  if (ct && ct.includes('application/json')) return res.json();
  return res;
}

// ============== UTILS ==============

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function initials(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
}

function fmtTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr.replace(' ', 'T'));
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`;
  return `${s}s`;
}

function slugify(s) {
  if (!s) return '';
  return String(s)
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/[^a-zA-Z0-9_-]+/g, '')
    .trim();
}

function renderTemplate(template, vars) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] ?? ''));
}

function buildFolderName(ingest, project, overrides = {}) {
  if (!project) return '';
  const tmpl = project.folder_template || '{day}/{ymd}_{crew}_{camera}_{nr}';
  const date = (ingest.created_at || '').slice(0, 10);
  const ymd = date.replace(/-/g, '');
  const nr = ingest.sequence_number != null ? String(ingest.sequence_number).padStart(3, '0') : '';
  const cameraToken = overrides.camera_short_code ?? ingest.camera_short_code ?? overrides.camera_name ?? ingest.camera_name;
  const vars = {
    project: slugify(project.name),
    date,
    ymd,
    day: slugify(overrides.day_label ?? ingest.day_label),
    crew: slugify(overrides.crew_name ?? ingest.crew_name),
    camera: slugify(cameraToken),
    card: slugify(overrides.card_label ?? ingest.card_label),
    stage: slugify(overrides.stage ?? ingest.stage),
    nr,
  };
  const rendered = renderTemplate(tmpl, vars);
  // Split into path segments, clean each, drop empty ones, rejoin with /
  return rendered
    .split('/')
    .map(seg => seg.replace(/_+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr.replace(' ', 'T'));
}

function toast(message, type = 'success') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = {
    success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  }[type] || '';
  el.innerHTML = `<span class="toast-icon">${icon}</span><span>${esc(message)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 250);
  }, 2700);
}

// ============== ROLE ==============

const ROLE_META = {
  ingest: {
    label: 'Ingest',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  },
  cutter: {
    label: 'Cutter',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>',
  },
};

function setRole(role) {
  state.role = role;
  if (role) localStorage.setItem('role', role);
  else localStorage.removeItem('role');
  renderRoleUi();
  applyRoleVisibility();

  // Re-select current project so role-specific data (crew/cameras for ingest, etc.) gets loaded fresh
  if (role && state.currentProjectId) {
    selectProject(state.currentProjectId);
    return;
  }
  routeForRole();
}

function renderRoleUi() {
  const chip = $('#btn-role-switch');
  if (!state.role) { chip.setAttribute('hidden', ''); return; }
  chip.removeAttribute('hidden');
  chip.dataset.role = state.role;
  $('#role-icon').innerHTML = ROLE_META[state.role].icon;
  $('#role-label').textContent = ROLE_META[state.role].label;
}

function applyRoleVisibility() {
  const isCutter = state.role === 'cutter';
  // View switcher is only for ingest
  if (isCutter) $('#view-switcher').setAttribute('hidden', '');
  else if (state.currentProjectId) $('#view-switcher').removeAttribute('hidden');

  // Tape strip only when a project is selected
  const tape = $('#tape-strip');
  if (tape) {
    if (state.currentProjectId && !isCutter) tape.removeAttribute('hidden');
    else tape.setAttribute('hidden', '');
  }

  // Shortcuts button only for ingest
  $('#btn-shortcuts').style.display = isCutter ? 'none' : '';

  // Notifications button only for cutter
  if (isCutter) $('#btn-notifications').removeAttribute('hidden');
  else $('#btn-notifications').setAttribute('hidden', '');

  // Project switcher settings option (only ingest)
  const settings = $('#ps-project-settings');
  if (isCutter) settings.style.display = 'none';
  else settings.style.display = '';
}

function routeForRole() {
  if (!state.role) { setView('role'); return; }
  if (!state.currentProjectId) {
    if (state.projects.length === 0) {
      // Cutters cannot create projects
      setView(state.role === 'cutter' ? 'empty-cutter' : 'empty');
    } else if (state.role === 'cutter') {
      // Auto-select first project for cutter
      selectProject(state.projects[0].id);
      return;
    } else {
      setView('empty');
    }
    return;
  }
  setView(state.role === 'cutter' ? 'cutter' : 'board');
}

function switchRole() {
  // Picker again
  state.role = null;
  localStorage.removeItem('role');
  renderRoleUi();
  setView('role');
}

// ============== PROJECTS ==============

async function loadProjects() {
  state.projects = await api('/api/projects');
  renderProjectSwitcher();
}

function renderProjectSwitcher() {
  const list = $('#project-list');
  const current = $('#ps-current');
  if (state.projects.length === 0) {
    list.innerHTML = '<div class="ps-empty">Noch keine Projekte vorhanden</div>';
  } else {
    list.innerHTML = state.projects.map(p => `
      <div class="ps-item ${p.id === state.currentProjectId ? 'active' : ''}" data-id="${p.id}">
        <span class="ps-item-name">${esc(p.name)}</span>
        ${p.location ? `<span class="ps-item-meta">${esc(p.location)}</span>` : ''}
      </div>
    `).join('');
    list.querySelectorAll('.ps-item').forEach(el => {
      el.addEventListener('click', () => {
        selectProject(Number(el.dataset.id));
        closeProjectSwitcher();
      });
    });
  }
  const cur = state.projects.find(p => p.id === state.currentProjectId);
  current.textContent = cur ? cur.name : '— Projekt wählen —';
  $('#ps-project-settings').disabled = !state.currentProjectId;
}

function toggleProjectSwitcher() {
  const menu = $('#project-switcher-menu');
  if (menu.hasAttribute('hidden')) {
    menu.removeAttribute('hidden');
    setTimeout(() => document.addEventListener('click', handleClickOutsideSwitcher), 0);
  } else {
    closeProjectSwitcher();
  }
}
function closeProjectSwitcher() {
  $('#project-switcher-menu').setAttribute('hidden', '');
  document.removeEventListener('click', handleClickOutsideSwitcher);
}
function handleClickOutsideSwitcher(e) {
  if (!e.target.closest('.project-switcher')) closeProjectSwitcher();
}

async function selectProject(id) {
  if (!id) {
    state.currentProjectId = null;
    state.currentProject = null;
    $('#view-switcher').setAttribute('hidden', '');
    $('#stats-pills').setAttribute('hidden', '');
    localStorage.removeItem('lastProject');
    renderProjectSwitcher();
    routeForRole();
    return;
  }
  state.currentProjectId = id;
  state.currentProject = state.projects.find(p => p.id === id);
  localStorage.setItem('lastProject', id);

  if (state.role === 'cutter') {
    state.ingests = await api(`/api/projects/${state.currentProjectId}/ingests`);
    loadKnownDoneIds();
    populateCutterFilters();
    setView('cutter');
    renderProjectSwitcher();
    applyRoleVisibility();
    return;
  }

  await Promise.all([loadCrew(), loadCameras(), loadIngests()]);
  applyRoleVisibility();
  populateStorageDatalist();
  populateDayFilter();
  populateCrewFilter();
  setView(['board', 'list', 'dashboard'].includes(state.view) ? state.view : 'board');
  renderProjectSwitcher();
}

async function createProject(fields) {
  const project = await api('/api/projects', { method: 'POST', body: fields });
  await loadProjects();
  await selectProject(project.id);
  toast(`Projekt "${project.name}" erstellt`);
  return project;
}

async function updateCurrentProject(fields) {
  const project = await api(`/api/projects/${state.currentProjectId}`, { method: 'PUT', body: fields });
  state.currentProject = project;
  state.projects = state.projects.map(p => p.id === project.id ? project : p);
  renderProjectSwitcher();
  populateStorageDatalist();
  toast('Projekt gespeichert');
  return project;
}

async function archiveCurrentProject() {
  if (!confirm(`Projekt "${state.currentProject.name}" archivieren?`)) return;
  await api(`/api/projects/${state.currentProjectId}`, { method: 'DELETE' });
  state.currentProjectId = null;
  state.currentProject = null;
  localStorage.removeItem('lastProject');
  await loadProjects();
  setView('empty');
  $('#view-switcher').setAttribute('hidden', '');
  $('#stats-pills').setAttribute('hidden', '');
  toast('Projekt archiviert');
}

// ============== CREW ==============

async function loadCrew() {
  state.crew = await api(`/api/projects/${state.currentProjectId}/crew`);
  populateCrewSelects();
  renderCrewBlocks();
  populateCrewFilter();
}

function populateCrewSelects() {
  for (const sel of [$('#qa-crew'), $('#sp-crew')]) {
    const val = sel.value;
    sel.innerHTML = `<option value="">${sel.id === 'qa-crew' ? 'Person...' : '— wählen —'}</option>`;
    for (const c of state.crew) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.role})`;
      sel.appendChild(opt);
    }
    if (val) sel.value = val;
  }
}

function populateCrewFilter() {
  const sel = $('#board-crew-filter');
  const val = sel.value;
  sel.innerHTML = '<option value="">Alle Personen</option>';
  for (const c of state.crew) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (val) sel.value = val;
}

function renderCrewBlocks() {
  const container = $('#crew-blocks');
  if (!container) return;

  if (state.crew.length === 0) {
    container.innerHTML = '<div class="crew-blocks-empty">Lege deine erste Kameraperson an um zu starten</div>';
    $('#orphan-cams-wrap')?.setAttribute('hidden', '');
    return;
  }

  const trashSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>';
  const plusSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  container.innerHTML = state.crew.map(c => {
    const cams = state.cameras.filter(cam => cam.owner_crew_id === c.id);
    const ownerOptions = (selectedId) => state.crew.map(cr =>
      `<option value="${cr.id}" ${cr.id === selectedId ? 'selected' : ''}>${esc(cr.name)}</option>`).join('');

    const camRows = cams.length === 0
      ? '<div class="cam-empty">Noch keine Kamera zugewiesen — füge unten eine hinzu.</div>'
      : cams.map(cam => `
        <div class="cam-row" data-cam-id="${cam.id}">
          <div class="cam-info">
            <span class="cam-name">${esc(cam.name)}</span>
            ${cam.short_code ? `<span class="cam-shortcode">${esc(cam.short_code)}</span>` : ''}
          </div>
          <select class="cam-owner-inline" data-id="${cam.id}" title="Besitzer ändern">
            <option value="">Pool</option>
            ${ownerOptions(cam.owner_crew_id)}
          </select>
          <button class="btn-remove" data-action="remove-camera" data-id="${cam.id}" title="Kamera entfernen">${trashSvg}</button>
        </div>
      `).join('');

    return `
      <div class="crew-block" data-crew-id="${c.id}">
        <div class="crew-block-head">
          <div class="crew-avatar" style="background:${c.color}">${initials(c.name)}</div>
          <span class="crew-block-name">${esc(c.name)}</span>
          <span class="crew-block-role">${esc(c.role)}</span>
          <span class="crew-block-spacer"></span>
          <button class="btn-remove" data-action="remove-crew" data-id="${c.id}" title="Person entfernen">${trashSvg}</button>
        </div>
        <div class="crew-block-body">
          ${camRows}
          <form class="add-cam-inline" data-crew-id="${c.id}">
            <input type="text" placeholder="Bezeichnung (z.B. Sony FX6 - Lisa Cam)" required>
            <input type="text" placeholder="Kürzel für Ordner (z.B. CamA)" required>
            <button type="submit" class="btn btn-primary btn-sm">${plusSvg} Kamera</button>
          </form>
        </div>
      </div>
    `;
  }).join('');

  // Wire inline add-camera forms
  container.querySelectorAll('.add-cam-inline').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const crewId = Number(form.dataset.crewId);
      const inputs = form.querySelectorAll('input');
      const name = inputs[0].value.trim();
      const shortCode = inputs[1].value.trim();
      if (!name || !shortCode) return;
      await api(`/api/projects/${state.currentProjectId}/cameras`, {
        method: 'POST',
        body: { name, short_code: shortCode, owner_crew_id: crewId }
      });
      inputs[0].value = '';
      inputs[1].value = '';
      toast(`Kamera "${name}" (${shortCode}) hinzugefügt`);
    });
  });

  // Wire inline owner-change
  container.querySelectorAll('.cam-owner-inline').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.id);
      const cam = state.cameras.find(c => c.id === id);
      if (!cam) return;
      await api(`/api/cameras/${id}`, {
        method: 'PUT',
        body: { name: cam.name, short_code: cam.short_code, owner_crew_id: sel.value || null }
      });
      toast('Kamera-Besitzer aktualisiert');
    });
  });

  // Orphan (pool) cameras at bottom
  renderOrphanCameras();
}

function renderOrphanCameras() {
  const wrap = $('#orphan-cams-wrap');
  const list = $('#orphan-cams');
  if (!wrap || !list) return;
  const orphans = state.cameras.filter(c => !c.owner_crew_id);
  if (orphans.length === 0) {
    wrap.setAttribute('hidden', '');
    return;
  }
  wrap.removeAttribute('hidden');
  const ownerOptions = state.crew.map(cr => `<option value="${cr.id}">${esc(cr.name)}</option>`).join('');
  const trashSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>';

  list.innerHTML = orphans.map(cam => `
    <div class="cam-row" data-cam-id="${cam.id}">
      <div class="cam-info">
        <span class="cam-name">${esc(cam.name)}</span>
        ${cam.short_code ? `<span class="cam-shortcode">${esc(cam.short_code)}</span>` : ''}
      </div>
      <select class="cam-owner-inline" data-id="${cam.id}" title="Person zuweisen">
        <option value="">Pool</option>
        ${ownerOptions}
      </select>
      <button class="btn-remove" data-action="remove-camera" data-id="${cam.id}" title="Kamera entfernen">${trashSvg}</button>
    </div>
  `).join('');

  list.querySelectorAll('.cam-owner-inline').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = Number(sel.dataset.id);
      const cam = state.cameras.find(c => c.id === id);
      if (!cam) return;
      await api(`/api/cameras/${id}`, { method: 'PUT', body: { name: cam.name, short_code: cam.short_code, owner_crew_id: sel.value || null }});
      toast('Kamera zugewiesen');
    });
  });
}

// ============== CAMERAS ==============

async function loadCameras() {
  state.cameras = await api(`/api/projects/${state.currentProjectId}/cameras`);
  populateCameraSelects();
  renderCrewBlocks();
}

function populateCameraSelects() {
  refillCameraSelect($('#qa-camera'), $('#qa-crew'), 'Kamera...');
  refillCameraSelect($('#sp-camera'), $('#sp-crew'), '— wählen —');
}

// Re-fill a single camera <select> with cameras owned by the crew currently
// selected in crewSel. If no crew is selected, show all cameras (initial state).
// Preserves the currently-selected camera even if it doesn't match the crew —
// important when editing an existing ingest whose camera was assigned earlier.
function refillCameraSelect(cameraSel, crewSel, placeholder) {
  if (!cameraSel) return;
  const val = cameraSel.value;
  const crewId = crewSel && crewSel.value ? Number(crewSel.value) : null;
  let cams = crewId
    ? state.cameras.filter(c => c.owner_crew_id === crewId)
    : state.cameras;
  if (val && !cams.some(c => String(c.id) === String(val))) {
    const current = state.cameras.find(c => String(c.id) === String(val));
    if (current) cams = [current, ...cams];
  }
  cameraSel.innerHTML = `<option value="">${placeholder}</option>`;
  for (const c of cams) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.short_code ? `${c.name} · ${c.short_code}` : c.name;
    cameraSel.appendChild(opt);
  }
  if (val && cams.some(c => String(c.id) === String(val))) {
    cameraSel.value = val;
  }
}


// ============== STORAGE (per-project list) ==============

function populateStorageDatalist() {
  const targets = state.currentProject?.storage_targets || [];
  $('#storage-datalist').innerHTML = targets.map(s => `<option value="${esc(s)}">`).join('');
  renderStorageList();
}

function renderStorageList() {
  const targets = state.currentProject?.storage_targets || [];
  const list = $('#storage-list');
  if (!list) return;
  if (targets.length === 0) {
    list.innerHTML = '<li style="justify-content:center;color:var(--text-muted);font-style:italic">Noch keine Storage-Ziele</li>';
    return;
  }
  list.innerHTML = targets.map(s => `
    <li>
      <span class="e-name">${esc(s)}</span>
      <span class="e-spacer"></span>
      <button class="btn-remove" data-action="remove-storage" data-name="${esc(s)}" title="Entfernen">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </li>
  `).join('');
}

// ============== INGESTS ==============

async function loadIngests() {
  const prev = state.ingests;
  const isFirstLoad = prev.length === 0;
  state.ingests = await api(`/api/projects/${state.currentProjectId}/ingests`);

  // Detect newly completed items for cutter notifications (skip first load)
  if (state.role === 'cutter') {
    if (!isFirstLoad) {
      const prevDoneIds = new Set(prev.filter(i => i.status === 'done').map(i => i.id));
      for (const i of state.ingests) {
        if (i.status === 'done' && !prevDoneIds.has(i.id)) {
          notifyCutter(i);
        }
      }
    }
    populateCutterFilters();
    if (state.view === 'cutter') renderCutterView();
  } else {
    populateDayFilter();
    renderActiveView();
    updateStats();
  }
}

function populateDayFilter() {
  const sel = $('#board-day-filter');
  const val = sel.value;
  const days = Array.from(new Set(state.ingests.map(i => i.day_label).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">Alle Tage</option>' + days.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  if (val) sel.value = val;
}

function filterIngests(items) {
  const { day, crew, search } = state.filters;
  return items.filter(i => {
    if (day && i.day_label !== day) return false;
    if (crew && String(i.crew_id) !== String(crew)) return false;
    if (search) {
      const s = search.toLowerCase();
      const haystack = [
        i.crew_name, i.camera_name, i.camera_model, i.description,
        i.path, i.card_label, i.stage, i.storage_destination, i.notes, i.day_label,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(s)) return false;
    }
    return true;
  });
}

async function createIngest(fields) {
  const ingest = await api(`/api/projects/${state.currentProjectId}/ingests`, { method: 'POST', body: fields });
  await maybeAddStorage(fields.storage_destination);
  toast(fields.status === 'transferring' ? 'Registriert & Transfer gestartet' : 'Aufnahme registriert');
  return ingest;
}

async function updateIngestSave(id, fields) {
  const ingest = await api(`/api/ingests/${id}`, { method: 'PUT', body: fields });
  await maybeAddStorage(fields.storage_destination);
  toast('Gespeichert');
  return ingest;
}

async function changeStatus(id, status) {
  await api(`/api/ingests/${id}/status`, { method: 'PATCH', body: { status } });
  const labels = { waiting: 'Wartend', transferring: 'Transfer gestartet', done: 'Fertig!' };
  toast(labels[status] || 'Status geändert');
}

async function deleteIngestById(id) {
  if (!confirm('Diesen Eintrag wirklich löschen?')) return false;
  await api(`/api/ingests/${id}`, { method: 'DELETE' });
  toast('Gelöscht');
  return true;
}

async function maybeAddStorage(name) {
  if (!name) return;
  const targets = state.currentProject?.storage_targets || [];
  if (targets.includes(name)) return;
  const updated = [...targets, name];
  await updateCurrentProject({
    name: state.currentProject.name,
    location: state.currentProject.location,
    date_start: state.currentProject.date_start,
    date_end: state.currentProject.date_end,
    notes: state.currentProject.notes,
    stages: state.currentProject.stages,
    storage_targets: updated,
  });
}

// ============== STATS ==============

function updateStats() {
  const stats = computeLocalStats();
  // Old stat-pills no longer in DOM (replaced by tape-strip) — guard
  const set = (id, val) => { const el = $(`#${id}`); if (el) el.textContent = val; };
  set('count-waiting', stats.waiting);
  set('count-transferring', stats.transferring);
  set('count-done', stats.done);
  updateTapeStrip();
}

function updateTapeStrip() {
  const strip = $('#tape-strip');
  if (!strip) return;
  if (!state.currentProjectId) { strip.setAttribute('hidden', ''); return; }
  strip.removeAttribute('hidden');

  const stats = computeLocalStats();
  const proj = state.currentProject;
  $('#tape-project').textContent = proj ? proj.name : '—';
  $('#tape-waiting').textContent = stats.waiting;
  $('#tape-transferring').textContent = stats.transferring;
  $('#tape-done').textContent = stats.done;

  const totalMin = state.ingests.reduce((s, i) => s + (i.duration_minutes || 0), 0);
  if (totalMin > 0) {
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    $('#tape-footage').textContent = `${h}h ${String(m).padStart(2, '0')}m`;
  } else {
    $('#tape-footage').textContent = '—';
  }
}

function tickTapeClock() {
  const el = $('#tape-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function computeLocalStats() {
  return {
    total: state.ingests.length,
    waiting: state.ingests.filter(i => i.status === 'waiting').length,
    transferring: state.ingests.filter(i => i.status === 'transferring').length,
    done: state.ingests.filter(i => i.status === 'done').length,
  };
}

// ============== VIEW ROUTING ==============

function setView(name) {
  state.view = name;
  for (const v of ['role', 'empty', 'board', 'list', 'dashboard', 'settings', 'cutter']) {
    const el = $(`#view-${v}`);
    if (!el) continue;
    if (v === name) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }
  $$('#view-switcher .view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (['board', 'list', 'dashboard'].includes(name)) renderActiveView();
  if (name === 'settings') renderSettingsView();
  if (name === 'cutter') renderCutterView();
}

function renderActiveView() {
  if (state.view === 'board') renderBoard();
  else if (state.view === 'list') renderList();
  else if (state.view === 'dashboard') renderDashboard();
}

// ============== BOARD VIEW ==============

function renderBoard() {
  const filtered = filterIngests(state.ingests);
  const cols = {
    waiting: $('#col-waiting'),
    transferring: $('#col-transferring'),
    done: $('#col-done'),
  };
  for (const status of Object.keys(cols)) {
    const items = filtered.filter(i => i.status === status);
    if (items.length === 0) {
      cols[status].innerHTML = `<div class="col-empty">nichts</div>`;
    } else {
      cols[status].innerHTML = items.map(renderKCard).join('');
    }
  }
  attachCardHandlers();
}

function renderKCard(i) {
  const avatar = i.crew_color
    ? `<div class="crew-avatar" style="background:${i.crew_color}" title="${esc(i.crew_name || '')}">${initials(i.crew_name)}</div>`
    : `<div class="crew-avatar" style="background:var(--text-4)">?</div>`;

  const camTag = (i.camera_short_code || i.camera_name) ? `<span class="kcard-tag cam-tag">${esc(i.camera_short_code || i.camera_name)}</span>` : '';

  const seq = i.sequence_number != null ? String(i.sequence_number).padStart(2, '0') : '';
  const recOrTime = i.status === 'transferring'
    ? `<span class="kcard-rec"><span class="rec-dot"></span>REC</span>`
    : '';
  const time = `<span class="kcard-time">${fmtTime(i.created_at)}</span>`;

  return `
    <div class="kcard status-${i.status}" draggable="true" data-id="${i.id}">
      <div class="kcard-top">
        <span class="kcard-status-dot"></span>
        ${seq ? `<span class="kcard-seq">${seq}</span>` : ''}
        ${i.day_label ? `<span class="kcard-day">${esc(i.day_label)}</span>` : ''}
        <div class="kcard-top-right">
          ${recOrTime}
          ${time}
        </div>
      </div>
      ${i.description ? `<div class="kcard-desc">${esc(i.description)}</div>` : '<div class="kcard-desc" style="color:var(--text-4);font-weight:400">(ohne Beschreibung)</div>'}
      <div class="kcard-meta">
        ${avatar}
        <span>${esc(i.crew_name || 'Keine Person')}</span>
        ${camTag ? `<span class="kcard-dot">·</span>${camTag}` : ''}
      </div>
      ${i.path ? `<div class="kcard-foot"><span class="kcard-path" title="${esc(i.path)}">${esc(i.path)}</span></div>` : ''}
      ${i.status === 'done' ? `<div class="kcard-foot" style="margin-top:8px"><span style="font-family:var(--font-mono);font-size:11px;color:var(--text-3);font-variant-numeric:tabular-nums">${i.duration_minutes ? i.duration_minutes + ' min' : ''}</span><span class="kcard-arrow">→ Cutter</span></div>` : ''}
    </div>
  `;
}

function attachCardHandlers() {
  $$('.kcard').forEach(card => {
    card.addEventListener('click', () => openSidePanel(Number(card.dataset.id)));
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  $$('.column').forEach(col => {
    const body = col.querySelector('.column-body');
    const status = body.dataset.drop;

    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drop-active');
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) col.classList.remove('drop-active');
    });
    body.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-active');
      const id = Number(e.dataTransfer.getData('text/plain'));
      const ingest = state.ingests.find(i => i.id === id);
      if (!ingest || ingest.status === status) return;
      await changeStatus(id, status);
    });
  });
}

// ============== LIST VIEW ==============

function renderList() {
  let filtered = filterIngests(state.ingests);
  if (state.filters.status !== 'all') filtered = filtered.filter(i => i.status === state.filters.status);

  const container = $('#list-container');
  if (filtered.length === 0) {
    container.innerHTML = '<div class="col-empty" style="padding:60px 20px">Keine Einträge gefunden.</div>';
    return;
  }

  const grouped = {};
  for (const i of filtered) {
    const key = i.day_label || 'Ohne Tag';
    (grouped[key] ||= []).push(i);
  }

  const html = [];
  for (const day of Object.keys(grouped)) {
    html.push(`<div class="day-group-header">${esc(day)} <span style="color:var(--text-muted);font-weight:500">· ${grouped[day].length}</span></div>`);
    for (const i of grouped[day]) html.push(renderListRow(i));
  }
  container.innerHTML = html.join('');

  container.querySelectorAll('.list-row').forEach(row => {
    row.addEventListener('click', () => openSidePanel(Number(row.dataset.id)));
  });
}

function renderListRow(i) {
  const avatar = i.crew_color
    ? `<div class="crew-avatar" style="background:${i.crew_color}">${initials(i.crew_name)}</div>`
    : `<div class="crew-avatar" style="background:var(--text-muted)">?</div>`;

  const statusLabels = { waiting: 'Wartend', transferring: 'Übertragung', done: 'Fertig', error: 'Fehler' };

  const timeHtml = `<span style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">${fmtTime(i.created_at)}</span>`;

  const tags = [];
  if (i.card_label) tags.push(`<span class="kcard-tag card-tag">${esc(i.card_label)}</span>`);
  if (i.camera_name) tags.push(`<span class="kcard-tag cam-tag">${esc(i.camera_name)}</span>`);
  if (i.stage) tags.push(`<span class="kcard-tag">${esc(i.stage)}</span>`);

  return `
    <div class="list-row status-${i.status}" data-id="${i.id}">
      <span class="list-id">#${i.id}</span>
      ${avatar}
      <div class="list-info">
        <div class="list-main">
          <span class="list-crew-name">${esc(i.crew_name || 'Keine Person')}</span>
          ${i.description ? `<span class="list-desc">${esc(i.description)}</span>` : ''}
        </div>
        <div class="list-meta">${tags.join('')} ${i.path ? `<span class="kcard-path">${esc(i.path)}</span>` : ''}</div>
      </div>
      ${timeHtml}
      <div class="status-badge status-${i.status}">${statusLabels[i.status]}</div>
    </div>
  `;
}

// ============== DASHBOARD VIEW ==============

async function renderDashboard() {
  const stats = await api(`/api/projects/${state.currentProjectId}/stats`);

  $('#dash-total').textContent = stats.total;
  $('#dash-waiting').textContent = stats.waiting;
  $('#dash-transferring').textContent = stats.transferring;
  $('#dash-done').textContent = stats.done;

  const max = Math.max(stats.waiting, stats.transferring, stats.done, 1);
  $('#bar-waiting').style.width = `${(stats.waiting / max) * 100}%`;
  $('#bar-transferring').style.width = `${(stats.transferring / max) * 100}%`;
  $('#bar-done').style.width = `${(stats.done / max) * 100}%`;

  $('#dash-footage').textContent = stats.total_footage_minutes ? fmtDuration(stats.total_footage_minutes * 60) : '—';

  const latest = state.ingests.reduce((best, i) => !best || i.created_at > best.created_at ? i : best, null);
  if (latest) {
    const d = new Date(latest.created_at.replace(' ', 'T'));
    $('#dash-last').textContent = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    $('#dash-last-sub').textContent = `${latest.crew_name || 'Unbekannt'} · ${latest.description || '—'}`;
  } else {
    $('#dash-last').textContent = '—';
    $('#dash-last-sub').textContent = 'Noch nichts registriert';
  }

  // Day breakdown
  const dayBox = $('#dash-by-day');
  const days = Object.entries(stats.by_day).sort(([a], [b]) => a.localeCompare(b));
  if (days.length === 0) {
    dayBox.innerHTML = '<div style="color:var(--text-muted);font-style:italic;padding:10px">Noch keine Tage erfasst</div>';
  } else {
    dayBox.innerHTML = days.map(([day, d]) => {
      const total = d.total;
      const w = (d.waiting || 0) / total * 100;
      const t = (d.transferring || 0) / total * 100;
      const dn = (d.done || 0) / total * 100;
      return `
        <div class="dash-day-row">
          <span class="day-label">${esc(day)}</span>
          <div class="day-bars">
            <span class="day-bar" style="width:${dn}%;background:var(--c-done)"></span>
            <span class="day-bar" style="width:${t}%;background:var(--c-transferring)"></span>
            <span class="day-bar" style="width:${w}%;background:var(--c-waiting)"></span>
          </div>
          <span class="day-value">${total}</span>
        </div>
      `;
    }).join('');
  }

  // Crew breakdown
  const crewBox = $('#dash-by-crew');
  const byCrew = {};
  for (const i of state.ingests) {
    const key = i.crew_name || 'Unbekannt';
    if (!byCrew[key]) byCrew[key] = { count: 0, color: i.crew_color || null };
    byCrew[key].count++;
  }
  const crewEntries = Object.entries(byCrew).sort(([, a], [, b]) => b.count - a.count);
  if (crewEntries.length === 0) {
    crewBox.innerHTML = '<div style="color:var(--text-muted);font-style:italic;padding:10px">Noch keine Aktivität</div>';
  } else {
    const maxCount = Math.max(...crewEntries.map(([, v]) => v.count));
    crewBox.innerHTML = crewEntries.map(([name, v]) => `
      <div class="dash-day-row">
        <span class="day-label" style="display:flex;align-items:center;gap:6px">
          <span class="dot" style="background:${v.color || 'var(--text-muted)'}"></span>
          ${esc(name)}
        </span>
        <div class="day-bars">
          <span class="day-bar" style="width:${(v.count / maxCount) * 100}%;background:${v.color || 'var(--accent)'}"></span>
        </div>
        <span class="day-value">${v.count}</span>
      </div>
    `).join('');
  }
}

// ============== FOLDER NAME HELPERS ==============

function updateFolderPreview() {
  const out = $('#folder-preview-output');
  if (!out || !state.currentProject) return;
  const tmpl = $('#folder-template').value.trim() || '{day}_{crew}_{camera}_{card}';
  const sample = {
    created_at: new Date().toISOString().replace('T', ' '),
    day_label: 'Day1',
    crew_name: 'Max Mustermann',
    camera_name: 'Cam A',
    card_label: 'A001',
    stage: 'Main Stage',
    sequence_number: 3,
  };
  const fakeProject = { ...state.currentProject, folder_template: tmpl };
  out.textContent = buildFolderName(sample, fakeProject) || '—';
}

function updateSidePanelFolderName() {
  const leafEl = $('#sp-folder-leaf');
  const fullEl = $('#sp-folder-full');
  if (!leafEl || !state.selectedIngestId || !state.currentProject) return;
  const ingest = state.ingests.find(i => i.id === state.selectedIngestId);
  if (!ingest) return;

  const crewId = Number($('#sp-crew').value) || null;
  const camId = Number($('#sp-camera').value) || null;
  const crew = state.crew.find(c => c.id === crewId);
  const cam = state.cameras.find(c => c.id === camId);

  const overrides = {
    day_label: $('#sp-day').value.trim() || ingest.day_label,
    crew_name: crew?.name || null,
    camera_name: cam?.name || null,
    camera_short_code: cam?.short_code || null,
  };
  const fullPath = buildFolderName(ingest, state.currentProject, overrides) || '';
  const segments = fullPath.split('/').filter(Boolean);
  const leaf = segments.length > 0 ? segments[segments.length - 1] : '';
  const parent = segments.length > 1 ? segments.slice(0, -1).join('/') + '/' : '';

  leafEl.textContent = leaf || '—';
  fullEl.textContent = fullPath || '—';

  const parentRow = $('#sp-folder-parent-row');
  if (parent) {
    $('#sp-folder-parent').textContent = parent;
    parentRow.removeAttribute('hidden');
  } else {
    parentRow.setAttribute('hidden', '');
  }

  // Hide full-path row if it's identical to leaf (no slashes)
  const fullRow = $('#sp-folder-full-row');
  if (fullPath === leaf || !fullPath) fullRow.setAttribute('hidden', '');
  else fullRow.removeAttribute('hidden');
}

// ============== CUTTER VIEW ==============

function loadKnownDoneIds() {
  const raw = localStorage.getItem(`cutter:seen:${state.currentProjectId}`);
  state.knownDoneIds = new Set(raw ? JSON.parse(raw) : []);
}

function persistKnownDoneIds() {
  localStorage.setItem(`cutter:seen:${state.currentProjectId}`, JSON.stringify([...state.knownDoneIds]));
}

function populateCutterFilters() {
  const daySel = $('#cutter-day-filter');
  const crewSel = $('#cutter-crew-filter');
  if (!daySel || !crewSel) return;

  const dayVal = daySel.value;
  const days = Array.from(new Set(state.ingests.map(i => i.day_label).filter(Boolean))).sort();
  daySel.innerHTML = '<option value="">Alle Tage</option>' + days.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  if (dayVal) daySel.value = dayVal;

  const crewVal = crewSel.value;
  const crewByName = new Map();
  for (const i of state.ingests) {
    if (i.crew_name && !crewByName.has(i.crew_name)) crewByName.set(i.crew_name, i.crew_id);
  }
  crewSel.innerHTML = '<option value="">Alle Personen</option>' +
    [...crewByName.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, id]) => `<option value="${id}">${esc(name)}</option>`).join('');
  if (crewVal) crewSel.value = crewVal;
}

function renderCutterView() {
  const proj = state.currentProject;
  $('#cutter-project-meta').textContent = proj ? `${proj.name}${proj.location ? ' · ' + proj.location : ''}` : '—';

  const doneCount = state.ingests.filter(i => i.status === 'done').length;
  const transferCount = state.ingests.filter(i => i.status === 'transferring').length;
  $('#cutter-count-done').textContent = doneCount;
  $('#cutter-count-transferring').textContent = transferCount;

  // Notification banner
  const banner = $('#cutter-banner');
  const dismissed = localStorage.getItem('cutter:banner-dismissed') === '1';
  if ('Notification' in window && Notification.permission === 'default' && !dismissed) {
    banner.removeAttribute('hidden');
  } else {
    banner.setAttribute('hidden', '');
  }

  // Filter ingests
  let items = state.ingests.filter(i => {
    if (state.cutterFilter === 'ready') return i.status === 'done';
    return i.status === 'done' || i.status === 'transferring';
  });

  const search = $('#cutter-search')?.value.toLowerCase() || '';
  const dayFilter = $('#cutter-day-filter')?.value || '';
  const crewFilter = $('#cutter-crew-filter')?.value || '';
  if (search) {
    items = items.filter(i => [i.crew_name, i.camera_name, i.description, i.path, i.card_label, i.stage, i.day_label]
      .filter(Boolean).join(' ').toLowerCase().includes(search));
  }
  if (dayFilter) items = items.filter(i => i.day_label === dayFilter);
  if (crewFilter) items = items.filter(i => String(i.crew_id) === String(crewFilter));

  // Sort: newest first
  items.sort((a, b) => (b.transfer_completed_at || b.created_at).localeCompare(a.transfer_completed_at || a.created_at));

  const list = $('#cutter-list');
  if (items.length === 0) {
    list.innerHTML = `
      <div class="cutter-empty">
        <div class="cutter-empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        </div>
        <p>Noch kein Material verfügbar.</p>
        <p style="font-size:12px">Sobald die Ingest-Station Material überträgt, erscheint es hier automatisch.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = items.map(renderCutterRow).join('');

  // Wire copy buttons
  list.querySelectorAll('.cutter-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const path = btn.dataset.path;
      try {
        await navigator.clipboard.writeText(path);
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Kopiert';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Kopieren';
        }, 1500);
      } catch (e) {
        toast('Konnte nicht kopieren', 'error');
      }
    });
  });

  // Wire per-row "Gesehen" buttons
  list.querySelectorAll('.cutter-mark-seen').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.id);
      if (!id) return;
      state.knownDoneIds.add(id);
      persistKnownDoneIds();
      renderCutterView();
    });
  });

  // Unread counter + "Alle als gesehen" button visibility
  const unreadCount = state.ingests.filter(i => i.status === 'done' && !state.knownDoneIds.has(i.id)).length;
  const newStat = $('#cutter-stat-new');
  $('#cutter-count-new').textContent = unreadCount;
  if (unreadCount > 0) newStat.removeAttribute('hidden');
  else newStat.setAttribute('hidden', '');
  const markAllBtn = $('#cutter-mark-all-seen');
  if (markAllBtn) {
    if (unreadCount > 0) markAllBtn.removeAttribute('hidden');
    else markAllBtn.setAttribute('hidden', '');
  }
}

function renderCutterRow(i) {
  const avatar = i.crew_color
    ? `<div class="crew-avatar" style="background:${i.crew_color}" title="${esc(i.crew_name)}">${initials(i.crew_name)}</div>`
    : `<div class="crew-avatar" style="background:var(--text-muted)">?</div>`;

  const isNew = i.status === 'done' && !state.knownDoneIds.has(i.id);
  const tags = [];
  if (i.card_label) tags.push(`<span class="kcard-tag card-tag">${esc(i.card_label)}</span>`);
  if (i.camera_name) tags.push(`<span class="kcard-tag cam-tag">${esc(i.camera_name)}</span>`);
  if (i.stage) tags.push(`<span class="kcard-tag">${esc(i.stage)}</span>`);
  if (i.day_label) tags.push(`<span class="kcard-tag day-tag">${esc(i.day_label)}</span>`);

  const status = i.status === 'done'
    ? `<div class="status-badge status-done">Verfügbar</div>`
    : `<div class="status-badge status-transferring">Wird übertragen</div>`;

  const whenStr = i.status === 'done' && i.transfer_completed_at
    ? `<span class="cutter-when"><strong>${fmtTime(i.transfer_completed_at)}</strong> fertig</span>`
    : `<span class="cutter-when">seit ${fmtTime(i.transfer_started_at || i.created_at)}</span>`;

  const seenBtn = isNew
    ? `<button class="cutter-mark-seen" data-id="${i.id}" title="Als gesehen markieren">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
         Gesehen
       </button>`
    : '';

  const pathRow = i.path
    ? `<div class="cutter-path-row">
        <span class="cutter-path">${esc(i.path)}</span>
        <button class="cutter-copy" data-path="${esc(i.path)}" title="Pfad kopieren">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Kopieren
        </button>
      </div>`
    : `<div class="cutter-path-row"><span class="cutter-path cutter-no-path">Kein Pfad hinterlegt</span></div>`;

  return `
    <div class="cutter-row status-${i.status} ${isNew ? 'is-new' : ''}" data-id="${i.id}">
      ${avatar}
      <div class="cutter-info">
        <div class="cutter-main-line">
          ${isNew ? '<span class="cutter-new-pill">Neu</span>' : ''}
          <span class="cutter-crew">${esc(i.crew_name || 'Unbekannt')}</span>
          ${i.description ? `<span class="cutter-desc">— ${esc(i.description)}</span>` : ''}
        </div>
        <div class="kcard-tags">${tags.join('')}</div>
        ${pathRow}
      </div>
      <div class="cutter-meta">
        ${status}
        ${whenStr}
        ${seenBtn}
      </div>
    </div>
  `;
}

// ============== NOTIFICATIONS ==============

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    toast('Browser unterstützt keine Benachrichtigungen', 'error');
    return false;
  }
  if (Notification.permission === 'granted') {
    state.notificationsEnabled = true;
    return true;
  }
  if (Notification.permission === 'denied') {
    toast('Benachrichtigungen sind im Browser blockiert', 'error');
    return false;
  }
  const result = await Notification.requestPermission();
  state.notificationsEnabled = result === 'granted';
  if (state.notificationsEnabled) {
    toast('Benachrichtigungen aktiviert');
    // Test notification
    new Notification('Ingest List', {
      body: 'Du erhältst jetzt Benachrichtigungen wenn neues Material verfügbar ist.',
      icon: '/favicon.ico',
      silent: false,
    });
  }
  return state.notificationsEnabled;
}

function updateNotificationButton() {
  const btn = $('#btn-notifications');
  if (!('Notification' in window)) {
    btn.style.color = 'var(--text-muted)';
    btn.title = 'Browser unterstützt keine Benachrichtigungen';
    return;
  }
  if (Notification.permission === 'granted') {
    state.notificationsEnabled = true;
    btn.style.color = 'var(--c-done)';
    btn.title = 'Benachrichtigungen aktiv';
  } else if (Notification.permission === 'denied') {
    btn.style.color = 'var(--c-error)';
    btn.title = 'Benachrichtigungen blockiert — im Browser freigeben';
  } else {
    btn.style.color = '';
    btn.title = 'Benachrichtigungen aktivieren';
  }
}

function notifyCutter(ingest) {
  if (state.role !== 'cutter') return;
  if (!state.notificationsEnabled || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') {
    // In-app toast when tab visible
    toast(`Neu: ${ingest.crew_name || '?'} — ${ingest.description || 'Material'}`, 'info');
  }
  try {
    const n = new Notification('Neues Material verfügbar', {
      body: `${ingest.crew_name || '?'}${ingest.description ? ' — ' + ingest.description : ''}\n${ingest.path || ''}`,
      icon: '/favicon.ico',
      tag: `ingest-${ingest.id}`,
      requireInteraction: false,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    console.warn('Notification failed', e);
  }
}

// ============== SETTINGS VIEW ==============

function renderSettingsView() {
  const p = state.currentProject;
  if (!p) return;
  $('#proj-name').value = p.name || '';
  $('#proj-location').value = p.location || '';
  $('#proj-date-start').value = p.date_start || '';
  $('#proj-date-end').value = p.date_end || '';
  $('#proj-notes').value = p.notes || '';
  $('#folder-template').value = p.folder_template || '{day}/{ymd}_{crew}_{camera}_{nr}';
  updateFolderPreview();
  renderCrewBlocks();
  renderStorageList();
}

// ============== SIDE PANEL ==============

function openSidePanel(id) {
  const ingest = state.ingests.find(i => i.id === id);
  if (!ingest) return;
  state.selectedIngestId = id;

  $('#sp-id').textContent = `#${ingest.id}`;
  const statusLabels = { waiting: 'Wartend', transferring: 'Übertragung', done: 'Fertig', error: 'Fehler' };
  $('#sp-status-badge').className = `status-badge status-${ingest.status}`;
  $('#sp-status-badge').textContent = statusLabels[ingest.status] || ingest.status;

  // Sequence number (e.g. "Nr. 003 von Lisa Schmidt am Day 1")
  const seqEl = $('#sp-sequence');
  if (ingest.sequence_number != null && ingest.crew_name) {
    const dayPart = ingest.day_label ? ` · ${ingest.day_label}` : '';
    seqEl.textContent = `${String(ingest.sequence_number).padStart(3, '0')}${dayPart}`;
    seqEl.removeAttribute('hidden');
  } else {
    seqEl.setAttribute('hidden', '');
  }

  $('#sp-id-input').value = ingest.id;
  $('#sp-crew').value = ingest.crew_id || '';
  $('#sp-camera').value = ingest.camera_id || '';
  refillCameraSelect($('#sp-camera'), $('#sp-crew'), '— wählen —');
  $('#sp-day').value = ingest.day_label || '';
  $('#sp-desc').value = ingest.description || '';
  $('#sp-storage').value = ingest.storage_destination || '';
  $('#sp-path').value = ingest.path || '';
  $('#sp-clips').value = ingest.clip_count || '';
  $('#sp-duration').value = ingest.duration_minutes || '';
  $('#sp-notes').value = ingest.notes || '';

  $$('.btn-status-action').forEach(b => b.classList.toggle('active', b.dataset.status === ingest.status));

  // Registered timestamp
  $('#sp-registered').textContent = ingest.created_at ? new Date(ingest.created_at.replace(' ', 'T')).toLocaleString('de-DE') : '—';

  // Folder name suggestion
  updateSidePanelFolderName();

  $('#side-panel').removeAttribute('hidden');
}

function closeSidePanel() {
  $('#side-panel').setAttribute('hidden', '');
  state.selectedIngestId = null;
}

// ============== SSE (real-time sync) ==============

function connectSSE() {
  const indicator = $('#sync-pill');
  indicator.className = 'sync-pill connecting';
  if (sse) sse.close();
  sse = new EventSource('/api/events');

  sse.addEventListener('open', () => { indicator.className = 'sync-pill'; });
  sse.addEventListener('error', () => { indicator.className = 'sync-pill offline'; });

  const refresh = () => {
    if (!state.currentProjectId) return;
    loadIngests();
  };
  const refreshCrew = () => state.currentProjectId && loadCrew();
  const refreshCameras = () => state.currentProjectId && loadCameras();
  const refreshProjects = () => loadProjects();

  ['ingest:created', 'ingest:updated', 'ingest:status', 'ingest:deleted'].forEach(t => sse.addEventListener(t, refresh));
  ['crew:created', 'crew:updated', 'crew:deleted'].forEach(t => sse.addEventListener(t, refreshCrew));
  ['camera:created', 'camera:updated', 'camera:deleted'].forEach(t => sse.addEventListener(t, refreshCameras));
  ['project:created', 'project:updated', 'project:archived'].forEach(t => sse.addEventListener(t, refreshProjects));
}

// ============== EVENT WIRING ==============

function focusQuickAdd() {
  setView('board');
  setTimeout(() => $('#qa-desc').focus(), 50);
}

function wireEvents() {
  // Role picker
  $$('#view-role .role-card').forEach(c => c.addEventListener('click', () => setRole(c.dataset.role)));
  $('#btn-role-switch').addEventListener('click', switchRole);

  // Cutter filters
  $$('[data-cutter-filter]').forEach(btn => btn.addEventListener('click', () => {
    $$('[data-cutter-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.cutterFilter = btn.dataset.cutterFilter;
    renderCutterView();
  }));
  $('#cutter-search')?.addEventListener('input', () => renderCutterView());
  $('#cutter-day-filter')?.addEventListener('change', () => renderCutterView());
  $('#cutter-crew-filter')?.addEventListener('change', () => renderCutterView());

  // Mark all currently-done items as seen (project-scoped).
  $('#cutter-mark-all-seen')?.addEventListener('click', () => {
    for (const i of state.ingests) {
      if (i.status === 'done') state.knownDoneIds.add(i.id);
    }
    persistKnownDoneIds();
    renderCutterView();
    toast('Alle als gesehen markiert');
  });

  // Notifications
  $('#cutter-enable-notifications').addEventListener('click', async () => {
    await requestNotificationPermission();
    renderCutterView();
    updateNotificationButton();
  });
  $('#cutter-dismiss-banner').addEventListener('click', () => {
    localStorage.setItem('cutter:banner-dismissed', '1');
    $('#cutter-banner').setAttribute('hidden', '');
  });
  $('#btn-notifications').addEventListener('click', async () => {
    if (Notification.permission === 'granted') {
      toast('Benachrichtigungen sind bereits aktiv');
    } else {
      await requestNotificationPermission();
      updateNotificationButton();
    }
  });

  // Project switcher
  $('#project-switcher-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleProjectSwitcher(); });
  $('#ps-new-project').addEventListener('click', () => { closeProjectSwitcher(); openModal('modal-new-project'); });
  $('#ps-project-settings').addEventListener('click', () => { closeProjectSwitcher(); setView('settings'); });

  // Empty state
  $('#btn-create-first').addEventListener('click', () => openModal('modal-new-project'));

  // View switcher
  $$('#view-switcher .view-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  // Theme toggle
  $('#btn-theme').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Shortcuts
  $('#btn-shortcuts').addEventListener('click', () => openModal('modal-shortcuts'));

  // Modal close
  $$('[data-close-modal]').forEach(el => el.addEventListener('click', closeAllModals));

  // New project form — after creation, jump to settings to set up crew/cameras
  $('#form-new-project').addEventListener('submit', async (e) => {
    e.preventDefault();
    await createProject({
      name: $('#new-proj-name').value.trim(),
      location: $('#new-proj-location').value.trim(),
      date_start: $('#new-proj-start').value,
      date_end: $('#new-proj-end').value,
    });
    closeAllModals();
    e.target.reset();
    setView('settings');
    setTimeout(() => $('#crew-name')?.focus(), 100);
  });

  // Project edit form (settings)
  $('#form-project-edit').addEventListener('submit', async (e) => {
    e.preventDefault();
    await updateCurrentProject({
      name: $('#proj-name').value.trim(),
      location: $('#proj-location').value.trim(),
      date_start: $('#proj-date-start').value,
      date_end: $('#proj-date-end').value,
      notes: $('#proj-notes').value.trim(),
      stages: state.currentProject.stages,
      storage_targets: state.currentProject.storage_targets,
    });
  });

  $('#settings-back').addEventListener('click', () => setView('board'));
  $('#btn-archive-project').addEventListener('click', archiveCurrentProject);

  // Crew form
  $('#form-add-crew').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#crew-name').value.trim();
    const role = $('#crew-role').value.trim() || 'Kamera';
    if (!name) return;
    await api(`/api/projects/${state.currentProjectId}/crew`, { method: 'POST', body: { name, role } });
    $('#crew-name').value = '';
    toast(`${name} hinzugefügt`);
  });

  // (Camera form removed — cameras are now added inline per crew member in renderCrewBlocks)

  // Folder template form + live preview
  $('#form-folder-template').addEventListener('submit', async (e) => {
    e.preventDefault();
    const tmpl = $('#folder-template').value.trim();
    await updateCurrentProject({
      name: state.currentProject.name, location: state.currentProject.location,
      date_start: state.currentProject.date_start, date_end: state.currentProject.date_end,
      notes: state.currentProject.notes,
      stages: state.currentProject.stages, storage_targets: state.currentProject.storage_targets,
      folder_template: tmpl || '{day}_{crew}_{camera}_{card}',
    });
    updateFolderPreview();
  });
  $('#folder-template').addEventListener('input', updateFolderPreview);

  // Quick-add: when crew is picked, restrict camera dropdown to that crew's cameras
  // and auto-select the first owned camera as a convenience.
  $('#qa-crew').addEventListener('change', () => {
    refillCameraSelect($('#qa-camera'), $('#qa-crew'), 'Kamera...');
    const crewId = Number($('#qa-crew').value);
    if (!crewId) return;
    if ($('#qa-camera').value) return;
    const ownedCameras = state.cameras.filter(c => c.owner_crew_id === crewId);
    if (ownedCameras.length >= 1) {
      $('#qa-camera').value = ownedCameras[0].id;
    }
  });

  // Side panel: same crew→camera filter when editing an ingest.
  $('#sp-crew').addEventListener('change', () => {
    refillCameraSelect($('#sp-camera'), $('#sp-crew'), '— wählen —');
  });

  // Side panel: copy buttons (leaf for OffShoot, full path for reference)
  const setupCopyButton = (btnId, sourceId, doneText) => {
    $(`#${btnId}`).addEventListener('click', async () => {
      const text = $(`#${sourceId}`).textContent;
      if (!text || text === '—') return;
      try {
        await navigator.clipboard.writeText(text);
        const btn = $(`#${btnId}`);
        btn.classList.add('copied');
        const orig = btn.innerHTML;
        btn.innerHTML = doneText;
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = orig; }, 1500);
      } catch (e) {
        toast('Konnte nicht kopieren', 'error');
      }
    });
  };
  setupCopyButton('sp-folder-copy-leaf', 'sp-folder-leaf',
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Kopiert');
  setupCopyButton('sp-folder-copy-full', 'sp-folder-full', 'kopiert');

  // Update folder preview as user edits side-panel fields
  ['sp-crew', 'sp-camera', 'sp-day'].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.addEventListener('input', updateSidePanelFolderName);
    if (el && el.tagName === 'SELECT') el.addEventListener('change', updateSidePanelFolderName);
  });

  // Storage form
  $('#form-add-storage').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#storage-name').value.trim();
    if (!name) return;
    await maybeAddStorage(name);
    $('#storage-name').value = '';
  });

  // Settings list actions (remove)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'remove-crew') {
      if (!confirm('Diese Person wirklich entfernen? Ihre Kameras werden auf "Pool" gesetzt.')) return;
      await api(`/api/crew/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Person entfernt');
    } else if (action === 'remove-camera') {
      await api(`/api/cameras/${btn.dataset.id}`, { method: 'DELETE' });
      toast('Kamera entfernt');
    } else if (action === 'remove-storage') {
      const targets = (state.currentProject.storage_targets || []).filter(s => s !== btn.dataset.name);
      await updateCurrentProject({
        name: state.currentProject.name, location: state.currentProject.location,
        date_start: state.currentProject.date_start, date_end: state.currentProject.date_end,
        notes: state.currentProject.notes,
        stages: state.currentProject.stages, storage_targets: targets,
      });
    }
  });

  // Quick add
  $('#qa-submit').addEventListener('click', submitQuickAdd);
  ['qa-desc'].forEach(id => {
    $(`#${id}`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitQuickAdd(); }
    });
  });

  // Filters
  $('#board-search').addEventListener('input', (e) => { state.filters.search = e.target.value; renderActiveView(); });
  $('#board-day-filter').addEventListener('change', (e) => { state.filters.day = e.target.value; renderActiveView(); });
  $('#board-crew-filter').addEventListener('change', (e) => { state.filters.crew = e.target.value; renderActiveView(); });
  $('#list-search').addEventListener('input', (e) => { state.filters.search = e.target.value; renderActiveView(); });
  $$('.filter-chips .chip').forEach(c => c.addEventListener('click', () => {
    $$('.filter-chips .chip').forEach(b => b.classList.remove('active'));
    c.classList.add('active');
    state.filters.status = c.dataset.filter;
    renderActiveView();
  }));

  // Export
  $('#btn-export-csv').addEventListener('click', () => state.currentProjectId && window.open(`/api/projects/${state.currentProjectId}/export/csv`));
  $('#btn-export-json').addEventListener('click', () => state.currentProjectId && window.open(`/api/projects/${state.currentProjectId}/export/json`));

  // Side panel
  $$('[data-close-panel]').forEach(el => el.addEventListener('click', closeSidePanel));
  $$('.btn-status-action').forEach(b => b.addEventListener('click', async () => {
    if (!state.selectedIngestId) return;
    await changeStatus(state.selectedIngestId, b.dataset.status);
    closeSidePanel();
  }));
  $('#form-edit-ingest').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = state.selectedIngestId;
    if (!id) return;
    await updateIngestSave(id, {
      crew_id: $('#sp-crew').value || null,
      camera_id: $('#sp-camera').value || null,
      day_label: $('#sp-day').value.trim(),
      description: $('#sp-desc').value.trim(),
      storage_destination: $('#sp-storage').value.trim(),
      path: $('#sp-path').value.trim(),
      clip_count: $('#sp-clips').value,
      duration_minutes: $('#sp-duration').value,
      notes: $('#sp-notes').value.trim(),
    });
    closeSidePanel();
  });
  $('#btn-delete-ingest').addEventListener('click', async () => {
    const id = state.selectedIngestId;
    if (!id) return;
    if (await deleteIngestById(id)) closeSidePanel();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleShortcut);
}

async function submitQuickAdd() {
  if (!state.currentProjectId) return;
  const crewId = $('#qa-crew').value;
  const cameraId = $('#qa-camera').value;
  const desc = $('#qa-desc').value.trim();

  if (!crewId && !desc) {
    toast('Bitte mindestens Person oder Beschreibung angeben', 'error');
    return;
  }

  const ingest = await createIngest({
    crew_id: crewId || null,
    camera_id: cameraId || null,
    description: desc,
    status: 'waiting',
  });

  // Remember smart defaults
  state.smartDefaults = { crew_id: crewId, camera_id: cameraId };

  // Clear ephemeral fields, keep crew/camera/stage as defaults
  $('#qa-desc').value = '';

  // Auto-open side panel for the new ingest so user can copy folder name
  if (ingest?.id) {
    // Optimistic add so openSidePanel finds it before SSE refresh
    if (!state.ingests.find(i => i.id === ingest.id)) {
      state.ingests = [ingest, ...state.ingests];
      renderActiveView();
      updateStats();
    }
    openSidePanel(ingest.id);
  }
}

function handleShortcut(e) {
  if (e.key === 'Escape') {
    closeSidePanel();
    closeAllModals();
    closeProjectSwitcher();
    return;
  }
  const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (inField) return;

  if (e.key === '/') { e.preventDefault(); ($('#board-search') || $('#list-search'))?.focus(); return; }
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); focusQuickAdd(); return; }
  if (e.key === '?') { e.preventDefault(); openModal('modal-shortcuts'); return; }
  if (e.key === '1') { setView('board'); return; }
  if (e.key === '2') { setView('list'); return; }
  if (e.key === '3') { setView('dashboard'); return; }
}

// ============== MODALS ==============

function openModal(id) {
  $(`#${id}`).removeAttribute('hidden');
  const firstInput = $(`#${id} input:not([type=hidden])`);
  if (firstInput) setTimeout(() => firstInput.focus(), 50);
}
function closeAllModals() {
  $$('.modal-wrap').forEach(m => m.setAttribute('hidden', ''));
}

// ============== INIT ==============

async function init() {
  wireEvents();

  // Restore role
  const savedRole = localStorage.getItem('role');
  state.role = (savedRole === 'ingest' || savedRole === 'cutter') ? savedRole : null;
  renderRoleUi();
  applyRoleVisibility();
  updateNotificationButton();

  await loadProjects();

  if (!state.role) {
    setView('role');
  } else {
    const lastId = localStorage.getItem('lastProject');
    if (lastId && state.projects.find(p => p.id === Number(lastId))) {
      await selectProject(Number(lastId));
    } else if (state.role === 'cutter' && state.projects.length > 0) {
      await selectProject(state.projects[0].id);
    } else {
      routeForRole();
    }
  }

  connectSSE();

  // Tape strip clock
  tickTapeClock();
  setInterval(tickTapeClock, 1000);
}

document.addEventListener('DOMContentLoaded', init);
