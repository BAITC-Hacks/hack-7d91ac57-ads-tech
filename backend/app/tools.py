"""Agent tools for the purchasing assistant. Numbers come only from the engine."""
from __future__ import annotations

from . import state
from .llm import tool
from .replenish import Params, compute_sku


def _strip(r: dict) -> dict:
    keep = ["sku", "name", "category", "warehouse", "supplier", "supplier_id", "recommended_qty", "urgency", "days_of_cover",
            "lead_time_days", "stock", "in_transit", "forecast_daily", "forecast_period_qty", "safety_stock", "seasonal_factor",
            "trend_pct_month", "plan_pct_year", "stockout_days", "lost_demand_qty", "outliers_excluded", "outlier_qty_excluded", "justification"]
    return {k: r[k] for k in keep if k in r}


@tool(
    "Запустить расчёт рекомендованных заказов поставщикам. Возвращает сводку и позиции по поставщикам.",
    {"type": "object", "properties": {"warehouse": {"type": "string", "description": "склад, по умолчанию Главный"}, "category": {"type": "string"}}, "required": []},
)
def run_replenishment(warehouse: str | None = None, category: str | None = None) -> dict:
    res = state.ensure_result(Params(warehouse=warehouse or state.get_ds().default_warehouse(), category=category or None))
    return {"summary": res["summary"], "suppliers": [{"supplier": s["supplier"], "supplier_id": s["supplier_id"], "positions": s["positions"], "total_qty": s["total_qty"], "critical": s["critical"]} for s in res["suppliers"]]}


@tool(
    "Объяснить расчёт по артикулу: прогноз, сезонность, тренд, исключённые выбросы, упущенный спрос, страховой запас, остаток, в пути, итоговое количество.",
    {"type": "object", "properties": {"sku": {"type": "string"}, "warehouse": {"type": "string"}}, "required": ["sku"]},
)
def explain_sku(sku: str, warehouse: str | None = None) -> dict:
    ds = state.get_ds()
    warehouse = warehouse or ds.default_warehouse()
    sku = sku.strip()
    if sku not in set(ds.products["sku"]):
        sku = sku.upper()
    if sku not in set(ds.products["sku"]):
        match = ds.products[ds.products["name"].str.contains(sku, case=False, na=False)]
        if match.empty:
            return {"error": f"артикул {sku} не найден"}
        sku = str(match["sku"].iloc[0])
    r = compute_sku(ds, sku, warehouse, Params(warehouse=warehouse))
    s = r.pop("_series")
    out = _strip(r)
    out["outliers"] = s["outliers"][:5]
    out["stockouts"] = s["stockouts"][:5]
    return out


@tool(
    "Список рекомендованных заказов с фильтрами по поставщику (id или название) и срочности (critical|high|normal).",
    {"type": "object", "properties": {"supplier": {"type": "string"}, "urgency": {"type": "string"}, "warehouse": {"type": "string"}, "limit": {"type": "integer", "default": 15}}, "required": []},
)
def list_orders(supplier: str | None = None, urgency: str | None = None, warehouse: str | None = None, limit: int = 15) -> dict:
    res = state.ensure_result()
    rows = res["orders"]
    if supplier:
        rows = [r for r in rows if supplier.lower() in (r["supplier_id"] + " " + r["supplier"]).lower()]
    if urgency:
        rows = [r for r in rows if r["urgency"] == urgency]
    if warehouse:
        rows = [r for r in rows if r["warehouse"] == warehouse]
    return {"count": len(rows), "orders": [_strip(r) for r in rows[:limit]]}


@tool(
    "Пересчитать позицию при изменении входных данных: товар в пути, остаток, срок поставки, уровень сервиса.",
    {"type": "object", "properties": {"sku": {"type": "string"}, "in_transit": {"type": "number"}, "stock": {"type": "number"}, "lead_time_days": {"type": "integer"}, "service_level": {"type": "number"}, "warehouse": {"type": "string"}}, "required": ["sku"]},
)
def what_if(sku: str, in_transit: float | None = None, stock: float | None = None, lead_time_days: int | None = None, service_level: float | None = None, warehouse: str | None = None) -> dict:
    ds = state.get_ds()
    warehouse = warehouse or ds.default_warehouse()
    sku = sku.strip()
    if sku not in set(ds.products["sku"]):
        sku = sku.upper()
    if sku not in set(ds.products["sku"]):
        return {"error": f"артикул {sku} не найден"}
    p = Params(warehouse=warehouse)
    base = compute_sku(ds, sku, warehouse, p)
    base.pop("_series", None)
    ov = {k: v for k, v in {"in_transit": in_transit, "stock": stock, "lead_time_days": lead_time_days, "service_level": service_level}.items() if v is not None}
    new = compute_sku(ds, sku, warehouse, p, overrides=ov)
    new.pop("_series", None)
    return {"overrides": ov, "base_qty": base["recommended_qty"], "scenario_qty": new["recommended_qty"], "delta_qty": new["recommended_qty"] - base["recommended_qty"], "scenario": _strip(new)}


@tool(
    "Черновик письма поставщику с позициями заказа. Только текст, ничего не отправляется.",
    {"type": "object", "properties": {"supplier_id": {"type": "string"}}, "required": ["supplier_id"]},
)
def draft_supplier_email(supplier_id: str) -> dict:
    res = state.ensure_result()
    sup = next((s for s in res["suppliers"] if s["supplier_id"] == supplier_id or s["supplier"].lower() == supplier_id.lower()), None)
    if not sup:
        return {"error": f"поставщик {supplier_id} не найден в текущем расчёте"}
    lines = "\n".join(f"{i + 1}. {o['sku']} {o['name']} — {o['recommended_qty']} шт" for i, o in enumerate(sup["orders"]))
    text = (
        f"Кому: {sup['email']}\nТема: Заказ на поставку от ТОО «Электрокомплект»\n\n"
        f"Здравствуйте!\nПросим подтвердить возможность поставки следующих позиций (срок поставки {sup['lead_time_days']} дн.):\n{lines}\n\n"
        f"Итого позиций: {sup['positions']}, количество: {sup['total_qty']}.\nС уважением, отдел закупа ТОО «Электрокомплект»"
    )
    return {"draft": text, "note": "Черновик. Отправка только после подтверждения ответственного сотрудника."}
