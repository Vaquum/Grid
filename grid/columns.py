"""Columnar store for sweep result rows.

Rows arrive as JSON objects, one per line. Each row is flattened into named
fields and appended to typed columns. The encoding is lossless in value:

- numbers keep their exact value: they are sent as the shortest text that
  round-trips (``json.dumps``), which JavaScript's ``JSON.parse`` reads back
  to the same double; NaN and the infinities, which JSON cannot carry, are
  sent as the strings "NaN", "Infinity" and "-Infinity";
- strings keep their exact text through a per-column dictionary;
- a list of strings becomes a set column over a member dictionary;
- a short list of numbers becomes one numeric column per position;
- any other value keeps its canonical JSON text through a dictionary.

A field can be **null** (present, value null: ``"tp": null`` means no
take-profit) or **absent** (the row has no such key: ``hpcfg.max_depth`` on
a logreg row). Both are kept apart: codes -1 and -2, or ``null`` and
``"~"`` in raw data.

A column's kind is fixed by its first non-null value. A later value of
another kind converts the column to ``json`` (earlier values are re-encoded
by value, nothing is dropped) and the change is recorded in ``events`` so
the page can say so.
"""

from __future__ import annotations

import json
import math
from array import array
from typing import Any, Iterator, cast

NUM = "num"
BOOL = "bool"
STR = "str"
SET = "set"
JSON = "json"

NULL_CODE = -1
ABSENT_CODE = -2
ABSENT_TEXT = "~"

MAX_DEPTH = 3          # dict nesting flattened into dotted names
MAX_NUM_LIST = 8       # longest list of numbers split into positional columns
DICT_CAP = 256         # distinct numbers kept for dictionary encoding
SAFE_INT = 2 ** 53     # larger integers are not exact as doubles

# A flattened value: a JSON scalar, ("set", [members]) or ("json", text).
Flat = Any
Exported = dict[str, Any]


class _Absent:
    def __repr__(self) -> str:
        return "ABSENT"


ABSENT = _Absent()


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def canonical(v: object) -> str:
    """Canonical JSON text of a value (sorted keys, no spaces)."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


def flatten(row: dict[str, Any], prefix: str = "",
            out: dict[str, Flat] | None = None,
            depth: int = 0) -> dict[str, Flat]:
    """Flatten one result row into {name: value}.

    Values are scalars, ``("set", [str, ...])`` for string lists, or
    ``("json", text)`` for values kept as canonical JSON text.
    """
    if out is None:
        out = {}
    for key, v in row.items():
        name = prefix + str(key)
        if isinstance(v, dict):
            sub = cast(dict[str, Any], v)
            if sub and depth < MAX_DEPTH:
                flatten(sub, name + ".", out, depth + 1)
            else:
                out[name] = ("json", canonical(sub))
        elif isinstance(v, list):
            items = cast(list[Any], v)
            if all(isinstance(x, str) for x in items):
                out[name] = ("set", items)
            elif items and len(items) <= MAX_NUM_LIST and \
                    all(_is_num(x) for x in items):
                for i, x in enumerate(items):
                    out["%s.%d" % (name, i)] = x
            else:
                out[name] = ("json", canonical(items))
        else:
            out[name] = v
    return out


def kind_of(v: Flat) -> str | None:
    """The column kind a flattened value belongs to (None for null)."""
    t = type(cast(object, v))
    if t is float:
        return NUM
    if t is str:
        return STR
    if t is int:
        return NUM if -SAFE_INT <= v <= SAFE_INT else JSON
    if t is bool:
        return BOOL
    if v is None:
        return None
    if t is tuple:
        tag = cast(tuple[str, Any], v)[0]
        return SET if tag == "set" else JSON
    return JSON


def num_text(f: float) -> float | int | str:
    """A double as the page receives it."""
    if math.isnan(f):
        return "NaN"
    if math.isinf(f):
        return "Infinity" if f > 0 else "-Infinity"
    if f == 0.0 and math.copysign(1.0, f) < 0:
        return -0.0
    if f.is_integer() and abs(f) <= SAFE_INT:
        return int(f)
    return f


class Column:
    """One field's values for every row so far."""

    def __init__(self, name: str, kind: str) -> None:
        self.name = name
        self.kind = kind
        self.nonnull = 0
        self.levels: list[str] = []         # str/json dictionary, set members
        self.level_rows = array("q")        # row where each level first came
        self.index: dict[str, int] = {}     # level -> code
        self.n = 0                          # rows held
        self.seen: set[float] = set()       # distinct non-zero numbers
        self.zeros: set[float] = set()      # 0.0 and/or -0.0, kept apart
        self.dict_ok = True                 # numeric column fits DICT_CAP
        self.nums = array("d")              # NUM values
        self.state = bytearray()            # NUM: 0 value, 1 null, 2 absent
        self.codes = array("i")             # BOOL 0/1, STR/JSON code; -1/-2
        self.masks: list[int | None] = []   # SET bitmask; None null; -1 absent

    def __len__(self) -> int:
        return self.n

    def code(self, text: str) -> int:
        c = self.index.get(text)
        if c is None:
            c = len(self.levels)
            self.levels.append(text)
            self.level_rows.append(self.n)
            self.index[text] = c
        return c

    def levels_before(self, rows: int) -> int:
        """How many dictionary entries existed once ``rows`` rows were in."""
        lo, hi = 0, len(self.level_rows)
        while lo < hi:
            mid = (lo + hi) // 2
            if self.level_rows[mid] < rows:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def pad(self, n: int, absent: bool = True) -> None:
        """Append n absent (or null) entries."""
        if n <= 0:
            return
        self.n += n
        if self.kind == NUM:
            self.nums.extend([0.0] * n)
            self.state.extend((b"\x02" if absent else b"\x01") * n)
        elif self.kind == SET:
            self.masks.extend([-1 if absent else None] * n)
        else:
            self.codes.extend([ABSENT_CODE if absent else NULL_CODE] * n)

    def push(self, v: Flat) -> None:
        """Append one value of this column's kind, None, or ABSENT."""
        if v is ABSENT:
            self.pad(1, absent=True)
            return
        if v is None:
            self.pad(1, absent=False)
            return
        self.nonnull += 1
        k = self.kind
        if k == NUM:
            f = float(v)
            self.nums.append(f)
            self.state.append(0)
            if self.dict_ok:
                if f == 0.0:
                    self.zeros.add(math.copysign(1.0, f))
                elif f - f == 0.0:   # finite
                    seen = self.seen
                    if f not in seen:
                        seen.add(f)
                        if len(seen) + len(self.zeros) > DICT_CAP:
                            self.dict_ok = False
                            self.seen = set()
                else:                # NaN or an infinity: no dictionary
                    self.dict_ok = False
                    self.seen = set()
        elif k == BOOL:
            self.codes.append(1 if v else 0)
        elif k == STR:
            self.codes.append(self.code(str(v)))
        elif k == JSON:
            text = cast(tuple[str, str], v)[1] if isinstance(v, tuple) \
                else canonical(v)
            self.codes.append(self.code(text))
        else:
            mask = 0
            for m in cast(tuple[str, list[str]], v)[1]:
                mask |= 1 << self.code(m)
            self.masks.append(mask)
        # only now: a new dictionary entry above records this row as its first
        self.n += 1

    def value_at(self, i: int) -> Flat:
        """Row i's value in flattened form, None, or ABSENT."""
        k = self.kind
        if k == NUM:
            s = self.state[i]
            return ABSENT if s == 2 else None if s == 1 else \
                num_text(self.nums[i])
        if k == SET:
            mask = self.masks[i]
            if mask is None:
                return None
            if mask < 0:
                return ABSENT
            return ("set", [m for j, m in enumerate(self.levels)
                            if mask >> j & 1])
        c = self.codes[i]
        if c == ABSENT_CODE:
            return ABSENT
        if c == NULL_CODE:
            return None
        if k == BOOL:
            return bool(c)
        if k == STR:
            return self.levels[c]
        return ("json", self.levels[c])

    def export(self, lo: int, hi: int, level_base: int = 0,
               compact: bool = True) -> Exported:
        """Encode rows [lo, hi) for the page.

        ``level_base`` is how many dictionary entries the receiver already
        holds; only newer entries are sent. ``compact`` allows dictionary
        encoding of a numeric column (used for whole exports, never for
        deltas, whose dictionary would reorder).
        """
        out: Exported = {"name": self.name, "kind": self.kind}
        k = self.kind
        if k == NUM:
            nums, state = self.nums, self.state
            if compact and self.dict_ok:
                # negatives, then -0.0 and/or 0.0 (kept apart), positives
                vals = ([v for v in sorted(self.seen) if v < 0] +
                        [math.copysign(0.0, z) for z in sorted(self.zeros)] +
                        [v for v in sorted(self.seen) if v > 0])
                pos = {v: c for c, v in enumerate(vals) if v != 0.0}
                zpos = {math.copysign(1.0, v): c for c, v in enumerate(vals)
                        if v == 0.0}
                out["levels"] = [num_text(v) for v in vals]
                codes: list[int] = []
                for i in range(lo, hi):
                    st = state[i]
                    if st:
                        codes.append(-st)
                        continue
                    f = nums[i]
                    codes.append(pos[f] if f != 0.0 else
                                 zpos[math.copysign(1.0, f)])
                out["codes"] = codes
            else:
                out["data"] = [num_text(nums[i]) if state[i] == 0 else
                               None if state[i] == 1 else ABSENT_TEXT
                               for i in range(lo, hi)]
        elif k == SET:
            out["levelBase"] = level_base
            out["levels"] = self.levels[level_base:]
            out["data"] = [None if m is None else ABSENT_TEXT if m < 0
                           else format(m, "x") for m in self.masks[lo:hi]]
        else:
            if k != BOOL:
                out["levelBase"] = level_base
                out["levels"] = self.levels[level_base:]
            out["data"] = self.codes[lo:hi].tolist()
        return out


class Store:
    """All columns of one run, rows in arrival order."""

    def __init__(self) -> None:
        self.columns: dict[str, Column] = {}
        self.order: list[str] = []
        self.rows = 0
        self.events: list[dict[str, Any]] = []   # schema changes

    def append(self, row: object) -> None:
        """Append one parsed JSON row (it must be a JSON object)."""
        if not isinstance(row, dict):
            raise ValueError("row %d is a JSON %s, not an object"
                             % (self.rows, type(row).__name__))
        i = self.rows
        columns = self.columns
        for name, v in flatten(cast(dict[str, Any], row)).items():
            kind = kind_of(v)
            col = columns.get(name)
            if col is None:
                col = Column(name, kind or NUM)
                col.pad(i)
                columns[name] = col
                self.order.append(name)
                if i:
                    self.events.append({"row": i, "column": name,
                                        "event": "added", "kind": col.kind})
            elif kind is not None and kind != col.kind:
                if col.nonnull == 0:
                    # nulls only so far: take the kind of the first value
                    new = Column(name, kind)
                    for j in range(col.n):
                        new.push(col.value_at(j))
                    columns[name] = col = new
                else:
                    col.pad(i - col.n)
                    col = self._to_json(col, i)
            gap = i - col.n
            if gap > 0:
                col.pad(gap)     # absent from the rows since its last value
            elif gap < 0:
                raise ValueError("row %d repeats field %r" % (i, name))
            col.push(v)
        self.rows = i + 1

    def level(self) -> None:
        """Pad every column to the row count (columns catch up lazily)."""
        for col in self.columns.values():
            col.pad(self.rows - col.n)

    def take(self, rows: list[int]) -> Store:
        """A store of these rows only, in this order, value for value."""
        self.level()
        out = Store()
        for name in self.order:
            col = self.columns[name]
            new = Column(name, col.kind)
            for i in rows:
                new.push(col.value_at(i))
            out.columns[name] = new
            out.order.append(name)
        out.rows = len(rows)
        return out

    def _to_json(self, col: Column, row: int) -> Column:
        new = Column(col.name, JSON)
        for j in range(len(col)):
            v = col.value_at(j)
            if v is None or v is ABSENT or isinstance(v, tuple):
                new.push(v)
            else:
                new.push(("json", canonical(v)))
        self.columns[col.name] = new
        self.events.append({"row": row, "column": col.name, "event": "kind",
                            "from": col.kind, "kind": JSON})
        return new

    def export(self, lo: int = 0, hi: int | None = None,
               compact: bool = True) -> list[Exported]:
        """Encode rows [lo, hi) of every column.

        Dictionary entries are sent from the first one the receiver lacks: a
        receiver holding rows [0, lo) holds exactly the entries that first
        appeared in them. A column the receiver does not know yet arrives
        with rows [lo, hi) only; its earlier rows are absent.
        """
        self.level()
        end = self.rows if hi is None else hi
        out: list[Exported] = []
        for n in self.order:
            col = self.columns[n]
            base = col.levels_before(lo) if col.kind in (STR, JSON, SET) \
                else 0
            out.append(col.export(lo, end, base, compact))
        return out

    def export_iter(self, lo: int = 0, hi: int | None = None,
                    compact: bool = True) -> Iterator[str]:
        """The export as JSON text, one column at a time (a column's values
        exist as Python objects only while it is being written)."""
        self.level()
        end = self.rows if hi is None else hi
        for n in self.order:
            col = self.columns[n]
            base = col.levels_before(lo) if col.kind in (STR, JSON, SET) \
                else 0
            yield json.dumps(col.export(lo, end, base, compact),
                             separators=(",", ":"))

    def row_object(self, i: int) -> dict[str, Any]:
        """Row i rebuilt from its columns (value-exact, absent keys left
        out)."""
        if not 0 <= i < self.rows:
            raise IndexError("row %d is outside 0..%d" % (i, self.rows - 1))
        self.level()
        root: dict[str, Any] = {}
        for n in self.order:
            v = self.columns[n].value_at(i)
            if v is ABSENT:
                continue
            if isinstance(v, tuple):
                tag, payload = cast(tuple[str, Any], v)
                v = payload if tag == "set" else json.loads(str(payload))
            parts = n.split(".")
            node = root
            for p in parts[:-1]:
                nxt = node.get(p)
                if not isinstance(nxt, dict):
                    nxt = {}
                    node[p] = nxt
                node = cast(dict[str, Any], nxt)
            node[parts[-1]] = v
        return cast(dict[str, Any], _lists(root))


def _lists(node: Any) -> Any:
    """Turn dicts keyed "0".."k-1" (split number lists) back into lists."""
    if isinstance(node, dict):
        d = cast(dict[str, Any], node)
        keys = list(d)
        if keys and keys == [str(i) for i in range(len(keys))]:
            return [_lists(d[k]) for k in keys]
        return {k: _lists(v) for k, v in d.items()}
    return node
