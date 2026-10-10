"""A cohort of a Limen run's rounds, judged on what the run recorded (the
Cohort view).

A Limen ``Cohort`` binds sensors of one experiment's rounds and averages
their probabilities on each bar: with ``probability_weighted`` aggregation
its prediction is the mean probability over 0.5 (the members' own
thresholds play no part), with ``majority_vote`` the mean of their votes
over 0.5 (limen/cohort/cohort.py). A run that recorded its model outputs
(``uel.record_model_outputs``, Limen 5.17) keeps each round's test
probabilities and predictions bar by bar in ``round_data.jsonl``, and one
that recorded its execution (``uel.record_execution``) keeps the market's
return on each bar (``market.ret``, Limen 5.20). From them, the cohort the
members would make is rebuilt over the test window without training
anything: the members' bars aligned by time, their probabilities averaged,
and the signal executed as Limen executes one (limen/backtest/
long_flat_strategy.py: long while the signal of the bar before was 1, at
the fee and slippage given). Each member is executed the same way from its
own recorded predictions, so the cohort and its members are set side by
side on one execution, over the whole window and over each half of it.

The bars' times are not recorded; each round's are rebuilt from its test
window's first and last bar, at the data's bar interval, less the bars it
dropped (``alignment``), and checked against the length of its arrays.
Exits by take-profit or stop-loss need the bars' prices, which the run does
not record: they are not rebuilt (``notes`` says when members use them).
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from datetime import datetime
from typing import Any, cast

from .limen import windows

Json = dict[str, Any]

BPS = 10_000.0
FEE_BPS = 5.0       # Limen's long_flat_strategy defaults
SLIP_BPS = 5.0
MAX_MEMBERS = 200
_ROUND_ID = re.compile(rb'^\{"round_id": "([^"]+)"')


def _epoch(text: object, what: str) -> int:
    if not isinstance(text, str):
        raise ValueError("%s is not a time" % what)
    try:
        return int(datetime.fromisoformat(text).timestamp())
    except ValueError as err:
        raise ValueError("%s is not a time: %r" % (what, text)) from err


def bar_times(rec: Json, step: int) -> list[int]:
    """The times of a round's test bars (seconds since the epoch): every
    bar from its window's first to its last at the data's bar interval,
    less those it dropped; refused when they do not number its arrays."""
    raw: Any = rec.get("alignment")
    if not isinstance(raw, dict):
        raise ValueError("round %s recorded no alignment" % _rid(rec))
    a = cast(Json, raw)
    first = _epoch(a.get("first_test_datetime"), "first_test_datetime")
    last = _epoch(a.get("last_test_datetime"), "last_test_datetime")
    dropped: Any = a.get("missing_datetimes") or []
    if not isinstance(dropped, list):
        raise ValueError("round %s: missing_datetimes is not a list"
                         % _rid(rec))
    gone = {_epoch(t, "a missing datetime")
            for t in cast(list[Any], dropped)}
    times = [t for t in range(first, last + step, step) if t not in gone]
    n = len(_preds(rec))
    if len(times) != n:
        raise ValueError("round %s: its %d test bars are not the %d bars "
                         "between its first and last test bar less those it "
                         "dropped (a gap in the data?)"
                         % (_rid(rec), n, len(times)))
    return times


def _rid(rec: Json) -> str:
    return str(rec.get("round_id") or "?")[:12]


def _numbers(v: Any, what: str, rec: Json,
             nulls: bool = False) -> list[Any]:
    values = cast(list[Any], v) if isinstance(v, list) else None
    if values is None or not all(
            (x is None and nulls) or (isinstance(x, (int, float))
                                      and not isinstance(x, bool)
                                      and math.isfinite(x))
            for x in values):
        raise ValueError("round %s: %s is not a list of numbers"
                         % (_rid(rec), what))
    return values


def _preds(rec: Json) -> list[int]:
    preds = _numbers(rec.get("preds"), "preds", rec)
    return [1 if p > 0.5 else 0 for p in preds]


def _probs(rec: Json) -> list[float] | None:
    probs: Any = rec.get("probs")
    if probs is None:
        return None
    values = _numbers(probs, "probs", rec)
    if not all(0.0 <= p <= 1.0 for p in values):
        raise ValueError("round %s: probs are not all within 0 and 1"
                         % _rid(rec))
    return [float(p) for p in values]


def _market(rec: Json, n: int) -> list[float | None]:
    raw: Any = rec.get("market")
    ret: Any = cast(Json, raw).get("ret") if isinstance(raw, dict) else None
    if ret is None:
        raise ValueError("round %s recorded no market returns (record its "
                         "execution with Limen 5.20 or later)" % _rid(rec))
    values = _numbers(ret, "market.ret", rec, nulls=True)
    if len(values) != n:
        raise ValueError("round %s: market.ret has %d bars, not %d"
                         % (_rid(rec), len(values), n))
    return [None if x is None else float(x) for x in values]


def long_flat(signal: list[int], ret: list[float | None], fee_bps: float,
              slip_bps: float, lag: int = 1
              ) -> tuple[list[float], list[float], list[float]]:
    """Limen's long-flat execution of a 0/1 signal over bars whose market
    return is ``ret`` (None where the bar cannot be traded): long on a bar
    when the signal ``lag`` bars before was 1 and the bar can be traded,
    earning the market's return; slippage moves the fill at entry and
    exit, and the fee is paid on the entry notional and the exit proceeds.
    Its per-bar position, gross and net return, as
    limen.backtest.long_flat_strategy computes them."""
    n = len(signal)
    fee = fee_bps / BPS
    slip = slip_bps / BPS
    pos = [(signal[i - lag] == 1 if i >= lag else False)
           and ret[i] is not None for i in range(n)]
    gross = [cast(float, ret[i]) if pos[i] else 0.0 for i in range(n)]
    net = [0.0] * n
    position = 1.0
    previous = 1.0      # the equity of the bar before
    for i in range(n):
        if not pos[i]:
            previous = 1.0
            continue
        entry = i == 0 or not pos[i - 1]
        leaving = i == n - 1 or not pos[i + 1]
        factor = 1.0 + gross[i]
        if entry:
            position = factor / (1.0 + slip)
        else:
            position *= factor
        equity = (position * (1.0 - fee) * (1.0 - slip) - fee if leaving
                  else position - fee)
        net[i] = equity / (1.0 if entry else previous) - 1.0
        previous = equity
    return [1.0 if p else 0.0 for p in pos], gross, net


def _param(rec: Json, key: str) -> Any:
    params: Any = rec.get("round_params")
    return cast(Json, params).get(key) if isinstance(params, dict) else None


def costs_of(records: list[Json]) -> tuple[float, float]:
    """The fee and slippage the members ran with: the most common pair of
    ``fee_bps`` and ``slip_bps`` among their parameters, else Limen's
    defaults."""
    seen: dict[tuple[float, float], int] = {}
    for rec in records:
        fee, slip = _param(rec, "fee_bps"), _param(rec, "slip_bps")
        pair = (float(fee) if isinstance(fee, (int, float)) else FEE_BPS,
                float(slip) if isinstance(slip, (int, float)) else SLIP_BPS)
        seen[pair] = seen.get(pair, 0) + 1
    if not seen:
        return FEE_BPS, SLIP_BPS
    return max(seen.items(), key=lambda kv: (kv[1], -kv[0][0] - kv[0][1]))[0]


def judge(records: list[Json], step: int, fee_bps: float,
          slip_bps: float) -> Json:
    """The cohort of ``records`` (round lines of one run) over the bars
    they share: its signal (the members' mean probability over 0.5, or the
    mean of their votes over 0.5 when they recorded no probabilities), and
    the cohort and each member executed alike, each over the whole window
    and its halves."""
    if not records:
        raise ValueError("a cohort has at least one member")
    if len(records) > MAX_MEMBERS:
        raise ValueError("a cohort of at most %d members" % MAX_MEMBERS)
    if not (math.isfinite(fee_bps) and math.isfinite(slip_bps)
            and 0 <= fee_bps < BPS and 0 <= slip_bps < BPS):
        raise ValueError("the fee and slippage are basis points from 0")
    series = []
    for rec in records:
        times = bar_times(rec, step)
        series.append((times, _preds(rec), _probs(rec),
                       _market(rec, len(times))))
    shared = set(series[0][0])
    for times, _, _, _ in series[1:]:
        shared &= set(times)
    bars = sorted(shared)
    if len(bars) < 2:
        raise ValueError("the members share fewer than two test bars")
    weighted = all(s[2] is not None for s in series)
    at = [{t: j for j, t in enumerate(s[0])} for s in series]
    ret = [series[0][3][at[0][t]] for t in bars]
    signal: list[int] = []
    for t in bars:
        if weighted:
            mean = sum(cast(list[float], s[2])[at[k][t]]
                       for k, s in enumerate(series)) / len(series)
        else:
            mean = sum(s[1][at[k][t]]
                       for k, s in enumerate(series)) / len(series)
        signal.append(1 if mean > 0.5 else 0)
    cohort = windows(*long_flat(signal, ret, fee_bps, slip_bps), ret)
    members = []
    for k, rec in enumerate(records):
        own = [series[k][1][at[k][t]] for t in bars]
        members.append({"id": rec.get("round_id"),
                        **windows(*long_flat(own, ret, fee_bps, slip_bps),
                                  ret)})
    notes = []
    exits = sum(1 for rec in records
                if _param(rec, "take_profit_bps") is not None
                or _param(rec, "stop_loss_bps") is not None)
    if exits:
        notes.append("%d of the %d members exit by take-profit or "
                     "stop-loss, which is not rebuilt here (the run does "
                     "not record the prices it needs): every series is "
                     "long while its signal is" % (exits, len(records)))
    calibrated = {bool(_param(rec, "use_calibration")) for rec in records}
    if weighted and len(calibrated) > 1:
        notes.append("calibrated and uncalibrated members' probabilities "
                     "are averaged together, as Limen's Cohort averages "
                     "them")
    return {"bars": len(bars), "first": bars[0], "last": bars[-1],
            "step": step, "fee": fee_bps, "slip": slip_bps,
            "aggregation": ("probability_weighted" if weighted
                            else "majority_vote"),
            "fired": sum(signal) / len(signal),
            "cohort": cohort, "members": members, "notes": notes}


def bar_step(experiment: Json) -> int:
    """The data's bar interval in seconds, from the manifest's data
    source (``kline_size``)."""
    manifest: Any = experiment.get("manifest")
    sfd: Any = cast(Json, manifest).get("sfd") if isinstance(
        manifest, dict) else None
    inner: Any = cast(Json, sfd).get("manifest") if isinstance(
        sfd, dict) else None
    source: Any = cast(Json, inner).get("data_source") if isinstance(
        inner, dict) else None
    params: Any = cast(Json, source).get("params") if isinstance(
        source, dict) else None
    size: Any = cast(Json, params).get("kline_size") if isinstance(
        params, dict) else None
    if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
        raise ValueError("the manifest names no bar interval "
                         "(sfd.manifest.data_source.params.kline_size)")
    return size


class RoundLines:
    """Rounds' lines in result directories' round_data.jsonl, found by
    their round id: where each line starts is learned once, and read on
    as the file grows (a round's line is written whole and never
    changes)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # path -> (inode, bytes read, round id -> offset)
        self.seen: dict[str, tuple[int, int, dict[str, int]]] = {}

    def _offsets(self, path: str) -> dict[str, int]:
        st = os.stat(path)
        with self.lock:
            ino, read, offsets = self.seen.get(path, (st.st_ino, 0, {}))
            if ino != st.st_ino or st.st_size < read:
                read, offsets = 0, {}
            if st.st_size > read:
                offsets = dict(offsets)
                with open(path, "rb") as f:
                    f.seek(read)
                    at = read
                    for line in f:
                        if not line.endswith(b"\n"):
                            break       # a line still being written
                        m = _ROUND_ID.match(line)
                        rid = m.group(1).decode() if m else None
                        if rid is None and line.strip():
                            loaded: Any = json.loads(line)
                            got: Any = cast(Json, loaded).get(
                                "round_id") if isinstance(loaded,
                                                          dict) else None
                            rid = got if isinstance(got, str) else None
                        if rid is not None:
                            offsets[rid] = at
                        at += len(line)
                    read = at
            self.seen[path] = (st.st_ino, read, offsets)
            return offsets

    def get(self, directory: str, round_id: str) -> Json:
        path = os.path.join(directory, "round_data.jsonl")
        offsets = self._offsets(path)
        if round_id not in offsets:
            raise ValueError("round %s is not in %s" % (round_id[:12], path))
        with open(path, "rb") as f:
            f.seek(offsets[round_id])
            loaded: Any = json.loads(f.readline())
        if not isinstance(loaded, dict):
            raise ValueError("round %s's line is not an object"
                             % round_id[:12])
        return cast(Json, loaded)
