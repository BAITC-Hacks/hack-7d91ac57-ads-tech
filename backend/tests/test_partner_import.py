"""Runs only when the partner's Excel exports are available locally (they are not committed)."""
import os
from pathlib import Path

import pytest

IEK = Path(os.environ.get("PARTNER_IEK", "/media/darkhan/Y/hackalem/IEK"))
SE = Path(os.environ.get("PARTNER_SE", "/media/darkhan/Y/hackalem/Systeme electric"))
pytestmark = pytest.mark.skipif(not (IEK.exists() and SE.exists()), reason="partner files not present")


def test_import_and_run(tmp_path):
    from app.import_partner import build
    from app.replenish import Dataset, Params, run

    info = build(IEK, SE, tmp_path)
    assert info["products"] > 3000 and info["sales_rows"] > 500_000 and info["in_transit"] > 100
    ds = Dataset.load(tmp_path)
    assert ds.default_warehouse() == "Алматы"
    res = run(ds, Params(category="Автоматы"))
    assert res["orders"], "ожидались рекомендации по автоматам"
    o = res["orders"][0]
    assert o["justification"] and o["recommended_qty"] % o["pack_size"] == 0 and o["recommended_qty"] >= o["moq"]
