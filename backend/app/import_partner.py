"""Import the partner's (ТОО «Электрокомплект») 1C exports for IEK and Systeme Electric into the
canonical CSV layout used by the engine (see replenish.Dataset).

Input folders (as provided by the partner):
  IEK/                 MOQ ИЭК.xlsx · Динамика продаж_2025-2026.xlsx · Ежемесячные остатки … ИЭК.xlsx ·
                       Ежемесячные продажи … .xlsx · Путь ИЭК 22.09.2026.xlsx · Сезонность ИЭК.xlsx
  Systeme electric/    MOQ SystemElectric.xlsx · Динамика продаж_… .xlsx · Ежемесячные остатки … .xlsx ·
                       Ежемесячные продажи … .xlsx · Товар в пути_… .xlsx · Сезонность … .xlsx

Usage:
  python -m app.import_partner --iek "/path/IEK" --se "/path/Systeme electric" --out data/partner

What the importer does (documented for the tech review):
  * sales.csv       — every «Расходная накладная» line: date, sku=Код 1С, qty (shipments positive, returns negative),
                      client_id = invoice number (partner data has no client id; one invoice = one customer order,
                      which is what the one-off detection needs), warehouse=Склад, price=0 (IEK) / cost (SE).
                      Months before the first transaction month are back-filled from the monthly sales table,
                      spread evenly over the days of the month (client_id="MONTHLY"), so seasonality can use
                      33 months instead of 21.
  * stock.csv       — IEK: stock at 1 Sep 2026 minus September shipments to date (clipped at 0);
                      SE: «Свободный остаток» from the in-transit workbook (as of 22.09.2026).
  * in_transit.csv  — IEK: each shipment column of «Путь ИЭК», ETA parsed from the header («поступление до dd.mm.yyyy»);
                      SE: «СЭ в пути 24.09», ETA assumed +21 days.
  * stockouts.csv   — months where beginning-of-month stock is 0/empty for an SKU that sells in other months.
  * products.csv    — sku, name, category (SE: «Категория 2026» → SE-1…; IEK: first word of the name),
                      supplier_id, pack_size = MOQ multiplicity, moq, unit_price (SE cost), growth_plan_pct_year=0.
  * suppliers.csv   — IEK (lead time 30 days, from «Путь»: 12–40 days), SE (30 days, assumption, editable).
"""
from __future__ import annotations

import argparse
import calendar
import re
import warnings
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

warnings.filterwarnings("ignore")

TODAY = date(2026, 9, 23)
RU_MONTHS = {"янв": 1, "февр": 2, "март": 3, "апр": 4, "май": 5, "июнь": 6, "июль": 7, "авг": 8, "сент": 9, "окт": 10, "нояб": 11, "дек": 12}
SUPPLIERS = [
    {"supplier_id": "IEK", "supplier": "IEK (ИЭК)", "lead_time_days": 30, "moq": 0, "email": "orders@iek.example"},
    {"supplier_id": "SE", "supplier": "Systeme Electric", "lead_time_days": 30, "moq": 0, "email": "orders@se.example"},
]


def _find(folder: Path, *keywords: str) -> Path:
    for f in sorted(folder.glob("*.xlsx")):
        low = f.name.lower()
        if all(k.lower() in low for k in keywords):
            return f
    raise FileNotFoundError(f"{keywords} in {folder}")


def _month_col(c: str) -> pd.Period | None:
    m = re.match(r"\s*([а-яё]+)\.?\s+(\d{4})", str(c).strip().lower())
    if not m:
        return None
    mon = RU_MONTHS.get(m.group(1)[:4].rstrip("."), RU_MONTHS.get(m.group(1)[:3]))
    return pd.Period(year=int(m.group(2)), month=mon, freq="M") if mon else None


def _clean_sku(x) -> str | None:
    if pd.isna(x):
        return None
    s = str(x).strip()
    return s or None


# ----------------------------------------------------------------------------- readers
def read_sales(path: Path, supplier: str, price_of: dict[str, float]) -> pd.DataFrame:
    d = pd.read_excel(path)
    d = d[d["Документ"].astype(str).str.startswith("Расходная")]
    d["date"] = pd.to_datetime(d["Дата"], dayfirst=True, errors="coerce")
    d = d.dropna(subset=["date"])
    out = pd.DataFrame({
        "date": d["date"].dt.normalize(),
        "sku": d["Код"].map(_clean_sku),
        "qty": pd.to_numeric(d["Количество"], errors="coerce").fillna(0),
        "client_id": d["Номер"].map(lambda x: f"INV-{int(x)}" if pd.notna(x) else "INV-?"),
        "warehouse": d["Склад"].astype(str).str.strip(),
        "unit": d["Ед."].astype(str).str.strip(),
        "supplier_id": supplier,
    }).dropna(subset=["sku"])
    out["price"] = out["sku"].map(price_of).fillna(0.0)
    return out


def read_monthly(path: Path) -> pd.DataFrame:
    """Wide monthly table → long (sku, month, qty)."""
    d = pd.read_excel(path)
    d = d[~d.iloc[:, 0].astype(str).str.strip().isin(["nan", "Итого", ""])]
    code_col = next(c for c in d.columns if "Код" in str(c))
    name_col = next(c for c in d.columns if str(c).startswith("Номенклатура") and "Код" not in str(c))
    months = {c: _month_col(c) for c in d.columns}
    months = {c: p for c, p in months.items() if p is not None}
    long = d.melt(id_vars=[code_col, name_col], value_vars=list(months), var_name="col", value_name="qty")
    long["month"] = long["col"].map(months)
    long["sku"] = long[code_col].map(_clean_sku)
    long["name"] = long[name_col].astype(str).str.strip()
    long["qty"] = pd.to_numeric(long["qty"], errors="coerce").fillna(0)
    return long.dropna(subset=["sku"])[["sku", "name", "month", "qty"]]


def read_stock_monthly(path: Path) -> pd.DataFrame:
    """Beginning-of-month stock, wide → long (sku, month, stock). Handles the 2-row sub-header."""
    d = pd.read_excel(path)
    d = d[~d.iloc[:, 0].astype(str).str.strip().isin(["nan", "Итого", ""])]
    code_col = next(c for c in d.columns if "Код" in str(c))
    months = {c: _month_col(c) for c in d.columns}
    months = {c: p for c, p in months.items() if p is not None}
    long = d.melt(id_vars=[code_col], value_vars=list(months), var_name="col", value_name="stock")
    long["month"] = long["col"].map(months)
    long["sku"] = long[code_col].map(_clean_sku)
    long["stock"] = pd.to_numeric(long["stock"], errors="coerce")
    return long.dropna(subset=["sku"])[["sku", "month", "stock"]]


def read_moq(path: Path) -> pd.DataFrame:
    d = pd.read_excel(path)
    if "Кратность" not in d.columns and "Мин. разр. к отгр." not in d.columns:
        d = pd.read_excel(path, skiprows=[1])
    code_col = next(c for c in d.columns if "Код" in str(c))
    moq_col = "Кратность" if "Кратность" in d.columns else "Мин. разр. к отгр."
    name_col = next((c for c in d.columns if str(c).startswith("Наименование") or str(c).startswith("Номенклатура")), None)
    art_col = next((c for c in d.columns if "Артикул" in str(c)), None)
    out = pd.DataFrame({
        "sku": d[code_col].map(_clean_sku),
        "moq": pd.to_numeric(d[moq_col], errors="coerce").fillna(1).clip(lower=1).astype(int),
        "name": d[name_col].astype(str).str.strip() if name_col else "",
        "article": d[art_col].astype(str).str.strip() if art_col else "",
    })
    return out.dropna(subset=["sku"])


def read_transit_iek(path: Path) -> pd.DataFrame:
    d = pd.read_excel(path)
    code_col = next(c for c in d.columns if "Код" in str(c))
    rows = []
    for c in d.columns[3:]:
        m = re.search(r"поступление до (\d{2})\.(\d{2})\.(\d{4})", str(c))
        if not m:
            continue
        eta = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        q = pd.to_numeric(d[c], errors="coerce").fillna(0)
        for sku, qty in zip(d[code_col].map(_clean_sku), q):
            if sku and qty > 0:
                rows.append({"sku": sku, "warehouse": "Алматы", "qty": float(qty), "eta": eta, "document": str(c).split(" (")[0]})
    return pd.DataFrame(rows)


def read_se_workbook(path: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, float], dict[str, str]]:
    """«Товар в пути_SystemElectric»: free stock, in transit, cost and category per SKU."""
    d = pd.read_excel(path, header=1)
    code_col = next(c for c in d.columns if "Код 1с" in str(c))
    d["sku"] = d[code_col].map(_clean_sku)
    d = d.dropna(subset=["sku"])
    free = pd.to_numeric(d["Свободный остаток"], errors="coerce").fillna(0)
    stock = pd.DataFrame({"sku": d["sku"], "warehouse": "Алматы", "stock": free.clip(lower=0), "as_of": TODAY})
    transit_col = next(c for c in d.columns if "в пути" in str(c))
    tq = pd.to_numeric(d[transit_col], errors="coerce").fillna(0)
    transit = pd.DataFrame({"sku": d["sku"], "warehouse": "Алматы", "qty": tq, "eta": TODAY + timedelta(days=21), "document": transit_col})
    transit = transit[transit["qty"] > 0]
    cost = dict(zip(d["sku"], pd.to_numeric(d["СС реал"], errors="coerce").fillna(0)))
    cat = dict(zip(d["sku"], d["Категория 2026"].map(lambda x: f"SE-кат.{int(x)}" if pd.notna(x) else "SE-без категории")))
    return stock, transit, cost, cat


# ----------------------------------------------------------------------------- build
def backfill_from_monthly(sales: pd.DataFrame, monthly: pd.DataFrame, first_tx_month: pd.Period, supplier: str) -> pd.DataFrame:
    """Months before the transaction history: spread monthly totals evenly over days."""
    rows = []
    early = monthly[(monthly["month"] < first_tx_month) & (monthly["qty"] > 0)]
    for r in early.itertuples():
        y, m = r.month.year, r.month.month
        ndays = calendar.monthrange(y, m)[1]
        per_day = r.qty / ndays
        for day in range(1, ndays + 1):
            rows.append({"date": pd.Timestamp(y, m, day), "sku": r.sku, "qty": per_day, "client_id": "MONTHLY", "warehouse": "Алматы", "unit": "", "supplier_id": supplier, "price": 0.0})
    return pd.concat([sales, pd.DataFrame(rows)], ignore_index=True) if rows else sales


def derive_stockouts(stock_m: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """A month with zero/empty beginning stock, sales ≤ 20 % of the neighbours, for an SKU that sold both in the
    previous and the next month and sells in ≥ 6 months overall, counts as a stockout month."""
    active = monthly.groupby("sku")["qty"].apply(lambda s: (s > 0).sum())
    active = set(active[active >= 6].index)
    sold_by = monthly.set_index(["sku", "month"])["qty"]
    rows = []
    for r in stock_m.itertuples():
        if r.sku not in active or r.month < pd.Period("2024-01", "M") or r.month >= pd.Period(TODAY, "M"):
            continue
        if pd.isna(r.stock) or r.stock <= 0:
            nxt = sold_by.get((r.sku, r.month + 1), 0)
            prv = sold_by.get((r.sku, r.month - 1), 0)
            if prv > 0 and nxt > 0 and sold_by.get((r.sku, r.month), 0) <= 0.2 * max(prv, nxt, 1):
                y, m = r.month.year, r.month.month
                rows.append({"sku": r.sku, "warehouse": "Алматы", "date_from": date(y, m, 1), "date_to": date(y, m, calendar.monthrange(y, m)[1])})
    return pd.DataFrame(rows, columns=["sku", "warehouse", "date_from", "date_to"])


CATEGORY_RULES = [
    ("Автоматы", ["ва47", "ва 47", "ва88", "ва 88", "автомат", "выключатель автомат", "ва-", "ba 47", "ba47"]),
    ("УЗО и дифавтоматы", ["узо", "дифавтомат", "диф.", "ад12", "ад14", "ад-", "вд1", "вд-"]),
    ("Контакторы и пускатели", ["контактор", "пускатель", "кми", "мки", "прк", "пмл", "приставка", "тепловое реле", "ртр"]),
    ("Реле и автоматика", ["реле", "таймер", "фотореле", "термостат", "гигростат", "логическое", "ограничитель", "опс", "уздп", "стабилизатор"]),
    ("Розетки и выключатели", ["роз", "розетк", "выкл", "переключ", "перекл", "диммер", "светорег", "рамка", "brite", "wessen", "atlas", "glossa", "sedna", "unica", "artgallery", "механизм"]),
    ("Светильники", ["светильник", "дво", "дпо", "дсп", "дба", "дпа", "дро", "нпп", "лпо", "жкх", "ночник", "дку", "ду "]),
    ("Лампы и прожекторы", ["лампа", "прожектор", "led ", "лента светодиодная", "лента led", "гирлянда", "патрон", "цоколь"]),
    ("Щиты и корпуса", ["щит", "щрн", "щрв", "щмп", "щу-", "щу ", "бокс", "корпус", "кмпн", "шкаф", "ящик", "щурн", "щурв"]),
    ("Кабель и провод", ["кабель ", "провод", "utp", "ftp", "ввг", "пвс", "шввп", "сип", "кг ", "nym", "пугв", "пв-", "шнур"]),
    ("Кабеленесущие системы", ["кабель-канал", "лоток", "труба", "гофр", "короб", "профиль", "strut", "консоль", "стойка", "кронштейн", "крышка", "угол", "поворот", "заглушка", "перегородка", "т-", "соединитель", "разветвитель"]),
    ("Клеммы и наконечники", ["клемм", "наконечник", "гильза", "зажим", "зви", "зни", "зои", "шина", "колодка", "перемычка", "сизы", "разъем", "разъём", "вилка", "коробка", "установочная"]),
    ("Крепёж и монтаж", ["хомут", "стяжк", "din", "дин-рейк", "дюбель", "анкер", "винт", "гайка", "шайба", "шпилька", "скоба", "бандаж", "маркер", "изолента", "лента", "термоусад", "тут", "площадка", "держатель", "скрепа"]),
    ("Инструмент и измерение", ["инструмент", "клещи", "стриппер", "мультиметр", "тестер", "индикатор", "отвертка", "отвёртка", "нож", "кусачки", "пассатижи", "бокорезы", "тонкогубцы", "ножницы", "пресс", "рулетка", "дальномер", "пирометр", "детектор", "набор", "сумка", "рюкзак", "амперметр", "вольтметр", "трансформатор тока", "тти"]),
    ("Удлинители и переноски", ["удлинитель", "переноска", "переносная", "сетевой фильтр", "фильтр", "разветвитель сетевой"]),
    ("Обогрев и вентиляция", ["обогреватель", "вентилятор", "конвектор", "тепловент"]),
]


def category_from_name(name: str) -> str:
    low = str(name).lower()
    for cat, keys in CATEGORY_RULES:
        if any(k in low for k in keys):
            return cat
    return "Прочее"


def build(iek_dir: Path, se_dir: Path, out: Path) -> dict[str, int]:
    out.mkdir(parents=True, exist_ok=True)
    # --- SE reference workbook (cost, category, free stock, transit)
    se_stock, se_transit, se_cost, se_cat = read_se_workbook(_find(se_dir, "в пути"))
    # --- sales
    iek_sales = read_sales(_find(iek_dir, "динамика"), "IEK", {})
    se_sales = read_sales(_find(se_dir, "динамика"), "SE", se_cost)
    iek_monthly = read_monthly(_find(iek_dir, "ежемесячные продажи"))
    se_monthly = read_monthly(_find(se_dir, "ежемесячные продажи"))
    first_iek = pd.Period(iek_sales.loc[iek_sales["date"] >= "2025-01-01", "date"].min(), "M")
    first_se = pd.Period(se_sales.loc[se_sales["date"] >= "2025-01-01", "date"].min(), "M")
    iek_sales = iek_sales[iek_sales["date"] >= first_iek.start_time]
    se_sales = se_sales[se_sales["date"] >= first_se.start_time]
    iek_sales = backfill_from_monthly(iek_sales, iek_monthly, first_iek, "IEK")
    se_sales = backfill_from_monthly(se_sales, se_monthly, first_se, "SE")
    sales = pd.concat([iek_sales, se_sales], ignore_index=True).sort_values(["date", "sku"])
    # --- stock
    iek_stock_m = read_stock_monthly(_find(iek_dir, "остатки"))
    se_stock_m = read_stock_monthly(_find(se_dir, "остатки"))
    last_p = pd.Period(TODAY, "M")
    iek_last = iek_stock_m[iek_stock_m["month"] == last_p].set_index("sku")["stock"].fillna(0)
    sep_sales = iek_sales[(iek_sales["date"] >= last_p.start_time) & (iek_sales["client_id"] != "MONTHLY")].groupby("sku")["qty"].sum()
    iek_stock = pd.DataFrame({"sku": iek_last.index, "warehouse": "Алматы", "stock": (iek_last - sep_sales.reindex(iek_last.index).fillna(0)).clip(lower=0).values, "as_of": TODAY})
    stock = pd.concat([iek_stock, se_stock], ignore_index=True)
    # --- in transit
    transit = pd.concat([read_transit_iek(_find(iek_dir, "путь")), se_transit], ignore_index=True)
    # --- stockouts
    stockouts = pd.concat([derive_stockouts(iek_stock_m, iek_monthly), derive_stockouts(se_stock_m, se_monthly)], ignore_index=True)
    # --- MOQ / products
    iek_moq = read_moq(_find(iek_dir, "moq")).assign(supplier_id="IEK")
    se_moq = read_moq(_find(se_dir, "moq")).assign(supplier_id="SE")
    moq = pd.concat([iek_moq, se_moq], ignore_index=True).drop_duplicates("sku")
    names = pd.concat([iek_monthly[["sku", "name"]], se_monthly[["sku", "name"]], moq[["sku", "name"]]]).drop_duplicates("sku").set_index("sku")["name"]
    sup_of = {}
    for df, sid in ((iek_sales, "IEK"), (se_sales, "SE"), (iek_moq, "IEK"), (se_moq, "SE"), (iek_stock_m, "IEK"), (se_stock_m, "SE")):
        for s in df["sku"].unique():
            sup_of.setdefault(s, sid)
    skus = sorted(set(sales["sku"]) | set(stock["sku"]) | set(moq["sku"]))
    moq_of = moq.set_index("sku")["moq"]
    art_of = moq.set_index("sku")["article"]
    products = pd.DataFrame({
        "sku": skus,
        "name": [str(names.get(s, "")) for s in skus],
        "category": [se_cat.get(s, category_from_name(names.get(s, ""))) if sup_of.get(s) == "SE" else category_from_name(names.get(s, "")) for s in skus],
        "supplier_id": [sup_of.get(s, "IEK") for s in skus],
        "article": [str(art_of.get(s, "")) for s in skus],
        "pack_size": [int(moq_of.get(s, 1)) for s in skus],
        "moq": [int(moq_of.get(s, 1)) for s in skus],
        "unit_price": [float(se_cost.get(s, 0.0)) for s in skus],
        "growth_plan_pct_year": 0,
    })
    products = products[products["name"] != ""]
    suppliers = pd.DataFrame(SUPPLIERS)

    products.to_csv(out / "products.csv", index=False)
    suppliers.to_csv(out / "suppliers.csv", index=False)
    sales[["date", "sku", "qty", "client_id", "price", "warehouse", "unit", "supplier_id"]].to_csv(out / "sales.csv", index=False)
    stock.to_csv(out / "stock.csv", index=False)
    transit.to_csv(out / "in_transit.csv", index=False)
    stockouts.to_csv(out / "stockouts.csv", index=False)
    return {"products": len(products), "sales_rows": len(sales), "stock": len(stock), "in_transit": len(transit), "stockouts": len(stockouts),
            "sales_from": str(sales["date"].min().date()), "sales_to": str(sales["date"].max().date())}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--iek", required=True)
    ap.add_argument("--se", required=True)
    ap.add_argument("--out", default="data/partner")
    a = ap.parse_args()
    print(build(Path(a.iek), Path(a.se), Path(a.out)))
