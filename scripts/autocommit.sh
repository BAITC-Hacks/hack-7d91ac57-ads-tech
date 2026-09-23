#!/usr/bin/env bash
# Auto-checkpoint: commits and pushes every N minutes if there are changes.
# Usage: bash scripts/autocommit.sh [minutes]   (default 20). Run in a separate terminal.
set -u
INTERVAL_MIN="${1:-20}"
cd "$(git rev-parse --show-toplevel)"
echo "autocommit every ${INTERVAL_MIN} min in $(pwd). Ctrl+C to stop."
while true; do
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q -m "checkpoint $(date +%H:%M): $(git status --porcelain | wc -l | tr -d ' ') files" && \
    git push -q && echo "$(date +%H:%M:%S) pushed" || echo "$(date +%H:%M:%S) PUSH FAILED — check network/auth"
  else
    echo "$(date +%H:%M:%S) no changes"
  fi
  sleep "$((INTERVAL_MIN * 60))"
done
