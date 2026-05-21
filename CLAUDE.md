# CLAUDE.md — Ingest List

Context for any Claude session working in this repo. Read this before touching deployment or the server.

## What this is

Festival video-ingest tracking tool. Camera operators bring SD cards, the ingest operator registers them in the app, transfers via OffShoot, and cutters see available material live. Vanilla JS + Express + SSE — no build step.

## Stack

- Backend: Node.js (Express) — `server.js`, `database.js`
- Storage: plain JSON at `data/db.json` (no external DB)
- Frontend: vanilla JS, Geist fonts, dark + light theme — `public/`
- Realtime: Server-Sent Events at `/api/events`
- Container: Node 22 Alpine

## Production deployment

The app is deployed on **james** (the user's home Ubuntu Docker server).

| Key | Value |
|---|---|
| Server | `nik@192.168.0.23` (hostname `james`) |
| Repo location on server | `~/docker/ingest-helper` |
| App URL | http://192.168.0.23:3000 |
| Container name | `ingest-list` |
| Data volume | `~/docker/ingest-helper/data` (host) → `/app/data` (container) |
| Restart policy | `unless-stopped` |
| Docker engine | 29.1.3 — but the bundled `docker compose` plugin is too old (v2.19.1, API 1.43), so we use `docker build` + `docker run` directly, NOT `docker compose up` |

SSH from the user's Windows machine works out of the box — the `id_ed25519` key is already authorized on james for the `nik` account.

## Update workflow (this is what the user expects me to do)

The user said: "Updates kommen nur über dich" — they do NOT push themselves. When the user wants a change:

1. Make changes locally in this repo on their Windows machine.
2. `git add -A && git commit -m "<msg>" && git push` to GitHub.
3. SSH to james and run the deploy script:
   ```powershell
   ssh nik@192.168.0.23 "cd ~/docker/ingest-helper && ./scripts/deploy.sh"
   ```
   That script pulls, rebuilds the image, stops + removes the old container, starts the new one with the same volume/port/env, and prints status + recent logs.

4. Verify the endpoint is alive:
   ```powershell
   Invoke-WebRequest -Uri "http://192.168.0.23:3000/api/projects" -UseBasicParsing -TimeoutSec 5
   ```
   Should return `200` with a JSON array.

## Git remote

- `origin` → `https://github.com/nikmarten/ingest-helper.git`
- HTTPS push works — credentials are cached locally via Git Credential Manager (no token handling needed).
- The user's SSH key is NOT registered on GitHub yet — don't switch the remote to SSH unless they add it.

## Local development

The user runs `node server.js` locally during development. There's no `npm run dev`, no watcher, no build step. Restart node when server-side files change. Browser reload for frontend changes.

The local dev server normally runs on http://localhost:3000 — but production is on 192.168.0.23:3000.

## Things that will trip you up

- **Don't use `docker compose`** on james — the plugin is too old. Use `docker build` + `docker run` directly, or `./scripts/deploy.sh`. The `docker-compose.yml` in the repo is kept as documentation only.
- **`data/` is .gitignored** — never commit the live DB. The mounted volume on james persists across rebuilds.
- **Light + dark theme are injected at runtime** via `<style id="__theme_vars">`. Don't rely solely on CSS attribute selectors for theme switching.
- **The DB is a single JSON file** (`data/db.json`). It's loaded once into memory at boot, mutated in place, and `JSON.stringify`d to disk on every write. Simple, fine for the scale of one festival.
- **SSE-based realtime** — when adding new server-side endpoints that mutate data, also emit a `db.events.emit('change', ...)` so the Cutter view's notifications work.
- **Sequence numbers (`{nr}`)** are scoped per (project, crew, camera, day). Don't change the grouping without thinking about existing folder names on disk.
- **Folder name template variables**: `{project}`, `{date}` (2026-05-21), `{ymd}` (20260521), `{day}`, `{crew}`, `{camera}` (uses short_code if set, else name), `{card}`, `{stage}`, `{nr}` (3-digit padded). Slash `/` in the template creates nested subfolders.

## Quick reference — server-side commands

```bash
# SSH in
ssh nik@192.168.0.23

# Deploy update (run on server, inside repo dir)
cd ~/docker/ingest-helper && ./scripts/deploy.sh

# View live logs
docker logs -f ingest-list

# Inspect db.json
cat ~/docker/ingest-helper/data/db.json | jq

# Stop the app (e.g. for maintenance)
docker stop ingest-list

# Start it again
docker start ingest-list

# Wipe data and start fresh — DESTRUCTIVE, ask user first
rm ~/docker/ingest-helper/data/db.json && docker restart ingest-list
```
