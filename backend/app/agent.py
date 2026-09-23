"""Утренний агент-закупщика: сам проходит по инструментам движка и готовит сводку «что сделать сегодня».
Работает без LLM (шаблон); с LLM переписывает сводку живым текстом, факты берёт только из инструментов."""
from __future__ import annotations

import time
from datetime import date, timedelta
from typing import Any

from . import state
from .config import get_settings
from .replenish import Params, overstock


def _fmt(n: float) -> str:
    return f"{n:,.0f}".replace(",", " ")


def collect_facts(warehouse: str | None = None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    steps: list[dict[str, Any]] = []
    ds = state.get_ds()
    wh = warehouse or ds.default_warehouse()
    today = ds.today

    t0 = time.perf_counter()
    res = state.ensure_result(Params(warehouse=wh))
    steps.append({"tool": "run_replenishment", "args": f'{{"warehouse":"{wh}"}}', "result": f"{res['summary']['positions']} позиций, {res['summary']['critical']} критичных", "ms": int((time.perf_counter() - t0) * 1000)})

    t0 = time.perf_counter()
    orders = res["orders"]
    week = today + timedelta(days=7)
    due_week = [o for o in orders if o.get("order_by") and date.fromisoformat(o["order_by"]) <= week]
    critical = [o for o in orders if o["urgency"] == "critical"]
    zero_stock = [o for o in critical if o["stock"] <= 0 and o["in_transit"] <= 0]
    steps.append({"tool": "list_orders", "args": '{"urgency":"critical"}', "result": f"{len(critical)} критичных, из них {len(zero_stock)} с нулевым остатком; заказать на этой неделе: {len(due_week)}", "ms": int((time.perf_counter() - t0) * 1000)})

    t0 = time.perf_counter()
    full = state.full_result(Params(warehouse=wh))
    over = overstock(ds, wh, 6.0, full=full)
    steps.append({"tool": "overstock_report", "args": '{"months":6}', "result": f"{over['overstock_positions']} поз. избытка, {over['dead_positions']} без продаж 6 мес.", "ms": int((time.perf_counter() - t0) * 1000)})

    t0 = time.perf_counter()
    late_transit = 0
    if len(ds.in_transit):
        late_transit = int((ds.in_transit["eta"].dt.date < today).sum())
    approved = state.load_orders()
    steps.append({"tool": "check_data", "args": "{}", "result": f"в пути с просроченной датой: {late_transit}; утверждённых заказов: {len(approved)}", "ms": int((time.perf_counter() - t0) * 1000)})

    suppliers = [{"supplier": s["supplier"], "supplier_id": s["supplier_id"], "positions": s["positions"], "total_qty": s["total_qty"], "total_value": s.get("total_value", 0), "critical": s["critical"], "lead_time_days": s["lead_time_days"]} for s in res["suppliers"]]
    facts = {
        "date": str(today),
        "warehouse": wh,
        "summary": res["summary"],
        "suppliers": suppliers,
        "due_this_week": len(due_week),
        "critical": len(critical),
        "zero_stock": [{"sku": o["sku"], "name": o["name"], "supplier": o["supplier"], "recommended_qty": o["recommended_qty"], "forecast_daily": o["forecast_daily"]} for o in sorted(zero_stock, key=lambda o: -o["forecast_daily"])[:5]],
        "top_due": [{"sku": o["sku"], "name": o["name"], "supplier": o["supplier"], "order_by": o["order_by"], "recommended_qty": o["recommended_qty"], "days_of_cover": o["days_of_cover"]} for o in sorted(due_week, key=lambda o: (o["order_by"], -o["recommended_qty"]))[:8]],
        "overstock": {k: over[k] for k in ("overstock_positions", "overstock_units", "overstock_value", "dead_positions", "dead_units", "dead_value")},
        "late_transit_lines": late_transit,
        "approved_orders": len(approved),
    }
    return facts, steps


def template_brief(f: dict[str, Any]) -> str:
    s = f["summary"]
    lines = [f"Утренняя сводка закупщика, {f['date']}, склад {f['warehouse']}.", ""]
    lines.append(f"1. К заказу {s['positions']} позиций у {s['suppliers']} поставщиков, всего {_fmt(s['total_qty'])} шт" + (f" (≈ {_fmt(s['total_value'])} ₸ по известной себестоимости)" if s.get("total_value") else "") + f". Критичных {s['critical']}, высокий приоритет {s['high']}.")
    if f["zero_stock"]:
        lines.append("2. Уже в дефиците (остаток 0, в пути 0), продажи теряются каждый день: " + "; ".join(f"{z['sku']} {z['name'][:40]} — заказать {_fmt(z['recommended_qty'])} шт ({z['supplier']})" for z in f["zero_stock"]) + ".")
    else:
        lines.append("2. Позиций с нулевым остатком без поставки нет.")
    lines.append(f"3. Разместить на этой неделе: {f['due_this_week']} позиций. Ближайшие: " + ("; ".join(f"{d['sku']} до {d['order_by'][5:].replace('-', '.')} — {_fmt(d['recommended_qty'])} шт" for d in f["top_due"][:5]) if f["top_due"] else "нет") + ".")
    lines.append("4. По поставщикам: " + "; ".join(f"{sp['supplier']}: {sp['positions']} поз., {_fmt(sp['total_qty'])} шт, критичных {sp['critical']}, срок {sp['lead_time_days']} дн." for sp in f["suppliers"]) + ".")
    o = f["overstock"]
    lines.append(f"5. Не заказывать и разгружать: {o['overstock_positions']} позиций с покрытием > 6 мес. ({_fmt(o['overstock_units'])} шт" + (f", ≈ {_fmt(o['overstock_value'])} ₸" if o["overstock_value"] else "") + f"), {o['dead_positions']} позиций без продаж полгода ({_fmt(o['dead_units'])} шт" + (f", ≈ {_fmt(o['dead_value'])} ₸" if o["dead_value"] else "") + ").")
    if f["late_transit_lines"]:
        lines.append(f"6. Внимание: {f['late_transit_lines']} строк товара в пути с прошедшей датой поступления, уточнить у поставщика.")
    lines.append("")
    lines.append(f"Исключено разовых продаж: {s['outliers_excluded_total']}, учтён упущенный спрос: {_fmt(s['lost_demand_total'])} шт. Черновики заказов по поставщикам готовы на дашборде, утверждение за вами; автоматически ничего не отправляется.")
    return "\n".join(lines)


async def daily_brief(warehouse: str | None = None) -> dict[str, Any]:
    facts, steps = collect_facts(warehouse)
    text = template_brief(facts)
    used_llm = False
    s = get_settings()
    if not s.demo_mode and s.llm_api_key:
        from .llm import chat

        try:
            prompt = (
                "Ты ассистент менеджера отдела закупа «Электрокомплект». Ниже факты, полученные инструментами (единственный источник чисел). "
                "Напиши утреннюю сводку на русском: 5–8 коротких пунктов, что сделать сегодня, с числами и артикулами из фактов. "
                "Не выдумывай числа, не говори, что заказ отправлен. В конце одной строкой: что требует решения человека.\n\nФакты:\n" + template_brief(facts)
            )
            t0 = time.perf_counter()
            out = await chat([{"role": "user", "content": prompt}])
            if out and len(out) > 80:
                text = out
                used_llm = True
            steps.append({"tool": "write_brief (LLM)", "args": f'{{"model":"{s.llm_model}"}}', "result": text[:200], "ms": int((time.perf_counter() - t0) * 1000)})
        except Exception as e:  # noqa: BLE001
            steps.append({"tool": "write_brief (LLM)", "args": "{}", "result": f"LLM недоступен: {e}; использован шаблон", "ms": 0})
    return {"brief": text, "facts": facts, "steps": steps, "llm": used_llm, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
