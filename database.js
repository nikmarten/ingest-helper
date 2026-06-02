const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const events = new EventEmitter();

const EMPTY_DB = {
  projects: [],
  crew: [],
  cameras: [],
  ingests: [],
  _counters: { projects: 0, crew: 0, cameras: 0, ingests: 0 },
};

const CREW_COLORS = [
  '#5b8def', '#a78bfa', '#34d399', '#f0b429', '#ef4444',
  '#60a5fa', '#f472b6', '#10b981', '#fb923c', '#8b5cf6',
  '#06b6d4', '#eab308', '#ec4899', '#84cc16', '#f97316',
];

let data = null;

function load() {
  if (data) return data;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    migrate();
  } else {
    data = JSON.parse(JSON.stringify(EMPTY_DB));
  }
  return data;
}

function migrate() {
  if (!data._counters) {
    data._counters = {
      projects: Math.max(0, ...data.projects.map(p => p.id)),
      crew: Math.max(0, ...data.crew.map(c => c.id)),
      cameras: Math.max(0, ...data.cameras.map(c => c.id)),
      ingests: Math.max(0, ...data.ingests.map(i => i.id)),
    };
  }
  data.crew.forEach((c, i) => {
    if (!c.color) c.color = CREW_COLORS[i % CREW_COLORS.length];
    if (c.phone === undefined) c.phone = null;
  });
  data.ingests.forEach(i => {
    if (i.day_label === undefined) i.day_label = null;
    if (i.storage_destination === undefined) i.storage_destination = null;
    if (i.sequence_number === undefined) i.sequence_number = null;
  });

  // Backfill sequence_number for existing ingests (grouped by project, crew, camera, day)
  const needsBackfill = data.ingests.filter(i => i.sequence_number == null);
  if (needsBackfill.length > 0) {
    const groups = {};
    for (const i of needsBackfill) {
      const key = `${i.project_id}|${i.crew_id ?? 'n'}|${i.camera_id ?? 'n'}|${i.day_label ?? 'n'}`;
      (groups[key] ||= []).push(i);
    }
    for (const key in groups) {
      groups[key].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
      const sameGroupExisting = data.ingests.filter(i => {
        const k = `${i.project_id}|${i.crew_id ?? 'n'}|${i.camera_id ?? 'n'}|${i.day_label ?? 'n'}`;
        return k === key && i.sequence_number != null;
      });
      let maxExisting = sameGroupExisting.reduce((m, i) => Math.max(m, i.sequence_number), 0);
      groups[key].forEach(i => { i.sequence_number = ++maxExisting; });
    }
  }
  data.projects.forEach(p => {
    if (p.storage_targets === undefined) p.storage_targets = [];
    if (p.folder_template === undefined) p.folder_template = '{day}/{ymd}_{crew}_{camera}_{nr}';
  });
  data.cameras.forEach(c => {
    if (c.owner_crew_id === undefined) c.owner_crew_id = null;
    if (c.short_code === undefined) c.short_code = null;
  });
}

function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function nextId(table) {
  data._counters[table]++;
  return data._counters[table];
}

function emit(type, payload) {
  events.emit('change', { type, payload, ts: Date.now() });
}

// --- Projects ---

function getProjects() {
  return load().projects.filter(p => !p.archived);
}

function getProject(id) {
  return load().projects.find(p => p.id === id);
}

function createProject({ name, location, date_start, date_end, notes, folder_template }) {
  const db = load();
  const project = {
    id: nextId('projects'),
    name,
    location: location || null,
    date_start: date_start || null,
    date_end: date_end || null,
    notes: notes || null,
    storage_targets: [],
    folder_template: folder_template || '{day}/{ymd}_{crew}_{camera}_{nr}',
    created_at: now(),
    archived: 0,
  };
  db.projects.push(project);
  save();
  emit('project:created', project);
  return project;
}

function updateProject(id, fields) {
  const db = load();
  const proj = db.projects.find(p => p.id === id);
  if (!proj) return null;
  Object.assign(proj, {
    name: fields.name ?? proj.name,
    location: fields.location ?? null,
    date_start: fields.date_start ?? null,
    date_end: fields.date_end ?? null,
    notes: fields.notes ?? null,
    storage_targets: fields.storage_targets ?? proj.storage_targets,
    folder_template: fields.folder_template ?? proj.folder_template,
  });
  save();
  emit('project:updated', proj);
  return proj;
}

function archiveProject(id) {
  const db = load();
  const proj = db.projects.find(p => p.id === id);
  if (proj) {
    proj.archived = 1;
    save();
    emit('project:archived', proj);
  }
}

// --- Crew ---

function getCrew(projectId) {
  return load().crew.filter(c => c.project_id === projectId).sort((a, b) => a.name.localeCompare(b.name));
}

function createCrew(projectId, { name, role, color, phone }) {
  const db = load();
  const existingColors = db.crew.filter(c => c.project_id === projectId).map(c => c.color);
  const availableColor = color || CREW_COLORS.find(c => !existingColors.includes(c)) || CREW_COLORS[db.crew.length % CREW_COLORS.length];
  const member = {
    id: nextId('crew'),
    project_id: projectId,
    name,
    role: role || 'Kamera',
    color: availableColor,
    phone: phone || null,
  };
  db.crew.push(member);
  save();
  emit('crew:created', member);
  return member;
}

function updateCrew(id, fields) {
  const db = load();
  const member = db.crew.find(c => c.id === id);
  if (!member) return null;
  Object.assign(member, {
    name: fields.name ?? member.name,
    role: fields.role ?? member.role,
    color: fields.color ?? member.color,
    phone: fields.phone ?? null,
  });
  save();
  emit('crew:updated', member);
  return member;
}

function deleteCrew(id) {
  const db = load();
  db.crew = db.crew.filter(c => c.id !== id);
  db.ingests.forEach(i => { if (i.crew_id === id) i.crew_id = null; });
  db.cameras.forEach(c => { if (c.owner_crew_id === id) c.owner_crew_id = null; });
  save();
  emit('crew:deleted', { id });
}

// --- Cameras ---

function getCameras(projectId) {
  return load().cameras.filter(c => c.project_id === projectId).sort((a, b) => a.name.localeCompare(b.name));
}

function createCamera(projectId, { name, short_code, model, owner_crew_id }) {
  const db = load();
  const camera = {
    id: nextId('cameras'),
    project_id: projectId,
    name,
    short_code: short_code || null,
    model: model || null,
    owner_crew_id: owner_crew_id ? Number(owner_crew_id) : null,
  };
  db.cameras.push(camera);
  save();
  emit('camera:created', camera);
  return camera;
}

function updateCamera(id, fields) {
  const db = load();
  const camera = db.cameras.find(c => c.id === id);
  if (!camera) return null;
  Object.assign(camera, {
    name: fields.name ?? camera.name,
    short_code: fields.short_code !== undefined ? (fields.short_code || null) : camera.short_code,
    model: fields.model !== undefined ? (fields.model || null) : camera.model,
    owner_crew_id: fields.owner_crew_id !== undefined && fields.owner_crew_id !== '' ? Number(fields.owner_crew_id) : null,
  });
  save();
  emit('camera:updated', camera);
  return camera;
}

function deleteCamera(id) {
  const db = load();
  db.cameras = db.cameras.filter(c => c.id !== id);
  db.ingests.forEach(i => { if (i.camera_id === id) i.camera_id = null; });
  save();
  emit('camera:deleted', { id });
}

// --- Ingests ---

function hydrate(i, crewMap, camMap) {
  const c = crewMap[i.crew_id];
  const cam = camMap[i.camera_id];
  return {
    ...i,
    crew_name: c?.name || null,
    crew_role: c?.role || null,
    crew_color: c?.color || null,
    camera_name: cam?.name || null,
    camera_short_code: cam?.short_code || null,
    camera_model: cam?.model || null,
  };
}

function getIngests(projectId) {
  const db = load();
  const crewMap = Object.fromEntries(db.crew.map(c => [c.id, c]));
  const camMap = Object.fromEntries(db.cameras.map(c => [c.id, c]));

  return db.ingests
    .filter(i => i.project_id === projectId)
    .map(i => hydrate(i, crewMap, camMap))
    .sort((a, b) => {
      const statusOrder = { waiting: 0, transferring: 1, error: 2, done: 3 };
      const sa = statusOrder[a.status] ?? 4;
      const sb = statusOrder[b.status] ?? 4;
      if (sa !== sb) return sa - sb;
      return b.created_at.localeCompare(a.created_at);
    });
}

function getIngest(id) {
  const db = load();
  const i = db.ingests.find(x => x.id === id);
  if (!i) return null;
  const crewMap = Object.fromEntries(db.crew.map(c => [c.id, c]));
  const camMap = Object.fromEntries(db.cameras.map(c => [c.id, c]));
  return hydrate(i, crewMap, camMap);
}

function computeDayLabel(projectId, createdAt) {
  const db = load();
  const proj = db.projects.find(p => p.id === projectId);
  if (!proj?.date_start) return null;
  const start = new Date(proj.date_start);
  const created = new Date(createdAt.replace(' ', 'T'));
  const diffMs = created - start;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'Pre-Show';
  return `Day ${diffDays + 1}`;
}

function computeSequenceNumber(projectId, crewId, cameraId, dayLabel) {
  const db = load();
  const max = db.ingests
    .filter(i => i.project_id === projectId && i.crew_id === crewId && i.camera_id === cameraId && i.day_label === dayLabel)
    .reduce((m, i) => Math.max(m, i.sequence_number || 0), 0);
  return max + 1;
}

function createIngest(projectId, fields) {
  const db = load();
  const createdAt = now();
  const crewId = fields.crew_id ? Number(fields.crew_id) : null;
  const cameraId = fields.camera_id ? Number(fields.camera_id) : null;
  const dayLabel = fields.day_label || computeDayLabel(projectId, createdAt);
  const ingest = {
    id: nextId('ingests'),
    project_id: projectId,
    crew_id: crewId,
    camera_id: cameraId,
    description: fields.description || null,
    path: fields.path || null,
    storage_destination: fields.storage_destination || null,
    day_label: dayLabel,
    sequence_number: computeSequenceNumber(projectId, crewId, cameraId, dayLabel),
    status: fields.status || 'waiting',
    notes: fields.notes || null,
    created_at: createdAt,
    updated_at: createdAt,
    transfer_started_at: fields.status === 'transferring' ? createdAt : null,
    transfer_completed_at: fields.status === 'done' ? createdAt : null,
  };
  db.ingests.push(ingest);
  save();
  const hydrated = getIngest(ingest.id);
  emit('ingest:created', hydrated);
  return hydrated;
}

function updateIngest(id, fields) {
  const db = load();
  const ingest = db.ingests.find(i => i.id === id);
  if (!ingest) return null;
  Object.assign(ingest, {
    crew_id: fields.crew_id ? Number(fields.crew_id) : null,
    camera_id: fields.camera_id ? Number(fields.camera_id) : null,
    description: fields.description ?? null,
    path: fields.path ?? null,
    storage_destination: fields.storage_destination ?? null,
    day_label: fields.day_label ?? ingest.day_label,
    notes: fields.notes ?? null,
    updated_at: now(),
  });
  save();
  const hydrated = getIngest(id);
  emit('ingest:updated', hydrated);
  return hydrated;
}

function updateIngestStatus(id, status) {
  const db = load();
  const ingest = db.ingests.find(i => i.id === id);
  if (!ingest) return null;
  ingest.status = status;
  ingest.updated_at = now();
  if (status === 'transferring' && !ingest.transfer_started_at) ingest.transfer_started_at = now();
  if (status === 'done') ingest.transfer_completed_at = now();
  if (status === 'waiting') {
    ingest.transfer_started_at = null;
    ingest.transfer_completed_at = null;
  }
  save();
  const hydrated = getIngest(id);
  emit('ingest:status', hydrated);
  return hydrated;
}

function deleteIngest(id) {
  const db = load();
  db.ingests = db.ingests.filter(i => i.id !== id);
  save();
  emit('ingest:deleted', { id });
}

// --- Stats ---

function getStats(projectId) {
  const db = load();
  const projectIngests = db.ingests.filter(i => i.project_id === projectId);
  const byDay = {};
  let transferTotalSec = 0;
  let transferCount = 0;

  for (const i of projectIngests) {
    const day = i.day_label || 'Unbekannt';
    if (!byDay[day]) byDay[day] = { total: 0, waiting: 0, transferring: 0, done: 0 };
    byDay[day].total++;
    byDay[day][i.status] = (byDay[day][i.status] || 0) + 1;

    if (i.transfer_started_at && i.transfer_completed_at) {
      const s = new Date(i.transfer_started_at.replace(' ', 'T'));
      const e = new Date(i.transfer_completed_at.replace(' ', 'T'));
      transferTotalSec += (e - s) / 1000;
      transferCount++;
    }
  }

  return {
    total: projectIngests.length,
    waiting: projectIngests.filter(i => i.status === 'waiting').length,
    transferring: projectIngests.filter(i => i.status === 'transferring').length,
    done: projectIngests.filter(i => i.status === 'done').length,
    errors: projectIngests.filter(i => i.status === 'error').length,
    by_day: byDay,
    avg_transfer_seconds: transferCount > 0 ? Math.round(transferTotalSec / transferCount) : 0,
  };
}

module.exports = {
  events,
  getProjects, getProject, createProject, updateProject, archiveProject,
  getCrew, createCrew, updateCrew, deleteCrew,
  getCameras, createCamera, updateCamera, deleteCamera,
  getIngests, getIngest, createIngest, updateIngest, updateIngestStatus, deleteIngest,
  getStats,
  CREW_COLORS,
};
