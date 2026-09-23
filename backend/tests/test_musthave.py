"""Acceptance tests mirroring the 5 must-have checks from the case brief (ТОО «Электрокомплект»)."""
from datetime import timedelta
from pathlib import Path

import pandas as pd
import pytest

from app.replenish import Dataset, Params, compute_sku, run

DATA = Path(__file__).resolve().parent.parent / "data" / "sample"


@pytest.fixture(scope="module")
def ds() -> Dataset:
    return Dataset.load(DATA)


def _rec(ds, sku, wh="Главный", **ov):
    r = compute_sku(ds, sku, wh, Params(warehouse=wh), overrides=ov or None)
    r.pop("_series", None)
    return r


# 1. базовая потребность учитывает все источники: изменение любого меняет результат
def test_all_inputs_matter(ds):
    sku = "KBL-002"
    base = _rec(ds, sku)
    assert base["forecast_period_qty"] > 0
    # товары в пути
    more_transit = _rec(ds, sku, in_transit=base["in_transit"] + 500)
    assert more_transit["raw_need"] == pytest.approx(base["raw_need"] - 500, abs=0.5)
    # остатки
    more_stock = _rec(ds, sku, stock=base["stock"] + 300)
    assert more_stock["raw_need"] == pytest.approx(base["raw_need"] - 300, abs=0.5)
    # срок поставки (справочник поставщиков)
    longer = _rec(ds, sku, lead_time_days=base["lead_time_days"] + 14)
    assert longer["forecast_period_qty"] > base["forecast_period_qty"]
    # прогноз по приросту (план категории)
    ds2 = Dataset.load(DATA)
    ds2.products.loc[ds2.products["sku"] == sku, "growth_plan_pct_year"] = 60
    plan = _rec(ds2, sku)
    assert plan["forecast_period_qty"] > base["forecast_period_qty"]
    # история продаж
    ds3 = Dataset.load(DATA)
    ds3.sales = ds3.sales[~((ds3.sales["sku"] == sku) & (ds3.sales["date"] >= ds3.sales["date"].max() - pd.Timedelta(days=120)))]
    fewer_sales = _rec(ds3, sku)
    assert fewer_sales["forecast_period_qty"] != base["forecast_period_qty"]
    # категории: фильтр расчёта и уровень сервиса по категории
    res = run(ds, Params(warehouse="Главный", category="Автоматика"))
    assert res["orders"] and all(o["category"] == "Автоматика" for o in res["orders"])
    assert all(o["service_level"] == 0.98 for o in res["orders"])


# 2. сезонность и устойчивый рост: прогноз отражает сезонный паттерн, а не среднее
def test_seasonality_and_growth(ds):
    r = compute_sku(ds, "LMP-001", "Главный", Params())
    idx = r["_series"]["seasonal_index"]
    assert idx[11] > 1.15 and idx[6] < 0.85, idx  # освещение: пик ноябрь, провал июнь
    assert idx[11] / idx[6] > 1.4
    # прогноз на ноябрь выше прогноза на июнь при том же уровне
    from app.replenish import forecast_horizon
    from datetime import date
    lm = r["_series"]["last_month"]
    nov, _ = forecast_horizon(date(2026, 11, 1), 30, r["_series"]["level"], 0.0, idx, lm)
    jun, _ = forecast_horizon(date(2027, 6, 1), 30, r["_series"]["level"], 0.0, idx, lm)
    assert nov > jun * 1.3
    # устойчивый рост: артикул с трендом в синтетике даёт положительный тренд
    grown = [s for s in ds.products["sku"] if compute_sku(ds, s, "Главный", Params())["trend_pct_month"] > 0.8]
    assert len(grown) >= 3, "ожидались артикулы с устойчивым ростом"


# 3. упущенный спрос в stockout: потребность скорректирована вверх относительно сырых продаж
def test_stockout_compensation(ds):
    so = ds.stockouts.iloc[0]
    sku, wh = so["sku"], so["warehouse"]
    with_so = _rec(ds, sku, wh)
    assert with_so["lost_demand_qty"] > 0 and with_so["stockout_days"] > 0
    ds_raw = Dataset.load(DATA)
    ds_raw.stockouts = ds_raw.stockouts.iloc[0:0]
    raw = _rec(ds_raw, sku, wh)
    assert with_so["forecast_period_qty"] > raw["forecast_period_qty"]


# 4. разовые крупные заказы (в т.ч. одному клиенту) исключаются из регулярной потребности
def test_outlier_excluded(ds):
    truth = pd.read_csv(DATA / "_truth_oneoffs.csv")
    clean_skus = [s for s in ds.products["sku"] if s not in set(truth["sku"]) and s not in set(ds.stockouts["sku"])]
    sku = clean_skus[0]
    base = _rec(ds, sku)
    assert base["outliers_excluded"] == 0
    ds2 = Dataset.load(DATA)
    tx = ds2.sales[(ds2.sales["sku"] == sku) & (ds2.sales["warehouse"] == "Главный")]
    med_daily = tx.groupby("date")["qty"].sum().median()
    big = pd.DataFrame([{"date": ds2.sales["date"].max() - pd.Timedelta(days=20), "sku": sku, "qty": int(med_daily * 40), "client_id": "C999", "price": 100.0, "warehouse": "Главный"}])
    ds2.sales = pd.concat([ds2.sales, big], ignore_index=True)
    injected = _rec(ds2, sku)
    assert injected["outliers_excluded"] >= 1
    assert injected["forecast_period_qty"] <= base["forecast_period_qty"] * 1.10, (base["forecast_period_qty"], injected["forecast_period_qty"])
    # для сравнения: наивное среднее выросло бы заметно
    naive_base = tx["qty"].sum() / 730
    naive_inj = (tx["qty"].sum() + med_daily * 40) / 730
    assert naive_inj / naive_base > 1.03


# 5. список по поставщикам с обоснованием каждой строки
def test_grouped_with_justification(ds):
    res = run(ds, Params(warehouse="Главный"))
    assert res["summary"]["positions"] > 10
    assert res["suppliers"], "нет группировки по поставщикам"
    for sup in res["suppliers"]:
        assert sup["positions"] == len(sup["orders"])
        assert all(o["supplier_id"] == sup["supplier_id"] for o in sup["orders"])
    for o in res["orders"]:
        assert o["justification"] and any(ch.isdigit() for ch in o["justification"])
        assert "прогноз" in o["justification"] and "остаток" in o["justification"]
        assert o["urgency"] in {"critical", "high", "normal"}
        assert o["recommended_qty"] % o["pack_size"] == 0
        assert o["recommended_qty"] >= o["moq"]


# ограничение ТЗ: заказ не отправляется автоматически
def test_no_auto_send():
    import inspect

    from app import main

    src = inspect.getsource(main)
    assert "smtplib" not in src and "sent\": False" in src or '"sent": False' in src
