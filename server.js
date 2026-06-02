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
  const headers = ['Nr', 'Tag', 'Erstellt', 'Kamera-Person', 'Kamera', 'Modell', 'Beschreibung', 'Pfad', 'Storage', 'Status', 'Notizen', 'Transfer Start', 'Transfer Ende', 'Transfer Dauer (s)'];
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

  const summaryCards = [
    { label: 'Übertragungen', value: stats.total, cls: '' },
    { label: 'Wartend', value: stats.waiting, cls: 'waiting' },
    { label: 'Übertragung', value: stats.transferring, cls: 'transferring' },
    { label: 'Fertig', value: stats.done, cls: 'done' },
    { label: 'Fehler', value: stats.errors, cls: 'error' },
    { label: 'Ø Transfer', value: stats.avg_transfer_seconds ? fmtDurationSec(stats.avg_transfer_seconds) : '–', cls: '' },
  ];

  const summaryHtml = summaryCards.map(c => `
    <div class="card ${c.cls}">
      <div class="card-val">${escHtml(c.value)}</div>
      <div class="card-lbl">${escHtml(c.label)}</div>
    </div>`).join('');

  const daySections = orderedDays.map(day => {
    const rows = groups.get(day);

    const tableRows = rows.map(i => {
      const cam = [i.camera_name, i.camera_model].filter(Boolean).join(' · ');
      const dur = fmtDurationSec(transferSeconds(i));
      const subBits = [];
      if (i.path) subBits.push(`<span class="sub-k">Ordner</span> ${escHtml(i.path)}`);
      if (i.storage_destination) subBits.push(`<span class="sub-k">Storage</span> ${escHtml(i.storage_destination)}`);
      if (i.notes) subBits.push(`<span class="sub-k">Notiz</span> ${escHtml(i.notes)}`);
      const subLine = subBits.length
        ? `<tr class="sub"><td></td><td colspan="4">${subBits.join('<span class="sep">·</span>')}</td></tr>`
        : '';
      const crewDot = i.crew_color
        ? `<span class="dot" style="background:${escHtml(i.crew_color)}"></span>`
        : '';
      return `
      <tr>
        <td class="nr">${i.sequence_number != null ? String(i.sequence_number).padStart(3, '0') : '–'}</td>
        <td>${crewDot}${escHtml(i.crew_name || '–')}</td>
        <td>${escHtml(cam || '–')}</td>
        <td class="desc">${escHtml(i.description || '–')}</td>
        <td><span class="badge ${i.status}">${escHtml(STATUS_LABELS[i.status] || i.status)}</span><span class="dur">${dur}</span></td>
      </tr>${subLine}`;
    }).join('');

    return `
    <section class="day">
      <div class="day-head">
        <h2>${escHtml(day)}</h2>
        <div class="day-sub">${rows.length} Übertragung${rows.length === 1 ? '' : 'en'}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th class="nr">Nr</th><th>Kamera-Person</th><th>Kamera</th><th>Beschreibung</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </section>`;
  }).join('');

  const emptyHtml = `<p class="empty">Noch keine Übertragungen in diesem Projekt.</p>`;

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Ingest-Report — ${escHtml(projectName)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1d1d1f; background: #f5f5f7; line-height: 1.4; font-size: 13px;
  }
  .page { max-width: 1000px; margin: 0 auto; padding: 32px; }
  header.report { display: flex; justify-content: space-between; align-items: flex-end;
    border-bottom: 2px solid #1d1d1f; padding-bottom: 16px; margin-bottom: 20px; }
  .brand { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #76767e; margin-bottom: 6px; }
  h1 { font-size: 26px; margin: 0; }
  .meta { color: #515154; font-size: 13px; margin-top: 4px; }
  .gen { text-align: right; color: #76767e; font-size: 11px; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 28px; }
  .card { border: 1px solid #e5e5e7; border-radius: 10px; padding: 12px 14px; background: #fff; }
  .card-val { font-size: 22px; font-weight: 600; }
  .card-lbl { font-size: 11px; color: #76767e; text-transform: uppercase; letter-spacing: .06em; margin-top: 2px; }
  .card.waiting .card-val { color: #b88a30; }
  .card.transferring .card-val { color: #c97050; }
  .card.done .card-val { color: #2f8a52; }
  .card.error .card-val { color: #d11; }
  section.day { margin-bottom: 22px; page-break-inside: auto; }
  .day-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px;
    border-bottom: 1px solid #d4d4d8; padding-bottom: 4px; }
  .day-head h2 { font-size: 16px; margin: 0; }
  .day-sub { color: #76767e; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
    color: #76767e; padding: 6px 8px; border-bottom: 1px solid #e5e5e7; }
  tbody td { padding: 7px 8px; border-bottom: 1px solid #ececef; vertical-align: top; }
  tbody tr { page-break-inside: avoid; }
  td.nr, th.nr { width: 42px; font-variant-numeric: tabular-nums; color: #76767e; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.desc { font-weight: 500; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge.waiting { background: #f7eed4; color: #8a6713; }
  .badge.transferring { background: #f7e2d6; color: #a3502c; }
  .badge.done { background: #d8f0e1; color: #1f6b3c; }
  .badge.error { background: #fbdad7; color: #b01; }
  .dur { color: #76767e; font-size: 11px; margin-left: 8px; font-variant-numeric: tabular-nums; }
  tr.sub td { border-bottom: 1px solid #ececef; padding-top: 0; color: #76767e; font-size: 11px; }
  tr.sub .sub-k { text-transform: uppercase; letter-spacing: .04em; font-size: 9px; color: #aeaeb4; margin-right: 3px; }
  tr.sub .sep { margin: 0 8px; color: #d4d4d8; }
  .empty { color: #76767e; padding: 40px 0; text-align: center; }
  footer.report { margin-top: 28px; border-top: 1px solid #e5e5e7; padding-top: 10px;
    color: #aeaeb4; font-size: 10px; display: flex; justify-content: space-between; }
  @media print {
    body { background: #fff; font-size: 11px; }
    .page { max-width: none; padding: 0; }
    .card { break-inside: avoid; }
    @page { margin: 14mm; }
  }
</style>
</head>
<body>
  <div class="page">
    <header class="report">
      <div>
        <div class="brand">Ingest List · Report</div>
        <h1>${escHtml(projectName)}</h1>
        ${metaBits.length ? `<div class="meta">${metaBits.join(' &nbsp;·&nbsp; ')}</div>` : ''}
      </div>
      <div class="gen">Erstellt<br>${escHtml(generatedAt)}</div>
    </header>
    <div class="summary">${summaryHtml}</div>
    ${ingests.length ? daySections : emptyHtml}
    <footer class="report">
      <span>Ingest List</span>
      <span>${stats.total} Übertragung${stats.total === 1 ? '' : 'en'} · ${escHtml(projectName)}</span>
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
