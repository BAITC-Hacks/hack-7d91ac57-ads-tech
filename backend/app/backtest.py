"""Honest out-of-sample backtest, assortment-level forecast model selection and safety-stock calibration.

Procedure (evaluate):
  window A (validation): pretend «today» = cutoff_A, train only on data before it, forecast 3 months, compare with actuals.
                         The forecast mode with the lowest error on A is chosen for the whole assortment, and the
                         safety-stock multiplier for that mode is calibrated on A.
  window B (test):       the next 3 months. The mode chosen on A is applied to B («auto» row) and the multiplier from A
                         is checked on B: both are genuine out-of-sample results. B's own errors pick the production mode
                         and multiplier (the most recent evidence).

Forecast modes (all on cleaned demand, all seasonal, so the brief's must-have 2 holds):
  trend         SKU seasonal indices × linear trend level
  blend         seasonal indices shrunk 50/50 towards the category's pooled indices × deseasonalized 6-month level
  blend_growth  blend + sustained trend (R² gate) extrapolated from the middle of the 6-month window
  blend_damped  blend + half of the sustained trend
Baselines (raw sales): naive_90d («Excel»), seasonal_naive (same month last year), ma_12m;
ablation: ours_no_cleaning (trend mode on raw sales, no outlier removal, no stockout restoration).
Per-SKU model switching was tested earlier and rejected (it overfits 3-month windows).

Metrics: WAPE = Σ|F − A| / ΣA over SKU×month, Bias = Σ(F − A) / ΣA. A_clean = actual sales with one-off orders
excluded (the regular demand we plan for). SKU-months with a known stockout are excluded. «Regular» SKUs are sold
in ≥ 8 of the 12 months before the cutoff.

Run:  python -m app.backtest --data data/partner
"""
from __future__ import annotations

import argparse
import calendar
import collections
import copy
import multiprocessing
import os
import threading
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .replenish import FORECAST_MODES, Dataset, Params, compute_sku, detect_outliers, forecast_horizon

VARIANTS = ["trend", "blend", "blend_growth", "blend_damped"]
MODELS = ["auto", *VARIANTS, "ours_no_cleaning", "naive_90d", "seasonal_naive", "ma_12m"]
MODEL_LABEL = {
    "auto": "Автовыбор модели на весь ассортимент (выбор на окне проверки)",
    "trend": "Сезонность артикула + тренд",
    "blend": "Сезонность с категорией + уровень 6 мес.",
    "blend_growth": "Сезонность с категорией + уровень 6 мес. + рост",
    "blend_damped": "Сезонность с категорией + уровень 6 мес. + рост с затуханием",
    "ours_no_cleaning": "Сезонность + тренд без очистки данных",
    "naive_90d": "Excel: среднее за 90 дней",
    "seasonal_naive": "Тот же месяц прошлого года",
    "ma_12m": "Среднее за 12 месяцев",
}
MULTIPLIERS = [round(1.0 + 0.1 * i, 1) for i in range(31)]  # 1.0 … 4.0

_G: dict[str, Any] = {}  # shared with forked workers
_RUN_LOCK = threading.Lock()  # one window at a time: _G is process-global (server background job vs. an API call or a test)


def _train(ds: Dataset, cutoff: date, clean: bool) -> Dataset:
    t = copy.copy(ds)
    ts = pd.Timestamp(cutoff)
    t.sales = ds.sales[ds.sales["date"] < ts]
    if clean:
        so = ds.stockouts[ds.stockouts["date_from"] < ts].copy()
        so["date_to"] = so["date_to"].where(so["date_to"] < ts, ts - pd.Timedelta(days=1))
        t.stockouts = so
    else:
        t.stockouts = ds.stockouts.iloc[0:0]
    t.today = cutoff
    t._groups = None
    t._cat_idx = None
    t.model_choice = None
    t.model_wape = None
    t.ss_multiplier = 1.0
    t.forecast_mode = "trend"  # levels in _series are then the raw building blocks for every mode
    t.signals = None
    return t


def _month_days(p: pd.Period) -> int:
    return calendar.monthrange(p.year, p.month)[1]


def _mode_params(s: dict[str, Any], cidx: dict[int, float] | None) -> dict[str, tuple[float, float, dict[int, float]]]:
    """(level incl. lost-demand uplift, monthly growth incl. plan, seasonal indices) for every forecast mode."""
    idx = s["seasonal_index_sku"]
    up, g, plan = s["lost_uplift"], s["growth_hist"], s["plan_month"]
    idx_b = {m: 0.5 * idx[m] + 0.5 * cidx[m] for m in range(1, 13)} if cidx else idx
    mon = s["monthly"]
    if len(mon):
        d = np.nan_to_num(mon.values.astype(float)) / np.array([idx_b[p.month] for p in mon.index])
        l6 = float(np.mean(d[-6:]))
    else:
        l6 = s["level_trend"]
    out = {"trend": (s["level_trend"] * up, g + plan, idx)}
    for mode, gm in (("blend", 0.0), ("blend_growth", g), ("blend_damped", 0.5 * g)):
        out[mode] = (l6 * ((1 + gm) ** 2.5) * up, gm + plan, idx_b)
    return out


def _one(sku: str) -> dict[str, Any] | None:
    full: Dataset = _G["full"]
    tr: Dataset = _G["train"]
    tr_raw: Dataset = _G["train_raw"]
    wh: str = _G["wh"]
    cutoff: date = _G["cutoff"]
    months: list[pd.Period] = _G["months"]
    mode: str = _G.get("mode") or "trend"
    ts = pd.Timestamp(cutoff)

    tx_full = full.tx(sku, wh)
    if tx_full.empty:
        return None
    hist = tx_full[tx_full["date"] < ts]
    if hist.empty:
        return None
    hist_m = hist.assign(m=hist["date"].dt.to_period("M")).groupby("m")["qty"].sum()
    last12 = [pd.Period(ts, "M") - k for k in range(12, 0, -1)]
    active_months = int(sum(1 for p in last12 if hist_m.get(p, 0) > 0))
    if active_months == 0:
        return None

    fut = tx_full[tx_full["date"] >= ts]
    flagged, _ = detect_outliers(tx_full, 5.0, 0.6)
    flagged = flagged[flagged["date"] >= ts]
    a_raw = fut.assign(m=fut["date"].dt.to_period("M")).groupby("m")["qty"].sum()
    a_clean = flagged.assign(m=flagged["date"].dt.to_period("M")).groupby("m")["qty_clean"].sum()
    so = full.stockouts[(full.stockouts["sku"] == sku) & (full.stockouts["warehouse"] == wh)]
    so_months: set[pd.Period] = set()
    for r in so.itertuples():
        p = pd.Period(r.date_from, "M")
        while p <= pd.Period(r.date_to, "M"):
            so_months.add(p)
            p += 1

    r = compute_sku(tr, sku, wh, Params(warehouse=wh))
    s = r["_series"]
    lm = s["last_month"]
    mp = _mode_params(s, tr.category_index(r["category"], wh))
    r_raw = compute_sku(tr_raw, sku, wh, Params(warehouse=wh, outlier_z=1e12, outlier_client_share=2.0))
    sr = r_raw["_series"]
    mean90 = float(hist.loc[hist["date"] >= ts - pd.Timedelta(days=90), "qty"].sum()) / 90.0
    ma12 = float(sum(hist_m.get(p, 0.0) for p in last12)) / 12.0

    rows = []
    for p in months:
        k = (p - lm).n
        f = {v: L * ((1 + g) ** k) * ix[p.month] for v, (L, g, ix) in mp.items()}
        f["auto"] = f[mode]
        kr = (p - sr["last_month"]).n
        f["ours_no_cleaning"] = sr["level_trend"] * sr["lost_uplift"] * ((1 + sr["growth_hist"] + sr["plan_month"]) ** kr) * sr["seasonal_index_sku"][p.month]
        f["naive_90d"] = mean90 * _month_days(p)
        sn = hist_m.get(p - 12, np.nan)
        f["seasonal_naive"] = float(sn) if not pd.isna(sn) else f["naive_90d"]
        f["ma_12m"] = ma12
        rows.append({"month": str(p), "stockout": p in so_months, "a_raw": float(a_raw.get(p, 0.0)), "a_clean": float(a_clean.get(p, 0.0)),
                     **{m: float(max(np.nan_to_num(v), 0.0)) for m, v in f.items()}})

    horizon = int(r["lead_time_days"] + r["review_days"])
    end = ts + pd.Timedelta(days=horizon)
    actual_h = float(flagged.loc[flagged["date"] < end, "qty_clean"].sum())
    so_in_h = any((row.date_from < end) and (row.date_to >= ts) for row in so.itertuples())
    fc_h = {v: float(forecast_horizon(cutoff, horizon, L, g, ix, lm)[0]) for v, (L, g, ix) in mp.items()}
    return {
        "sku": sku,
        "category": r["category"],
        "regular": active_months >= 8,
        "rows": rows,
        "cover": None if so_in_h else {"actual": actual_h, "fc": fc_h, "safety": float(r["safety_stock"]), "sl": float(r["service_level"])},
    }


def _metrics(points: list[dict[str, Any]], target: str) -> dict[str, dict[str, float | None]]:
    tot = sum(p[target] for p in points)
    out = {}
    for m in MODELS:
        err = sum(abs(p[m] - p[target]) for p in points)
        bias = sum(p[m] - p[target] for p in points)
        out[m] = {"wape": round(100 * err / tot, 1) if tot else None, "bias": round(100 * bias / tot, 1) if tot else None}
    return out


def run_window(ds: Dataset, wh: str, cutoff: date, horizon_months: int = 3, mode: str = "trend", m_prev: float | None = None) -> dict[str, Any]:
    months = [pd.Period(cutoff, "M") + k for k in range(horizon_months)]
    skus = sorted(set(ds.sales.loc[ds.sales["warehouse"] == wh, "sku"]) & set(ds.products["sku"]))
    ds.tx(skus[0], wh)
    tr, tr_raw = _train(ds, cutoff, True), _train(ds, cutoff, False)
    tr.tx(skus[0], wh)
    tr_raw.tx(skus[0], wh)
    for c in ds.products["category"].unique():  # pooled seasonality per category, computed before forking
        tr.category_index(str(c), wh)
    n = min(os.cpu_count() or 1, 8)
    with _RUN_LOCK:
        _G.update(full=ds, train=tr, train_raw=tr_raw, wh=wh, cutoff=cutoff, months=months, mode=mode)
        try:
            if n > 1 and os.name == "posix" and len(skus) > 200:
                with multiprocessing.get_context("fork").Pool(n) as pool:
                    results = [x for x in pool.imap(_one, skus, chunksize=64) if x]
            else:
                results = [x for x in map(_one, skus) if x]
        finally:
            _G.clear()

    def pts(regular: bool | None) -> list[dict[str, Any]]:
        return [dict(p, sku=r["sku"], category=r["category"]) for r in results if regular is None or r["regular"] == regular for p in r["rows"] if not p["stockout"]]

    reg, irr, allp = pts(True), pts(False), pts(None)
    reg_m = _metrics(reg, "a_clean")
    best_mode = min(VARIANTS, key=lambda v: (reg_m[v]["wape"] if reg_m[v]["wape"] is not None else 1e9, VARIANTS.index(v)))

    sku_wape: dict[str, dict[str, float]] = {}
    wins = collections.Counter()
    for r in results:
        rows = [p for p in r["rows"] if not p["stockout"]]
        tot = sum(p["a_clean"] for p in rows)
        if len(rows) < 2 or tot <= 0:
            continue
        sku_wape[r["sku"]] = {v: round(100 * sum(abs(p[v] - p["a_clean"]) for p in rows) / tot, 1) for v in VARIANTS}
        if r["regular"]:
            allerr = {m: sum(abs(p[m] - p["a_clean"]) for p in rows) for m in MODELS if m != "auto"}
            wins[min(allerr, key=allerr.get)] += 1

    covers = [r["cover"] for r in results if r["cover"] and r["regular"]]

    def coverage(m: float, v: str) -> float | None:
        if not covers:
            return None
        ok = sum(1 for c in covers if c["actual"] <= c["fc"][v] + m * c["safety"])
        return round(100 * ok / len(covers), 1)

    target = round(100 * float(np.median([c["sl"] for c in covers])), 1) if covers else 95.0
    calib_by_mode = {}
    for v in VARIANTS:
        m_star = next((m for m in MULTIPLIERS if (coverage(m, v) or 0) >= target), MULTIPLIERS[-1])
        calib_by_mode[v] = {"coverage_raw_pct": coverage(1.0, v), "multiplier": m_star, "coverage_calibrated_in_sample_pct": coverage(m_star, v)}
    cats = {}
    for c in sorted({p["category"] for p in reg}):
        cp = [p for p in reg if p["category"] == c]
        if sum(p["a_clean"] for p in cp) > 0 and len({p["sku"] for p in cp}) >= 10:
            mm = _metrics(cp, "a_clean")
            cats[c] = {"skus": len({p["sku"] for p in cp}), "auto": mm["auto"]["wape"], "naive_90d": mm["naive_90d"]["wape"]}
    return {
        "cutoff": str(cutoff),
        "months": [str(m) for m in months],
        "mode_applied": mode,
        "best_mode": best_mode,
        "skus_evaluated": len(results),
        "regular_skus": sum(1 for r in results if r["regular"]),
        "regular_vs_clean": reg_m,
        "regular_vs_raw": _metrics(reg, "a_raw"),
        "intermittent_vs_clean": _metrics(irr, "a_clean"),
        "all_vs_clean": _metrics(allp, "a_clean"),
        "wins_regular": dict(wins),
        "by_category": cats,
        "sku_wape": sku_wape,
        "calibration_by_mode": calib_by_mode,
        "calibration": {
            "skus": len(covers),
            "target_pct": target,
            "coverage_raw_pct": coverage(1.0, mode),
            "multiplier": calib_by_mode[mode]["multiplier"],
            "coverage_calibrated_in_sample_pct": calib_by_mode[mode]["coverage_calibrated_in_sample_pct"],
            "multiplier_from_previous_window": m_prev,
            "coverage_out_of_sample_pct": coverage(m_prev, mode) if m_prev else None,
        },
    }


def evaluate(ds: Dataset, warehouse: str | None = None, horizon_months: int = 3) -> dict[str, Any]:
    wh = warehouse or ds.default_warehouse()
    last_full = pd.Period(ds.today, "M") - 1
    cut_b = (last_full - (horizon_months - 1)).start_time.date()
    cut_a = (last_full - (2 * horizon_months - 1)).start_time.date()
    a = run_window(ds, wh, cut_a, horizon_months, mode="trend")
    mode_a = a["best_mode"]
    m_a = a["calibration_by_mode"][mode_a]["multiplier"]
    b = run_window(ds, wh, cut_b, horizon_months, mode=mode_a, m_prev=m_a)
    mode_b = b["best_mode"]

    def strip(w: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in w.items() if k not in ("sku_wape",)}

    return {
        "warehouse": wh,
        "labels": MODEL_LABEL,
        "models": MODELS,
        "modes": FORECAST_MODES,
        "selected_on_validation": mode_a,
        "validation": strip(a),
        "test": strip(b),
        "production": {
            "model": mode_b,
            "mode_label": FORECAST_MODES[mode_b],
            "wape": b["sku_wape"],
            "ss_multiplier": b["calibration_by_mode"][mode_b]["multiplier"],
            "distribution": {},
            "labels": FORECAST_MODES,
        },
        "note": "Модели обучены только на данных до даты среза. Модель для всего ассортимента и множитель запаса выбраны на окне проверки; строка «Автовыбор» и покрытие «вне выборки» измерены на следующем окне, которое при выборе не использовалось. Переключение модели по каждому артикулу проверено отдельно и отклонено: переобучается на коротких окнах.",
    }


def format_table(res: dict[str, Any]) -> str:
    t, v = res["test"], res["validation"]
    lines = [f"Выбор модели и калибровка: окно {', '.join(v['months'])} (срез {v['cutoff']}), выбрана: {res['selected_on_validation']}",
             f"Проверка вне выборки:     окно {', '.join(t['months'])} (срез {t['cutoff']}), склад {res['warehouse']}",
             f"Артикулов: {t['skus_evaluated']}, регулярных: {t['regular_skus']}", "",
             f"{'Модель':62s} WAPE A  WAPE B  Bias B  B к сырым"]
    for m in res["models"]:
        lines.append(f"{res['labels'][m]:62s} {v['regular_vs_clean'][m]['wape']!s:>6}  {t['regular_vs_clean'][m]['wape']!s:>6}  {t['regular_vs_clean'][m]['bias']!s:>6}  {t['regular_vs_raw'][m]['wape']!s:>8}")
    k = t["calibration"]
    lines += ["", f"Страховой запас (цель {k['target_pct']}%): без калибровки {k['coverage_raw_pct']}%; с множителем ×{k['multiplier_from_previous_window']} из окна проверки — {k['coverage_out_of_sample_pct']}% вне выборки",
              f"В работе: {res['production']['mode_label']}, множитель запаса ×{res['production']['ss_multiplier']} (по последнему окну)"]
    return "\n".join(lines)


if __name__ == "__main__":
    import json
    import time

    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/sample")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    ds = Dataset.load(Path(a.data))
    res = evaluate(ds)
    print(json.dumps({k: v for k, v in res.items() if k != "production"}, ensure_ascii=False, indent=1) if a.json else format_table(res))
    print(f"\n({time.time() - t0:.1f} s)")
