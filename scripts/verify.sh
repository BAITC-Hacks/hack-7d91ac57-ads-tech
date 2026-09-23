#!/usr/bin/env bash
# Main scenario check. Reviewers run this after `docker compose up`.
set -euo pipefail
BASE="${BASE:-http://localhost:8000}"
SAMPLE="${SAMPLE:-data-samples/biology_7_photosynthesis.txt}"
echo "[1/3] health"
curl -sf "$BASE/api/health" | python3 -m json.tool
if [ -f "$SAMPLE" ]; then
  echo "[2/3] upload sample: $SAMPLE"
  curl -sf -F "file=@$SAMPLE" "$BASE/api/documents" | python3 -m json.tool
else
  echo "[2/3] no sample file at $SAMPLE, skipping upload"
fi
echo "[3/3] chat round-trip (agent may call tools)"
curl -sf -X POST "$BASE/api/chat" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Что такое фотосинтез? Ответь по загруженным материалам, если они есть."}]}' | python3 -m json.tool
echo "OK"
