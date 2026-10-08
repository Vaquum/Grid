"""Reference values for the engine tests, computed independently of it.

Needs numpy, pandas and scipy (development only):

    python tools/golden_engine.py --out tests/golden/engine.json

It generates the synthetic sweep (tools/synth.py, 20,000 rows, seed 7) and
computes every checked number with other methods than the engine uses:
scipy's f_oneway for one-way effects, an ordinary least squares fit of the
additive and the full model for interactions (the engine backfits), scipy's
chi2_contingency for Cramér's V, a pandas groupby for stratified inclusion
effects, and a pandas sort for the leaderboard.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
from typing import Any

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth  # noqa: E402

ROWS, SEED = 20000, 7


def load() -> pd.DataFrame:
    d = tempfile.mkdtemp()
    synth.write(ROWS, d, SEED, 500000)
    with open(os.path.join(d, "results.jsonl")) as f:
        rows = [json.loads(line) for line in f]
    df = pd.DataFrame(rows)
    df["tradeable"] = ((df.gates >= 6) & (df.total >= 3000)).astype(float)
    return df


def key(v: Any) -> str:
    """The level key the page gives a value (schema.js levelOf / null)."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(float(v)).rstrip("0").rstrip(".") if float(v) != int(v) \
            else str(int(v))
    return str(v)


def one_way(df: pd.DataFrame, dim: str, target: str) -> dict[str, Any]:
    col = df[dim].map(key)
    groups = [df[target][col == k].to_numpy() for k in sorted(col.unique())]
    groups = [g for g in groups if len(g)]
    f, p = stats.f_oneway(*groups)
    k, n = len(groups), sum(len(g) for g in groups)
    omega2 = (f - 1) * (k - 1) / ((f - 1) * (k - 1) + n)
    levels = {kk: {"n": int((col == kk).sum()),
                   "mean": float(df[target][col == kk].mean())}
              for kk in col.unique()}
    return {"F": float(f), "p": float(p), "omega2": float(omega2),
            "levels": levels}


def interaction(df: pd.DataFrame, a: str, b: str,
                target: str) -> dict[str, Any]:
    A = pd.get_dummies(df[a].map(key), prefix="a", drop_first=True,
                       dtype=float)
    B = pd.get_dummies(df[b].map(key), prefix="b", drop_first=True,
                       dtype=float)
    y = df[target].to_numpy()
    one = np.ones((len(df), 1))
    add = np.hstack([one, A.to_numpy(), B.to_numpy()])
    cells = df[a].map(key) + "|" + df[b].map(key)
    full = pd.get_dummies(cells, dtype=float).to_numpy()

    def rss(X: np.ndarray) -> tuple[float, int]:
        beta, *_ = np.linalg.lstsq(X, y, rcond=None)
        r = y - X @ beta
        return float(r @ r), int(np.linalg.matrix_rank(X))

    r_add, p_add = rss(add)
    r_full, p_full = rss(full)
    df_i, df_w = p_full - p_add, len(y) - p_full
    ss_i = r_add - r_full
    f = (ss_i / df_i) / (r_full / df_w)
    sst = float(((y - y.mean()) ** 2).sum())
    msw = r_full / df_w
    return {"SSI": ss_i, "dfI": df_i, "dfW": df_w, "F": f,
            "p": float(stats.f.sf(f, df_i, df_w)),
            "omega2": (ss_i - df_i * msw) / (sst + msw)}


def g_test(df: pd.DataFrame, dim: str, target: str) -> dict[str, Any]:
    tab = pd.crosstab(df[dim].map(key), df[target])
    g, p, dof, _ = stats.chi2_contingency(tab, correction=False,
                                          lambda_="log-likelihood")
    return {"G": float(g), "p": float(p), "df": int(dof)}


def logistic_lr(df: pd.DataFrame, a: str, b: str,
                target: str) -> dict[str, Any]:
    """Additive logistic model vs the saturated cell model, fitted by
    scipy.optimize on the cell table (the engine uses IRLS)."""
    from scipy.optimize import minimize
    t = df.groupby([df[a].map(key), df[b].map(key)])[target].agg(
        ["sum", "count"]).reset_index()
    t.columns = ["a", "b", "k", "n"]
    la, lb = sorted(t.a.unique()), sorted(t.b.unique())
    ia = t.a.map({v: i for i, v in enumerate(la)}).to_numpy()
    ib = t.b.map({v: i for i, v in enumerate(lb)}).to_numpy()
    k, n = t.k.to_numpy(float), t.n.to_numpy(float)

    def nll(x: np.ndarray) -> float:
        al = np.concatenate([[0.0], x[1:len(la)]])
        be = np.concatenate([[0.0], x[len(la):]])
        eta = x[0] + al[ia] + be[ib]
        return float(np.sum(n * np.logaddexp(0, eta) - k * eta))

    x0 = np.zeros(len(la) + len(lb) - 1)
    res = minimize(nll, x0, method="BFGS", options={"gtol": 1e-10,
                                                   "maxiter": 10000})
    ph = k / n
    with np.errstate(divide="ignore", invalid="ignore"):
        sat = -np.sum(np.where(k > 0, k * np.log(ph), 0) +
                      np.where(n - k > 0, (n - k) * np.log(1 - ph), 0))
    dev = 2 * (res.fun - sat)
    dof = len(t) - (len(la) + len(lb) - 1)
    return {"D": float(dev), "df": int(dof),
            "p": float(stats.chi2.sf(dev, dof))}


def cramers(df: pd.DataFrame, a: str, b: str) -> dict[str, Any]:
    tab = pd.crosstab(df[a].map(key), df[b].map(key))
    chi2, p, dof, _ = stats.chi2_contingency(tab, correction=False)
    n = tab.to_numpy().sum()
    return {"V": float(math.sqrt(chi2 / (n * (min(tab.shape) - 1)))),
            "chi2": float(chi2), "p": float(p), "df": int(dof)}


def member(df: pd.DataFrame, name: str, target: str) -> dict[str, Any]:
    inc = df.feats.map(lambda f: name in f)
    num = var = wsum = 0.0
    for _, g in df.groupby("nfeats"):
        gi, go = g[target][inc[g.index]], g[target][~inc[g.index]]
        if len(gi) < 2 or len(go) < 2:
            continue
        w = len(g)
        num += w * (gi.mean() - go.mean())
        var += w * w * (gi.var(ddof=1) / len(gi) + go.var(ddof=1) / len(go))
        wsum += w
    return {"delta": num / wsum, "se": math.sqrt(var) / wsum}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    df = load()
    k, n = int(df.tradeable.sum()), len(df)
    out: dict[str, Any] = {
        "rows": ROWS, "seed": SEED,
        "fingerprint": {"mean_mo_sum": round(float(df.mean_mo.sum()), 6),
                        "seed_sum": int(df.seed.sum())},
        "base": {"hits": k, "n": n},
        "oneWay": {t: {d: one_way(df, d, t) for d in
                       ["model", "tp", "sl", "label_q", "sizing", "meta",
                        "mthr"]}
                   for t in ["tradeable", "mean_mo"]},
        "insideLogreg": {d: one_way(df[df.model == "logreg"], d, "mean_mo")
                         for d in ["C_meta", "cw_dir", "sizing"]},
        "interaction": {"meta|mthr|tradeable":
                        interaction(df, "meta", "mthr", "tradeable"),
                        "model|tp|mean_mo":
                        interaction(df, "model", "tp", "mean_mo")},
        "gTest": {d: g_test(df, d, "tradeable") for d in
                  ["model", "tp", "sizing", "mthr"]},
        "logisticLR": {"meta|mthr|tradeable":
                       logistic_lr(df, "meta", "mthr", "tradeable"),
                       "model|tp|tradeable":
                       logistic_lr(df, "model", "tp", "tradeable")},
        "cramers": {"model|pf_frac": cramers(df, "model", "pf_frac"),
                    "tp|sl": cramers(df, "tp", "sl")},
        "members": {f: member(df, f, "mean_mo") for f in
                    ["pf_poc_pos", "tv_med_eff", "pf_c7_skew", "btc_vz"]},
        "top5": [int(i) for i in df.sort_values(
            ["gates", "mean_mo"], ascending=[False, False],
            kind="stable").index[:5]],
        "gatePass": {g: float(df.gates_detail.map(
            lambda d, g=g: d[g]["pass"]).mean())
            for g in ["m_green", "m_avg", "wr", "top5"]},
    }
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
