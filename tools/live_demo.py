"""A live demo in one process: a simulated sweep writing its files, and
the monitor serving them.

    python3 tools/live_demo.py --port 0 --out /tmp/grid-live

The simulated sweep starts with 3,000 rows already written (a sweep that
has been running a while), then appends about six rows a second, and
crashes and relaunches after 900 more rows.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))

import simulate  # noqa: E402
import synth  # noqa: E402

from grid.__main__ import main as grid_main  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", default="0")
    ap.add_argument("--rate", type=float, default=6.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    # history first: a sweep that has been running for a while
    synth.write(3000, a.out, 3, 500000)
    stop = threading.Event()

    def later() -> None:
        time.sleep(4.0)
        # keep appending to the same files, as the running sweep would
        play_append(a.out, a.rate, stop)

    threading.Thread(target=later, daemon=True).start()
    sys.exit(grid_main(["serve", "--results",
                           os.path.join(a.out, "results.jsonl"),
                           "--log", os.path.join(a.out, "sweep.log"),
                           "--name", "Synthetic sweep",
                           "--label", "simulated run",
                           "--port", a.port]))


def last_elapsed(path: str) -> float:
    """The elapsed seconds of the log's last progress line, or 0."""
    seconds = 0.0
    with open(path) as f:
        for line in f:
            m = re.match(r"\d+/\d+ (\d+(?:\.\d+)?)s\b", line)
            if m:
                seconds = float(m.group(1))
    return seconds


def play_append(out: str, rate: float, stop: threading.Event) -> None:
    """Append to the files synth.write left, then crash and relaunch."""
    import json
    import random
    rng = random.Random(29)
    grid = [(t, s) for t in synth.TP for s in synth.SL]
    results = os.path.join(out, "results.jsonl")
    with open(results) as f:
        n = sum(1 for _ in f)
    f = open(results, "a", buffering=1)
    # the segment's clock carries on from the history's last progress line
    t0 = time.time() - last_elapsed(os.path.join(out, "sweep.log"))
    log = open(os.path.join(out, "sweep.log"), "a", buffering=1)
    best = (0, -1e9, "")
    i = n
    try:
        while not stop.is_set():
            rec = synth.score(synth.sample(rng), rng)
            rec["bt"] = grid.index((rec["tp"], rec["sl"]))
            f.write(json.dumps({k: rec[k] for k in synth.ORDER}) + "\n")
            i += 1
            key = (int(rec["gates"]), float(rec["mean_mo"]),
                   str(rec["model"]))
            if key[:2] > best[:2]:
                best = key
            if i % 100 == 0:
                log.write("%d/500000 %.0fs top: gates=%d mean=%+.2f %s\n" % (
                    i, time.time() - t0, best[0], best[1], best[2]))
            if i == n + 900:
                log.write(simulate.CRASH)
                time.sleep(3.0)
                log.write("--- %s relaunch after the crash ---\n"
                          % time.strftime("%Y%m%d_%H%M%S", time.gmtime()))
                log.write("sampling 500000 A-perms...\n")
                f.close()
                f = open(results, "w", buffering=1)  # a relaunch truncates
                n, i, t0, best = -10**9, 0, time.time(), (0, -1e9, "")
            time.sleep(rng.expovariate(rate))
    finally:
        f.close()
        log.close()


if __name__ == "__main__":
    main()
