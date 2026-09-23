"""Sales-signals agent: reads sales managers' chats (Telegram JSON export, WhatsApp .txt export, Bitrix24 chat CSV/JSON
or pasted text), extracts demand signals into fixed fields, links them to SKUs and anonymises clients.

Fields of a signal: date, channel, manager, client (hash only), type, product_text, sku, sku_name, category, qty,
expected_month, probability, weighted_qty, quote (client names redacted), extracted_by.
Types: «крупный разовый заказ», «регулярный рост», «снижение или отказ», «перенос сроков», «цены и условия поставщика»,
«проблема у поставщика», «другое».

Extraction: an LLM with a strict JSON schema when a key is configured, otherwise transparent rules. Either way the
numbers come from the message text; the agent never invents quantities. Signals do not change the regular demand
(the brief requires excluding one-off orders); they can be added to the order explicitly («учитывать сигналы»).
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any

SIGNALS_FILE = Path("data/signals.json")
TYPES = ["крупный разовый заказ", "регулярный рост", "снижение или отказ", "перенос сроков", "цены и условия поставщика", "проблема у поставщика", "другое"]
MONTHS = {"январ": 1, "феврал": 2, "март": 3, "апрел": 4, "ма": 5, "июн": 6, "июл": 7, "август": 8, "сентябр": 9, "октябр": 10, "ноябр": 11, "декабр": 12}
CLIENT_RE = re.compile(r"((?:ТОО|ИП|АО|ТДО|ПК)\s*[«\"][^»\"]{2,60}[»\"]|(?:ТОО|ИП|АО)\s+[A-ZА-ЯЁ][\w\-]+(?:\s+[A-ZА-ЯЁ][\w\-]+)?)")


# ------------------------------------------------------------------ parsing chat exports
def parse_chat(filename: str, data: bytes, channel_hint: str | None = None) -> list[dict[str, Any]]:
    name = (filename or "").lower()
    text = data.decode("utf-8-sig", errors="ignore")
    msgs: list[dict[str, Any]] = []
    if name.endswith(".json"):
        obj = json.loads(text)
        if isinstance(obj, dict) and "messages" in obj:  # Telegram Desktop export
            for m in obj["messages"]:
                t = m.get("text", "")
                if isinstance(t, list):
                    t = "".join(p if isinstance(p, str) else p.get("text", "") for p in t)
                if t:
                    msgs.append({"date": str(m.get("date", ""))[:10], "channel": channel_hint or "Telegram", "author": m.get("from") or "", "text": t})
        elif isinstance(obj, list):  # Bitrix24 / generic JSON: [{date, author, message}]
            for m in obj:
                t = m.get("message") or m.get("text") or m.get("MESSAGE") or ""
                if t:
                    msgs.append({"date": str(m.get("date") or m.get("DATE") or "")[:10], "channel": channel_hint or "Bitrix24", "author": m.get("author") or m.get("AUTHOR") or "", "text": t})
    elif name.endswith(".csv"):
        sample = text.splitlines()[0] if text else ""
        rows = csv.DictReader(io.StringIO(text), delimiter=";" if sample.count(";") > sample.count(",") else ",")
        for r in rows:
            low = {k.strip().lower(): v for k, v in r.items() if k}
            t = low.get("message") or low.get("сообщение") or low.get("text") or low.get("текст") or ""
            if t:
                msgs.append({"date": (low.get("date") or low.get("дата") or "")[:10], "channel": channel_hint or "Bitrix24", "author": low.get("author") or low.get("автор") or "", "text": t})
    else:  # WhatsApp export «10.09.2026, 12:00 - Айдос: текст» or plain lines
        wa = re.compile(r"^\[?(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+\d{1,2}:\d{2}(?::\d{2})?\]?\s*[-–]?\s*([^:]{1,60}):\s*(.+)$")
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            m = wa.match(line)
            if m:
                d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
                y = y + 2000 if y < 100 else y
                msgs.append({"date": f"{y:04d}-{mo:02d}-{d:02d}", "channel": channel_hint or "WhatsApp", "author": m.group(4).strip(), "text": m.group(5).strip()})
            else:
                msgs.append({"date": "", "channel": channel_hint or "текст", "author": "", "text": line})
    return msgs


# ------------------------------------------------------------------ helpers
def client_hash(name: str) -> str:
    return "Клиент-" + hashlib.sha1(name.strip().lower().encode()).hexdigest()[:6]


def redact(text: str) -> tuple[str, str | None]:
    """Replace company names with a stable hash label; returns (redacted text, client label or None)."""
    found = CLIENT_RE.search(text)
    label = client_hash(found.group(0)) if found else None
    return CLIENT_RE.sub(lambda m: client_hash(m.group(0)), text), label


def _month(text: str, msg_date: str) -> str | None:
    low = text.lower()
    base = datetime.strptime(msg_date, "%Y-%m-%d").date() if re.match(r"\d{4}-\d{2}-\d{2}", msg_date or "") else date.today()
    if "следующем месяце" in low or "в след. месяце" in low:
        m = base.month % 12 + 1
        return f"{base.year + (1 if m == 1 else 0)}-{m:02d}"
    for stem, m in MONTHS.items():
        if re.search(rf"\b(?:в|к|до|на)\s+{stem}\w*", low) or re.search(rf"\b{stem}\w*\s+(?:месяц|20\d\d)", low):
            y = base.year + (1 if m < base.month else 0)
            return f"{y}-{m:02d}"
    return None


def _type(text: str) -> str:
    low = text.lower()
    rules = [
        ("проблема у поставщика", ["нет в наличии у поставщика", "задерж", "срыв поставки", "поставщик не", "дефицит у"]),
        ("цены и условия поставщика", ["подорожа", "повыш", "цены", "прайс", "скидк", "условия оплаты"]),
        ("перенос сроков", ["перенос", "отложил", "сдвинул"]),
        ("снижение или отказ", ["отказ", "не будут брать", "ушли к конкурент", "снизил", "меньше брать"]),
        ("крупный разовый заказ", ["тендер", "объект", "проект", "разово", "крупн", "под стройку", "заяв", "застройщ", "под школу", "договор"]),
        ("регулярный рост", ["растёт", "растет", "рост", "увелич", "больше берут", "каждый месяц", "ежемесячно"]),
    ]
    for t, keys in rules:
        if any(k in low for k in keys):
            return t
    return "другое"


def _probability(text: str) -> float:
    low = text.lower()
    if any(k in low for k in ["подписали", "оплатил", "точно", "согласовали", "договор"]):
        return 0.9
    if any(k in low for k in ["планиру", "скорее всего", "собираются", "готовят"]):
        return 0.6
    if any(k in low for k in ["возможно", "думают", "может быть", "рассматрива"]):
        return 0.3
    return 0.5


QTY_RE = re.compile(r"(\d[\d\s]{0,8})\s*(шт|штук|м\b|метр|упак|бухт|компл)", re.I)


def _qty(text: str) -> float | None:
    m = QTY_RE.search(text)
    if not m:
        return None
    try:
        return float(m.group(1).replace(" ", "").replace(" ", ""))
    except ValueError:
        return None


_LOOKALIKE = str.maketrans("авекмнорстух", "abekmhopctyx")  # Cyrillic → Latin lookalikes, applied to both sides


def _tokens(s: str) -> set[str]:
    return {t.translate(_LOOKALIKE) for t in re.findall(r"[\w\-.]+", (s or "").lower()) if len(t) >= 2}


def _spec(tokens: set[str]) -> set[str]:
    """Technical tokens that must agree: letters+digits (25a, 1p, 36w) or sizes (3x2.5); bare quantities are ignored."""
    return {t for t in tokens if re.search(r"\d", t) and re.search(r"[a-z]", t) or re.fullmatch(r"\d+x\d+(\.\d+)?", t)}


def link_sku(product_text: str, products) -> tuple[str | None, str | None, str | None]:
    """Return (sku, name, category) by 1C code, supplier article, or the best name-token overlap."""
    if not product_text:
        return None, None, None
    code = re.search(r"\b\d{9}_?", product_text)
    skus = set(products["sku"])
    if code:
        c = code.group(0) if code.group(0) in skus else code.group(0).rstrip("_") + "_"
        if c in skus:
            row = products[products["sku"] == c].iloc[0]
            return c, str(row["name"]), str(row["category"])
    alpha = re.search(r"\b[A-Z]{2,4}-\d{3}\b", product_text)  # sample dataset codes like LMP-006
    if alpha and alpha.group(0) in skus:
        row = products[products["sku"] == alpha.group(0)].iloc[0]
        return alpha.group(0), str(row["name"]), str(row["category"])
    q = _tokens(product_text)
    if not q:
        return None, None, None
    spec = _spec(q)
    best, best_score = None, 0.0
    for r in products.itertuples():
        nt = _tokens(r.name)
        inter = q & nt
        if len(inter) < 2 or (spec & _spec(nt)) != (spec & (spec | _spec(nt))) and not spec <= nt:
            continue
        if spec and not spec <= nt:
            continue  # every technical token from the message must be in the name (25А, 1P, 3x2.5 …)
        score = len(inter) + 0.5 * len(spec & nt)
        if score > best_score:
            best, best_score = r, score
    if best is not None and best_score >= (2.5 if spec else 3):
        return str(best.sku), str(best.name), str(best.category)
    return None, None, None


# ------------------------------------------------------------------ extraction
def extract_rules(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for i, m in enumerate(msgs):
        t = m["text"]
        typ = _type(t)
        qty = _qty(t)
        if typ == "другое" and qty is None:
            continue
        out.append({"message_index": i, "type": typ, "product_text": t, "qty": qty, "expected_month": _month(t, m.get("date", "")), "probability": _probability(t), "summary": t[:160]})
    return out


async def extract_llm(msgs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    from .llm import chat

    out: list[dict[str, Any]] = []
    for start in range(0, len(msgs), 40):
        batch = msgs[start : start + 40]
        listing = "\n".join(f"[{start + k}] {m.get('date', '')} {m.get('author', '')}: {m['text']}" for k, m in enumerate(batch))
        prompt = (
            "Ты агент отдела закупа дистрибьютора электротоваров. Из сообщений менеджеров по продажам извлеки сигналы спроса. "
            "Верни JSON {\"signals\": [...]} , где каждый элемент: {\"message_index\": int, \"type\": одно из " + json.dumps(TYPES, ensure_ascii=False) + ", "
            "\"product_text\": товар словами из сообщения (с артикулом, если он есть), \"qty\": число из сообщения или null, "
            "\"expected_month\": \"YYYY-MM\" или null, \"probability\": 0..1 по формулировкам, \"summary\": одна короткая фраза}. "
            "Не выдумывай количества и товары; сообщения без сигнала пропускай.\n\nСообщения:\n" + listing
        )
        raw = await chat([{"role": "user", "content": prompt}], response_format={"type": "json_object"})
        try:
            out.extend(json.loads(raw).get("signals", []))
        except json.JSONDecodeError:
            continue
    return out


async def run_agent(msgs: list[dict[str, Any]], products, use_llm: bool) -> dict[str, Any]:
    steps = []
    t0 = time.perf_counter()
    steps.append({"tool": "parse_chat", "label": "Разбор выгрузки чата", "summary": f"сообщений: {len(msgs)}; каналы: {', '.join(sorted({m['channel'] for m in msgs}))}", "ms": int((time.perf_counter() - t0) * 1000)})
    t0 = time.perf_counter()
    by = "правила"
    raw: list[dict[str, Any]] = []
    if use_llm:
        try:
            raw = await extract_llm(msgs)
            by = "LLM"
        except Exception as e:  # noqa: BLE001 — never lose the import because the model is down
            steps.append({"tool": "extract_llm", "label": "Извлечение сигналов моделью", "summary": f"модель недоступна ({type(e).__name__}), используются правила", "ms": 0})
    if not raw:
        raw = extract_rules(msgs)
        by = "правила" if by != "LLM" or not raw else by
    steps.append({"tool": "extract_signals", "label": "Извлечение сигналов", "summary": f"найдено сигналов: {len(raw)} ({by})", "ms": int((time.perf_counter() - t0) * 1000)})
    t0 = time.perf_counter()
    signals = []
    linked = 0
    for s in raw:
        i = int(s.get("message_index", -1))
        if not 0 <= i < len(msgs):
            continue
        m = msgs[i]
        quote, client = redact(m["text"])
        typ = s.get("type") if s.get("type") in TYPES else "другое"
        sku, sku_name, cat = link_sku(str(s.get("product_text") or m["text"]), products)
        if sku:
            linked += 1
        qty = s.get("qty")
        try:
            qty = float(qty) if qty is not None else None
        except (TypeError, ValueError):
            qty = None
        prob = float(s.get("probability") or 0.5)
        signals.append({
            "id": hashlib.sha1(f"{m.get('date')}|{m.get('author')}|{m['text']}".encode()).hexdigest()[:10],
            "date": m.get("date", ""),
            "channel": m.get("channel", ""),
            "manager": m.get("author", ""),
            "client": client,
            "type": typ,
            "sku": sku,
            "sku_name": sku_name,
            "category": cat,
            "qty": qty,
            "expected_month": s.get("expected_month") or _month(m["text"], m.get("date", "")),
            "probability": round(max(0.0, min(prob, 1.0)), 2),
            "weighted_qty": round(qty * prob, 1) if qty else None,
            "quote": quote[:400],
            "summary": str(s.get("summary") or "")[:200],
            "extracted_by": by,
        })
    steps.append({"tool": "link_sku", "label": "Сопоставление с артикулами", "summary": f"привязано к артикулам: {linked} из {len(signals)}", "ms": int((time.perf_counter() - t0) * 1000)})
    steps.append({"tool": "anonymize", "label": "Обезличивание клиентов", "summary": f"названия компаний заменены хешами: {sum(1 for s in signals if s['client'])}", "ms": 0})
    return {"signals": signals, "steps": steps, "extracted_by": by}


# ------------------------------------------------------------------ storage
def load() -> list[dict[str, Any]]:
    if SIGNALS_FILE.exists():
        try:
            return json.loads(SIGNALS_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return []
    return []


def merge_save(new: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cur = {s["id"]: s for s in load()}
    for s in new:
        cur[s["id"]] = s
    rows = sorted(cur.values(), key=lambda s: (s.get("date") or "", s["id"]), reverse=True)
    SIGNALS_FILE.parent.mkdir(exist_ok=True)
    SIGNALS_FILE.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    return rows


def clear() -> None:
    if SIGNALS_FILE.exists():
        SIGNALS_FILE.unlink()


def by_sku(rows: list[dict[str, Any]] | None = None) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for s in rows if rows is not None else load():
        if s.get("sku"):
            out.setdefault(s["sku"], []).append(s)
    return out
