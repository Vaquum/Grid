"""A Limen result directory: the experiment's manifest and its rounds.

``limen run`` copies the manifest it runs into the directory (under its
own file name, or ``manifest.yaml`` for a committed manifest), writes
``metadata.json`` (the parsed manifest under ``yaml_reference``), then
appends one line to ``results.csv`` as each round finishes: the metrics,
then every parameter, then the round's own bookkeeping. The manifest says
which columns are parameters, so nothing is inferred about them; its copy
is kept as written, comments and all, for the page to show and narrow.
After a round that succeeded, it appends the round to ``round_data.jsonl``
(its parameters as the round used them, and its predictions); from it the
page learns which feature columns the round's ablation dropped; for a run
recorded with ``uel.record_model_outputs`` (Limen 5.17), what the round's
test probabilities say of its threshold; and for a run recorded with
``uel.record_execution`` (Limen 5.16), what its test window's execution
did, bar by bar: its trades, each half of the window, and from Limen 5.20,
which records the market's return on each bar too, its timing.

CSV carries no types. Limen writes ``None`` as an empty field and Python
booleans as ``True``/``False``; numbers and JSON lists (``_warnings``) are
read back as such, and every other field stays text.

Several result directories of one manifest, run side by side with
different search seeds (``uel.search_strategy.seed``), read as one run:
their manifests must be the same but for the seed, and their draws must
differ (a grid search, or one seed twice, draws the same rounds again).
"""

from __future__ import annotations

import csv
import json
import math
import os
import re
from collections.abc import Iterable
from typing import Any, cast

Json = dict[str, Any]
_INT = re.compile(r"[+-]?\d+\Z")
ROUND_LOG = "round_data.jsonl"
# How near its threshold a bar's probability must come to count as within
# reach: 0.05 in probability, a threshold that much lower would let it pass.
REACH = 0.05
BPS = 10_000.0
# The fewest trades a per-trade t is read from. With fewer its spread is
# too wide to read (two trades give it one degree of freedom), and trades
# stopped at one level have all but one return, their t near infinite: on
# a 10,000-round run, |t| reached 1e14 under 10 trades and 19 from 30.
T_TRADES = 30


def manifest_copy(names: Iterable[str], directory: str) -> str:
    """The manifest copy among a result directory's file names: its only
    YAML file."""
    found = sorted(n for n in names if n.endswith((".yaml", ".yml")))
    if len(found) != 1:
        held = ("%d YAML files (%s)" % (len(found), ", ".join(found))
                if found else "no YAML file")
        raise ValueError("%s holds %s; a Limen result directory holds "
                         "exactly one, the copy of the manifest it ran"
                         % (directory, held))
    return found[0]


def read_experiment(text: str, path: str, manifest_file: str,
                    manifest_text: str) -> Json:
    """The experiment as the page needs it, from metadata.json's text and
    the manifest copy's."""
    raw: Any = json.loads(text)
    if not isinstance(raw, dict) or "yaml_reference" not in raw:
        raise ValueError("%s has no yaml_reference: not a Limen result "
                         "directory's metadata.json" % path)
    meta = cast(Json, raw)
    manifest: Any = meta["yaml_reference"]
    if not isinstance(manifest, dict):
        raise ValueError("%s: yaml_reference is not a mapping" % path)
    objective: Any = meta.get("objective")
    return {"kind": "limen", "manifest": cast(Json, manifest),
            "manifestFile": manifest_file, "manifestText": manifest_text,
            "limenVersion": meta.get("limen_version"),
            "createdAt": meta.get("created_at"),
            "manifestId": meta.get("manifest_id"),
            # the objective the run selects by, when its manifest declares
            # one (Limen 5.18): {metric, direction}
            "objective": objective if isinstance(objective, dict) else None}


def shard_labels(dirs: list[str]) -> list[str]:
    """Each directory's label among several: its name, or its whole path
    where two share a name."""
    names = [os.path.basename(d.rstrip("/")) for d in dirs]
    return names if len(set(names)) == len(names) else list(dirs)


def _search(manifest: Json) -> Json:
    uel: Any = manifest.get("uel")
    strategy: Any = cast(Json, uel).get("search_strategy") \
        if isinstance(uel, dict) else None
    return cast(Json, strategy) if isinstance(strategy, dict) else {}


def without_seed(manifest: Json) -> Json:
    """A manifest less its search seed, the one thing in which several runs
    of it side by side differ."""
    out = cast(Json, json.loads(json.dumps(manifest)))
    _search(out).pop("seed", None)
    return out


def differences(a: Any, b: Any, path: str = "") -> list[str]:
    """Where two JSON values differ: each place as a dotted path, with the
    first value and the second."""
    if isinstance(a, dict) and isinstance(b, dict):
        da, db = cast(Json, a), cast(Json, b)
        out: list[str] = []
        for k in sorted(set(da) | set(db)):
            here = "%s.%s" % (path, k) if path else k
            if k not in da or k not in db:
                out.append("%s %s" % (here, "only in the second" if k in db
                                      else "only in the first"))
            else:
                out.extend(differences(da[k], db[k], here))
        return out
    # as JSON text, so that true is not 1, nor 1 the same as 1.0
    if json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True):
        return []
    return ["%s %s, then %s" % (path or "the manifest", _short(a),
                                _short(b))]


def _short(v: Any) -> str:
    text = json.dumps(v)
    return text if len(text) <= 40 else text[:37] + "..."


def shards_problem(labels: list[str], experiments: list[Json]) -> str | None:
    """Why several result directories cannot be read as one run, or None:
    their manifests differ in more than the search seed, or their draws
    are the same."""
    first = cast(Json, experiments[0]["manifest"])
    base = without_seed(first)
    for label, exp in zip(labels[1:], experiments[1:], strict=True):
        diff = differences(base, without_seed(cast(Json, exp["manifest"])))
        if diff:
            more = " and %d more" % (len(diff) - 3) if len(diff) > 3 else ""
            return ("%s and %s ran different manifests, not one manifest "
                    "with different search seeds: %s%s"
                    % (labels[0], label, "; ".join(diff[:3]), more))
    if _search(first).get("type") == "grid":
        return ("%s: a grid search draws the same rounds in every directory; "
                "only a random search drawn with different seeds can be "
                "read as one run" % ", ".join(labels))
    seen: dict[str, str] = {}
    for label, exp in zip(labels, experiments, strict=True):
        seed: Any = _search(cast(Json, exp["manifest"])).get("seed")
        if seed is None:
            continue
        key = json.dumps(seed)
        if key in seen:
            return ("%s and %s share the search seed %s, so they drew the "
                    "same rounds" % (seen[key], label, key))
        seen[key] = label
    return None


def experiment_name(experiment: Json) -> str | None:
    manifest = cast(Json, experiment["manifest"])
    meta: Any = manifest.get("metadata")
    if not isinstance(meta, dict):
        return None
    name: Any = cast(Json, meta).get("name")
    return name if isinstance(name, str) else None


def csv_value(text: str) -> Any:
    """One CSV field as the value Limen wrote."""
    if text == "":
        return None
    if text == "True":
        return True
    if text == "False":
        return False
    if _INT.match(text):
        return int(text)
    try:
        return float(text)
    except ValueError:
        pass
    if text[0] in "[{":
        try:
            return json.loads(text)
        except ValueError:
            return text
    return text


class CsvRecords:
    """Records of a CSV file arriving line by line. A quoted field may hold
    a line break, so a record is complete only when its quotes are."""

    def __init__(self) -> None:
        self.header: list[str] | None = None
        self.pending: list[str] = []

    def feed(self, line: str) -> list[str] | None:
        """The record this line completes, or None while one is open."""
        self.pending.append(line)
        text = "\n".join(self.pending)
        if text.count('"') % 2:
            return None
        self.pending = []
        return next(csv.reader([text], strict=True))

    def row(self, fields: list[str]) -> Json:
        """A data record as a row; the header must have been read."""
        assert self.header is not None
        if len(fields) != len(self.header):
            raise ValueError("%d fields where the header names %d"
                             % (len(fields), len(self.header)))
        return {k: csv_value(v)
                for k, v in zip(self.header, fields, strict=True)}


def model_outputs(rec: Json, index: int) -> Json | None:
    """What a round's test probabilities say of its threshold, from the
    ``probs``, ``optimal_threshold`` and ``threshold_rule`` that Limen
    records with ``uel.record_model_outputs``: the share of the bars that
    passed the threshold (``fired``), the share within REACH of it
    (``reach``, the passing ones too), and the largest probability less the
    threshold (``margin``). None when the round recorded none (``probs``
    absent, or null for a model with no probabilities)."""
    probs: Any = rec.get("probs")
    if probs is None:
        return None
    values = cast(list[Any], probs) if isinstance(probs, list) else []
    if not values or not all(
            isinstance(p, (int, float)) and not isinstance(p, bool)
            and math.isfinite(p) for p in values):
        raise ValueError("round %d: probs is not a list of probabilities"
                         % index)
    threshold: Any = rec.get("optimal_threshold")
    rule: Any = rec.get("threshold_rule")
    if not isinstance(threshold, (int, float)) or isinstance(threshold,
                                                             bool):
        raise ValueError("round %d: optimal_threshold is not a number, got "
                         "%r" % (index, threshold))
    if rule not in (">", ">="):
        raise ValueError("round %d: threshold_rule is %r, not > or >="
                         % (index, rule))
    ps = [float(p) for p in values]
    t = float(threshold)

    def passes(p: float) -> bool:
        return p > t if rule == ">" else p >= t
    n = len(ps)
    return {"fired": round(sum(1 for p in ps if passes(p)) / n, 6),
            "reach": round(sum(1 for p in ps if passes(p + REACH)) / n, 6),
            "margin": round(max(ps) - t, 6)}


def _series(v: Any, name: str, index: int) -> list[float]:
    """A recorded execution array: a list of finite numbers."""
    values = cast(list[Any], v) if isinstance(v, list) else []
    if not values or not all(
            isinstance(x, (int, float)) and not isinstance(x, bool)
            and math.isfinite(x) for x in values):
        raise ValueError("round %d: execution.%s is not a list of numbers"
                         % (index, name))
    return cast(list[float], values)


def _returns(v: Any, n: int, index: int) -> list[float | None] | None:
    """A round's market returns (``market.ret``, Limen 5.20): a number or
    null for each of its n test bars; None when the round recorded none
    (Limen before 5.20 writes no ``market``)."""
    if v is None:
        return None
    ret: Any = cast(Json, v).get("ret") if isinstance(v, dict) else None
    values = cast(list[Any], ret) if isinstance(ret, list) else None
    if values is None or len(values) != n or not all(
            x is None or (isinstance(x, (int, float))
                          and not isinstance(x, bool) and math.isfinite(x))
            for x in values):
        raise ValueError("round %d: market.ret is not a return or null for "
                         "each of its %d test bars" % (index, n))
    return cast(list[float | None], values)


def _span(pos: list[float], gross: list[float], net: list[float],
          ret: list[float | None] | None, lo: int, hi: int) -> Json:
    """Bars [lo, hi) of a round's test window, read as a window of their
    own the way Limen's ledger reads one (limen.backtest._snapshot_ledger):
    its net return per bar (``pnl``), cost per bar (``cost``), share of
    winning bars (``wins``) and mean deployed notional (``inventory``);
    its trades, each a run of bars in the market (pos above 0) with its
    net return compounded over them, as Limen's per-trade summary has it
    (``trades``, their mean ``tradeMean`` and, from T_TRADES of them, its
    t, ``tradeT``); and with
    market returns, the window's ``timing``, the mean gross return beyond
    the mean deployed notional times the market's mean return, over the
    bars with a market return (what the bars it chose earned beyond being
    in the market), and the ``market``'s own return, compounded. Returns
    per bar and per trade in bps."""
    bars = hi - lo
    trades: list[float] = []
    growth = 0.0        # the open trade's growth so far
    held = False        # a trade is open
    s_net = s_cost = s_pos = 0.0
    wins = 0
    # the bars with a market return: their count, sums and the market's
    # growth over them
    v = 0
    s_g = s_p = s_r = 0.0
    market = 1.0
    for i in range(lo, hi):
        p, g, x = pos[i], gross[i], net[i]
        s_net += x
        s_cost += g - x
        s_pos += p
        if x > 0:
            wins += 1
        if p > 0:
            growth = growth * (1.0 + x) if held else 1.0 + x
            held = True
        elif held:
            trades.append(growth - 1.0)
            held = False
        if ret is not None:
            r = ret[i]
            if r is not None:
                v += 1
                s_g += g
                s_p += p
                s_r += r
                market *= 1.0 + r
    if held:
        trades.append(growth - 1.0)
    k = len(trades)
    mean = sum(trades) / k if k else None
    t = None
    if mean is not None and k >= T_TRADES:
        var = sum((r - mean) ** 2 for r in trades) / (k - 1)
        # trades of one return (but for float error) have no t
        if var > (1e-9 * max(abs(r) for r in trades)) ** 2:
            t = mean / math.sqrt(var / k)
    out: Json = {"bars": bars, "trades": k,
                 "tradeMean": None if mean is None else mean * BPS,
                 "tradeT": t, "pnl": s_net / bars * BPS,
                 "cost": s_cost / bars * BPS, "wins": wins / bars,
                 "inventory": s_pos / bars, "timing": None, "market": None}
    if v:
        out["timing"] = (s_g / v - s_p / v * (s_r / v)) * BPS
        out["market"] = market - 1.0
    return {key: float("%.6g" % x) if isinstance(x, float) else x
            for key, x in out.items()}


def execution_summary(rec: Json, index: int) -> Json | None:
    """What a round's test window did, from the per-bar ``execution`` (pos,
    gross and net, each times the round's notional rate) that Limen records
    with ``uel.record_execution`` (5.16), and the ``market`` returns it
    records beside it from 5.20: the whole window and each half of it
    (``whole``, ``halves``), each read by _span. The halves are Limen's
    ordinal ones, bars [0, n // 2) and [n // 2, n); a window of one bar has
    none. None when the round recorded no execution (``execution`` absent,
    or null where no snapshot ran: event execution, missing prices)."""
    raw: Any = rec.get("execution")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("round %d: execution is not a mapping of pos, gross "
                         "and net" % index)
    ex = cast(Json, raw)
    pos = _series(ex.get("pos"), "pos", index)
    gross = _series(ex.get("gross"), "gross", index)
    net = _series(ex.get("net"), "net", index)
    n = len(pos)
    if len(gross) != n or len(net) != n:
        raise ValueError("round %d: execution's pos, gross and net differ in "
                         "length (%d, %d, %d)" % (index, n, len(gross),
                                                  len(net)))
    ret = _returns(rec.get("market"), n, index)
    k = n // 2
    return {"whole": _span(pos, gross, net, ret, 0, n),
            "halves": [_span(pos, gross, net, ret, 0, k),
                       _span(pos, gross, net, ret, k, n)] if k else None}


def round_record(text: str) -> tuple[int, list[str], Json | None,
                                     Json | None]:
    """One line of a Limen run's round_data.jsonl: the round's index, the
    feature columns its ablation dropped, what its test probabilities say
    of its threshold when it recorded them (model_outputs), and what its
    test window did when it recorded its execution (execution_summary).

    ``limen run`` writes the line after the round's results.csv row, and
    only for a round that succeeded. Its ``round_params`` hold
    ``_dropped_features`` (sorted) when the round dropped any; results.csv
    cannot carry them, as its columns are fixed by the first round. The
    predictions on the line are not read, nor the probabilities and the
    execution kept: the page gets what they say.
    """
    raw: Any = json.loads(text)
    if not isinstance(raw, dict):
        raise ValueError("a round line is a JSON object")
    rec = cast(Json, raw)
    index: Any = rec.get("_round_index")
    params: Any = rec.get("round_params")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        raise ValueError("a round line needs a _round_index, got %r"
                         % (index,))
    if not isinstance(params, dict):
        raise ValueError("round %d has no round_params" % index)
    outputs = model_outputs(rec, index)
    execution = execution_summary(rec, index)
    dropped: Any = cast(Json, params).get("_dropped_features")
    if dropped is None:
        return index, [], outputs, execution
    if not isinstance(dropped, list) or not all(
            isinstance(c, str) for c in cast(list[Any], dropped)):
        raise ValueError("round %d: _dropped_features is not a list of "
                         "column names" % index)
    return index, sorted(cast(list[str], dropped)), outputs, execution
