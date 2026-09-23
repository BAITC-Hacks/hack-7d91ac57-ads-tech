"""Honest out-of-sample backtest, per-SKU forecast model selection and safety-stock calibration.

Procedure (evaluate):
  window A (validation): pretend «today» = cutoff_A, train only on data before it, forecast 3 months, compare with
                         actuals → choose the best forecasting model per SKU and a safety-stock multiplier.
  window B (test):       same with cutoff_B = the next 3 months; the choices made on A are applied to B, so the
                         «auto» row is a genuine out-of-sample result. B's own errors give the production choice.

Candidate models (all on the cleaned demand, all keep seasonality so the brief's must-have 2 holds):
  trend   seasonal indices × linear trend level (the engine default)
  recent  seasonal indices × deseasonalized mean of the last 3 months
  year    seasonal indices × deseasonalized mean of the last 12 months
Baselines for comparison (raw sales): naive_90d («Excel»), seasonal_naive (same month last year), ma_12m;
ablation: ours_no_cleaning (trend model on raw sales, no outlier removal, no stockout restoration).

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
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .replenish import FORECAST_MODELS, Dataset, Params, compute_sku, detect_outliers, forecast_horizon

VARIANTS = ["trend", "recent", "year"]
MODELS = ["auto", "trend", "recent", "year", "ours_no_cleaning", "naive_90d", "seasonal_naive", "ma_12m"]
MODEL_LABEL = {
    "auto": "Эксперимент: авто-выбор модели по артикулу",
    "trend": "Сезонность + тренд — модель в работе",
    "recent": "Сезонность + уровень 3 мес.",
    "year": "Сезонность + уровень 12 мес.",
    "ours_no_cleaning": "Сезонность + тренд без очистки данных",
    "naive_90d": "Excel: среднее за 90 дней",
    "seasonal_naive": "Тот же месяц прошлого года",
    "ma_12m": "Среднее за 12 месяцев",
}
MULTIPLIERS = [round(1.0 + 0.1 * i, 1) for i in range(31)]  # 1.0 … 4.0

_G: dict[str, Any] = {}  # shared with forked workers


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
    t.model_choice = None
    t.model_wape = None
    t.ss_multiplier = 1.0
    return t


def _month_days(p: pd.Period) -> int:
    return calendar.monthrange(p.year, p.month)[1]


def _one(sku: str) -> dict[str, Any] | None:
    full: Dataset = _G["full"]
    tr: Dataset = _G["train"]
    tr_raw: Dataset = _G["train_raw"]
    wh: str = _G["wh"]
    cutoff: date = _G["cutoff"]
    months: list[pd.Period] = _G["months"]
    choice: dict[str, str] = _G.get("choice") or {}
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
    idx, lm, up = s["seasonal_index"], s["last_month"], s["lost_uplift"]
    L = {"trend": s["level_trend"], "recent": s["level_recent"], "year": s["level_year"]}
    g = {"trend": s["growth_hist"] + s["plan_month"], "recent": s["plan_month"], "year": s["plan_month"]}
    ch = choice.get(sku, "trend")
    r_raw = compute_sku(tr_raw, sku, wh, Params(warehouse=wh, outlier_z=1e12, outlier_client_share=2.0))
    sr = r_raw["_series"]
    mean90 = float(hist.loc[hist["date"] >= ts - pd.Timedelta(days=90), "qty"].sum()) / 90.0
    ma12 = float(sum(hist_m.get(p, 0.0) for p in last12)) / 12.0

    rows = []
    for p in months:
        k = (p - lm).n
        f = {v: L[v] * up * ((1 + g[v]) ** k) * idx[p.month] for v in VARIANTS}
        f["auto"] = f[ch]
        kr = (p - sr["last_month"]).n
        f["ours_no_cleaning"] = sr["level_trend"] * sr["lost_uplift"] * ((1 + sr["growth_hist"] + sr["plan_month"]) ** kr) * sr["seasonal_index"][p.month]
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
    fc_h = {v: float(forecast_horizon(cutoff, horizon, L[v] * up, g[v], idx, lm)[0]) for v in VARIANTS}
    return {
        "sku": sku,
        "category": r["category"],
        "regular": active_months >= 8,
        "choice": ch,
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


def run_window(ds: Dataset, wh: str, cutoff: date, horizon_months: int = 3, choice: dict | None = None, m_prev: float | None = None) -> dict[str, Any]:
    months = [pd.Period(cutoff, "M") + k for k in range(horizon_months)]
    skus = sorted(set(ds.sales.loc[ds.sales["warehouse"] == wh, "sku"]) & set(ds.products["sku"]))
    ds.tx(skus[0], wh)
    tr, tr_raw = _train(ds, cutoff, True), _train(ds, cutoff, False)
    tr.tx(skus[0], wh)
    tr_raw.tx(skus[0], wh)
    _G.update(full=ds, train=tr, train_raw=tr_raw, wh=wh, cutoff=cutoff, months=months, choice=choice or {})
    n = min(os.cpu_count() or 1, 8)
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

    # per-SKU errors → selection for the next window / production
    sel_choice: dict[str, str] = {}
    sel_wape: dict[str, dict[str, float]] = {}
    wins = collections.Counter()
    for r in results:
        rows = [p for p in r["rows"] if not p["stockout"]]
        tot = sum(p["a_clean"] for p in rows)
        if len(rows) < 2 or tot <= 0:
            continue
        errs = {v: sum(abs(p[v] - p["a_clean"]) for p in rows) for v in VARIANTS}
        best = min(VARIANTS, key=lambda v: (errs[v], VARIANTS.index(v)))
        sel_choice[r["sku"]] = best
        sel_wape[r["sku"]] = {v: round(100 * errs[v] / tot, 1) for v in VARIANTS}
        if r["regular"]:
            allerr = {m: sum(abs(p[m] - p["a_clean"]) for p in rows) for m in MODELS if m != "auto"}
            wins[min(allerr, key=allerr.get)] += 1

    # safety-stock coverage with the model actually used in this window («auto» = choice from the previous window)
    covers = [(r["cover"], r["choice"]) for r in results if r["cover"] and r["regular"]]

    def coverage(m: float) -> float | None:
        if not covers:
            return None
        ok = sum(1 for c, _ in covers if c["actual"] <= c["fc"]["trend"] + m * c["safety"])  # production model
        return round(100 * ok / len(covers), 1)

    target = round(100 * float(np.median([c["sl"] for c, _ in covers])), 1) if covers else 95.0
    m_star = next((m for m in MULTIPLIERS if (coverage(m) or 0) >= target), MULTIPLIERS[-1])
    cats = {}
    for c in sorted({p["category"] for p in reg}):
        cp = [p for p in reg if p["category"] == c]
        if sum(p["a_clean"] for p in cp) > 0 and len({p["sku"] for p in cp}) >= 10:
            mm = _metrics(cp, "a_clean")
            cats[c] = {"skus": len({p["sku"] for p in cp}), "auto": mm["auto"]["wape"], "naive_90d": mm["naive_90d"]["wape"]}
    return {
        "cutoff": str(cutoff),
        "months": [str(m) for m in months],
        "skus_evaluated": len(results),
        "regular_skus": sum(1 for r in results if r["regular"]),
        "regular_vs_clean": _metrics(reg, "a_clean"),
        "regular_vs_raw": _metrics(reg, "a_raw"),
        "intermittent_vs_clean": _metrics(irr, "a_clean"),
        "all_vs_clean": _metrics(allp, "a_clean"),
        "wins_regular": dict(wins),
        "by_category": cats,
        "selection": {"choice": sel_choice, "wape": sel_wape, "distribution": dict(collections.Counter(sel_choice.values()))},
        "calibration": {
            "skus": len(covers),
            "target_pct": target,
            "coverage_raw_pct": coverage(1.0),
            "multiplier": m_star,
            "coverage_calibrated_in_sample_pct": coverage(m_star),
            "multiplier_from_previous_window": m_prev,
            "coverage_out_of_sample_pct": coverage(m_prev) if m_prev else None,
        },
    }


def evaluate(ds: Dataset, warehouse: str | None = None, horizon_months: int = 3) -> dict[str, Any]:
    wh = warehouse or ds.default_warehouse()
    last_full = pd.Period(ds.today, "M") - 1
    cut_b = (last_full - (horizon_months - 1)).start_time.date()
    cut_a = (last_full - (2 * horizon_months - 1)).start_time.date()
    a = run_window(ds, wh, cut_a, horizon_months)
    b = run_window(ds, wh, cut_b, horizon_months, choice=a["selection"]["choice"], m_prev=a["calibration"]["multiplier"])

    def strip(w: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in w.items() if k != "selection"} | {"selection_distribution": w["selection"]["distribution"]}

    return {
        "warehouse": wh,
        "labels": MODEL_LABEL,
        "models": MODELS,
        "validation": strip(a),
        "test": strip(b),
        "production": {
            "model": "trend",
            "wape": b["selection"]["wape"],
            "ss_multiplier": b["calibration"]["multiplier"],
            "distribution": b["selection"]["distribution"],
            "labels": FORECAST_MODELS,
        },
        "note": "Модели обучены только на данных до даты среза. Выбор модели и калибровка запаса сделаны на окне проверки, а ошибки в строке «Эксперимент: авто-выбор» и покрытие «вне выборки» измерены на следующем окне, которое при выборе не использовалось. Авто-выбор не обыграл единую модель, поэтому в работе остаётся «сезонность + тренд»; калибровка запаса применяется.",
    }


def format_table(res: dict[str, Any]) -> str:
    t, v = res["test"], res["validation"]
    lines = [f"Выбор модели и калибровка: окно {', '.join(v['months'])} (срез {v['cutoff']})",
             f"Проверка вне выборки:     окно {', '.join(t['months'])} (срез {t['cutoff']}), склад {res['warehouse']}",
             f"Артикулов: {t['skus_evaluated']}, регулярных: {t['regular_skus']}", "",
             f"{'Модель':46s} WAPE рег.  Bias    WAPE рег.(сырые)  WAPE нерег.  Лучшая у"]
    for m in res["models"]:
        a, b, c = t["regular_vs_clean"][m], t["regular_vs_raw"][m], t["intermittent_vs_clean"][m]
        lines.append(f"{res['labels'][m]:46s} {a['wape']!s:>7}%  {a['bias']!s:>6}%  {b['wape']!s:>12}%  {c['wape']!s:>10}%  {t['wins_regular'].get(m, '-')!s:>6}")
    k = t["calibration"]
    lines += ["", f"Страховой запас (цель {k['target_pct']}%): без калибровки {k['coverage_raw_pct']}%; с множителем ×{k['multiplier_from_previous_window']} из окна проверки — {k['coverage_out_of_sample_pct']}% вне выборки",
              f"В работе: модель «сезонность + тренд», множитель запаса ×{res['production']['ss_multiplier']} (откалиброван на последнем окне)"]
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
