# Параллельная работа Claude Code и Codex в одном репозитории

Оба агента работают в одной рабочей копии, на ветке `main`, без веток и merge. Конфликтов не будет, если каждый трогает только свои пути.

## Владение путями

| Путь | Владелец | Второй агент |
|---|---|---|
| `backend/**` | **Claude Code** | не редактирует; просит через HANDOFF |
| `docs/API.md` | **Claude Code** (контракт API) | Codex читает перед любой работой с фронтом |
| `README.md`, `THIRD_PARTY.md`, `docs/PLAN.md`, `docs/DECISIONS.md` | **Claude Code** | Codex дописывает только свои строки в AI_USAGE.md |
| `frontend/**` | **Codex** | Claude не редактирует; просит через HANDOFF |
| `data-samples/**`, `docs/PITCH.md` | человек / любой | по договорённости в HANDOFF |
| `docs/HANDOFF.md` | общий | оба дописывают в конец, не переписывают |
| `.env` | человек | агенты не трогают |

Если задача требует правки чужого пути: написать запрос в HANDOFF.md и продолжать своё. Не править чужое «по-быстрому».

## Контракт

`docs/API.md` — единственный источник правды по эндпоинтам и JSON. Порядок изменения: Claude меняет backend → обновляет API.md → пишет строку в HANDOFF.md «API: изменил X». Codex строит фронт только по API.md, при расхождении с реальным ответом пишет в HANDOFF.md.

## Серверы и порты

- Backend запускает человек один раз: `make backend` (порт 8000). Оба агента ходят в него. Агенты не запускают второй backend.
- Frontend dev: `make frontend` (порт 5173, proxy на 8000). Запускает Codex или человек.
- Проверка: `bash scripts/verify.sh` может запускать любой.
- Docker-сборку с нуля делает только Claude в 17:00 (`/freeze`).

## Коммиты

- `scripts/autocommit.sh 20` коммитит всё каждые 20 минут: страховка от правила «прогресс каждый час».
- Осмысленные коммиты каждый делает сам, только своих путей: `git add backend docs README.md && git commit -m "feat(api): …"` / `git add frontend && git commit -m "feat(ui): …"`.
- Префиксы сообщений: Claude — `feat(api)|fix(api)|docs`, Codex — `feat(ui)|fix(ui)`. По ним заполняется AI_USAGE.md.
- Никогда: `git add -A` вручную, `git push --force`, `git reset --hard`, `git stash`.

## Передача

`docs/HANDOFF.md` — журнал в формате «время · кто · что сделал · что нужно от другого». Оба читают его в начале каждой задачи и в `/checkpoint`.

## Запуск Codex

```bash
cd repo
codex --full-auto "Прочитай AGENTS.md, docs/TEAMWORK.md, docs/API.md, docs/HANDOFF.md. Ты владеешь frontend/. Задача: <…>. По завершении допиши строку в docs/HANDOFF.md и закоммить только frontend/."
```
