"""Media-monitoring agent: collects Kazakh business news (RSS), keeps what matters for electrical-goods procurement and
fills fixed fields. Sources, keywords and the field list are editable by the administrator.

Fields (FIELDS below): date, source, title, url, summary, topic, categories, suppliers, region, direction, strength,
horizon, relevance, action. Extraction: LLM with a strict JSON schema when a key is configured, otherwise keyword rules.
The agent informs the buyer; it does not change the calculation.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

import httpx

NEWS_FILE = Path("data/news.json")
SETTINGS_FILE = Path("data/news_settings.json")

DEFAULT_SOURCES = [
    "https://tengrinews.kz/news.rss",
    "https://kapital.kz/feed",
    "https://lsm.kz/rss",
    "https://profit.kz/rss/",
    "https://www.inform.kz/rss/rus.xml",
]
DEFAULT_KEYWORDS = [
    "строительств", "строител", "ввод жил", "жилищн", "электроэнерг", "электросет", "энергетик", "энергосист", "тариф",
    "курс тенге", "девальвац", "пошлин", "импорт", "логистик", "грузоперевоз", "границ", "хоргос", "таможн",
    "iek", "иэк", "schneider", "systeme electric", "legrand", "кабел", "электротехн", "дефицит", "подорож", "инфляц",
    "госзакуп", "жкх", "модернизац", "капремонт", "девелопер", "застройщик", "ипотек", "медь", "металлопрокат",
]
FIELDS = [
    {"key": "date", "label": "Дата публикации"},
    {"key": "source", "label": "Источник"},
    {"key": "title", "label": "Заголовок"},
    {"key": "url", "label": "Ссылка"},
    {"key": "summary", "label": "Кратко"},
    {"key": "topic", "label": "Тема: строительство, цены и тарифы, курс валют, логистика и границы, поставщики и производители, регулирование, спрос"},
    {"key": "categories", "label": "Затронутые товарные категории"},
    {"key": "suppliers", "label": "Затронутые поставщики и бренды"},
    {"key": "region", "label": "Регион"},
    {"key": "direction", "label": "Влияние: рост спроса, спад спроса, риск поставок, рост цен, нейтрально"},
    {"key": "strength", "label": "Сила влияния, 1–3"},
    {"key": "horizon", "label": "Горизонт: сейчас, 1–3 мес., 3–12 мес."},
    {"key": "relevance", "label": "Релевантность для закупа, 0–1"},
    {"key": "action", "label": "Что сделать закупщику"},
]
TOPIC_RULES = [
    ("курс валют", ["курс", "тенге", "доллар", "рубл", "девальв"]),
    ("логистика и границы", ["границ", "хоргос", "логист", "перевоз", "таможн", "контейнер", "жд ", "железн"]),
    ("цены и тарифы", ["тариф", "цен", "инфляц", "подорож", "пошлин"]),
    ("поставщики и производители", ["iek", "иэк", "schneider", "systeme", "legrand", "завод", "производ"]),
    ("строительство", ["строител", "жиль", "ввод", "застройщ", "девелоп", "ипотек", "ремонт", "модерниз", "жкх"]),
    ("регулирование", ["закон", "постановлен", "минэнерго", "правительств", "госзакуп", "регулир"]),
    ("спрос", ["спрос", "продаж", "потребл"]),
]
CATEGORY_RULES = [
    ("Кабель и провод", ["кабел", "провод", "медь", "медн", "алюмин"]),
    ("Светильники", ["освещ", "светильник", "фонар"]),
    ("Автоматы", ["электрощит", "автомат", "распредел"]),
    ("Щиты и корпуса", ["щит", "подстанц"]),
    ("Розетки и выключатели", ["жиль", "квартир", "ремонт", "отделк"]),
    ("Кабеленесущие системы", ["строител", "объект", "монтаж"]),
]


def settings() -> dict[str, Any]:
    s = {"sources": DEFAULT_SOURCES, "keywords": DEFAULT_KEYWORDS, "fields": FIELDS}
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            s["sources"] = saved.get("sources") or s["sources"]
            s["keywords"] = saved.get("keywords") or s["keywords"]
        except (json.JSONDecodeError, OSError):
            pass
    return s


def save_settings(sources: list[str], keywords: list[str]) -> dict[str, Any]:
    SETTINGS_FILE.parent.mkdir(exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps({"sources": [x.strip() for x in sources if x.strip()], "keywords": [x.strip().lower() for x in keywords if x.strip()]}, ensure_ascii=False, indent=1), encoding="utf-8")
    return settings()


def _text(el: ET.Element | None) -> str:
    return re.sub(r"<[^>]+>", " ", (el.text or "") if el is not None else "").strip()


async def fetch(sources: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    items, errors = [], []
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, headers={"User-Agent": "EKT procurement monitor (prototype)"}) as client:
        for url in sources:
            try:
                r = await client.get(url)
                root = ET.fromstring(r.content)
                src = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
                for it in root.iter("item"):
                    title = _text(it.find("title"))
                    link = _text(it.find("link"))
                    desc = _text(it.find("description"))
                    pub = _text(it.find("pubDate"))
                    try:
                        d = parsedate_to_datetime(pub).date().isoformat() if pub else ""
                    except (TypeError, ValueError):
                        d = pub[:10]
                    if title:
                        items.append({"date": d, "source": src, "title": title, "url": link, "description": re.sub(r"\s+", " ", desc)[:600]})
            except Exception as e:  # noqa: BLE001 — one broken feed must not stop the others
                errors.append(f"{url}: {type(e).__name__}")
    return items, errors


def _rules(item: dict[str, Any]) -> dict[str, Any]:
    low = (item["title"] + " " + item.get("description", "")).lower()
    topic = next((t for t, keys in TOPIC_RULES if any(k in low for k in keys)), "спрос")
    cats = [c for c, keys in CATEGORY_RULES if any(k in low for k in keys)]
    sups = [s for s in ["IEK", "Systeme Electric", "Schneider Electric", "Legrand", "EKF", "ABB"] if s.lower() in low or (s == "IEK" and "иэк" in low)]
    if any(k in low for k in ["рост цен", "подорож", "повыс", "девальв", "ослаб"]):
        direction = "рост цен"
    elif any(k in low for k in ["границ", "задерж", "дефицит", "очеред", "простой", "санкц"]):
        direction = "риск поставок"
    elif any(k in low for k in ["ввод", "строител", "рост", "увелич", "модерниз", "программ"]):
        direction = "рост спроса"
    elif any(k in low for k in ["снижен", "спад", "сократ", "упал"]):
        direction = "спад спроса"
    else:
        direction = "нейтрально"
    strength = 3 if any(k in low for k in ["резко", "значител", "рекорд", "вдвое", "в разы"]) else 2 if direction != "нейтрально" else 1
    region = next((r for r in ["Алматы", "Астана", "Шымкент", "Караганд", "Актобе", "Атырау"] if r.lower() in low), "Казахстан")
    actions = {
        "рост цен": "проверить прайс поставщиков, при необходимости закупить заранее позиции с высоким оборотом",
        "риск поставок": "увеличить страховой запас по позициям с долгим сроком поставки, уточнить сроки у поставщиков",
        "рост спроса": "следить за продажами затронутых категорий, учесть в плановом приросте",
        "спад спроса": "не наращивать запасы затронутых категорий",
        "нейтрально": "информировать",
    }
    kw_hits = sum(1 for k in settings()["keywords"] if k in low)
    return {
        "topic": topic,
        "categories": cats,
        "suppliers": sups,
        "region": region,
        "direction": direction,
        "strength": strength,
        "horizon": "сейчас" if direction in ("риск поставок", "рост цен") else "1–3 мес.",
        "relevance": round(min(1.0, 0.2 + 0.15 * kw_hits + (0.2 if cats or sups else 0)), 2),
        "action": actions[direction],
        "summary": item.get("description", "")[:240] or item["title"],
    }


async def _llm(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from .llm import chat

    listing = "\n".join(f"[{k}] {it['date']} {it['source']}: {it['title']}. {it.get('description', '')[:300]}" for k, it in enumerate(items))
    schema = {f["key"]: f["label"] for f in FIELDS if f["key"] not in ("date", "source", "title", "url")}
    prompt = (
        "Ты агент мониторинга СМИ для отдела закупа дистрибьютора электротоваров в Казахстане (поставщики IEK, Systeme Electric). "
        "Для каждой новости заполни поля и верни JSON {\"items\": [{\"index\": int, ...поля}]}. Поля: " + json.dumps(schema, ensure_ascii=False) + ". "
        "Если новость не влияет на спрос, цены или поставки электротоваров, ставь relevance ниже 0.3 и direction «нейтрально». "
        "categories и suppliers — массивы строк; strength — 1, 2 или 3; relevance — число 0..1. Не придумывай фактов, которых нет в тексте.\n\nНовости:\n" + listing
    )
    raw = await chat([{"role": "user", "content": prompt}], response_format={"type": "json_object"})
    return json.loads(raw).get("items", [])


async def run_agent(use_llm: bool, max_items: int = 30) -> dict[str, Any]:
    cfg = settings()
    steps = []
    t0 = time.perf_counter()
    items, errors = await fetch(cfg["sources"])
    steps.append({"tool": "fetch_feeds", "label": "Сбор новостных лент", "summary": f"источников: {len(cfg['sources'])}, новостей: {len(items)}" + (f"; недоступно: {len(errors)}" if errors else ""), "ms": int((time.perf_counter() - t0) * 1000)})
    t0 = time.perf_counter()
    pats = [re.compile(r"(?<![а-яёa-z])" + re.escape(k)) for k in cfg["keywords"]]

    def hits(it: dict[str, Any]) -> int:
        text = (it["title"] + " " + it.get("description", "")).lower()
        return sum(1 for p in pats if p.search(text))

    seen: set[str] = set()
    relevant = []
    for it in sorted(items, key=hits, reverse=True):
        if hits(it) == 0 or it["title"] in seen:
            continue
        seen.add(it["title"])
        relevant.append(it)
    relevant = relevant[:max_items]
    steps.append({"tool": "filter_keywords", "label": "Отбор по ключевым словам", "summary": f"релевантных закупу: {len(relevant)} из {len(items)}", "ms": int((time.perf_counter() - t0) * 1000)})
    t0 = time.perf_counter()
    by = "правила"
    enriched: dict[int, dict[str, Any]] = {}
    if use_llm and relevant:
        try:
            for r in await _llm(relevant):
                if isinstance(r, dict) and 0 <= int(r.get("index", -1)) < len(relevant):
                    enriched[int(r["index"])] = r
            by = "LLM"
        except Exception as e:  # noqa: BLE001
            steps.append({"tool": "extract_llm", "label": "Заполнение полей моделью", "summary": f"модель недоступна ({type(e).__name__}), используются правила", "ms": 0})
    rows = []
    for k, it in enumerate(relevant):
        base = _rules(it)
        llm = enriched.get(k, {})
        row = {**base, **{f: llm[f] for f in base if f in llm and llm[f] not in (None, "")}}
        row.update({"id": hashlib.sha1((it["url"] or it["title"]).encode()).hexdigest()[:10], "date": it["date"], "source": it["source"], "title": it["title"], "url": it["url"], "extracted_by": "LLM" if k in enriched else "правила"})
        rows.append(row)
    steps.append({"tool": "extract_fields", "label": "Заполнение полей", "summary": f"заполнено записей: {len(rows)} ({by}); полей в записи: {len(FIELDS)}", "ms": int((time.perf_counter() - t0) * 1000)})
    dropped = [r for r in rows if float(r.get("relevance") or 0) < 0.35 and r.get("direction") == "нейтрально"]
    rows = [r for r in rows if r not in dropped]
    if dropped:
        steps.append({"tool": "drop_irrelevant", "label": "Отсев нерелевантного", "summary": f"отброшено: {len(dropped)} (не влияют на спрос, цены или поставки)", "ms": 0})
    saved = merge_save(rows)
    steps.append({"tool": "save", "label": "Сохранение в журнал мониторинга", "summary": f"всего записей: {len(saved)}", "ms": 0})
    return {"items": rows, "total": len(saved), "steps": steps, "errors": errors, "extracted_by": by}


def load() -> list[dict[str, Any]]:
    if NEWS_FILE.exists():
        try:
            return json.loads(NEWS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
    return []


def merge_save(new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cur = {n["id"]: n for n in load()}
    for n in new:
        cur[n["id"]] = n
    rows = sorted(cur.values(), key=lambda n: (n.get("date") or "", n["id"]), reverse=True)[:500]
    NEWS_FILE.parent.mkdir(exist_ok=True)
    NEWS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    return rows
