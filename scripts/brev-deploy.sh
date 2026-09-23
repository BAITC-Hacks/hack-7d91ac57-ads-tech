#!/usr/bin/env bash
# Выкатить текущее рабочее дерево (код + backend/data + .env) на Brev-инстанс и пересобрать.
# Публичная ссылка: контейнер ekt-tunnel (Cloudflare quick tunnel) → localhost:8080.
# Usage: bash scripts/brev-deploy.sh [instance]
set -euo pipefail
INSTANCE="${1:-varying-pink-duck}"
cd "$(dirname "$0")/.."
rsync -az --delete --exclude node_modules --exclude .venv --exclude dist --exclude .git \
  --exclude __pycache__ --exclude .pytest_cache --exclude '*.tsbuildinfo' ./ "$INSTANCE":ekt/
ssh -o BatchMode=yes "$INSTANCE" 'cd ekt && WEB_PORT=8080 docker compose -p ekt \
  -f docker-compose.yml -f docker-compose.brev.yml up -d --build && \
  (docker ps -q -f name=ekt-tunnel | grep -q . || docker run -d --name ekt-tunnel --restart unless-stopped \
     --network host cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://localhost:8080) && \
  sleep 3 && docker logs ekt-tunnel 2>&1 | grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | tail -1'
