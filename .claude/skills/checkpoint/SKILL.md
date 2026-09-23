---
name: checkpoint
description: Hourly hackathon checkpoint — verify the app runs, sync README to code, commit and push with a meaningful message. Use every hour or when the Stop hook warns.
---

# /checkpoint

Do all steps, do not skip any. Report each with evidence.

1. Read docs/HANDOFF.md; act on any request addressed to Claude/backend. Then `git status --short` — list what changed since the last commit.
2. Run the main scenario check: if the backend is running, `bash scripts/verify.sh`; otherwise start it (`backend/.venv/bin/uvicorn app.main:app --port 8000 &`), run verify, stop it. If verify fails, fix before committing.
3. Append this hour's decisions and rejected approaches to docs/DECISIONS.md (1–2 lines each) and AI tool usage to AI_USAGE.md.
4. Update README.md so sections 2 (что реализовано, до/после), 3 (сценарий по шагам), 4 (архитектура, таблица инструментов) and 11 (ограничения) match the current code. Replace `<...>` placeholders you now have real content for. Update THIRD_PARTY.md if any dependency, model or dataset was added.
5. Confirm `.env` is not tracked: `git ls-files .env` must print nothing.
6. Commit only your paths (`git add backend docs README.md THIRD_PARTY.md AI_USAGE.md`) with a descriptive message in the form `feat|fix|docs: <what works now>` and push. Confirm with `git log -1 --oneline` and `git status -sb` (no "ahead").
7. Print the time and what the next hour's goal is (from docs/PLAN.md).
