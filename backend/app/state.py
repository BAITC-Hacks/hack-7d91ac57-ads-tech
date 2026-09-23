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
_backtest: dict[str, Any] | None = None
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
        from .signals import by_sku

        _ds.signals = by_sku()
    return _ds


def reset_ds(regenerate: bool = False) -> Dataset:
    global _ds, _last, _backtest
    _backtest = None
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
    key = (params.warehouse, params.category, params.service_level, params.review_days, params.include_zero, params.growth_plan_pct_year, params.ss_calibrated, params.include_signals)
    with _lock:
        if key not in _cache:
            _cache[key] = run(get_ds(), params)
        _last = _cache[key]
        _last_params = params
    return _last


def full_result(params: Params) -> dict[str, Any]:
    """The include_zero variant of a run (all positions), cached like ensure_result but without touching _last."""
    p = Params(**{**params.__dict__, "include_zero": True})
    key = (p.warehouse, p.category, p.service_level, p.review_days, True, p.growth_plan_pct_year, p.ss_calibrated, p.include_signals)
    with _lock:
        if key not in _cache:
            _cache[key] = run(get_ds(), p)
        return _cache[key]


def _fingerprint(ds: Dataset) -> str:
    lt = sorted(zip(ds.suppliers["supplier_id"].astype(str), ds.suppliers["lead_time_days"].astype(int)))
    from .replenish import ENGINE_VERSION

    return f"v{ENGINE_VERSION}|{len(ds.sales)}|{float(ds.sales['qty'].sum()):.0f}|{ds.sales['date'].max()}|{len(ds.stockouts)}|{ds.today}|{lt}"


def ensure_backtest() -> dict[str, Any]:
    """Out-of-sample backtest (app.backtest.evaluate): gives per-SKU forecast error and the calibrated safety-stock
    multiplier used in production. Cached on disk by a data fingerprint (partner data: ~80 s the first time)."""
    global _backtest
    from .backtest import evaluate

    ds = get_ds()
    path = Path("data") / f"backtest_{DATA_DIR.name}.json"
    fp = _fingerprint(ds)
    rep = None
    if path.exists():
        try:
            cached = json.loads(path.read_text())
            if cached.get("fingerprint") == fp:
                rep = cached
        except (json.JSONDecodeError, OSError):
            rep = None
    if rep is None:
        rep = evaluate(ds)
        rep["fingerprint"] = fp
        try:
            path.parent.mkdir(exist_ok=True)
            path.write_text(json.dumps(rep, ensure_ascii=False))
        except OSError:
            pass
    with _lock:
        ds.model_choice = None
        ds.model_wape = rep["production"]["wape"]
        ds.ss_multiplier = float(rep["production"]["ss_multiplier"])
        ds.forecast_mode = rep["production"].get("model", "trend")
        _cache.clear()
    _backtest = {k: v for k, v in rep.items() if k not in ("production", "fingerprint")}
    _backtest["production"] = {"model": rep["production"].get("model", "trend"), "mode_label": rep["production"].get("mode_label", ""), "ss_multiplier": rep["production"]["ss_multiplier"], "skus_with_error": len(rep["production"]["wape"])}
    return _backtest


def backtest_report() -> dict[str, Any] | None:
    return _backtest


def precompute_in_background() -> None:
    """At startup: backtest (per-SKU error, safety-stock calibration), then warm the default calculation."""

    def _job():
        try:
            ensure_backtest()
        except Exception:  # noqa: BLE001 — never block the calculation on the backtest
            import logging

            logging.getLogger("state").exception("backtest failed; using uncalibrated safety stock")
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
