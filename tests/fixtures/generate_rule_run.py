"""Record a real, offline Limen rule run for Grid's image/schema proofs.

Run in the Grid image: python /fixtures/generate_rule_run.py /evidence.
The only generated input is a deterministic OHLC CSV; Limen writes every
result, metadata field and execution bar through its normal CLI.
"""

import csv
import datetime as dt
import math
import sys
from pathlib import Path

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
config = {
    "schema_version": "1.0",
    "metadata": {"name": "rule_smoke", "limen_version": "5.27.0",
                 "mode": "development", "description": "Offline Grid proof"},
    "sfd": {"manifest": {
        "type": "rule_based",
        "data_source": {"method": "polars.read_csv",
                        "params": {"source": str(source),
                                   "try_parse_dates": True}},
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
