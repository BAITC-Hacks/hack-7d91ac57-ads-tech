"""Process-wide state: loaded dataset, last calculation, approved orders."""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from .replenish import Dataset, Params, run

DATA_DIR = Path(os.environ.get("DATA_DIR", "data/sample"))
ORDERS_FILE = Path("data/approved_orders.json")

_ds: Dataset | None = None
_last: dict[str, Any] | None = None
_last_params: Params | None = None
_cache: dict[tuple, dict[str, Any]] = {}
_lock = threading.Lock()


def _today_override():
    from datetime import date

    v = os.environ.get("TODAY")
    return date.fromisoformat(v) if v else None


def get_ds() -> Dataset:
    global _ds
    if _ds is None:
        if not (DATA_DIR / "sales.csv").exists() and DATA_DIR.name == "sample":
            from .synth import generate

            generate(DATA_DIR)
        _ds = Dataset.load(DATA_DIR, today=_today_override())
    return _ds


def reset_ds(regenerate: bool = False) -> Dataset:
    global _ds, _last
    if regenerate:
        from .synth import generate

        generate(DATA_DIR)
    _ds = None
    _last = None
    _cache.clear()
    return get_ds()


def invalidate() -> None:
    global _last
    _last = None
    _cache.clear()


def ensure_result(params: Params | None = None) -> dict[str, Any]:
    global _last, _last_params
    if params is None:
        if _last is not None:
            return _last
        params = _last_params or Params(warehouse=get_ds().default_warehouse())
    key = (params.warehouse, params.category, params.service_level, params.review_days, params.include_zero, params.growth_plan_pct_year)
    with _lock:
        if key not in _cache:
            _cache[key] = run(get_ds(), params)
        _last = _cache[key]
        _last_params = params
    return _last


def full_result(params: Params) -> dict[str, Any]:
    """The include_zero variant of a run (all positions), cached like ensure_result but without touching _last."""
    p = Params(**{**params.__dict__, "include_zero": True})
    key = (p.warehouse, p.category, p.service_level, p.review_days, True, p.growth_plan_pct_year)
    with _lock:
        if key not in _cache:
            _cache[key] = run(get_ds(), p)
        return _cache[key]


def precompute_in_background() -> None:
    """Warm the default calculation at startup so the first UI request is instant (partner data: ~40 s)."""

    def _job():
        try:
            wh = get_ds().default_warehouse()
            ensure_result(Params(warehouse=wh))
            full_result(Params(warehouse=wh))
        except Exception:  # noqa: BLE001
            import logging

            logging.getLogger("state").exception("precompute failed")

    threading.Thread(target=_job, daemon=True).start()


def last_result() -> dict[str, Any] | None:
    return _last


def load_orders() -> list[dict[str, Any]]:
    if ORDERS_FILE.exists():
        try:
            return json.loads(ORDERS_FILE.read_text())
        except json.JSONDecodeError:
            return []
    return []


def save_order(order: dict[str, Any]) -> dict[str, Any]:
    orders = load_orders()
    order["order_id"] = f"ORD-{datetime.now():%Y%m%d}-{len(orders) + 1:03d}"
    order["approved_at"] = datetime.now().isoformat(timespec="seconds")
    order["status"] = "approved"
    orders.append(order)
    ORDERS_FILE.parent.mkdir(exist_ok=True)
    ORDERS_FILE.write_text(json.dumps(orders, ensure_ascii=False, indent=1))
    return order
