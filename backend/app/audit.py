"""Append-only action log (журнал действий): who did what and when. JSON lines in data/audit.jsonl."""
from __future__ import annotations

import csv
import io
import json
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

AUDIT_FILE = Path("data/audit.jsonl")
_lock = threading.Lock()

ACTION_LABELS = {
    "login": "Вход в систему",
    "login_failed": "Неудачная попытка входа",
    "logout": "Выход",
    "run": "Расчёт заказов",
    "approve": "Утверждение заказа",
    "export": "Экспорт заказов",
    "import_partner": "Импорт выгрузок 1С",
    "upload": "Загрузка таблицы CSV",
    "data_reset": "Сброс данных",
    "chat": "Вопрос ассистенту",
    "daily_brief": "Утренняя сводка агента",
    "whatif": "Расчёт «что если»",
    "email_draft": "Черновик письма поставщику",
    "integration_save": "Настройка интеграции",
    "integration_test": "Проверка интеграции",
    "signals_import": "Импорт чатов продажников",
    "signals_clear": "Очистка сигналов продаж",
    "news_refresh": "Мониторинг СМИ",
    "news_settings": "Настройка мониторинга СМИ",
}


def log(user: dict[str, Any] | None, action: str, details: dict[str, Any] | None = None, ok: bool = True) -> dict[str, Any]:
    rec = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "user": (user or {}).get("username", "—"),
        "name": (user or {}).get("name", ""),
        "role": (user or {}).get("role", ""),
        "action": action,
        "label": ACTION_LABELS.get(action, action),
        "ok": ok,
        "details": details or {},
    }
    with _lock:
        try:
            AUDIT_FILE.parent.mkdir(exist_ok=True)
            with AUDIT_FILE.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
        except OSError:
            pass
    return rec


def read(limit: int = 500, user: str | None = None, action: str | None = None) -> list[dict[str, Any]]:
    if not AUDIT_FILE.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in reversed(AUDIT_FILE.read_text(encoding="utf-8").splitlines()):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if user and r.get("user") != user:
            continue
        if action and r.get("action") != action:
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return out


def summary() -> dict[str, Any]:
    rows = read(limit=100000)
    by_action: dict[str, int] = {}
    by_user: dict[str, int] = {}
    for r in rows:
        by_action[r["label"]] = by_action.get(r["label"], 0) + 1
        by_user[r["user"]] = by_user.get(r["user"], 0) + 1
    return {"total": len(rows), "by_action": by_action, "by_user": by_user}


def to_csv(rows: list[dict[str, Any]]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Время", "Пользователь", "Имя", "Роль", "Действие", "Успешно", "Детали"])
    for r in rows:
        w.writerow([r["ts"], r["user"], r.get("name", ""), r.get("role", ""), r["label"], "да" if r.get("ok", True) else "нет", json.dumps(r.get("details", {}), ensure_ascii=False)])
    return "﻿" + buf.getvalue()
