"""Play a synthetic sweep into files, as a running sweep writes them.

    python3 tools/simulate.py --out /tmp/sweep --rate 6 --relaunch 600

Appends rows to ``results.jsonl`` and progress lines (every 100 rows),
warnings and a crash to ``sweep.log`` in PocketA's format. With
``--relaunch N`` it crashes after N rows, writes a relaunch marker,
truncates the results file (as pocket_a.py's sweep does when it reopens
it for writing) and starts again, so a monitor's reset path is exercised.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import threading
import time

import synth

CRASH = ('multiprocessing.pool.RemoteTraceback: \n"""\n'
         "Traceback (most recent call last):\n"
         '  File "/usr/lib/python3.14/multiprocessing/pool.py", line 125, '
         "in worker\n    result = (True, func(*args, **kwds))\n"
         '  File "/srv/research/sweep.py", line 419, in post_meta\n'
         "    Dtr = expand(Xc[tr], KI, RI)\n"
         "NameError: cannot access free variable 'KI' where it is not "
         "associated with a value in enclosing scope\n"
         '"""\n')


def play(out: str, rate: float, total: int, relaunch: int | None,
         seed: int, stop: threading.Event | None = None) -> None:
    os.makedirs(out, exist_ok=True)
    rng = random.Random(seed)
    grid = [(t, s) for t in synth.TP for s in synth.SL]
    results = os.path.join(out, "results.jsonl")
    logp = os.path.join(out, "sweep.log")
    open(results, "w").close()
    log = open(logp, "w", buffering=1)
    log.write("sampling %d A-perms...\n" % total)
    f = open(results, "w", buffering=1)
    best: tuple[int, float, str] | None = None
    i, t0, launched = 0, time.time(), False
    while i < total and not (stop and stop.is_set()):
        rec = synth.score(synth.sample(rng), rng)
        rec["bt"] = grid.index((rec["tp"], rec["sl"]))
        f.write(json.dumps({k: rec[k] for k in synth.ORDER}) + "\n")
        i += 1
        key = (int(rec["gates"]), float(rec["mean_mo"]), str(rec["model"]))
        if best is None or key[:2] > best[:2]:
            best = key
        if rec["lr_nit_dir"] == 10000:
            log.write("/srv/.venv/lib/python3.14/site-packages/sklearn/"
                      "linear_model/_sag.py:348: ConvergenceWarning: The "
                      "max_iter was reached which means the coef_ did not "
                      "converge\n  warnings.warn(\n")
        if i % 100 == 0:
            log.write("%d/%d %.0fs top: gates=%d mean=%+.2f %s\n" % (
                i, total, time.time() - t0, best[0], best[1], best[2]))
        if relaunch and i == relaunch and not launched:
            launched = True
            log.write(CRASH)
            time.sleep(2.0)
            log.write("--- %s relaunch after the crash ---\n"
                      % time.strftime("%Y%m%d_%H%M%S", time.gmtime()))
            log.write("sampling %d A-perms...\n" % total)
            f.close()
            # reopening for writing truncates, as a relaunch does
            f = open(results, "w", buffering=1)
            i, t0, best = 0, time.time(), None
        time.sleep(rng.expovariate(rate))
    f.close()
    if i >= total:
        log.write("-- top 5 / %d --\nlogged\n" % total)
    log.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--rate", type=float, default=6.0, help="rows a second")
    ap.add_argument("--total", type=int, default=500000)
    ap.add_argument("--relaunch", type=int, default=None,
                    help="crash and relaunch after this many rows")
    ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()
    play(a.out, a.rate, a.total, a.relaunch, a.seed)


if __name__ == "__main__":
    main()
