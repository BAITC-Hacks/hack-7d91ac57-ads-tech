"""Integration settings for the admin panel (1C OData, Bitrix24) with real connection checks, plus LLM status."""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from .config import get_settings

INTEG_FILE = Path("data/integrations.json")
MASK = "••••••••"
DEFAULTS: dict[str, dict[str, Any]] = {
    "onec": {"enabled": False, "base_url": "", "username": "", "password": "", "status": "не подключено", "checked_at": None, "message": ""},
    "bitrix24": {"enabled": False, "webhook_url": "", "bot_name": "Закупщик", "status": "не подключено", "checked_at": None, "message": ""},
}
EDITABLE = {"onec": {"enabled", "base_url", "username", "password"}, "bitrix24": {"enabled", "webhook_url", "bot_name"}}


def load() -> dict[str, dict[str, Any]]:
    data = {k: dict(v) for k, v in DEFAULTS.items()}
    if INTEG_FILE.exists():
        try:
            saved = json.loads(INTEG_FILE.read_text(encoding="utf-8"))
            for k in data:
                data[k].update({kk: vv for kk, vv in (saved.get(k) or {}).items() if kk in data[k]})
        except (json.JSONDecodeError, OSError):
            pass
    return data


def _save_all(data: dict[str, dict[str, Any]]) -> None:
    INTEG_FILE.parent.mkdir(exist_ok=True)
    INTEG_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def public() -> dict[str, Any]:
    data = load()
    if data["onec"].get("password"):
        data["onec"]["password"] = MASK
    s = get_settings()
    return {
        **data,
        "llm": {"provider": s.llm_base_url, "model": s.llm_model, "demo_mode": s.demo_mode, "key_configured": bool(s.llm_api_key)},
    }


def save(name: str, patch: dict[str, Any]) -> dict[str, Any]:
    if name not in EDITABLE:
        raise KeyError(name)
    data = load()
    for k, v in patch.items():
        if k not in EDITABLE[name]:
            continue
        if k == "password" and v == MASK:
            continue
        data[name][k] = v
    data[name]["status"] = "настроено, не проверено" if data[name].get("enabled") else "отключено"
    _save_all(data)
    return public()[name]


def _set_status(name: str, ok: bool, message: str) -> None:
    data = load()
    data[name]["status"] = "подключено" if ok else "ошибка"
    data[name]["message"] = message
    data[name]["checked_at"] = datetime.now().isoformat(timespec="seconds")
    _save_all(data)


async def test(name: str) -> dict[str, Any]:
    t0 = time.perf_counter()
    ok, message = False, ""
    if name == "onec":
        c = load()["onec"]
        if not c["base_url"]:
            return {"ok": False, "message": "Укажите адрес OData, например http://1c-server/base/odata/standard.odata", "ms": 0}
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(c["base_url"].rstrip("/") + "/$metadata", auth=(c["username"], c["password"]) if c["username"] else None)
            ok = r.status_code == 200 and ("edmx" in r.text.lower() or "xml" in r.headers.get("content-type", ""))
            message = f"HTTP {r.status_code}: " + ("метаданные OData получены" if ok else (r.text[:160] or "нет ответа"))
        except httpx.HTTPError as e:
            message = f"нет соединения: {type(e).__name__}"
        _set_status("onec", ok, message)
    elif name == "bitrix24":
        c = load()["bitrix24"]
        if not c["webhook_url"]:
            return {"ok": False, "message": "Укажите входящий вебхук портала, например https://company.bitrix24.kz/rest/1/xxxxxxxx/", "ms": 0}
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                r = await client.get(c["webhook_url"].rstrip("/") + "/profile.json")
            body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
            ok = r.status_code == 200 and "result" in body
            who = (body.get("result") or {}) if ok else {}
            message = f"HTTP {r.status_code}: " + (f"портал ответил, вебхук от имени {who.get('NAME', '')} {who.get('LAST_NAME', '')}".strip() if ok else str(body.get("error_description") or r.text[:160]))
        except (httpx.HTTPError, ValueError) as e:
            message = f"нет соединения: {type(e).__name__}"
        _set_status("bitrix24", ok, message)
    elif name == "llm":
        s = get_settings()
        if s.demo_mode or not s.llm_api_key:
            return {"ok": False, "message": "DEMO_MODE: модель не используется, ассистент отвечает по шаблонам", "ms": 0}
        from .llm import chat

        try:
            out = await chat([{"role": "user", "content": "Ответь одним словом: готов"}], max_tokens=5)
            ok = bool(out)
            message = f"{s.llm_model}: «{out.strip()[:40]}»"
        except Exception as e:  # noqa: BLE001
            message = f"ошибка: {type(e).__name__}"
    else:
        raise KeyError(name)
    return {"ok": ok, "message": message, "ms": int((time.perf_counter() - t0) * 1000)}
