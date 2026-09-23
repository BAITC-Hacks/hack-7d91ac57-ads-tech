"""Synthetic dataset generator with realistic structure (allowed by the case brief).

Produces CSVs in the layout of a 1C export:
  products.csv   sku,name,category,supplier_id,pack_size,unit_price,growth_plan_pct_year
  suppliers.csv  supplier_id,supplier,lead_time_days,moq,email
  sales.csv      date,sku,qty,client_id,price,warehouse
  stock.csv      sku,warehouse,stock,as_of
  in_transit.csv sku,warehouse,qty,eta
  stockouts.csv  sku,warehouse,date_from,date_to

Built-in "ground truth" (seasonality, growth, stockouts, one-off orders) is what the
engine must recover; tests rely on the seed.
"""
from __future__ import annotations

import math
import random
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 42
START = date(2024, 9, 1)
END = date(2026, 8, 31)  # 24 full months
TODAY = date(2026, 9, 1)

CATEGORIES = {
    # name: (12 monthly seasonal factors Jan..Dec, service level, growth plan %/year)
    "Кабель": ([0.75, 0.8, 0.95, 1.1, 1.2, 1.25, 1.25, 1.2, 1.1, 0.95, 0.75, 0.7], 0.95, 8),
    "Освещение": ([1.1, 1.0, 0.9, 0.8, 0.75, 0.7, 0.75, 0.9, 1.15, 1.3, 1.35, 1.3], 0.95, 12),
    "Автоматика": ([0.95, 0.95, 1.0, 1.05, 1.05, 1.05, 1.0, 1.0, 1.0, 1.0, 0.95, 1.0], 0.98, 5),
    "Розетки и выключатели": ([0.9, 0.9, 1.0, 1.1, 1.1, 1.1, 1.05, 1.05, 1.0, 1.0, 0.9, 0.9], 0.95, 6),
    "Щиты и корпуса": ([0.85, 0.9, 1.05, 1.15, 1.15, 1.15, 1.1, 1.05, 1.0, 0.95, 0.85, 0.8], 0.9, 4),
    "Инструмент": ([1.0, 0.95, 1.0, 1.05, 1.05, 1.0, 1.0, 1.0, 1.0, 1.05, 1.0, 0.9], 0.9, 3),
}

SUPPLIERS = [
    ("S1", "ТОО Кабельный дом", 14, 100, "orders@kabeldom.kz"),
    ("S2", "IEK Central Asia", 21, 50, "kz@iek.example"),
    ("S3", "Schneider Electric KZ", 30, 20, "orders@se.example"),
    ("S4", "Legrand Дистрибуция", 28, 24, "dist@legrand.example"),
    ("S5", "ЭлектроСклад Алматы", 7, 10, "sales@elsklad.kz"),
    ("S6", "Guangzhou Lighting Co.", 45, 200, "export@gzlight.example"),
]

NAMES = {
    "Кабель": ["ВВГнг-LS 3x1.5", "ВВГнг-LS 3x2.5", "ВВГнг-LS 3x4", "ПВС 2x1.5", "ПВС 3x2.5", "NYM 3x1.5", "АВВГ 4x16", "КГ 3x2.5", "СИП-4 4x16", "UTP cat5e", "ШВВП 2x0.75", "ВВГнг 5x6"],
    "Освещение": ["Лампа LED A60 10W E27", "Лампа LED A60 15W E27", "Лампа LED C37 7W E14", "Прожектор LED 50W", "Прожектор LED 100W", "Светильник ДВО 36W", "Светильник ЖКХ 12W", "Лента LED 12V 4.8W/m", "Гирлянда уличная 10м", "Датчик движения ДД-008", "Лампа ДРЛ 250", "Светильник NLED 24W"],
    "Автоматика": ["Автомат ВА47-29 1P 16A", "Автомат ВА47-29 1P 25A", "Автомат ВА47-29 3P 32A", "УЗО ВД1-63 2P 40A 30mA", "Дифавтомат АД12 16A", "Контактор КМИ-11210", "Реле напряжения РН-113", "Пускатель ПМЛ-1220", "Таймер ТЭ15", "Автомат ВА88-32 100A", "Рубильник ВР32", "Шина нулевая 6x9"],
    "Розетки и выключатели": ["Розетка с/з Schneider Sedna", "Выключатель 1кл Sedna", "Выключатель 2кл Sedna", "Розетка о/у IP54", "Рамка 1-пост белая", "Рамка 2-пост белая", "Розетка Legrand Valena", "Выключатель Legrand Valena", "Розетка USB 2x2.1A", "Диммер 400W", "Розетка компьютерная RJ45", "Выключатель проходной"],
    "Щиты и корпуса": ["Щит ЩРН-12 металл", "Щит ЩРН-24 металл", "Бокс ЩРН-П-12 пластик", "Бокс ЩРН-П-36 пластик", "Корпус КМПн 2/4", "Щит учёта ЩУ-1", "Шкаф ЩМП-1", "Шкаф ЩМП-3", "DIN-рейка 1м", "Кабель-канал 40x25", "Кабель-канал 100x60", "Гофра ПВХ 20мм"],
    "Инструмент": ["Клещи обжимные КО-04", "Стриппер WS-04", "Мультиметр DT-838", "Индикатор напряжения", "Набор отвёрток VDE", "Нож монтажный", "Кусачки 160мм", "Изолента ПВХ синяя", "Изолента ПВХ чёрная", "Хомут нейлон 200мм (100шт)", "Термоусадка 6/3", "Перфоратор SDS+"],
}

SUPPLIER_FOR_CAT = {
    "Кабель": ["S1", "S5"],
    "Освещение": ["S6", "S2", "S5"],
    "Автоматика": ["S2", "S3"],
    "Розетки и выключатели": ["S3", "S4"],
    "Щиты и корпуса": ["S2", "S5"],
    "Инструмент": ["S5", "S2"],
}


def _months_between(d0: date, d1: date) -> float:
    return (d1.year - d0.year) * 12 + (d1.month - d0.month) + (d1.day - d0.day) / 30.0


def generate(out_dir: Path, seed: int = SEED) -> dict[str, int]:
    rng = np.random.default_rng(seed)
    random.seed(seed)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ---- products
    products = []
    truth = {}  # sku -> dict(base, growth, season)
    i = 0
    for cat, (season, _sl, plan) in CATEGORIES.items():
        prefix = {"Кабель": "KBL", "Освещение": "LMP", "Автоматика": "AUT", "Розетки и выключатели": "SCK", "Щиты и корпуса": "BOX", "Инструмент": "TLS"}[cat]
        for j, name in enumerate(NAMES[cat]):
            sku = f"{prefix}-{j + 1:03d}"
            base = float(np.exp(rng.uniform(np.log(2), np.log(45))))  # units/day
            growth = float(rng.choice([0.0, 0.0, 0.01, 0.02, 0.03, -0.01], p=[0.35, 0.15, 0.2, 0.15, 0.1, 0.05]))
            pack = int(rng.choice([1, 1, 5, 10, 20, 100] if cat != "Кабель" else [100, 100, 200]))
            price = round(float(np.exp(rng.uniform(np.log(120), np.log(900)))), 2) if cat == "Кабель" else round(float(np.exp(rng.uniform(np.log(300), np.log(45000)))), 2)
            supplier = rng.choice(SUPPLIER_FOR_CAT[cat])
            products.append({"sku": sku, "name": name, "category": cat, "supplier_id": supplier, "pack_size": pack, "unit_price": price, "growth_plan_pct_year": plan})
            truth[sku] = {"base": base, "growth": growth, "season": season, "pack": pack, "cat": cat}
            i += 1
    products_df = pd.DataFrame(products)

    suppliers_df = pd.DataFrame(SUPPLIERS, columns=["supplier_id", "supplier", "lead_time_days", "moq", "email"])

    # ---- stockouts and one-off orders (ground truth)
    skus = list(truth)
    stockout_skus = list(rng.choice(skus, 12, replace=False))
    outlier_skus = list(rng.choice([s for s in skus if s not in stockout_skus], 8, replace=False))
    stockouts = []
    for s in stockout_skus:
        n = int(rng.integers(1, 3))
        for _ in range(n):
            start = START + timedelta(days=int(rng.integers(60, (END - START).days - 40)))
            length = int(rng.integers(5, 15))
            stockouts.append({"sku": s, "warehouse": "Главный", "date_from": start, "date_to": start + timedelta(days=length - 1)})
    stockouts_df = pd.DataFrame(stockouts)
    stockout_days: dict[str, set[date]] = {}
    for r in stockouts:
        d = r["date_from"]
        while d <= r["date_to"]:
            stockout_days.setdefault(r["sku"], set()).add(d)
            d += timedelta(days=1)

    oneoffs = []
    for s in outlier_skus:
        n = int(rng.integers(1, 3))
        for _ in range(n):
            d = START + timedelta(days=int(rng.integers(90, (END - START).days - 20)))
            mult = float(rng.uniform(12, 30))
            oneoffs.append((s, d, mult, f"C{int(rng.integers(150, 200)):03d}"))

    # ---- sales
    clients = [f"C{k:03d}" for k in range(1, 201)]
    client_w = 1 / (np.arange(1, 201) ** 0.8)
    client_w /= client_w.sum()
    weekday_f = [1.05, 1.1, 1.1, 1.05, 1.0, 0.45, 0.25]
    rows = []
    price_of = dict(zip(products_df["sku"], products_df["unit_price"]))
    wh_share = {"Главный": 1.0, "Филиал Алматы": 0.3}
    branch_skus = set(rng.choice(skus, 30, replace=False))
    d = START
    while d <= END:
        m = _months_between(START, d)
        for s in skus:
            t = truth[s]
            unit_mult = t["pack"] if t["cat"] == "Кабель" else 1  # cable sold in metres, ~pack per typical order
            lam = t["base"] * unit_mult * t["season"][d.month - 1] * ((1 + t["growth"]) ** m) * weekday_f[d.weekday()]
            for wh, share in wh_share.items():
                if wh != "Главный" and s not in branch_skus:
                    continue
                if wh == "Главный" and d in stockout_days.get(s, set()):
                    continue
                qty = int(rng.poisson(lam * share))
                if qty <= 0:
                    continue
                n_tx = max(1, min(4, int(rng.poisson(1.5))))
                parts = np.maximum(1, np.round(rng.dirichlet(np.ones(n_tx)) * qty)).astype(int)
                for q in parts:
                    rows.append({"date": d, "sku": s, "qty": int(q), "client_id": str(rng.choice(clients, p=client_w)), "price": price_of[s], "warehouse": wh})
        d += timedelta(days=1)
    sales_df = pd.DataFrame(rows)
    # inject one-off big orders (tenders) to a single client
    for s, dd, mult, client in oneoffs:
        t = truth[s]
        med = t["base"] * (t["pack"] if t["cat"] == "Кабель" else 1)
        q = int(round(med * mult / (t["pack"] if t["cat"] == "Кабель" else 1))) * (t["pack"] if t["cat"] == "Кабель" else 1)
        price = float(products_df.loc[products_df.sku == s, "unit_price"].iloc[0])
        sales_df = pd.concat([sales_df, pd.DataFrame([{"date": dd, "sku": s, "qty": max(q, 1), "client_id": client, "price": price, "warehouse": "Главный"}])], ignore_index=True)
    sales_df = sales_df.sort_values(["date", "sku"]).reset_index(drop=True)

    # ---- stock and in-transit as of TODAY
    stock_rows, transit_rows = [], []
    transit_skus = set(rng.choice(skus, 12, replace=False))
    for s in skus:
        t = truth[s]
        mult = t["pack"] if t["cat"] == "Кабель" else 1
        daily = t["base"] * mult * ((1 + t["growth"]) ** 24) * t["season"][TODAY.month - 1]
        cover = float(rng.uniform(3, 60))
        stock_rows.append({"sku": s, "warehouse": "Главный", "stock": int(daily * cover), "as_of": TODAY})
        if s in branch_skus:
            stock_rows.append({"sku": s, "warehouse": "Филиал Алматы", "stock": int(daily * 0.3 * rng.uniform(5, 50)), "as_of": TODAY})
        if s in transit_skus:
            transit_rows.append({"sku": s, "warehouse": "Главный", "qty": int(daily * rng.uniform(7, 25)), "eta": TODAY + timedelta(days=int(rng.integers(3, 20)))})
    stock_df = pd.DataFrame(stock_rows)
    transit_df = pd.DataFrame(transit_rows)

    products_df.to_csv(out_dir / "products.csv", index=False)
    suppliers_df.to_csv(out_dir / "suppliers.csv", index=False)
    sales_df.to_csv(out_dir / "sales.csv", index=False)
    stock_df.to_csv(out_dir / "stock.csv", index=False)
    transit_df.to_csv(out_dir / "in_transit.csv", index=False)
    stockouts_df.to_csv(out_dir / "stockouts.csv", index=False)
    pd.DataFrame([{"sku": s, "date": dd, "client_id": c, "multiplier": round(m, 1)} for s, dd, m, c in oneoffs]).to_csv(out_dir / "_truth_oneoffs.csv", index=False)
    return {"products": len(products_df), "sales": len(sales_df), "stockouts": len(stockouts_df), "in_transit": len(transit_df), "stock": len(stock_df)}


if __name__ == "__main__":
    import sys

    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data/sample")
    print(generate(out))
