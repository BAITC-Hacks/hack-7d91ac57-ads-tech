---
name: freeze
description: Final 17:00 submission routine — clean Docker rebuild from scratch, verify, DEMO_MODE check, README/THIRD_PARTY completeness audit, final push. Use at 17:00 and again at 17:45.
---

# /freeze

The snapshot at 18:00 is judged. Experts must run it from README alone; if it fails they will not ask questions. Run everything below.

1. **Clean rebuild:** `docker compose down -v --remove-orphans; docker compose up --build -d`. Wait for `healthy`. If ports 8000/8080 are busy locally, use API_PORT/WEB_PORT in .env but keep README defaults.
2. **Verify:** `bash scripts/verify.sh` against the container, then `curl -sf http://localhost:${WEB_PORT:-8080}/` returns the UI. Walk the README section 8 steps literally via curl or the UI and confirm each expected result.
3. **DEMO_MODE:** set `DEMO_MODE=true`, restart backend, confirm the main scenario still produces a meaningful result (not an error). Revert.
4. **Local run path (README variant B):** `make backend` and `make frontend` start without errors.
5. **README audit** — first read it as a stranger: can they run it in 3 minutes from the top block alone? «Быстрый старт», «Что вы увидите», таблица «Ожидаемый результат по шагам» and «Если не запускается» must be filled and true. Take a real screenshot of the UI into docs/screenshot.png. — every one of the 8 mandatory sections present and concrete: описание, архитектура, технологии, установка, запуск, зависимости, параметры окружения, порядок проверки. No placeholders like `<...>` left. `grep -n '<' README.md` must show only real HTML/markdown, not template placeholders.
6. **THIRD_PARTY.md** lists every library in requirements.txt/package.json dependencies, every model, every dataset with source and license.
7. **Secrets:** `git grep -nE 'sk-[A-Za-z0-9]{10,}|nvapi-' -- . ':!*.md'` returns nothing. `.env` untracked.
8. **Commit and push.** `git log origin/main -1` equals local HEAD. Open the GitHub URL in the report.
9. Print a final summary: what works, what is in DEMO_MODE only, known limitations (also add them to README «Ограничения»).
