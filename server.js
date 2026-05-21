const express = require('express');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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
  const headers = ['Nr', 'Tag', 'Erstellt', 'Kamera-Person', 'Kamera', 'Modell', 'Bühne', 'Karte', 'Beschreibung', 'Pfad', 'Storage', 'Clips', 'Footage (min)', 'Status', 'Notizen', 'Transfer Start', 'Transfer Ende', 'Transfer Dauer (s)'];
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
      row.stage || '', row.card_label || '',
      `"${(row.description || '').replace(/"/g, '""')}"`,
      `"${(row.path || '').replace(/"/g, '""')}"`,
      row.storage_destination || '', row.clip_count || '', row.duration_minutes || '',
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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  Ingest List läuft auf http://localhost:${PORT}\n`);
});
