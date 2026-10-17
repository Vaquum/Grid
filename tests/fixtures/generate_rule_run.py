"""Record a real, offline Limen rule run for Grid's image/schema proofs.

Run in the Grid image: python /fixtures/generate_rule_run.py /evidence.
The only generated input is a deterministic OHLC CSV; Limen writes every
result, metadata field and execution bar through its normal CLI.
"""

import csv
import datetime as dt
import math
import sys
from importlib.metadata import version
from pathlib import Path

import polars as pl
from ruamel.yaml import YAML

root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
source = root / "market.csv"
with source.open("w", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["datetime", "open", "high", "low", "close", "volume"])
    for i in range(24 * 12):
        opened = 100 + math.sin(i / 3)
        closed = opened + (0.5 if i % 4 < 2 else -0.5)
        writer.writerow([(dt.datetime(2026, 1, 1) + dt.timedelta(hours=i))
                         .isoformat(), opened, max(opened, closed) + 0.2,
                         min(opened, closed) - 0.2, closed, 100])
frame = pl.read_csv(source, try_parse_dates=True).with_columns(
    pl.col("datetime").dt.replace_time_zone("UTC"))
source_format = sys.argv[2] if len(sys.argv) > 2 else "parquet"
if source_format == "arrow":
    source = root / "market.arrow"
    frame.write_ipc(source, compression="uncompressed")
    loader = "limen.data.HistoricalData.get_arrow_file"
    source_params = {"file_path": str(source)}
else:
    source = root / "market.parquet"
    frame.write_parquet(source)
    loader = "limen.data.HistoricalData.get_any_file"
    source_params = {"file_path_or_url": str(source)}
config = {
    "schema_version": "1.0",
    "metadata": {"name": "rule_smoke", "limen_version": version("vaquum-limen"),
                 "mode": "development", "description": "Offline Grid proof"},
    "sfd": {"manifest": {
        "type": "rule_based",
        "data_source": {"method": loader, "params": source_params},
        "split_dates": {"train_start": "2026-01-01", "train_end": "2026-01-04",
                        "val_start": "2026-01-05", "val_end": "2026-01-08",
                        "test_start": "2026-01-09", "test_end": "2026-01-12"},
        "strategy": {"conditions": [{"id": "enter", "name": "Up bar",
                                      "type": "relative", "column": "close",
                                      "operator": ">", "other_column": "open"}],
                     "entry": "enter"},
        "reference_architecture":
            "limen.sfd.reference_architecture.rule_based.rule_based",
        "backtest": {"fee_bps": "{fee}", "slip_bps": 0.,
                     "notional_rate": 1.}},
        "params": {"fee": list(range(40))}},
    "uel": {"n_permutations": 40, "search_strategy": {"type": "grid"},
            "prep_each_round": True, "factorize": True, "workers": 1,
            "record_execution": True, "record_model_outputs": True,
            "output_format": "csv", "output_path": "rule_smoke"}}
with (root / "rule_smoke.yaml").open("w") as stream:
    YAML().dump(config, stream)
