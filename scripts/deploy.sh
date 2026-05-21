#!/usr/bin/env bash
# Deploy / update Ingest List on james.
# Run from inside the repo dir on the server:
#   cd ~/docker/ingest-helper && ./scripts/deploy.sh
#
# This script is idempotent — safe to run multiple times.

set -euo pipefail

IMAGE="ingest-list:latest"
CONTAINER="ingest-list"
HOST_PORT="${HOST_PORT:-3000}"
DATA_DIR="${DATA_DIR:-$HOME/docker/ingest-helper/data}"
TZ_VAL="${TZ_VAL:-Europe/Berlin}"

echo "==> Pulling latest from GitHub"
git pull --ff-only

echo "==> Building image $IMAGE"
docker build -t "$IMAGE" .

echo "==> Ensuring data dir $DATA_DIR exists"
mkdir -p "$DATA_DIR"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
  echo "==> Stopping existing container $CONTAINER"
  docker stop "$CONTAINER" >/dev/null
  echo "==> Removing existing container $CONTAINER"
  docker rm "$CONTAINER" >/dev/null
fi

echo "==> Starting fresh container $CONTAINER"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "${HOST_PORT}:3000" \
  -v "${DATA_DIR}:/app/data" \
  -e NODE_ENV=production \
  -e TZ="$TZ_VAL" \
  "$IMAGE" >/dev/null

# brief wait for healthcheck to spin up
sleep 2

echo ""
echo "==> Status"
docker ps --filter "name=${CONTAINER}" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

echo ""
echo "==> Recent logs"
docker logs --tail 8 "$CONTAINER" 2>&1 || true

echo ""
echo "Done. App: http://$(hostname -I | awk '{print $1}'):${HOST_PORT}"
