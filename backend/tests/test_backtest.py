"""Out-of-sample backtest on the synthetic sample: the engine must beat simple methods, and calibration must raise
safety-stock coverage out of sample."""
from pathlib import Path

from app.backtest import evaluate
from app.replenish import Dataset

DATA = Path(__file__).resolve().parent.parent / "data" / "sample"


def test_engine_beats_baselines_and_calibration_helps():
    res = evaluate(Dataset.load(DATA))
    m = res["test"]["regular_vs_clean"]
    # «auto» = the assortment-level model chosen on the validation window, measured on the unseen test window
    assert m["auto"]["wape"] < m["naive_90d"]["wape"]
    assert m["auto"]["wape"] < m["seasonal_naive"]["wape"]
    assert m["auto"]["wape"] < m["ma_12m"]["wape"]
    assert res["production"]["model"] in res["modes"]
    k = res["test"]["calibration"]
    assert k["coverage_out_of_sample_pct"] > k["coverage_raw_pct"]
    assert res["production"]["ss_multiplier"] >= 1.0 and res["production"]["wape"]
