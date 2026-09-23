"""Minimal auth for the prototype: users from AUTH_USERS, HMAC-signed bearer tokens, two roles.

AUTH_USERS format: "login:password:role:Display name,login2:…" (role = manager | admin).
Default demo users: manager / demo (закупщик) and admin / admin (администратор).
In production this is replaced by the company SSO (Bitrix24 OAuth / LDAP); the API contract stays the same.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

SECRET = (os.environ.get("AUTH_SECRET") or secrets.token_hex(32)).encode()
TTL_SECONDS = 12 * 3600
DEFAULT_USERS = "manager:demo:manager:Менеджер отдела закупа,admin:admin:admin:Администратор"
ROLE_LABEL = {"manager": "закупщик", "admin": "администратор"}


def _hash(password: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{password}".encode()).hexdigest()


def _load_users() -> dict[str, dict[str, str]]:
    users: dict[str, dict[str, str]] = {}
    for item in (os.environ.get("AUTH_USERS") or DEFAULT_USERS).split(","):
        parts = item.strip().split(":")
        if len(parts) < 3:
            continue
        login, password, role = parts[0].strip().lower(), parts[1], parts[2].strip()
        salt = secrets.token_hex(8)
        users[login] = {"salt": salt, "hash": _hash(password, salt), "role": role, "name": parts[3] if len(parts) > 3 else login}
    return users


USERS = _load_users()


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    login = (username or "").strip().lower()
    u = USERS.get(login)
    if not u or not hmac.compare_digest(u["hash"], _hash(password or "", u["salt"])):
        return None
    return {"username": login, "role": u["role"], "name": u["name"], "role_label": ROLE_LABEL.get(u["role"], u["role"])}


def issue(user: dict[str, Any]) -> str:
    payload = {**user, "exp": int(time.time()) + TTL_SECONDS}
    body = base64.urlsafe_b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode().rstrip("=")
    sig = hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify(token: str | None) -> dict[str, Any] | None:
    if not token or "." not in token:
        return None
    body, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, hmac.new(SECRET, body.encode(), hashlib.sha256).hexdigest()):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(payload.get("exp", 0)) < time.time():
        return None
    return {k: payload[k] for k in ("username", "role", "name", "role_label") if k in payload}


def users_public() -> list[dict[str, str]]:
    return [{"username": k, "role": v["role"], "role_label": ROLE_LABEL.get(v["role"], v["role"]), "name": v["name"]} for k, v in USERS.items()]
