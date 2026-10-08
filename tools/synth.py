"""Write a synthetic sweep in PocketA's format, with effects planted on
purpose, so the analyses can be checked against a known truth.

    python3 tools/synth.py --rows 20000 --out demo/synthetic

writes ``results.jsonl`` and ``sweep.log``. Deterministic for a seed.

Planted (on a latent score; every outcome follows the score):

- ``model``: strong (xgb_def, xgb_tuned best; logreg worst);
- ``tp``: strong (0.15 worst; 0.25 to 0.4 best); ``sl``: weak; ``label_q``:
  moderate;
- ``mthr``: acts only when ``meta`` = 1 (0.6 hurts);
- ``C_meta`` and ``cw_dir``: act only when ``model`` = logreg;
- ``hpcfg.min_child_weight`` under xgb_hp: 40 is dead (never tradeable);
- features: pf_poc_pos and tv_med_eff help, pf_c7_skew hurts, others
  nothing; subset size: nothing;
- ``sizing``: nothing (inert, as in PocketA under sizem = meta);
- ``pf_frac``: drawn for 2% of rows and never for stack_dir;
- the ``wr`` gate never passes (win days are bounded by signal days);
- 4% of logreg fits stop at max_iter (an invariant break the page shows).
"""

from __future__ import annotations

import argparse
import json
import os
import random
from typing import Any

MODELS = ["lgbm_lead", "lgbm_hp", "lgbm_def", "xgb_tuned", "xgb_hp",
          "xgb_def", "logreg", "stack_dir"]
TP = [None, 0.15, 0.2, 0.25, 0.3, 0.4]
SL = [None, 0.12, 0.15, 0.2]
SIZINGS = ["full", "mt", "thr02", "thr04", "thr05", "thr06", "thr07",
           "thr08", "kelly"]
LR_C = [0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0]
LR_L1R = [0.0, 0.3, 0.5, 0.7]
LR_CW = ["none", "balanced", "pos2", "neg2"]
CAL = ["raw", "platt", "iso"]
POOL = ["btc_volpct", "h4_btc_park4", "pf_poc_pos", "tv_med_eff",
        "pf_c7_skew", "mic_btc_db5_24", "v2_park_ratio", "st_rnd1k",
        "tv_har_w", "mic_eth_delta_24", "btc_vz", "tv_rsi_slope"]
LGB = {"num_leaves": [4, 8, 12, 16, 24, 31],
       "learning_rate": [0.005, 0.01, 0.02, 0.03, 0.06, 0.1],
       "min_child_samples": [5, 10, 20, 40, 80],
       "reg_lambda": [0.1, 1.0, 5.0, 10.0, 20.0, 50.0],
       "subsample": [0.5, 0.6, 0.8, 1.0],
       "colsample_bytree": [0.5, 0.6, 0.8, 1.0],
       "n_estimators": [100, 200, 400, 800]}
XGB = {"max_depth": [2, 3, 4, 5, 6],
       "learning_rate": [0.005, 0.01, 0.02, 0.03, 0.06, 0.1],
       "min_child_weight": [1, 5, 10, 20, 40],
       "reg_lambda": [0.1, 1.0, 5.0, 10.0, 20.0, 50.0],
       "subsample": [0.5, 0.6, 0.8, 1.0],
       "colsample_bytree": [0.5, 0.6, 0.8, 1.0],
       "n_estimators": [100, 200, 400, 800]}
FIXED = {"lgbm_lead": {"num_leaves": 31, "learning_rate": 0.01,
                       "min_child_samples": 20, "reg_lambda": 1.0,
                       "subsample": 1.0, "colsample_bytree": 0.8,
                       "n_estimators": 400},
         "lgbm_def": {"num_leaves": 4, "learning_rate": 0.03,
                      "min_child_samples": 10, "reg_lambda": 5.0,
                      "subsample": 0.7, "colsample_bytree": 0.7,
                      "n_estimators": 200},
         "xgb_tuned": {"max_depth": 3, "learning_rate": 0.03,
                       "min_child_weight": 10, "reg_lambda": 20.0,
                       "subsample": 0.8, "colsample_bytree": 1.0,
                       "n_estimators": 200},
         "xgb_def": {"max_depth": 2, "learning_rate": 0.03,
                     "min_child_weight": 10, "reg_lambda": 5.0,
                     "subsample": 0.7, "colsample_bytree": 0.7,
                     "n_estimators": 200},
         "stack_dir": {"stack": "xgb+lgbm+lr>lr"}}

E_MODEL = {"xgb_def": 0.6, "xgb_tuned": 0.55, "stack_dir": 0.2,
           "lgbm_hp": 0.1, "xgb_hp": 0.0, "lgbm_def": 0.0,
           "lgbm_lead": -0.05, "logreg": -0.9}
E_TP = {None: -0.2, 0.15: -0.6, 0.2: -0.3, 0.25: 0.3, 0.3: 0.3, 0.4: 0.25}
E_SL = {None: 0.0, 0.12: -0.06, 0.15: 0.0, 0.2: 0.06}
E_LQ = {0.4: 0.15, 0.5: 0.0, 0.6: -0.2}
E_CMETA = {0.01: -0.4, 0.03: -0.2, 0.1: -0.2, 0.3: -0.3, 1.0: 0.0, 3.0: 0.2,
           10.0: 0.4}
E_CW = {"pos2": 0.4, "balanced": 0.2, "none": -0.2, "neg2": -0.3}
E_MCW = {1: 0.1, 5: 0.2, 10: 0.4, 20: -0.6, 40: -6.0}
E_FEAT = {"pf_poc_pos": 0.25, "tv_med_eff": 0.2, "pf_c7_skew": -0.25}
COST = {"lgbm_lead": 0.55, "lgbm_hp": 0.45, "lgbm_def": 0.21,
        "xgb_tuned": 0.4, "xgb_hp": 0.65, "xgb_def": 0.27, "logreg": 0.67,
        "stack_dir": 0.41}
DAYS = 638


def sample(rng: random.Random) -> dict[str, Any]:
    model = rng.choice(MODELS)
    if model == "lgbm_hp":
        hp: dict[str, Any] = {k: rng.choice(v)
                              for k, v in sorted(LGB.items())}
    elif model == "xgb_hp":
        hp = {k: rng.choice(v) for k, v in sorted(XGB.items())}
    else:
        hp = dict(FIXED.get(model, {}))
    pf = int(rng.random() < 0.02) if model != "stack_dir" else 0
    k = rng.randint(3, 8)
    idx = rng.sample(range(len(POOL)), k)
    feats = [POOL[i] for i in sorted(idx)]
    perm: dict[str, Any] = {
        "tp": rng.choice(TP), "sl": rng.choice(SL),
        "label_q": rng.choice([0.4, 0.5, 0.6]),
        "label_mode": rng.choice(["q", "vol"]),
        "vol_k": rng.choice([0.0, 0.5, 1.0]),
        "model": model, "hpcfg": hp, "feats": feats, "nfeats": len(feats),
        "sizing": rng.choice(SIZINGS), "fsize": 0.0,
        "meta": rng.randint(0, 1), "mthr": rng.choice([0.4, 0.5, 0.6]),
        "sizem": "meta", "seed": rng.randrange(1 << 30),
        "lr_w": rng.randint(0, 1), "C_dir": rng.choice(LR_C),
        "C_meta": rng.choice(LR_C), "l1r_dir": rng.choice(LR_L1R),
        "l1r_meta": rng.choice(LR_L1R), "cw_dir": rng.choice(LR_CW),
        "cw_meta": rng.choice(LR_CW),
        "cal_meta": rng.choice(CAL) if not pf else "raw",
        "preg": rng.randint(0, 1), "pf_frac": pf}
    if model == "logreg":
        perm["hpcfg"] = {"C": perm["C_dir"], "l1_ratio": perm["l1r_dir"],
                         "class_weight": perm["cw_dir"], "max_iter": 10000}
    return perm


def score(p: dict[str, Any], rng: random.Random) -> dict[str, Any]:
    model = str(p["model"])
    z = E_MODEL[model] + E_TP[p["tp"]] + E_SL[p["sl"]]
    z += E_LQ[p["label_q"]]
    if p["meta"] == 1 and p["mthr"] == 0.6:
        z -= 0.5
    if model == "logreg":
        z += E_CMETA[p["C_meta"]] + E_CW[p["cw_dir"]]
    hp: dict[str, Any] = p["hpcfg"]
    if model == "xgb_hp":
        z += E_MCW[hp["min_child_weight"]]
    feats: list[str] = p["feats"]
    for f in feats:
        z += E_FEAT.get(f, 0.0)
    z += rng.gauss(0, 1)
    mean_mo = round(1.45 + 0.9 * z + rng.gauss(0, 0.35), 2)
    total = round(mean_mo * 3050 + rng.gauss(0, 900), 2)
    green_ok = z + rng.gauss(0, 0.6) > 0.75
    greens = 21 if green_ok else max(10, 21 - int(abs(rng.gauss(2.5, 2))) - 1)
    worst = round(rng.uniform(-0.49, 0.0), 2) if green_ok else \
        round(-0.6 - abs(rng.gauss(2.5, 2.5)), 2)
    month = "%d-%02d" % (rng.choice([2025, 2026]), rng.randint(1, 12))
    nsig = max(0, int(rng.gauss(85, 34)))
    winday = round(min(nsig / DAYS * 100 * rng.uniform(0.5, 0.95), 24.9), 1)
    aw = round(abs(rng.gauss(420 + 80 * z, 120)), 2)
    al = round(abs(rng.gauss(330, 90)), 2)
    top5 = round(abs(rng.gauss(0.75, 0.3)) if rng.random() > 0.02 else
                 rng.uniform(0.1, 0.29), 3)
    maxdd = round(abs(rng.gauss(1400, 900)), 2)
    dynsize = "vary=%s ncoins=%d" % (nsig > 0 and rng.random() < 0.95,
                                     1 if nsig else 0)
    gd: dict[str, dict[str, Any]] = {
        "m_green": {"v": "%d/21 months >= -0.5%%" % greens,
                    "pass": greens == 21},
        "m_avg": {"v": mean_mo, "pass": mean_mo >= 5.0},
        "m_min": {"v": "%s %+.2f%%" % (month, worst), "pass": worst >= -0.5},
        "wr": {"v": winday, "pass": winday > 50},
        "skew": {"v": [aw, al], "pass": aw > al},
        "top5": {"v": top5, "pass": top5 < 0.30},
        "dynsize": {"v": dynsize, "pass": dynsize.startswith("vary=True")},
        "dynexit": {"v": "holds=[1, 2, 3, 4] midexits=%d" % rng.randint(0, 60),
                    "pass": rng.random() < 0.99},
        "dd": {"v": maxdd, "pass": rng.random() < 0.97},
    }
    gates = sum(1 for g in gd.values() if g["pass"])
    pf = int(p["pf_frac"])
    cal = str(p["cal_meta"])
    cal_applied = cal if model == "logreg" and not pf else "raw"
    nit_dir = nit_meta = None
    if model == "logreg":
        nit_dir = 10000 if rng.random() < 0.04 else rng.randint(5, 3000)
        nit_meta = rng.randint(1, 4000)
    auc = round(0.53 + 0.015 * z + rng.gauss(0, 0.04), 4)
    rec = dict(p)
    rec.update({
        "cal_applied": cal_applied, "cal_fb": 1 if cal_applied != "raw" else 0,
        "pf_applied": pf, "pf_fb": 0, "auc": auc,
        "ll_dir": round(abs(rng.gauss(0.9, 0.3)), 4),
        "ll_meta": round(abs(rng.gauss(1.0, 0.4)), 4),
        "lr_nit_dir": nit_dir, "lr_nit_meta": nit_meta,
        "gates": gates, "gates_detail": gd, "total": total,
        "mean_mo": mean_mo, "maxDD": maxdd, "avgwin": aw, "avgloss": al,
        "winday": winday, "nsig": nsig,
        "meansz": round(abs(rng.gauss(5200, 2500)), 2),
        "green": gd["m_green"]["v"], "min_mo": gd["m_min"]["v"],
        "verdict": "PASS" if gates == 9 else "FAIL",
        "sec": round(abs(rng.gauss(COST[model] + (0.6 if pf else 0), 0.25)),
                     1)})
    return rec


ORDER = ["bt", "tp", "sl", "label_q", "label_mode", "vol_k", "model",
         "hpcfg", "feats", "nfeats", "sizing", "fsize", "meta", "mthr",
         "sizem", "seed", "lr_w", "C_dir", "C_meta", "l1r_dir", "l1r_meta",
         "cw_dir", "cw_meta", "cal_meta", "cal_applied", "cal_fb", "preg",
         "pf_frac", "pf_applied", "pf_fb", "auc", "ll_dir", "ll_meta",
         "lr_nit_dir", "lr_nit_meta", "gates", "gates_detail", "total",
         "mean_mo", "maxDD", "avgwin", "avgloss", "winday", "nsig",
         "meansz", "green", "min_mo", "verdict", "sec"]


def write(rows: int, out: str, seed: int, total: int) -> None:
    os.makedirs(out, exist_ok=True)
    rng = random.Random(seed)
    grid: list[tuple[float | None, float | None]] = [
        (t, s) for t in TP for s in SL]
    log = open(os.path.join(out, "sweep.log"), "w")
    # an earlier run that crashed after 100 rows
    log.write("sampling %d A-perms...\n" % total)
    log.write("100/%d 14s top: gates=6 mean=+3.12 xgb_def\n" % total)
    log.write('multiprocessing.pool.RemoteTraceback: \n"""\n'
              "Traceback (most recent call last):\n"
              '  File "/usr/lib/python3.14/multiprocessing/pool.py", '
              "line 125, in worker\n"
              "    result = (True, func(*args, **kwds))\n"
              '  File "/srv/research/sweep.py", line 419, in post_meta\n'
              "    Dtr = expand(Xc[tr], KI, RI)\n"
              "NameError: cannot access free variable 'KI' where it is not "
              "associated with a value in enclosing scope\n"
              '"""\n\nThe above exception was the direct cause of the '
              "following exception:\n\nTraceback (most recent call last):\n"
              '  File "/srv/research/sweep.py", line 979, in <module>\n'
              "    sweep(a.n, a.workers, a.seed)\n"
              "NameError: cannot access free variable 'KI' where it is not "
              "associated with a value in enclosing scope\n")
    log.write("--- 20261008_183539 relaunch post stack-pf fix ---\n")
    log.write("sampling %d A-perms...\n" % total)
    best: tuple[int, float, str] | None = None
    elapsed = 0.0
    with open(os.path.join(out, "results.jsonl"), "w") as f:
        for i in range(rows):
            p = sample(rng)
            rec = score(p, rng)
            rec["bt"] = grid.index((rec["tp"], rec["sl"]))
            f.write(json.dumps({k: rec[k] for k in ORDER}) + "\n")
            elapsed += float(rec["sec"]) / 3 + 0.05
            key = (int(rec["gates"]), float(rec["mean_mo"]),
                   str(rec["model"]))
            if best is None or key[:2] > best[:2]:
                best = key
            if rec["pf_frac"]:
                for _ in range(rng.randint(3, 9)):
                    log.write("/srv/research/eval/harness.py:38: "
                              "FutureWarning: adfuller currently returns a "
                              "plain tuple whose length depends on the store "
                              "and autolag arguments.\n  return float("
                              'adfuller(x, maxlag=1, regression="c")[1])\n')
            if rec["lr_nit_dir"] == 10000:
                log.write("/srv/.venv/lib/python3.14/site-packages/sklearn/"
                          "linear_model/_sag.py:348: ConvergenceWarning: The "
                          "max_iter was reached which means the coef_ did "
                          "not converge\n  warnings.warn(\n")
            if (i + 1) % 100 == 0 or i + 1 == total:
                log.write("%d/%d %.0fs top: gates=%d mean=%+.2f %s\n" % (
                    i + 1, total, elapsed, best[0], best[1], best[2]))
    if rows >= total:
        log.write("-- top 5 / %d --\nlogged\n" % total)
    log.close()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=20000)
    ap.add_argument("--total", type=int, default=500000,
                    help="the run's planned size (fewer rows: running)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    write(a.rows, a.out, a.seed, a.total)
    print("wrote %d rows to %s" % (a.rows, a.out))


if __name__ == "__main__":
    main()
