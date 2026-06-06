const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Auth (single shared password, stored in browser cookie) ---

const PASSWORD = process.env.INGEST_PASSWORD || 'RaR2026';
const AUTH_TOKEN = crypto.createHash('sha256').update(PASSWORD).digest('hex');
const COOKIE_NAME = 'ingest_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthenticated(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] === AUTH_TOKEN;
}

app.use(express.json());

// Gate everything except the login page + the login API behind a cookie check.
app.use((req, res, next) => {
  if (req.path === '/login' && req.method === 'GET') return next();
  if (req.path === '/api/login' && req.method === 'POST') return next();
  if (req.path === '/healthz') return next();
  if (req.path === '/favicon.ico' || req.path === '/favicon.svg') return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
  if (isAuthenticated(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== PASSWORD) {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}; Path=/`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- SSE for real-time sync ---

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  const listener = (event) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
  };
  db.events.on('change', listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    db.events.off('change', listener);
  });
});

// --- Projects ---

app.get('/api/projects', (req, res) => res.json(db.getProjects()));
app.post('/api/projects', (req, res) => res.status(201).json(db.createProject(req.body)));
app.put('/api/projects/:id', (req, res) => {
  const project = db.updateProject(Number(req.params.id), req.body);
  if (!project) return res.status(404).json({ error: 'Not found' });
  res.json(project);
});
app.delete('/api/projects/:id', (req, res) => {
  db.archiveProject(Number(req.params.id));
  res.json({ ok: true });
});

// --- Crew ---

app.get('/api/projects/:projectId/crew', (req, res) => res.json(db.getCrew(Number(req.params.projectId))));
app.post('/api/projects/:projectId/crew', (req, res) => res.status(201).json(db.createCrew(Number(req.params.projectId), req.body)));
app.put('/api/crew/:id', (req, res) => {
  const member = db.updateCrew(Number(req.params.id), req.body);
  if (!member) return res.status(404).json({ error: 'Not found' });
  res.json(member);
});
app.delete('/api/crew/:id', (req, res) => {
  db.deleteCrew(Number(req.params.id));
  res.json({ ok: true });
});

// --- Cameras ---

app.get('/api/projects/:projectId/cameras', (req, res) => res.json(db.getCameras(Number(req.params.projectId))));
app.post('/api/projects/:projectId/cameras', (req, res) => res.status(201).json(db.createCamera(Number(req.params.projectId), req.body)));
app.put('/api/cameras/:id', (req, res) => {
  const camera = db.updateCamera(Number(req.params.id), req.body);
  if (!camera) return res.status(404).json({ error: 'Not found' });
  res.json(camera);
});
app.delete('/api/cameras/:id', (req, res) => {
  db.deleteCamera(Number(req.params.id));
  res.json({ ok: true });
});

// --- Ingests ---

app.get('/api/projects/:projectId/ingests', (req, res) => res.json(db.getIngests(Number(req.params.projectId))));
app.post('/api/projects/:projectId/ingests', (req, res) => res.status(201).json(db.createIngest(Number(req.params.projectId), req.body)));
app.put('/api/ingests/:id', (req, res) => {
  const ingest = db.updateIngest(Number(req.params.id), req.body);
  if (!ingest) return res.status(404).json({ error: 'Not found' });
  res.json(ingest);
});
app.patch('/api/ingests/:id/status', (req, res) => {
  const ingest = db.updateIngestStatus(Number(req.params.id), req.body.status);
  if (!ingest) return res.status(404).json({ error: 'Not found' });
  res.json(ingest);
});
app.delete('/api/ingests/:id', (req, res) => {
  db.deleteIngest(Number(req.params.id));
  res.json({ ok: true });
});

// --- Stats ---

app.get('/api/projects/:projectId/stats', (req, res) => res.json(db.getStats(Number(req.params.projectId))));

// --- Export ---

app.get('/api/projects/:projectId/export/csv', (req, res) => {
  const projectId = Number(req.params.projectId);
  const project = db.getProject(projectId);
  const ingests = db.getIngests(projectId);
  const statusMap = { waiting: 'Wartend', transferring: 'Wird übertragen', done: 'Fertig', error: 'Fehler' };
  const headers = ['Nr', 'Tag', 'Erstellt', 'Kamera-Person', 'Kamera', 'Modell', 'Beschreibung', 'Bühne', 'Pfad', 'Storage', 'Status', 'Notizen', 'Transfer Start', 'Transfer Ende', 'Transfer Dauer (s)'];
  const csvRows = [headers.join(';')];

  for (const row of ingests) {
    let durationSec = '';
    if (row.transfer_started_at && row.transfer_completed_at) {
      const s = new Date(row.transfer_started_at.replace(' ', 'T'));
      const e = new Date(row.transfer_completed_at.replace(' ', 'T'));
      durationSec = Math.round((e - s) / 1000);
    }
    csvRows.push([
      row.id, row.day_label || '', row.created_at,
      row.crew_name || '', row.camera_name || '', row.camera_model || '',
      `"${(row.description || '').replace(/"/g, '""')}"`,
      row.stage || '',
      `"${(row.path || '').replace(/"/g, '""')}"`,
      row.storage_destination || '',
      statusMap[row.status] || row.status,
      `"${(row.notes || '').replace(/"/g, '""')}"`,
      row.transfer_started_at || '', row.transfer_completed_at || '', durationSec,
    ].join(';'));
  }

  const filename = `ingest_${(project?.name || 'export').replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csvRows.join('\r\n'));
});

app.get('/api/projects/:projectId/export/json', (req, res) => {
  const projectId = Number(req.params.projectId);
  const project = db.getProject(projectId);
  const ingests = db.getIngests(projectId);
  const crew = db.getCrew(projectId);
  const cameras = db.getCameras(projectId);
  const filename = `ingest_${(project?.name || 'export').replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json({ project, crew, cameras, ingests });
});

// --- PDF / HTML report ---

const STATUS_LABELS = { waiting: 'Wartend', transferring: 'Wird übertragen', done: 'Fertig', error: 'Fehler' };

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtDurationSec(sec) {
  if (sec == null || isNaN(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function transferSeconds(row) {
  if (!row.transfer_started_at || !row.transfer_completed_at) return null;
  const s = new Date(row.transfer_started_at.replace(' ', 'T'));
  const e = new Date(row.transfer_completed_at.replace(' ', 'T'));
  return Math.round((e - s) / 1000);
}

// Order day labels: Pre-Show first, then "Day N" ascending, unknown last.
function dayRank(label) {
  if (!label) return Number.MAX_SAFE_INTEGER;
  if (label === 'Pre-Show') return -1;
  const m = /Day\s+(\d+)/i.exec(label);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER - 1;
}

function buildReportHtml(project, ingests, stats, { print = false } = {}) {
  const projectName = project?.name || 'Projekt';
  const generatedAt = new Date().toLocaleString('de-DE', { dateStyle: 'long', timeStyle: 'short' });

  const metaBits = [];
  if (project?.location) metaBits.push(escHtml(project.location));
  if (project?.date_start) {
    metaBits.push(escHtml(project.date_end && project.date_end !== project.date_start
      ? `${project.date_start} – ${project.date_end}`
      : project.date_start));
  }

  // Group ingests by day_label.
  const groups = new Map();
  for (const i of ingests) {
    const key = i.day_label || 'Ohne Tag';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const orderedDays = [...groups.keys()].sort((a, b) => dayRank(a) - dayRank(b));

  // Full storage location = storage target + generated folder name (the "where").
  const fullLocation = (i) => {
    const folder = db.buildFolderName(i, project);
    const base = (i.storage_destination || '').trim().replace(/[\/\\]+$/, '');
    if (base && folder) return `${base}/${folder}`;
    return base || folder || '';
  };

  const summaryCards = [
    { label: 'Aufnahmen', value: stats.total, cls: '' },
    { label: 'Fertig', value: stats.done, cls: 'done' },
    { label: 'In Arbeit', value: stats.waiting + stats.transferring, cls: 'transferring' },
    { label: 'Drehtage', value: orderedDays.length, cls: '' },
  ];
  if (stats.errors) summaryCards.push({ label: 'Fehler', value: stats.errors, cls: 'error' });

  const summaryHtml = summaryCards.map(c => `
    <div class="card ${c.cls}">
      <div class="card-val">${escHtml(c.value)}</div>
      <div class="card-lbl">${escHtml(c.label)}</div>
    </div>`).join('');

  const daySections = orderedDays.map(day => {
    const rows = groups.get(day);

    const tableRows = rows.map(i => {
      const camBits = [i.camera_short_code || i.camera_name, i.camera_model].filter(Boolean);
      const cam = camBits.length ? camBits.join(' · ') : '–';
      const loc = fullLocation(i);
      const crewDot = i.crew_color
        ? `<span class="dot" style="background:${escHtml(i.crew_color)}"></span>`
        : '';
      const stageBadge = i.stage ? `<span class="stage">${escHtml(i.stage)}</span>` : '';
      const noteLine = i.notes ? `<div class="note">${escHtml(i.notes)}</div>` : '';
      return `
      <tr>
        <td class="nr">${i.sequence_number != null ? String(i.sequence_number).padStart(3, '0') : '–'}</td>
        <td class="rec">
          <div class="rec-title">${escHtml(i.description || '(ohne Beschreibung)')}${stageBadge}</div>
          ${noteLine}
        </td>
        <td class="who">${crewDot}${escHtml(i.crew_name || '–')}<span class="cam">${escHtml(cam)}</span></td>
        <td class="loc">${loc ? `<span class="path">${escHtml(loc)}</span>` : '<span class="path none">—</span>'}</td>
        <td class="st"><span class="badge ${i.status}">${escHtml(STATUS_LABELS[i.status] || i.status)}</span></td>
      </tr>`;
    }).join('');

    return `
    <section class="day">
      <div class="day-head">
        <h2>${escHtml(day)}</h2>
        <span class="day-sub">${rows.length} Aufnahme${rows.length === 1 ? '' : 'n'}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th class="nr">Nr</th>
            <th>Was wurde gedreht</th>
            <th>Person · Kamera</th>
            <th>Speicherort</th>
            <th class="st">Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </section>`;
  }).join('');

  const emptyHtml = `<p class="empty">Noch keine Aufnahmen in diesem Projekt.</p>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ingest-Report — ${escHtml(projectName)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #14161a; background: #eceef1; line-height: 1.45; font-size: 13px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .page { max-width: 1080px; margin: 24px auto; background: #fff; padding: 44px 48px;
    box-shadow: 0 1px 4px rgba(0,0,0,.06); border-radius: 4px; }

  header.report { display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2.5px solid #14161a; padding-bottom: 18px; margin-bottom: 26px; }
  .brand { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: #9aa0a8; font-weight: 600; margin-bottom: 8px; }
  h1 { font-size: 30px; line-height: 1.1; margin: 0; letter-spacing: -0.01em; }
  .meta { color: #4b5563; font-size: 13.5px; margin-top: 8px; }
  .gen { text-align: right; color: #9aa0a8; font-size: 11px; line-height: 1.5; white-space: nowrap; padding-top: 4px; }
  .gen strong { color: #4b5563; font-weight: 600; }

  .summary { display: flex; flex-wrap: wrap; gap: 0; margin-bottom: 34px;
    border: 1px solid #e6e8eb; border-radius: 8px; overflow: hidden; }
  .card { flex: 1 1 0; min-width: 120px; padding: 14px 18px; border-right: 1px solid #e6e8eb; }
  .card:last-child { border-right: none; }
  .card-val { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
  .card-lbl { font-size: 10.5px; color: #9aa0a8; text-transform: uppercase; letter-spacing: .07em; margin-top: 3px; font-weight: 600; }
  .card.done .card-val { color: #1f7a44; }
  .card.transferring .card-val { color: #b4651f; }
  .card.error .card-val { color: #c0271a; }

  section.day { margin-bottom: 30px; }
  .day-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .day-head h2 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  .day-sub { color: #9aa0a8; font-size: 12px; font-weight: 500; }

  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
    color: #6b7280; font-weight: 700; padding: 0 12px 8px; border-bottom: 2px solid #14161a; }
  tbody td { padding: 11px 12px; border-bottom: 1px solid #eef0f2; vertical-align: top; }
  tbody tr { page-break-inside: avoid; }
  tbody tr:nth-child(even) { background: #f8f9fa; }

  td.nr, th.nr { width: 46px; font-variant-numeric: tabular-nums; color: #9aa0a8; font-weight: 600; }
  td.rec { width: 38%; }
  .rec-title { font-size: 14px; font-weight: 600; color: #14161a; }
  .note { color: #6b7280; font-size: 11.5px; margin-top: 3px; font-style: italic; }
  .stage { display: inline-block; margin-left: 8px; padding: 1px 8px; border-radius: 4px;
    background: #14161a; color: #fff; font-size: 9.5px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; vertical-align: middle; }
  td.who { color: #14161a; font-weight: 500; white-space: nowrap; }
  td.who .cam { display: block; color: #6b7280; font-weight: 400; font-size: 11.5px; margin-top: 2px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 7px; vertical-align: middle; }
  td.loc { width: 34%; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
    color: #374151; background: #f3f4f6; padding: 3px 7px; border-radius: 4px; word-break: break-all; }
  .path.none { background: none; color: #c4c8cd; }
  td.st, th.st { text-align: right; white-space: nowrap; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge.waiting { background: #f3edda; color: #84671a; }
  .badge.transferring { background: #f6e3d4; color: #a3501f; }
  .badge.done { background: #d9f0e2; color: #1f7a44; }
  .badge.error { background: #fbdad7; color: #c0271a; }

  .empty { color: #9aa0a8; padding: 60px 0; text-align: center; }
  footer.report { margin-top: 34px; border-top: 1px solid #e6e8eb; padding-top: 12px;
    color: #9aa0a8; font-size: 10.5px; display: flex; justify-content: space-between; }

  @media print {
    body { background: #fff; font-size: 10.5px; }
    .page { max-width: none; margin: 0; padding: 0; box-shadow: none; border-radius: 0; }
    section.day { page-break-inside: auto; }
    thead { display: table-header-group; }
    @page { margin: 14mm; }
  }
</style>
</head>
<body>
  <div class="page">
    <header class="report">
      <div>
        <div class="brand">Ingest&nbsp;·&nbsp;Aufnahmebericht</div>
        <h1>${escHtml(projectName)}</h1>
        ${metaBits.length ? `<div class="meta">${metaBits.join(' &nbsp;·&nbsp; ')}</div>` : ''}
      </div>
      <div class="gen">Erstellt am<br><strong>${escHtml(generatedAt)}</strong></div>
    </header>
    <div class="summary">${summaryHtml}</div>
    ${ingests.length ? daySections : emptyHtml}
    <footer class="report">
      <span>Ingest List · Aufnahmebericht</span>
      <span>${stats.total} Aufnahme${stats.total === 1 ? '' : 'n'} · ${escHtml(projectName)}</span>
    </footer>
  </div>
  ${print ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},250);});</script>' : ''}
</body>
</html>`;
}

app.get('/api/projects/:projectId/export/html', (req, res) => {
  const projectId = Number(req.params.projectId);
  const project = db.getProject(projectId);
  const ingests = db.getIngests(projectId);
  const stats = db.getStats(projectId);
  const print = req.query.print === '1';
  const html = buildReportHtml(project, ingests, stats, { print });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.query.download === '1') {
    const filename = `ingest_${(project?.name || 'export').replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().slice(0, 10)}.html`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  res.send(html);
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Ingest List läuft auf http://localhost:${PORT}\n`);
});
