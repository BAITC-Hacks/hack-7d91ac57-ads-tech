import io
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import admin as integrations
from . import audit, auth, state
from . import tools  # noqa: F401  (registers agent tools)
from .config import get_settings
from .ingest import extract_text
from .llm import run_agent, tool_specs
from .rag import store
from .replenish import Params, category_trends, compute_sku, export_rows, impact, overstock, sku_detail

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
settings = get_settings()

SYSTEM_PROMPT = (
    "Ты ассистент менеджера отдела закупа компании «Электрокомплект» (электротовары). "
    "Отвечай по-русски, кратко, с числами. Все числа бери ТОЛЬКО из инструментов: сначала вызови нужный инструмент, потом объясняй. "
    "Никогда не утверждай, что заказ отправлен поставщику: отправка возможна только после подтверждения сотрудником. "
    "Если спрашивают «почему такое количество» по артикулу — вызови explain_sku. Если про поставщика или критичные позиции — list_orders. "
    "Если «что если» (в пути, остаток) — what_if. Письмо поставщику — draft_supplier_email (это только черновик)."
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Path("data").mkdir(exist_ok=True)
    state.get_ds()
    state.precompute_in_background()
    yield


app = FastAPI(title="Электрокомплект · Расчёт заказов поставщикам", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origin_list, allow_methods=["*"], allow_headers=["*"])

PUBLIC_PATHS = {"/api/health", "/api/auth/login"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every /api call except health and login needs a token (header «Authorization: Bearer …» or «?token=» for downloads)."""
    path = request.url.path
    request.state.user = None
    if path.startswith("/api/") and path not in PUBLIC_PATHS:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token")
        user = auth.verify(token)
        if settings.auth_enabled and not user:
            return JSONResponse({"detail": "требуется вход в систему"}, status_code=401)
        request.state.user = user or {"username": "anonymous", "role": "admin", "name": "без авторизации"}
    return await call_next(request)


def current_user(request: Request) -> dict:
    return getattr(request.state, "user", None) or {}


def require_admin(request: Request) -> dict:
    u = current_user(request)
    if u.get("role") != "admin":
        raise HTTPException(403, "доступно только администратору")
    return u


# ------------------------------------------------------------------ auth
class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = auth.authenticate(req.username, req.password)
    if not user:
        audit.log({"username": (req.username or "").strip().lower()[:40]}, "login_failed", ok=False)
        raise HTTPException(401, "неверный логин или пароль")
    audit.log(user, "login")
    return {"token": auth.issue(user), "user": user}


@app.get("/api/auth/me")
def me(request: Request):
    return current_user(request)


@app.post("/api/auth/logout")
def logout(request: Request):
    audit.log(current_user(request), "logout")
    return {"ok": True}


# ------------------------------------------------------------------ admin: integrations, action log, users
@app.get("/api/admin/integrations")
def admin_integrations(request: Request):
    require_admin(request)
    return {**integrations.public(), "users": auth.users_public(), "bot_events_path": "/api/integrations/bitrix24/bot"}


class IntegrationPatch(BaseModel):
    enabled: bool | None = None
    base_url: str | None = None
    username: str | None = None
    password: str | None = None
    webhook_url: str | None = None
    bot_name: str | None = None


@app.put("/api/admin/integrations/{name}")
def admin_integration_save(name: str, patch: IntegrationPatch, request: Request):
    u = require_admin(request)
    try:
        res = integrations.save(name, {k: v for k, v in patch.model_dump().items() if v is not None})
    except KeyError as e:
        raise HTTPException(404, f"неизвестная интеграция {name}") from e
    audit.log(u, "integration_save", {"integration": name, "enabled": res.get("enabled")})
    return res


@app.post("/api/admin/integrations/{name}/test")
async def admin_integration_test(name: str, request: Request):
    u = require_admin(request)
    try:
        res = await integrations.test(name)
    except KeyError as e:
        raise HTTPException(404, f"неизвестная интеграция {name}") from e
    audit.log(u, "integration_test", {"integration": name, "message": res["message"]}, ok=res["ok"])
    return res


@app.get("/api/admin/audit")
def admin_audit(request: Request, limit: int = 300, user: str | None = None, action: str | None = None):
    require_admin(request)
    return {"items": audit.read(limit, user or None, action or None), "summary": audit.summary(), "actions": audit.ACTION_LABELS}


@app.get("/api/admin/audit.csv")
def admin_audit_csv(request: Request, user: str | None = None, action: str | None = None):
    require_admin(request)
    data = audit.to_csv(audit.read(100000, user or None, action or None)).encode("utf-8")
    return StreamingResponse(io.BytesIO(data), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="audit-{time.strftime("%Y%m%d-%H%M")}.csv"'})


# ------------------------------------------------------------------ health / chat
class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


class ChatResponse(BaseModel):
    answer: str
    steps: list[dict]
    latency_ms: int


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "env": settings.app_env,
        "model": settings.llm_model,
        "provider": settings.llm_base_url,
        "demo_mode": settings.demo_mode,
        "tools": [t["function"]["name"] for t in tool_specs()],
        "data": state.get_ds().summary(),
        "calculation_ready": state.last_result() is not None,
        "backtest_ready": state.backtest_report() is not None,
        "ss_multiplier": state.get_ds().ss_multiplier,
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(req: ChatRequest, request: Request):
    t0 = time.perf_counter()
    result = await run_agent([m.model_dump() for m in req.messages], system=SYSTEM_PROMPT)
    question = next((m.content for m in reversed(req.messages) if m.role == "user"), "")
    audit.log(current_user(request), "chat", {"question": question[:300], "tools": [s.get("label", s.get("tool")) for s in result["steps"]]})
    return ChatResponse(answer=result["answer"], steps=result["steps"], latency_ms=int((time.perf_counter() - t0) * 1000))


@app.get("/api/agent/daily-brief")
async def agent_daily_brief(request: Request, warehouse: str | None = None):
    """Утренний агент: сам проходит по инструментам (расчёт, критичные, избытки, данные) и готовит сводку «что сделать сегодня»."""
    from .agent import daily_brief

    res = await daily_brief(warehouse)
    audit.log(current_user(request), "daily_brief", {"llm": res["llm"], "steps": [s.get("label") for s in res["steps"]]})
    return res


# ------------------------------------------------------------------ data
REQUIRED_COLUMNS = {
    "sales": ["date", "sku", "qty", "client_id", "price", "warehouse"],
    "stock": ["sku", "warehouse", "stock", "as_of"],
    "stockouts": ["sku", "warehouse", "date_from", "date_to"],
    "in_transit": ["sku", "warehouse", "qty", "eta"],
    "suppliers": ["supplier_id", "supplier", "lead_time_days", "moq"],
    "products": ["sku", "name", "category", "supplier_id", "pack_size"],
}
DATE_COLS = {"sales": ["date"], "stock": ["as_of"], "stockouts": ["date_from", "date_to"], "in_transit": ["eta"]}


@app.get("/api/data/summary")
def data_summary():
    return state.get_ds().summary()


@app.post("/api/data/upload")
async def data_upload(request: Request, kind: str = Form(...), file: UploadFile = File(...)):
    if kind not in REQUIRED_COLUMNS:
        raise HTTPException(400, f"kind must be one of {list(REQUIRED_COLUMNS)}")
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")
    try:
        text = raw.decode("utf-8-sig")
        sep = ";" if text.splitlines()[0].count(";") > text.splitlines()[0].count(",") else ","
        df = pd.read_csv(io.StringIO(text), sep=sep, parse_dates=DATE_COLS.get(kind, []))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"cannot parse CSV: {e}") from e
    missing = [c for c in REQUIRED_COLUMNS[kind] if c not in df.columns]
    if missing:
        raise HTTPException(400, f"missing columns: {missing}; required: {REQUIRED_COLUMNS[kind]}")
    ds = state.get_ds()
    ds.replace(kind, df)
    if kind == "sales":
        ds.today = (df["date"].max() + pd.Timedelta(days=1)).date()
    ds.model_wape, ds.ss_multiplier = None, 1.0
    state.invalidate()
    state.precompute_in_background()
    audit.log(current_user(request), "upload", {"table": kind, "file": file.filename, "rows": int(len(df))})
    return {"kind": kind, "rows": int(len(df)), "summary": ds.summary()}


@app.post("/api/data/import_partner")
async def data_import_partner(request: Request, files: list[UploadFile] = File(...)):
    """Импорт выгрузок 1С партнёра «как есть»: загрузите 12 файлов Excel (IEK и Systeme Electric).
    Файлы раскладываются по поставщику по имени, затем вызывается тот же импортёр, что и CLI."""
    import shutil
    import tempfile

    from .import_partner import build

    tmp = Path(tempfile.mkdtemp(prefix="partner_"))
    iek, se = tmp / "IEK", tmp / "SE"
    iek.mkdir()
    se.mkdir()
    saved = {"IEK": [], "SE": []}
    for f in files:
        name = f.filename or "file.xlsx"
        low = name.lower()
        target = se if any(k in low for k in ("sys", "electric", "se_", "сэ", "systemelectric")) else iek
        data = await f.read()
        (target / name).write_bytes(data)
        saved["SE" if target is se else "IEK"].append(name)
    try:
        out = Path("data/partner_upload")
        if out.exists():
            shutil.rmtree(out)
        info = build(iek, se, out)
    except FileNotFoundError as e:
        raise HTTPException(400, f"не хватает файла: {e}. Нужны для каждого поставщика: MOQ, Динамика продаж, Ежемесячные продажи, Ежемесячные остатки, товар в пути (IEK: «Путь», SE: «Товар в пути»)") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"ошибка импорта: {e}") from e
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    state.DATA_DIR = out
    ds = state.reset_ds(regenerate=False)
    state.precompute_in_background()
    audit.log(current_user(request), "import_partner", {"files": len(files), "products": info.get("products"), "sales_rows": info.get("sales_rows")})
    return {"imported": info, "files": saved, "summary": ds.summary()}


@app.post("/api/data/reset")
def data_reset(request: Request):
    ds = state.reset_ds(regenerate=False)
    audit.log(current_user(request), "data_reset")
    return {"ok": True, "summary": ds.summary()}


# ------------------------------------------------------------------ replenishment
class RunRequest(BaseModel):
    warehouse: str | None = None  # None → склад по умолчанию из данных
    category: str | None = None
    service_level: float | None = None
    review_days: int = 14
    include_zero: bool = False
    growth_plan_pct_year: float | None = None  # плановый прирост спроса, %/год, ко всем позициям
    ss_calibrated: bool = True  # калибровка страхового запаса по бэктесту
    include_signals: bool = False  # добавить проектный спрос из сигналов продаж (взвешенный по вероятности)


def _params(req: RunRequest) -> Params:
    return Params(
        warehouse=req.warehouse or state.get_ds().default_warehouse(),
        category=req.category or None,
        service_level=req.service_level,
        review_days=req.review_days,
        include_zero=req.include_zero,
        growth_plan_pct_year=req.growth_plan_pct_year,
        ss_calibrated=req.ss_calibrated,
        include_signals=req.include_signals,
    )


@app.post("/api/replenish/run")
def replenish_run(req: RunRequest, request: Request):
    t0 = time.perf_counter()
    res = state.ensure_result(_params(req))
    audit.log(current_user(request), "run", {"warehouse": res["params"].get("warehouse"), "category": req.category, "service_level": req.service_level, "calibrated": req.ss_calibrated, "positions": res["summary"]["positions"], "critical": res["summary"]["critical"]})
    return {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "elapsed_ms": int((time.perf_counter() - t0) * 1000), **res}


@app.get("/api/replenish/orders")
def replenish_orders(supplier: str | None = None, urgency: str | None = None, warehouse: str | None = None, category: str | None = None):
    res = state.ensure_result()
    rows = res["orders"]
    if supplier:
        rows = [r for r in rows if r["supplier_id"] == supplier or r["supplier"] == supplier]
    if urgency:
        rows = [r for r in rows if r["urgency"] == urgency]
    if warehouse:
        rows = [r for r in rows if r["warehouse"] == warehouse]
    if category:
        rows = [r for r in rows if r["category"] == category]
    return {"count": len(rows), "orders": rows}


@app.get("/api/replenish/impact")
def replenish_impact():
    """Эффект относительно наивного (Excel) расчёта: избыточный и недостаточный заказ в штуках и тенге."""
    res = state.ensure_result()
    full = state.full_result(Params(**{k: v for k, v in res["params"].items() if k != "include_zero"}))
    return impact(state.get_ds(), res, full)


@app.get("/api/backtest")
def backtest():
    """Точность прогноза вне выборки: сравнение с Excel и другими методами, калибровка страхового запаса."""
    rep = state.backtest_report()
    if rep is None:
        from fastapi.responses import JSONResponse

        return JSONResponse({"status": "computing"}, status_code=202)
    return rep


@app.get("/api/replenish/overstock")
def replenish_overstock(warehouse: str | None = None, months: float = 6.0):
    """Избыточные и «мёртвые» запасы: где заморожены деньги и место на складе."""
    ds = state.get_ds()
    wh = warehouse or ds.default_warehouse()
    full = state.full_result(Params(warehouse=wh))
    return overstock(ds, wh, months, full=full)


@app.get("/api/replenish/categories")
def replenish_categories(warehouse: str | None = None, months: int = 12):
    """Тренды спроса по категориям за последние N полных месяцев (опциональный пункт ТЗ)."""
    ds = state.get_ds()
    return category_trends(ds, warehouse or ds.default_warehouse(), months)


@app.get("/api/sku/{sku}")
def sku_get(sku: str, warehouse: str | None = None):
    ds = state.get_ds()
    warehouse = warehouse or ds.default_warehouse()
    if sku not in set(ds.products["sku"]):
        raise HTTPException(404, f"unknown sku {sku}")
    return sku_detail(ds, sku, warehouse, Params(warehouse=warehouse))


class WhatIfRequest(BaseModel):
    sku: str
    warehouse: str | None = None
    in_transit: float | None = None
    stock: float | None = None
    service_level: float | None = None
    lead_time_days: int | None = None
    review_days: int | None = None


@app.post("/api/replenish/whatif")
def whatif(req: WhatIfRequest, request: Request):
    ds = state.get_ds()
    if req.sku not in set(ds.products["sku"]):
        raise HTTPException(404, f"unknown sku {req.sku}")
    wh = req.warehouse or ds.default_warehouse()
    p = Params(warehouse=wh)
    base = compute_sku(ds, req.sku, wh, p)
    base.pop("_series", None)
    ov = {k: v for k, v in req.model_dump().items() if k not in ("sku", "warehouse") and v is not None}
    new = compute_sku(ds, req.sku, wh, p, overrides=ov)
    new.pop("_series", None)
    audit.log(current_user(request), "whatif", {"sku": req.sku, "changes": ov, "from": base["recommended_qty"], "to": new["recommended_qty"]})
    return {"base": base, "scenario": new, "overrides": ov, "delta_qty": new["recommended_qty"] - base["recommended_qty"]}


# ------------------------------------------------------------------ orders (human approval)
class ApproveLine(BaseModel):
    sku: str
    qty: int


class ApproveRequest(BaseModel):
    supplier_id: str
    lines: list[ApproveLine]
    comment: str = ""
    approved_by: str = "менеджер отдела закупа"


@app.post("/api/orders/approve")
def approve(req: ApproveRequest, request: Request):
    ds = state.get_ds()
    sup = ds.suppliers.loc[ds.suppliers["supplier_id"] == req.supplier_id]
    if sup.empty:
        raise HTTPException(404, f"unknown supplier {req.supplier_id}")
    if not req.lines:
        raise HTTPException(400, "no lines")
    order = {
        "supplier_id": req.supplier_id,
        "supplier": str(sup["supplier"].iloc[0]),
        "lines": [l.model_dump() for l in req.lines],
        "total_qty": int(sum(l.qty for l in req.lines)),
        "comment": req.comment,
        "approved_by": current_user(request).get("name") or req.approved_by,
        "approved_login": current_user(request).get("username"),
        "sent": False,  # never auto-sent
    }
    saved = state.save_order(order)
    audit.log(current_user(request), "approve", {"order_id": saved["order_id"], "supplier": saved["supplier"], "lines": len(saved["lines"]), "total_qty": saved["total_qty"]})
    return saved


@app.get("/api/orders")
def orders_list():
    return {"orders": state.load_orders()}


@app.get("/api/orders/{order_id}/email")
def order_email(order_id: str, request: Request):
    """Черновик письма поставщику по утверждённому заказу. Ничего не отправляется."""
    order = next((o for o in state.load_orders() if o["order_id"] == order_id), None)
    if not order:
        raise HTTPException(404, "order not found")
    ds = state.get_ds()
    sup = ds.suppliers.loc[ds.suppliers["supplier_id"] == order["supplier_id"]]
    email = str(sup["email"].iloc[0]) if len(sup) and "email" in sup.columns else ""
    lead = int(sup["lead_time_days"].iloc[0]) if len(sup) else 0
    names = dict(zip(ds.products["sku"], ds.products["name"]))
    arts = dict(zip(ds.products["sku"], ds.products.get("article", pd.Series(dtype=str)).fillna("")))
    lines = "\n".join(f"{i + 1}. {l['sku']}{(' / ' + str(arts.get(l['sku']))) if arts.get(l['sku']) else ''} — {names.get(l['sku'], '')} — {l['qty']} шт" for i, l in enumerate(order["lines"]))
    text = (
        f"Кому: {email}\nТема: Заказ {order['order_id']} от ТОО «Электрокомплект»\n\n"
        f"Здравствуйте!\nПросим подтвердить возможность поставки следующих позиций (ожидаемый срок поставки {lead} дн.):\n{lines}\n\n"
        f"Итого позиций: {len(order['lines'])}, количество: {order['total_qty']}.\n"
        + (f"Комментарий: {order['comment']}\n" if order.get("comment") else "")
        + "\nС уважением, отдел закупа ТОО «Электрокомплект»"
    )
    audit.log(current_user(request), "email_draft", {"order_id": order_id, "to": email})
    return {"order_id": order_id, "to": email, "subject": f"Заказ {order['order_id']} от ТОО «Электрокомплект»", "body": text, "sent": False}


# ------------------------------------------------------------------ agents: sales signals (chats) and media monitoring
def _llm_available() -> bool:
    return not settings.demo_mode and bool(settings.llm_api_key)


def _apply_signals(rows: list) -> None:
    from . import signals as sig

    ds = state.get_ds()
    ds.signals = sig.by_sku(rows)
    state.invalidate()


@app.post("/api/signals/import")
async def signals_import(request: Request, files: list[UploadFile] = File(default=[]), text: str = Form(default=""), channel: str = Form(default="")):
    """Агент сигналов продаж: выгрузки чатов Telegram (.json), WhatsApp (.txt), Bitrix24 (.csv/.json) или вставленный текст."""
    from . import signals as sig

    msgs = []
    for f in files:
        try:
            msgs += sig.parse_chat(f.filename or "chat.txt", await f.read(), channel or None)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"не удалось прочитать {f.filename}: {e}") from e
    if text.strip():
        msgs += sig.parse_chat("paste.txt", text.encode("utf-8"), channel or "вставка")
    if not msgs:
        raise HTTPException(400, "нет сообщений: загрузите выгрузку чата или вставьте текст")
    res = await sig.run_agent(msgs, state.get_ds().products, _llm_available())
    rows = sig.merge_save(res["signals"])
    _apply_signals(rows)
    audit.log(current_user(request), "signals_import", {"messages": len(msgs), "signals": len(res["signals"]), "extracted_by": res["extracted_by"]})
    return {**res, "total": len(rows)}


@app.post("/api/signals/import_sample")
async def signals_import_sample(request: Request):
    """Загрузить демонстрационные выгрузки чатов (Telegram, WhatsApp, Bitrix24) из data/sample/chats."""
    from . import signals as sig

    folder = Path(__file__).resolve().parent.parent / "data" / "sample" / "chats"
    msgs = []
    for f in sorted(folder.glob("*")):
        msgs += sig.parse_chat(f.name, f.read_bytes())
    res = await sig.run_agent(msgs, state.get_ds().products, _llm_available())
    rows = sig.merge_save(res["signals"])
    _apply_signals(rows)
    audit.log(current_user(request), "signals_import", {"messages": len(msgs), "signals": len(res["signals"]), "extracted_by": res["extracted_by"], "source": "демо-выгрузки"})
    return {**res, "total": len(rows)}


@app.get("/api/signals")
def signals_list():
    from . import signals as sig

    rows = sig.load()
    by_type: dict[str, int] = {}
    by_channel: dict[str, int] = {}
    for r in rows:
        by_type[r["type"]] = by_type.get(r["type"], 0) + 1
        by_channel[r["channel"]] = by_channel.get(r["channel"], 0) + 1
    return {"items": rows, "summary": {"total": len(rows), "linked": sum(1 for r in rows if r.get("sku")), "by_type": by_type, "by_channel": by_channel}, "types": sig.TYPES}


@app.delete("/api/signals")
def signals_clear(request: Request):
    from . import signals as sig

    sig.clear()
    _apply_signals([])
    audit.log(current_user(request), "signals_clear")
    return {"ok": True}


@app.post("/api/news/refresh")
async def news_refresh(request: Request):
    """Агент мониторинга СМИ: собрать ленты, отобрать релевантное закупу, заполнить поля."""
    from . import news

    res = await news.run_agent(_llm_available())
    audit.log(current_user(request), "news_refresh", {"new": len(res["items"]), "total": res["total"], "extracted_by": res["extracted_by"], "errors": len(res["errors"])})
    return res


@app.get("/api/news")
def news_list():
    from . import news

    return {"items": news.load(), "fields": news.FIELDS}


class NewsSettings(BaseModel):
    sources: list[str]
    keywords: list[str]


@app.get("/api/admin/news-settings")
def news_settings_get(request: Request):
    from . import news

    require_admin(request)
    return news.settings()


@app.put("/api/admin/news-settings")
def news_settings_put(body: NewsSettings, request: Request):
    from . import news

    u = require_admin(request)
    res = news.save_settings(body.sources, body.keywords)
    audit.log(u, "news_settings", {"sources": len(res["sources"]), "keywords": len(res["keywords"])})
    return res


# ------------------------------------------------------------------ export
@app.get("/api/export")
def export(request: Request, format: str = "csv", supplier: str | None = None):
    res = state.ensure_result()
    df = export_rows(res, supplier)
    audit.log(current_user(request), "export", {"format": format, "supplier": supplier or "все", "rows": int(len(df))})
    stamp = time.strftime("%Y%m%d-%H%M")
    if format == "xlsx":
        buf = io.BytesIO()
        with pd.ExcelWriter(buf, engine="openpyxl") as w:
            df.to_excel(w, index=False, sheet_name="Заказы")
            ws = w.sheets["Заказы"]
            for col, width in zip("ABCDEFGHIJK", [26, 12, 34, 22, 14, 12, 12, 10, 10, 14, 90]):
                ws.column_dimensions[col].width = width
        buf.seek(0)
        return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f'attachment; filename="orders-{stamp}.xlsx"'})
    csv = df.to_csv(index=False, sep=";")
    return StreamingResponse(io.BytesIO(("﻿" + csv).encode("utf-8")), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f'attachment; filename="orders-{stamp}.csv"'})


# ------------------------------------------------------------------ documents / RAG (kept from scaffold)
@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    data = await file.read()
    if not data:
        raise HTTPException(400, "empty file")
    try:
        text = extract_text(file.filename or "file.txt", data)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"cannot parse {file.filename}: {e}") from e
    n = await store.add(file.filename or "file", text)
    return {"source": file.filename, "chunks": n, "total_chunks": len(store.docs)}


@app.get("/api/documents")
def list_documents():
    sources: dict[str, int] = {}
    for d in store.docs:
        sources[d["source"]] = sources.get(d["source"], 0) + 1
    return {"sources": sources, "total_chunks": len(store.docs), "mode": "embeddings" if store.vecs is not None else "keyword"}


@app.delete("/api/documents")
def clear_documents():
    store.clear()
    return {"ok": True}


@app.get("/api/search")
async def search(q: str, k: int = 5):
    return {"query": q, "hits": await store.search(q, k=k)}
