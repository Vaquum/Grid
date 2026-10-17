"""A cohort of a Limen run's rounds, judged on what the run recorded (the
Cohort view).

A Limen ``Cohort`` binds sensors of one experiment's rounds, all of one
architecture, and aggregates them on each bar as the architecture's name
says (limen/cohort/cohort.py): an architecture it knows to give
probabilities is ``probability_weighted``, its prediction the members' mean
probability over 0.5 (their own thresholds play no part); any other is
``majority_vote``, the mean of their votes over 0.5, each member voting for
a prediction above 0.5 (a regressor's, a predicted move above 0, as its
backtest trades it). A run that recorded its model outputs
(``uel.record_model_outputs``, Limen 5.17) keeps each round's test
probabilities and predictions bar by bar in ``round_data.jsonl``, and one
that recorded its execution (``uel.record_execution``) keeps the market's
return on each bar (``market.ret``, Limen 5.20). From them, the cohort the
members would make is rebuilt over the test window without training
anything: the members' bars aligned by time, aggregated as Limen's Cohort
aggregates them, and the signal executed as Limen executes one (limen/backtest/
long_flat_strategy.py: long while the signal of the bar before was 1, at
the fee and slippage given). Each member is executed the same way from its
own recorded predictions, so the cohort and its members are set side by
side on one execution, over the whole window and over each half of it.

The bars' times are not recorded; each round's are rebuilt from its test
window's first and last bar, at the data's bar interval, less the bars it
dropped (``alignment``), and checked against the length of its arrays.
Exits by take-profit or stop-loss need the bars' prices, which the run does
not record: they are not rebuilt (``notes`` says when members use them).
Nor does a member's predictor always predict what its round recorded:
price-line features find their lines on the history they are given, so
on other history their values, and the predictions, differ (``notes``
says when members use them).
"""

from __future__ import annotations

import bisect
import json
import math
import os
import re
import threading
from datetime import datetime, timezone
from typing import Any, cast

from .limen import windows
from .round_storage import RETAINED, frames, read_local, restore, round_path

Json = dict[str, Any]
# a member over its test window: its bars' times, its predictions (0/1, or
# a regressor's predicted moves), its probabilities (None when it recorded
# none) and the market's returns
Series = tuple[list[int], list[float], list[float] | None,
               list[float | None]]

BPS = 10_000.0
FEE_BPS = 5.0       # Limen's long_flat_strategy defaults
SLIP_BPS = 5.0
MAX_MEMBERS = 200
# Limen 5.20's Cohort: the round parameters it names a round's architecture
# by, and the hints in an architecture's name that it averages by
# probability (limen/cohort/cohort.py)
ARCHITECTURE_KEYS = ("architecture", "model_architecture", "_architecture",
                     "reference_architecture", "decoder_architecture",
                     "model_name")
PROBABILITY_HINTS = ("logreg", "tabpfn", "random_binary", "random forest",
                     "random_forest", "lightgbm", "lgbm", "ridge", "svm",
                     "hmm", "garch", "lstm", "cnn")
# features that find their lines on the history they are given
# (limen.features.price_lines, limen.features.quantile_price_lines)
LINE_FEATURES = re.compile(r"(^|\.)(quantile_)?price_lines$")
_ROUND_ID = re.compile(rb'^\{"round_id": "([^"]+)"')


def _epoch(text: object, what: str) -> int:
    if not isinstance(text, str):
        raise ValueError("%s is not a time" % what)
    try:
        value = datetime.fromisoformat(text)
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp())
    except ValueError as err:
        raise ValueError("%s is not a time: %r" % (what, text)) from err


def bar_times(rec: Json, step: int | None) -> list[int]:
    """The times of a round's test bars (seconds since the epoch): every
    bar from its window's first to its last at the data's bar interval,
    less those it dropped; refused when they do not number its arrays."""
    raw: Any = rec.get("alignment")
    if not isinstance(raw, dict):
        if rec.get("preds") is None:
            raise ValueError("round %s recorded no model outputs (record "
                             "them with uel.record_model_outputs, Limen "
                             "5.17 or later)" % _rid(rec))
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
    exact: Any = a.get("test_datetimes", rec.get("_grid_source_datetimes"))
    if exact is not None:
        if not isinstance(exact, list):
            raise ValueError("test_datetimes must be a list of timestamps")
        source = [_epoch(t, "a test datetime") for t in cast(list[Any], exact)]
        if any(b <= a for a, b in zip(source, source[1:], strict=False)):
            raise ValueError("test timestamps must be unique and increasing")
        bounded = [t for t in source if first <= t <= last]
        if not bounded or (first not in gone and bounded[0] != first) or \
                (last not in gone and bounded[-1] != last):
            raise ValueError("test timestamps do not match recorded alignment")
        times = [t for t in bounded if t not in gone]
    elif step is not None:
        times = [t for t in range(first, last + step, step) if t not in gone]
    else:
        raise ValueError("no recorded test timestamps; evaluate with a "
                         "Limen project and its original file source, or "
                         "record alignment.test_datetimes")
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


def _preds(rec: Json) -> list[float]:
    return [float(p) for p in _numbers(rec.get("preds"), "preds", rec)]


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


def _sfd_manifest(manifest: Json | None) -> Json:
    sfd: Any = manifest.get("sfd") if manifest else None
    inner: Any = cast(Json, sfd).get("manifest") if isinstance(
        sfd, dict) else None
    return cast(Json, inner) if isinstance(inner, dict) else {}


def architecture_of(rec: Json, manifest: Json | None,
                    sfd_module: str | None) -> str:
    """A round's architecture as Limen's Cohort names it: a round parameter
    naming it, else the manifest's reference architecture, else the run's
    sfd_module."""
    for key in ARCHITECTURE_KEYS:
        value = _param(rec, key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    ref: Any = _sfd_manifest(manifest).get("reference_architecture")
    if isinstance(ref, str) and ref.strip():
        return ref.strip()
    if isinstance(sfd_module, str) and sfd_module.strip():
        return sfd_module.strip()
    return "unknown_architecture"


def aggregation_of(architecture: str) -> str:
    """How Limen's Cohort aggregates members of an architecture."""
    name = architecture.strip().lower()
    return ("probability_weighted" if any(h in name
                                          for h in PROBABILITY_HINTS)
            else "majority_vote")


def vote_threshold(architecture: str) -> float:
    """The prediction above which a member is long, and votes so: a
    regressor's predicted move above 0 (as Limen's Cohort votes and its
    backtest trades it), else a prediction above 0.5."""
    return 0.0 if "regressor" in architecture.strip().lower() else 0.5


def line_features(rec: Json, manifest: Json | None) -> bool:
    """Whether a round used a price-line feature: one of the manifest's,
    included as Limen includes a feature (its include_if flag on, if it
    has one, and its group, if it has one, among the round's
    feature_groups: 'all', or none set, is every group)."""
    raw: Any = _sfd_manifest(manifest).get("features")
    groups: Any = _param(rec, "feature_groups")
    for entry in cast(list[Any], raw) if isinstance(raw, list) else []:
        if not isinstance(entry, dict):
            continue
        feature = cast(Json, entry)
        func: Any = feature.get("func")
        if not isinstance(func, str) or not LINE_FEATURES.search(func):
            continue
        params: Any = feature.get("params")
        args: Json = cast(Json, params) if isinstance(params, dict) else {}
        flag: Any = args.get("include_if") or feature.get("include_if")
        if isinstance(flag, str) and _param(rec, flag) is not True:
            continue
        group: Any = args.get("group") or feature.get("group")
        if (not isinstance(group, str) or groups is None or groups == "all"
                or (isinstance(groups, str) and group in groups.split("|"))):
            return True
    return False


def judge(records: list[Json], step: int | None, fee_bps: float,
          slip_bps: float, manifest: Json | None = None,
          sfd_module: str | None = None) -> Json:
    """The cohort of ``records`` (round lines of one run, whose manifest is
    ``manifest``) over the bars they share: its signal, aggregated as Limen's
    Cohort aggregates the members' architecture (their mean probability
    over 0.5, or the mean of their votes over 0.5), and the cohort and each
    member executed alike, each over the whole window and its halves.

    The halves are where every member's own halves agree. A member's needle
    was read on its own test window's halves (Limen's ordinal ones, its
    second half from its middle bar), so the second half here starts where
    the last member's own second half starts, and the first ends where the
    first member's own second half starts: no bar of the second half chose
    a member. Bars between the two, where the members' windows differ, are
    in neither half."""
    if not records:
        raise ValueError("a cohort has at least one member")
    if len(records) > MAX_MEMBERS:
        raise ValueError("a cohort of at most %d members" % MAX_MEMBERS)
    if not (math.isfinite(fee_bps) and math.isfinite(slip_bps)
            and 0 <= fee_bps < BPS and 0 <= slip_bps < BPS):
        raise ValueError("the fee and slippage are basis points from 0")
    kinds = sorted({architecture_of(rec, manifest, sfd_module)
                    for rec in records})
    if len(kinds) > 1:
        raise ValueError("a Limen Cohort's members are of one architecture; "
                         "these are of %d (%s)" % (len(kinds),
                                                    ", ".join(kinds)))
    architecture = kinds[0]
    aggregation = aggregation_of(architecture)
    weighted = aggregation == "probability_weighted"
    cut_at = vote_threshold(architecture)
    series: list[Series] = []
    for rec in records:
        times = bar_times(rec, step)
        series.append((times, _preds(rec), _probs(rec),
                       _market(rec, len(times))))
    # Limen records a round's probabilities with its model outputs (a
    # null for a model that gives none), and its predictions always
    unrecorded = sum(1 for rec in records if "probs" not in rec)
    none = sum(1 for rec in records if "probs" in rec
               and rec["probs"] is None)
    if weighted and (none or (unrecorded and cut_at == 0.0)):
        raise ValueError("Limen's Cohort averages the probabilities of %s's "
                         "members, and %s: its cohort cannot predict"
                         % (architecture, "a regressor's model gives none"
                            if cut_at == 0.0 else "%d of these %d rounds' "
                            "models gave none" % (none, len(records))))
    if weighted and unrecorded:
        raise ValueError("Limen's Cohort averages the probabilities of %s's "
                         "members, and %d of these %d rounds did not record "
                         "them (record them with uel.record_model_outputs, "
                         "Limen 5.17 or later)"
                         % (architecture, unrecorded, len(records)))
    shared: set[int] = set(series[0][0])
    for s in series[1:]:
        shared &= set(s[0])
    bars = sorted(shared)
    if len(bars) < 2:
        raise ValueError("the members share fewer than two test bars")
    at: list[dict[int, int]] = [{t: j for j, t in enumerate(s[0])}
                                for s in series]
    ret: list[float | None] = [series[0][3][at[0][t]] for t in bars]
    signal: list[int] = []
    for t in bars:
        if weighted:
            mean = sum(cast(list[float], s[2])[at[k][t]]
                       for k, s in enumerate(series)) / len(series)
        else:
            mean = sum(1 if s[1][at[k][t]] > cut_at else 0
                       for k, s in enumerate(series)) / len(series)
        signal.append(1 if mean > 0.5 else 0)
    starts = [s[0][len(s[0]) // 2] for s in series]
    cut = (bisect.bisect_left(bars, min(starts)),
           bisect.bisect_left(bars, max(starts)))
    cohort = windows(*long_flat(signal, ret, fee_bps, slip_bps), ret, cut)
    members: list[Json] = []
    for k, rec in enumerate(records):
        own = [1 if series[k][1][at[k][t]] > cut_at else 0 for t in bars]
        members.append({"id": rec.get("round_id"),
                        **windows(*long_flat(own, ret, fee_bps, slip_bps),
                                  ret, cut)})
    notes: list[str] = []
    if cut[1] > cut[0]:
        notes.append("The members' test windows differ: %d bars, in the "
                     "first half of some members and the second of others, "
                     "are in neither half, so no bar of the second half "
                     "chose a member." % (cut[1] - cut[0]))
    exits = sum(1 for rec in records
                if _param(rec, "take_profit_bps") is not None
                or _param(rec, "stop_loss_bps") is not None)
    if exits:
        notes.append("%d of the %d members exit by take-profit or "
                     "stop-loss, which is not rebuilt here (the run does "
                     "not record the prices it needs): here each is long "
                     "on every bar after a 1, so their figures differ from "
                     "those their rounds recorded. The cohort, its best "
                     "member and its members' mean are rebuilt alike."
                     % (exits, len(records)))
    calibrated = {bool(_param(rec, "use_calibration")) for rec in records}
    if weighted and len(calibrated) > 1:
        notes.append("Calibrated and uncalibrated members' probabilities "
                     "are averaged together, as Limen's Cohort averages "
                     "them.")
    lines = sum(1 for rec in records if line_features(rec, manifest))
    if lines:
        notes.append("%d of the %d members use price-line features, which "
                     "find their lines on the history they are given: on "
                     "other history than their rounds had, as when they "
                     "predict live, their predictions can differ from "
                     "those recorded and judged here."
                     % (lines, len(records)))
    return {"bars": len(bars), "first": bars[0], "last": bars[-1],
            "between": cut[1] - cut[0],
            "step": step, "fee": fee_bps, "slip": slip_bps,
            "architecture": architecture, "aggregation": aggregation,
            "fired": sum(signal) / len(signal),
            "cohort": cohort, "members": members, "notes": notes}


def bar_step(experiment: Json) -> int | None:
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
        return None
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
                    for line, at, end in frames(
                            f, compact=path.endswith(".gz")):
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
                        read = end
            self.seen[path] = (st.st_ino, read, offsets)
            return offsets

    def get(self, directory: str, round_id: str) -> Json:
        path = round_path(directory)
        if os.path.basename(path) == RETAINED:
            from .retention import Reader
            reader = Reader(directory)
            try:
                return reader.get(round_id)
            finally:
                reader.close()
        offsets = self._offsets(path)
        if round_id not in offsets:
            raise ValueError("round %s is not in %s" % (round_id[:12], path))
        with open(path, "rb") as f:
            f.seek(offsets[round_id])
            frame = next(frames(f, compact=path.endswith(".gz")), None)
            if frame is None:
                raise ValueError("round %s is no longer in %s"
                                 % (round_id[:12], path))
            loaded: Any = json.loads(frame[0])
        if not isinstance(loaded, dict):
            raise ValueError("round %s's line is not an object"
                             % round_id[:12])
        return restore(cast(Json, loaded),
                       lambda name: read_local(directory, name))
