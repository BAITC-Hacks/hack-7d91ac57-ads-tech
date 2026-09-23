#!/usr/bin/env bash
# Stop hook: warns when the last push is older than 25 minutes or there are uncommitted changes.
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
last=$(git log -1 --format=%ct 2>/dev/null || echo 0)
age=$(( ( $(date +%s) - last ) / 60 ))
dirty=$(git status --porcelain | wc -l | tr -d ' ')
unpushed=$(git log @{u}..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
msg=""
[ "$age" -ge 25 ] && msg="$msg Last commit ${age} min ago."
[ "$dirty" -gt 0 ] && msg="$msg ${dirty} uncommitted files."
[ "$unpushed" -gt 0 ] && msg="$msg ${unpushed} unpushed commits."
[ -n "$msg" ] && echo "⏰ HACKATHON CHECKPOINT:$msg Run /checkpoint (hourly progress rule 5.4.8)."
exit 0
