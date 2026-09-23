"""Process-wide state: loaded dataset, last calculation, approved orders."""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from .replenish import Dataset, Params, run

DATA_DIR = Path(os.environ.get("DATA_DIR", "data/sample"))
ORDERS_FILE = Path("data/approved_orders.json")

_ds: Dataset | None = None
_last: dict[str, Any] | None = None
_last_params: Params | None = None


def get_ds() -> Dataset:
    global _ds
    if _ds is None:
        if not (DATA_DIR / "sales.csv").exists():
            from .synth import generate

            generate(DATA_DIR)
        _ds = Dataset.load(DATA_DIR)
    return _ds


def reset_ds(regenerate: bool = False) -> Dataset:
    global _ds, _last
    if regenerate:
        from .synth import generate

        generate(DATA_DIR)
    _ds = None
    _last = None
    return get_ds()


def invalidate() -> None:
    global _last
    _last = None


def ensure_result(params: Params | None = None) -> dict[str, Any]:
    global _last, _last_params
    if params is None:
        if _last is not None:
            return _last
        params = _last_params or Params(warehouse="Главный")
    _last = run(get_ds(), params)
    _last_params = params
    return _last


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
