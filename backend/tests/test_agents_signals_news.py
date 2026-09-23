"""Sales-signals agent on the bundled chat exports (rules, offline) and the effect of include_signals on the order."""
import asyncio
from pathlib import Path

from app import signals as sig
from app.replenish import Dataset, Params, compute_sku

DATA = Path(__file__).resolve().parent.parent / "data" / "sample"


def test_chat_exports_parse_extract_link_and_anonymise():
    msgs = []
    for f in sorted((DATA / "chats").glob("*")):
        msgs += sig.parse_chat(f.name, f.read_bytes())
    assert {m["channel"] for m in msgs} == {"Telegram", "WhatsApp", "Bitrix24"}
    ds = Dataset.load(DATA)
    res = asyncio.run(sig.run_agent(msgs, ds.products, use_llm=False))
    s = res["signals"]
    assert len(s) >= 8
    assert any(x["type"] == "крупный разовый заказ" for x in s) and any(x["type"] == "цены и условия поставщика" for x in s)
    lmp = next(x for x in s if x["sku"] == "LMP-006" and x["qty"] == 150)
    assert lmp["qty"] == 150 and lmp["probability"] == 0.9 and lmp["expected_month"] == "2026-10"
    assert all("АлматыСтройМонтаж" not in x["quote"] for x in s)  # client names are hashed
    # Latin «25A» in a chat must match Cyrillic «25А» in the catalogue, and spec tokens must agree
    sku, name, _ = sig.link_sku("Автомат ВА47-29 1P 25A", ds.products)
    assert sku == "AUT-002", (sku, name)
    # signals do not change the regular order unless explicitly included
    ds.signals = sig.by_sku(s)
    base = compute_sku(ds, "LMP-006", "Главный", Params(warehouse="Главный"))
    inc = compute_sku(ds, "LMP-006", "Главный", Params(warehouse="Главный", include_signals=True))
    assert base["signal_qty"] > 0 and inc["raw_need"] > base["raw_need"]
    assert "сигналы продаж" in base["justification"]
