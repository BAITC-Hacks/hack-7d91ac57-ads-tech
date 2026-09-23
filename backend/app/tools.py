"""Agent tools for the purchasing assistant. Numbers come only from the engine."""
from __future__ import annotations

from . import state
from .llm import tool
from .replenish import Params, compute_sku


def resolve_sku(raw: str) -> str | None:
    """Tolerant SKU lookup: exact 1C code, code with/without trailing «_», supplier article, then name substring."""
    ds = state.get_ds()
    skus = set(ds.products["sku"])
    q = (raw or "").strip().strip("«»\"'")
    for cand in (q, q.upper(), q + "_", q.rstrip("_"), q.upper() + "_"):
        if cand in skus:
            return cand
    if "article" in ds.products.columns:
        hit = ds.products[ds.products["article"].astype(str).str.upper() == q.upper()]
        if not hit.empty:
            return str(hit["sku"].iloc[0])
    hit = ds.products[ds.products["name"].astype(str).str.contains(q, case=False, na=False, regex=False)]
    return str(hit["sku"].iloc[0]) if not hit.empty else None


def _wh(warehouse: str | None) -> str:
    """Known warehouse or the default one: LLMs sometimes invent names («Главный», «основной»)."""
    ds = state.get_ds()
    return warehouse if warehouse in set(ds.stock["warehouse"].unique()) else ds.default_warehouse()


def _n(x) -> str:
    try:
        return f"{float(x):,.0f}".replace(",", " ") if float(x) == int(float(x)) else f"{float(x):,.1f}".replace(",", " ").replace(".", ",")
    except (TypeError, ValueError):
        return str(x)


def _sum_run(d: dict) -> str:
    s = d.get("summary", {})
    return f"к заказу {_n(s.get('positions', 0))} позиций у {_n(s.get('suppliers', 0))} поставщиков, критичных {_n(s.get('critical', 0))}"


def _sum_explain(d: dict) -> str:
    return (f"{d.get('sku')}: рекомендовано {_n(d.get('recommended_qty'))} шт, остаток {_n(d.get('stock'))}, в пути {_n(d.get('in_transit'))}, "
            f"прогноз {_n(d.get('forecast_daily'))} шт/день, страховой запас {_n(d.get('safety_stock'))}")


def _sum_list(d: dict) -> str:
    rows = d.get("orders", [])
    head = ", ".join(f"{r.get('sku')} ({_n(r.get('recommended_qty'))} шт)" for r in rows[:3])
    return f"найдено {_n(d.get('count', len(rows)))} позиций" + (f": {head}" if head else "")


EMAIL_LINES = 15  # positions in the chat draft; the full list goes as the 1C XLSX attachment
_WHATIF_NAMES = {"in_transit": "в пути", "stock": "остаток", "lead_time_days": "срок поставки, дн.", "service_level": "уровень сервиса"}


def _fmt_input(k: str, v) -> str:
    return f"{float(v) * 100:.0f} %" if k == "service_level" and v is not None else _n(v)


def _sum_whatif(d: dict) -> str:
    sc, was = d.get("scenario", {}), d.get("base_inputs", {})
    ch = "; ".join(f"{_WHATIF_NAMES.get(k, k)} было {_fmt_input(k, was.get(k))}, станет {_fmt_input(k, v)}" for k, v in (d.get("overrides") or {}).items())
    return f"{sc.get('sku', '')}: {ch + '; ' if ch else ''}заказ был {_n(d.get('base_qty'))} шт, станет {_n(d.get('scenario_qty'))} шт"


def _sum_email(d: dict) -> str:
    return f"черновик готов: {d.get('positions_in_letter', '?')} самых срочных позиций из {d.get('positions_total', '?')}, ничего не отправлено"


def _strip(r: dict) -> dict:
    keep = ["sku", "name", "category", "warehouse", "supplier", "supplier_id", "recommended_qty", "urgency", "days_of_cover",
            "lead_time_days", "stock", "in_transit", "forecast_daily", "forecast_period_qty", "safety_stock", "seasonal_factor",
            "trend_pct_month", "plan_pct_year", "stockout_days", "lost_demand_qty", "outliers_excluded", "outlier_qty_excluded", "justification"]
    return {k: r[k] for k in keep if k in r}


@tool(
    "Запустить расчёт рекомендованных заказов поставщикам. Возвращает сводку и позиции по поставщикам.",
    {"type": "object", "properties": {"warehouse": {"type": "string", "description": "склад; не указывай, если пользователь не назвал склад"}, "category": {"type": "string"}}, "required": []},
)
def run_replenishment(warehouse: str | None = None, category: str | None = None) -> dict:
    res = state.ensure_result(Params(warehouse=_wh(warehouse), category=category or None))
    return {"summary": res["summary"], "suppliers": [{"supplier": s["supplier"], "supplier_id": s["supplier_id"], "positions": s["positions"], "total_qty": s["total_qty"], "critical": s["critical"]} for s in res["suppliers"]]}


@tool(
    "Объяснить расчёт по артикулу: прогноз, сезонность, тренд, исключённые выбросы, упущенный спрос, страховой запас, остаток, в пути, итоговое количество.",
    {"type": "object", "properties": {"sku": {"type": "string", "description": "код артикула ровно как в вопросе пользователя, например 010300016_ (подчёркивание на конце — часть кода 1С)"}, "warehouse": {"type": "string"}}, "required": ["sku"]},
    label="Разбор позиции",
    summarize=_sum_explain,
)
def explain_sku(sku: str, warehouse: str | None = None) -> dict:
    ds = state.get_ds()
    warehouse = _wh(warehouse)
    found = resolve_sku(sku)
    if not found:
        return {"error": f"артикул {sku} не найден; коды 1С имеют вид 010300016_ (с подчёркиванием) или LMP-006"}
    sku = found
    r = compute_sku(ds, sku, warehouse, Params(warehouse=warehouse))
    s = r.pop("_series")
    out = _strip(r)
    out["outliers"] = s["outliers"][:5]
    out["stockouts"] = s["stockouts"][:5]
    return out


@tool(
    "Список рекомендованных заказов с фильтрами по поставщику (id или название) и срочности (critical|high|normal).",
    {"type": "object", "properties": {"supplier": {"type": "string"}, "urgency": {"type": "string"}, "warehouse": {"type": "string"}, "limit": {"type": "integer", "default": 15}}, "required": []},
    label="Поиск позиций в заказе",
    summarize=_sum_list,
)
def list_orders(supplier: str | None = None, urgency: str | None = None, warehouse: str | None = None, limit: int = 15) -> dict:
    res = state.ensure_result()
    rows = res["orders"]
    if supplier:
        rows = [r for r in rows if supplier.lower() in (r["supplier_id"] + " " + r["supplier"]).lower()]
    if urgency:
        rows = [r for r in rows if r["urgency"] == urgency]
    if warehouse:
        rows = [r for r in rows if r["warehouse"] == _wh(warehouse)]
    return {"count": len(rows), "orders": [_strip(r) for r in rows[:limit]]}


@tool(
    "Пересчитать позицию «что если». Передавай ТОЛЬКО то, что пользователь явно назвал числом: остаток, товар в пути, срок поставки, "
    "уровень сервиса и склад движок берёт из данных сам, не подставляй их. «Придёт ещё N в пути» — это add_in_transit = N.",
    {"type": "object", "properties": {
        "sku": {"type": "string", "description": "код артикула ровно как в вопросе, например 010300016_"},
        "add_in_transit": {"type": "number", "description": "сколько штук ДОБАВИТЬ к товару в пути (прирост, не итог)"},
        "stock": {"type": "number", "description": "новый остаток; только если пользователь назвал число"},
        "lead_time_days": {"type": "integer", "description": "новый срок поставки в днях; только если пользователь назвал число"},
        "service_level": {"type": "number", "description": "новый уровень сервиса от 0 до 1; только если пользователь назвал"},
        "warehouse": {"type": "string", "description": "склад; не указывай, если пользователь не назвал склад"},
    }, "required": ["sku"]},
    label="Пересчёт «что если»",
    summarize=_sum_whatif,
)
def what_if(sku: str, add_in_transit: float | None = None, stock: float | None = None, lead_time_days: int | None = None, service_level: float | None = None,
            warehouse: str | None = None, in_transit: float | None = None) -> dict:
    ds = state.get_ds()
    warehouse = _wh(warehouse)
    found = resolve_sku(sku)
    if not found:
        return {"error": f"артикул {sku} не найден; коды 1С имеют вид 010300016_ (с подчёркиванием)"}
    sku = found
    p = Params(warehouse=warehouse)
    base = compute_sku(ds, sku, warehouse, p)
    base.pop("_series", None)
    was = {k: base.get(k) for k in ("in_transit", "stock", "lead_time_days", "service_level")}
    ov: dict = {}
    if add_in_transit is not None:
        ov["in_transit"] = float(base["in_transit"]) + float(add_in_transit)
    elif in_transit is not None:  # older argument: the new total in transit
        ov["in_transit"] = float(in_transit)
    for k, v in {"stock": stock, "lead_time_days": lead_time_days, "service_level": service_level}.items():
        if v is not None and not (was.get(k) is not None and float(v) == float(was[k])):  # a value equal to the data is not a change
            ov[k] = v
    new = compute_sku(ds, sku, warehouse, p, overrides=ov)
    new.pop("_series", None)
    return {"base_inputs": was, "overrides": ov, "base_qty": base["recommended_qty"], "scenario_qty": new["recommended_qty"],
            "delta_qty": new["recommended_qty"] - base["recommended_qty"], "scenario": _strip(new)}


@tool(
    "Черновик письма поставщику с позициями заказа. Только текст, ничего не отправляется.",
    {"type": "object", "properties": {"supplier_id": {"type": "string"}}, "required": ["supplier_id"]},
    label="Черновик письма поставщику",
    summarize=_sum_email,
    final=lambda d: f"Черновик письма поставщику, ничего не отправлено:\n\n{d['draft']}\n\n{d.get('note', '')}",
)
def draft_supplier_email(supplier_id: str) -> dict:
    res = state.ensure_result()
    sup = next((s for s in res["suppliers"] if s["supplier_id"] == supplier_id or s["supplier"].lower() == supplier_id.lower()), None)
    if not sup:
        return {"error": f"поставщик {supplier_id} не найден в текущем расчёте"}
    urg = {"critical": 0, "high": 1, "normal": 2}
    orders = sorted(sup["orders"], key=lambda o: (urg.get(o.get("urgency"), 3), str(o.get("order_by") or ""), -float(o.get("recommended_qty") or 0)))
    top = orders[:EMAIL_LINES]  # a short letter: a long one made a small model re-type it for minutes
    lines = "\n".join(f"{i + 1}. {o['sku']} {o['name']} — {_n(o['recommended_qty'])} шт" for i, o in enumerate(top))
    rest = len(orders) - len(top)
    more = f"\n…и ещё {rest} поз. Полный список во вложении: выгрузка XLSX для 1С." if rest > 0 else ""
    text = (
        f"Кому: {sup['email']}\nТема: Заказ на поставку от ТОО «Электрокомплект»\n\n"
        f"Здравствуйте!\nПросим подтвердить возможность поставки позиций (срок поставки {sup['lead_time_days']} дн.), самые срочные:\n{lines}{more}\n\n"
        f"Итого позиций: {sup['positions']}, количество: {_n(sup['total_qty'])} шт.\nС уважением, отдел закупа ТОО «Электрокомплект»"
    )
    return {"draft": text, "positions_in_letter": len(top), "positions_total": len(orders),
            "note": "Черновик. Отправка только после подтверждения ответственного сотрудника."}
