"""Replenishment engine: deterministic, explainable, robust to outliers.

Pipeline per (sku, warehouse):
  1. transactions → flag one-off orders (robust z-score on transaction size +
     single-client concentration per month) → replace flagged qty with typical daily demand
  2. daily series (zeros filled) → impute demand inside stockout periods from
     neighbouring windows → "lost demand"
  3. monthly series → seasonal indices (ratio-to-trend, 2 iterations, shrunk when
     history is short) → linear trend on deseasonalized series → growth %/month
  4. forecast over horizon H = lead_time + review_days, month-aware
  5. safety stock = z(service_level) * sigma_daily * sqrt(H)
  6. need = forecast + safety - stock - in_transit(eta <= H) → pack rounding, MOQ
  7. urgency by days of cover vs lead time; templated justification (no LLM needed)
"""
from __future__ import annotations

import calendar
import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

Z = {0.9: 1.2816, 0.95: 1.6449, 0.98: 2.0537, 0.99: 2.3263}
MONTHS_RU = {1: "январь", 2: "февраль", 3: "март", 4: "апрель", 5: "май", 6: "июнь", 7: "июль", 8: "август", 9: "сентябрь", 10: "октябрь", 11: "ноябрь", 12: "декабрь"}
CATEGORY_SERVICE_LEVEL = {"Автоматика": 0.98, "Кабель": 0.95, "Освещение": 0.95, "Розетки и выключатели": 0.95, "Щиты и корпуса": 0.9, "Инструмент": 0.9}


def z_for(sl: float) -> float:
    if sl in Z:
        return Z[sl]
    # inverse normal approximation (Abramowitz-Stegun 26.2.23)
    p = 1 - sl
    t = math.sqrt(-2 * math.log(p))
    return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3)


@dataclass
class Dataset:
    products: pd.DataFrame
    suppliers: pd.DataFrame
    sales: pd.DataFrame
    stock: pd.DataFrame
    in_transit: pd.DataFrame
    stockouts: pd.DataFrame
    today: date = field(default_factory=date.today)

    @classmethod
    def load(cls, folder: Path, today: date | None = None) -> "Dataset":
        f = Path(folder)
        sales = pd.read_csv(f / "sales.csv", parse_dates=["date"], low_memory=False)
        stockouts = pd.read_csv(f / "stockouts.csv", parse_dates=["date_from", "date_to"]) if (f / "stockouts.csv").exists() else pd.DataFrame(columns=["sku", "warehouse", "date_from", "date_to"])
        in_transit = pd.read_csv(f / "in_transit.csv", parse_dates=["eta"]) if (f / "in_transit.csv").exists() else pd.DataFrame(columns=["sku", "warehouse", "qty", "eta"])
        ds = cls(
            products=pd.read_csv(f / "products.csv"),
            suppliers=pd.read_csv(f / "suppliers.csv"),
            sales=sales,
            stock=pd.read_csv(f / "stock.csv", parse_dates=["as_of"]),
            in_transit=in_transit,
            stockouts=stockouts,
        )
        if today is None:
            today = (sales["date"].max() + pd.Timedelta(days=1)).date()
        ds.today = today
        return ds

    def replace(self, kind: str, df: pd.DataFrame) -> None:
        setattr(self, kind, df)
        self._groups = None

    _groups: dict | None = None

    def tx(self, sku: str, warehouse: str) -> pd.DataFrame:
        """Transactions for one SKU/warehouse, from a cached groupby (2 700 SKUs × 250 k rows otherwise)."""
        if self._groups is None:
            self._groups = {k: g for k, g in self.sales.groupby(["sku", "warehouse"], sort=False)}
        g = self._groups.get((sku, warehouse))
        return g if g is not None else self.sales.iloc[0:0]

    def default_warehouse(self) -> str:
        whs = sorted(self.stock["warehouse"].unique().tolist()) or sorted(self.sales["warehouse"].unique().tolist())
        return "Главный" if "Главный" in whs else (whs[0] if whs else "Главный")

    def summary(self) -> dict[str, Any]:
        return {
            "skus": int(self.products["sku"].nunique()),
            "categories": sorted(self.products["category"].unique().tolist()),
            "warehouses": sorted(self.stock["warehouse"].unique().tolist()),
            "suppliers": int(self.suppliers["supplier_id"].nunique()),
            "sales_rows": int(len(self.sales)),
            "sales_from": str(self.sales["date"].min().date()),
            "sales_to": str(self.sales["date"].max().date()),
            "stockout_periods": int(len(self.stockouts)),
            "in_transit_lines": int(len(self.in_transit)),
            "today": str(self.today),
            "default_warehouse": self.default_warehouse(),
        }


@dataclass
class Params:
    warehouse: str | None = None
    category: str | None = None
    service_level: float | None = None  # None → per category
    review_days: int = 14
    outlier_z: float = 5.0
    outlier_client_share: float = 0.6
    include_zero: bool = False


# --------------------------------------------------------------------------- steps
def detect_outliers(tx: pd.DataFrame, z_thr: float, client_share_thr: float) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """Flag one-off orders. Returns (tx with 'is_outlier','qty_clean', reasons)."""
    tx = tx.copy()
    tx["is_outlier"] = False
    tx["reason"] = ""
    if tx.empty:
        tx["qty_clean"] = tx["qty"]
        return tx, []
    daily = tx.groupby("date")["qty"].sum()
    med = float(daily.median())
    mad = float((daily - med).abs().median()) or max(med * 0.25, 1.0)
    typical = max(med, 1.0)
    # rule A: a transaction far beyond typical daily demand AND in the top 1 % of this SKU's transaction sizes
    # (the percentile cap keeps heavy-tailed but regular demand, e.g. cable by the drum, from being "one-off")
    z = 0.6745 * (tx["qty"] - med) / mad
    p99 = float(tx["qty"].quantile(0.99)) if len(tx) >= 20 else float("inf")
    rule_a = (z > z_thr) & (tx["qty"] > 8 * typical) & (tx["qty"] >= p99)
    tx.loc[rule_a, "is_outlier"] = True
    tx.loc[rule_a, "reason"] = "робастный z=" + z[rule_a].round(1).astype(str)
    # rule B: one client dominates a month with an unusually large month
    tx["month"] = tx["date"].dt.to_period("M")
    monthly = tx.groupby("month")["qty"].sum()
    med_month = float(monthly.median()) if len(monthly) else 0
    by_client = tx.groupby(["month", "client_id"])["qty"].sum()
    for (mth, client), q in by_client.items():
        tot = monthly[mth]
        if tot > 0 and q / tot >= client_share_thr and tot > 2 * med_month and q > 8 * typical:
            mask = (tx["month"] == mth) & (tx["client_id"] == client) & (tx["qty"] > typical)
            tx.loc[mask & ~tx["is_outlier"], "reason"] = f"{q / tot:.0%} спроса месяца одним клиентом"
            tx.loc[mask, "is_outlier"] = True
    tx["qty_clean"] = np.where(tx["is_outlier"], np.minimum(tx["qty"], typical), tx["qty"])
    reasons = [
        {"date": str(r.date.date()), "qty": int(r.qty), "client_id": str(r.client_id), "reason": r.reason}
        for r in tx[tx["is_outlier"]].itertuples()
    ]
    return tx.drop(columns=["month"]), reasons


def daily_series(tx: pd.DataFrame, start: date, end: date, col: str) -> pd.Series:
    idx = pd.date_range(start, end, freq="D")
    if tx.empty:
        return pd.Series(0.0, index=idx)
    s = tx.groupby("date")[col].sum().reindex(idx, fill_value=0.0).astype(float)
    return s


def impute_stockouts(daily: pd.Series, periods: pd.DataFrame, window: int = 28) -> tuple[pd.Series, list[dict[str, Any]]]:
    """Replace demand inside stockout periods with the mean of surrounding windows."""
    out = daily.copy()
    info = []
    mask_all = pd.Series(False, index=daily.index)
    for r in periods.itertuples():
        mask_all |= (daily.index >= r.date_from) & (daily.index <= r.date_to)
    for r in periods.itertuples():
        m = (daily.index >= r.date_from) & (daily.index <= r.date_to)
        if not m.any():
            continue
        before = (daily.index < r.date_from) & (daily.index >= r.date_from - pd.Timedelta(days=window)) & ~mask_all
        after = (daily.index > r.date_to) & (daily.index <= r.date_to + pd.Timedelta(days=window)) & ~mask_all
        ref = daily[before | after]
        expected = float(ref.mean()) if len(ref) else float(daily[~mask_all].mean())
        actual = float(daily[m].sum())
        imputed = expected * int(m.sum())
        out[m] = np.maximum(daily[m].values, expected)
        info.append({"from": str(r.date_from.date()), "to": str(r.date_to.date()), "days": int(m.sum()), "lost_demand_qty": int(round(max(imputed - actual, 0)))})
    return out, info


def seasonal_and_trend(monthly: pd.Series) -> tuple[dict[int, float], float, float, float]:
    """Returns (seasonal index by month 1..12, level at last month (deseasonalized), growth per month, r2)."""
    n = len(monthly)
    if n == 0 or float(np.nansum(monthly.values)) <= 0:
        return {m: 1.0 for m in range(1, 13)}, 0.0, 0.0, 0.0
    y = np.nan_to_num(monthly.values.astype(float))
    x = np.arange(n, dtype=float)
    idx = {m: 1.0 for m in range(1, 13)}
    months = np.array([p.month for p in monthly.index])
    for _ in range(2):
        s = np.array([idx[m] for m in months])
        yd = y / s
        if n >= 3:
            b, a = np.polyfit(x, yd, 1)
        else:
            b, a = 0.0, float(yd.mean())
        trend = a + b * x
        trend = np.where(trend <= 0, max(float(yd.mean()), 1e-6), trend)
        ratio = y / trend
        if n >= 18:
            raw = {m: float(np.mean(ratio[months == m])) if (months == m).any() else 1.0 for m in range(1, 13)}
            k = min(n / 24.0, 1.0)  # shrink toward 1 when history is short
            raw = {m: 1 + (v - 1) * k for m, v in raw.items()}
            mean = float(np.mean(list(raw.values())))
            idx = {m: float(v / mean) if mean > 0 and np.isfinite(v) else 1.0 for m, v in raw.items()}
            idx = {m: (v if np.isfinite(v) and v > 0 else 1.0) for m, v in idx.items()}
        else:
            idx = {m: 1.0 for m in range(1, 13)}
    s = np.array([idx[m] for m in months])
    yd = y / s
    b, a = np.polyfit(x, yd, 1) if n >= 3 else (0.0, float(yd.mean()))
    level = max(a + b * (n - 1), 0.0)
    fitted = a + b * x
    ss_res = float(((yd - fitted) ** 2).sum())
    ss_tot = float(((yd - yd.mean()) ** 2).sum()) or 1e-9
    r2 = max(0.0, 1 - ss_res / ss_tot)
    growth = (b / level) if level > 0 else 0.0
    growth = float(np.clip(growth, -0.1, 0.1))
    if r2 < 0.2:  # not a sustained trend → do not extrapolate
        growth = 0.0
        level = float(yd[-6:].mean()) if n >= 6 else float(yd.mean())
    return idx, float(level), growth, float(r2)


def forecast_horizon(today: date, horizon_days: int, level_month: float, growth: float, idx: dict[int, float], last_month: pd.Period) -> tuple[float, list[dict[str, Any]]]:
    """Sum forecast demand from today over horizon_days, month by month."""
    total = 0.0
    d = today
    end = today + timedelta(days=horizon_days)
    parts = []
    while d < end:
        p = pd.Period(d, freq="M")
        k = (p - last_month).n
        days_in_month = calendar.monthrange(d.year, d.month)[1]
        month_end = date(d.year, d.month, days_in_month)
        seg_end = min(end - timedelta(days=1), month_end)
        days = (seg_end - d).days + 1
        month_fc = level_month * ((1 + growth) ** k) * idx[d.month]
        q = month_fc / days_in_month * days
        total += q
        parts.append({"month": str(p), "days": days, "forecast": round(float(q), 1), "seasonal_index": round(float(idx[d.month]), 2)})
        d = seg_end + timedelta(days=1)
    return total, parts


# --------------------------------------------------------------------------- main
def _fmt(x: float, nd: int = 1) -> str:
    return f"{x:,.{nd}f}".replace(",", " ").replace(".", ",")


def compute_sku(ds: Dataset, sku: str, warehouse: str, p: Params, overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    overrides = overrides or {}
    prod = ds.products.loc[ds.products["sku"] == sku].iloc[0]
    sup = ds.suppliers.loc[ds.suppliers["supplier_id"] == prod["supplier_id"]].iloc[0]
    lead = int(overrides.get("lead_time_days", sup["lead_time_days"]))
    review = int(overrides.get("review_days", p.review_days))
    horizon = lead + review
    sl = p.service_level or CATEGORY_SERVICE_LEVEL.get(prod["category"], 0.95)
    sl = float(overrides.get("service_level") or sl)

    tx = ds.tx(sku, warehouse)
    start = ds.sales["date"].min().date()
    end = ds.today - timedelta(days=1)
    tx, outliers = detect_outliers(tx, p.outlier_z, p.outlier_client_share)
    raw_daily = daily_series(tx, start, end, "qty")
    clean_daily = daily_series(tx, start, end, "qty_clean")
    so = ds.stockouts[(ds.stockouts["sku"] == sku) & (ds.stockouts["warehouse"] == warehouse)]
    clean_no_impute = clean_daily.copy()
    clean_daily, stockout_info = impute_stockouts(clean_daily, so)
    lost = int(sum(i["lost_demand_qty"] for i in stockout_info))
    stockout_days = int(sum(i["days"] for i in stockout_info))
    # explicit lost-demand uplift over the last 12 months: observed sales understate demand
    last_year_imputed = float(clean_daily[-365:].sum())
    last_year_observed = float(clean_no_impute[-365:].sum())
    lost_uplift = (last_year_imputed / last_year_observed) if last_year_observed > 0 else 1.0
    lost_uplift = float(min(lost_uplift, 1.5))

    monthly = clean_daily.resample("MS").sum()
    monthly.index = monthly.index.to_period("M")
    # drop trailing partial month
    if len(monthly) and (end.day < calendar.monthrange(end.year, end.month)[1] - 1):
        monthly = monthly.iloc[:-1]
    idx, level, growth_hist, r2 = seasonal_and_trend(monthly)
    level *= lost_uplift
    plan_month = float(prod.get("growth_plan_pct_year", 0) or 0) / 100 / 12
    growth = growth_hist + plan_month
    last_month = monthly.index[-1] if len(monthly) else pd.Period(end, freq="M")
    fc_total, fc_parts = forecast_horizon(ds.today, horizon, level, growth, idx, last_month)
    fc_daily = fc_total / horizon if horizon else 0.0

    # demand variability: weekly sums over the last 26 weeks, deseasonalized (removes weekday pattern and
    # seasonal drift, keeps genuine randomness), scaled to the horizon
    weekly = clean_daily[-182:].resample("W").sum() if len(clean_daily) >= 14 else clean_daily.resample("W").sum()
    weekly = weekly / np.array([idx[ts.month] for ts in weekly.index])
    sigma_week = float(np.nan_to_num(weekly.std())) if len(weekly) > 2 else 0.0
    sigma = sigma_week / math.sqrt(7)
    safety = z_for(sl) * sigma_week * math.sqrt(horizon / 7)

    stock_row = ds.stock[(ds.stock["sku"] == sku) & (ds.stock["warehouse"] == warehouse)]
    stock = float(overrides["stock"]) if overrides.get("stock") is not None else (float(stock_row["stock"].iloc[0]) if len(stock_row) else 0.0)
    it = ds.in_transit[(ds.in_transit["sku"] == sku) & (ds.in_transit["warehouse"] == warehouse)]
    if overrides.get("in_transit") is not None:
        in_transit = float(overrides["in_transit"])
    else:
        eta_limit = pd.Timestamp(ds.today + timedelta(days=horizon))
        in_transit = float(it.loc[it["eta"] <= eta_limit, "qty"].sum()) if len(it) else 0.0

    fc_total = float(np.nan_to_num(fc_total))
    safety = float(np.nan_to_num(safety))
    raw_need = fc_total + safety - stock - in_transit
    pack = int(prod.get("pack_size", 1) or 1)
    moq = int(prod.get("moq") or 0) if "moq" in prod.index and pd.notna(prod.get("moq")) else int(sup.get("moq", 0) or 0)
    if raw_need <= 0:
        rec = 0
    else:
        rec = int(math.ceil(raw_need / pack) * pack)
        if rec < moq:
            rec = int(math.ceil(moq / pack) * pack)
    cover = (stock + in_transit) / fc_daily if fc_daily > 0 else float("inf")
    if rec == 0:
        urgency = "none"
    elif cover < lead:
        urgency = "critical"
    elif cover < horizon:
        urgency = "high"
    else:
        urgency = "normal"

    avg_daily_raw = float(raw_daily[-90:].mean()) if len(raw_daily) else 0.0
    season_now = idx[ds.today.month]
    parts_txt = []
    parts_txt.append(f"Регулярный спрос ≈ {_fmt(level / 30)} шт/день (очищенный, десезонализированный)")
    if abs(season_now - 1) >= 0.03:
        parts_txt.append(f"сезонный коэффициент ({MONTHS_RU[ds.today.month]}) {_fmt(season_now, 2)}")
    if growth_hist:
        parts_txt.append(f"устойчивый тренд {'+' if growth_hist > 0 else ''}{_fmt(growth_hist * 100)}%/мес (R²={_fmt(r2, 2)})")
    if plan_month:
        parts_txt.append(f"план прироста категории +{_fmt(plan_month * 1200, 0)}%/год")
    parts_txt.append(f"→ прогноз {_fmt(fc_daily)} шт/день, на {horizon} дн. (поставка {lead} + период {review}) = {_fmt(fc_total, 0)} шт")
    if outliers:
        parts_txt.append(f"исключено {len(outliers)} разовых продаж на {_fmt(sum(o['qty'] for o in outliers), 0)} шт ({outliers[0]['reason']})")
    if lost:
        parts_txt.append(f"в {stockout_days} дн. дефицита учтён упущенный спрос {_fmt(lost, 0)} шт" + (f" (+{_fmt((lost_uplift - 1) * 100)}% к уровню за год)" if lost_uplift > 1.001 else ""))
    parts_txt.append(f"страховой запас {_fmt(safety, 0)} шт (уровень сервиса {int(sl * 100)}%)")
    parts_txt.append(f"остаток {_fmt(stock, 0)}, в пути {_fmt(in_transit, 0)}")
    if rec > 0:
        tail = f"→ потребность {_fmt(raw_need, 0)}"
        if rec != math.ceil(max(raw_need, 0)):
            tail += f", с учётом кратности {pack}" + (f" и MOQ {moq}" if raw_need < moq else "") + f" → {rec}"
        parts_txt.append(tail)
        parts_txt.append(f"покрытие {_fmt(min(cover, 999), 0)} дн. при сроке поставки {lead} — {'критично' if urgency == 'critical' else 'высокий приоритет' if urgency == 'high' else 'плановый заказ'}")
    else:
        parts_txt.append(f"→ запаса хватает (покрытие {_fmt(min(cover, 999), 0)} дн.), заказ не требуется")
    justification = "; ".join(parts_txt) + "."

    return {
        "sku": sku,
        "name": str(prod["name"]),
        "category": str(prod["category"]),
        "warehouse": warehouse,
        "supplier_id": str(sup["supplier_id"]),
        "supplier": str(sup["supplier"]),
        "recommended_qty": int(rec),
        "raw_need": round(raw_need, 1),
        "pack_size": pack,
        "moq": moq,
        "urgency": urgency,
        "days_of_cover": round(min(cover, 999), 1),
        "lead_time_days": lead,
        "review_days": review,
        "service_level": sl,
        "stock": int(stock),
        "in_transit": int(in_transit),
        "avg_daily_raw_90d": round(avg_daily_raw, 2),
        "forecast_daily": round(fc_daily, 2),
        "forecast_period_qty": round(fc_total, 1),
        "forecast_parts": fc_parts,
        "safety_stock": round(safety, 1),
        "sigma_daily": round(sigma, 2),
        "seasonal_factor": round(season_now, 3),
        "trend_pct_month": round(growth_hist * 100, 2),
        "trend_r2": round(r2, 2),
        "plan_pct_year": round(plan_month * 1200, 1),
        "stockout_days": stockout_days,
        "lost_demand_qty": lost,
        "lost_demand_uplift_pct": round((lost_uplift - 1) * 100, 2),
        "outliers_excluded": len(outliers),
        "outlier_qty_excluded": int(sum(o["qty"] for o in outliers)),
        "justification": justification,
        "_series": {
            "raw_daily": raw_daily,
            "clean_daily": clean_daily,
            "monthly": monthly,
            "seasonal_index": idx,
            "outliers": outliers,
            "stockouts": stockout_info,
            "level": level,
            "growth": growth,
            "last_month": last_month,
        },
    }


def run(ds: Dataset, p: Params) -> dict[str, Any]:
    prods = ds.products
    if p.category:
        prods = prods[prods["category"] == p.category]
    warehouses = [p.warehouse] if p.warehouse else [ds.default_warehouse()]
    rows = []
    for wh in warehouses:
        skus_here = set(ds.stock.loc[ds.stock["warehouse"] == wh, "sku"]) | set(ds.sales.loc[ds.sales["warehouse"] == wh, "sku"])
        for sku in prods["sku"]:
            if sku not in skus_here:
                continue
            r = compute_sku(ds, sku, wh, p)
            r.pop("_series", None)
            if r["recommended_qty"] > 0 or p.include_zero:
                rows.append(r)
    order = {"critical": 0, "high": 1, "normal": 2, "none": 3}
    rows.sort(key=lambda r: (r["supplier"], order[r["urgency"]], r["days_of_cover"]))
    suppliers = []
    for sid in sorted({r["supplier_id"] for r in rows}):
        sr = [r for r in rows if r["supplier_id"] == sid]
        sup = ds.suppliers.loc[ds.suppliers["supplier_id"] == sid].iloc[0]
        suppliers.append({
            "supplier_id": sid,
            "supplier": str(sup["supplier"]),
            "lead_time_days": int(sup["lead_time_days"]),
            "moq": int(sup["moq"]),
            "email": str(sup.get("email", "")),
            "positions": len(sr),
            "total_qty": int(sum(r["recommended_qty"] for r in sr)),
            "critical": sum(1 for r in sr if r["urgency"] == "critical"),
            "orders": sr,
        })
    summary = {
        "positions": len(rows),
        "suppliers": len(suppliers),
        "critical": sum(1 for r in rows if r["urgency"] == "critical"),
        "high": sum(1 for r in rows if r["urgency"] == "high"),
        "normal": sum(1 for r in rows if r["urgency"] == "normal"),
        "total_qty": int(sum(r["recommended_qty"] for r in rows)),
        "lost_demand_total": int(sum(r["lost_demand_qty"] for r in rows)),
        "outliers_excluded_total": int(sum(r["outliers_excluded"] for r in rows)),
    }
    return {"params": p.__dict__, "today": str(ds.today), "summary": summary, "suppliers": suppliers, "orders": rows}


def sku_detail(ds: Dataset, sku: str, warehouse: str, p: Params) -> dict[str, Any]:
    r = compute_sku(ds, sku, warehouse, p)
    s = r.pop("_series")
    raw_m = s["raw_daily"].resample("MS").sum()
    clean_m = s["clean_daily"].resample("MS").sum()
    months = []
    for ts, rv in raw_m.items():
        cv = float(clean_m.get(ts, rv))
        months.append({"month": ts.strftime("%Y-%m"), "raw": round(float(rv), 1), "cleaned": round(cv, 1), "forecast": None})
    # forecast next 6 months
    for k in range(1, 7):
        pm = s["last_month"] + k
        months.append({"month": str(pm), "raw": None, "cleaned": None, "forecast": round(float(s["level"] * ((1 + s["growth"]) ** k) * s["seasonal_index"][pm.month]), 1)})
    r["monthly"] = months
    r["outliers"] = s["outliers"]
    r["stockouts"] = s["stockouts"]
    r["seasonal_index"] = {str(k): round(float(v), 3) for k, v in s["seasonal_index"].items()}
    return r


def export_rows(result: dict[str, Any], supplier_id: str | None = None) -> pd.DataFrame:
    rows = [r for r in result["orders"] if not supplier_id or r["supplier_id"] == supplier_id]
    return pd.DataFrame([{
        "Поставщик": r["supplier"],
        "Артикул": r["sku"],
        "Наименование": r["name"],
        "Категория": r["category"],
        "Склад": r["warehouse"],
        "Количество": r["recommended_qty"],
        "Срочность": {"critical": "Критично", "high": "Высокая", "normal": "Плановая"}.get(r["urgency"], ""),
        "Остаток": r["stock"],
        "В пути": r["in_transit"],
        "Прогноз в день": r["forecast_daily"],
        "Обоснование": r["justification"],
    } for r in rows])


def naive_need(ds: Dataset, sku: str, warehouse: str, horizon: int, window_days: int = 90) -> float:
    """Excel-style baseline as purchasing managers usually do it: mean raw daily sales over the last 90 days ×
    horizon − stock − in transit. No outlier handling, no stockout compensation, no seasonality, no safety stock."""
    tx = ds.tx(sku, warehouse)
    since = pd.Timestamp(ds.today - timedelta(days=window_days))
    mean_daily = float(tx.loc[tx["date"] >= since, "qty"].sum()) / window_days
    stock_row = ds.stock[(ds.stock["sku"] == sku) & (ds.stock["warehouse"] == warehouse)]
    stock = float(stock_row["stock"].iloc[0]) if len(stock_row) else 0.0
    it = ds.in_transit[(ds.in_transit["sku"] == sku) & (ds.in_transit["warehouse"] == warehouse)]
    in_transit = float(it["qty"].sum()) if len(it) else 0.0
    return mean_daily * horizon - stock - in_transit


def impact(ds: Dataset, result: dict[str, Any]) -> dict[str, Any]:
    """Compare engine recommendations with the naive baseline, in units and money, over ALL positions of the
    warehouse (including those where the engine recommends nothing but the naive method would order)."""
    p = Params(**{**result["params"], "include_zero": True})
    full = run(ds, p)
    rows = []
    excess_qty = deficit_qty = excess_money = deficit_money = 0.0
    prices = dict(zip(ds.products["sku"], ds.products.get("unit_price", pd.Series(dtype=float)).fillna(0)))
    for r in full["orders"]:
        nv = max(naive_need(ds, r["sku"], r["warehouse"], r["lead_time_days"] + r["review_days"]), 0.0)
        ours = float(r["recommended_qty"])
        price = float(prices.get(r["sku"], 0.0))
        diff = nv - ours
        if abs(diff) < 1:
            continue
        if diff > 0:
            excess_qty += diff
            excess_money += diff * price
        else:
            deficit_qty += -diff
            deficit_money += -diff * price
        rows.append({"sku": r["sku"], "name": r["name"], "supplier": r["supplier"], "naive_qty": int(round(nv)), "recommended_qty": int(ours), "diff_qty": int(round(diff)), "diff_money": round(diff * price), "reason": "выброс" if r["outliers_excluded"] else "дефицит" if r["lost_demand_qty"] else "сезон/тренд/страховой"})
    rows.sort(key=lambda x: -abs(x["diff_money"]))
    return {
        "positions": len(full["orders"]),
        "positions_differ": len(rows),
        "naive_overorder_qty": int(round(excess_qty)),
        "naive_overorder_money": round(excess_money),
        "naive_underorder_qty": int(round(deficit_qty)),
        "naive_underorder_money": round(deficit_money),
        "note": "Наивный (Excel) расчёт: среднее сырых продаж за последние 90 дней × горизонт − остаток − в пути; без очистки выбросов, компенсации дефицита, сезонности и страхового запаса.",
        "top": rows[:15],
    }
