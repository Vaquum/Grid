"""Lossless shared evidence and versioned native reductions.

Content identities include numeric types, null masks and float64 bits. The
SQLite cache is bounded; decoded objects have a separate byte-bounded LRU.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
import sys
import threading
import zlib
from array import array
from collections import OrderedDict
from collections.abc import Callable, Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

from .limen import (
    RoundSummary,
    execution_summary,
    model_outputs,
    round_object,
)
from .round_storage import MEMBER_LIMIT, Json, read_local, restore

DIGEST = re.compile(r"[0-9a-f]{64}\Z")
VECTOR_PATHS = (
    "preds",
    "probs",
    "execution.pos",
    "execution.gross",
    "execution.net",
    "market.ret",
)
CONTRACT = hashlib.sha256(
    Path(__file__).with_name("limen.py").read_bytes() + sys.version.encode()
).hexdigest()


def encoded(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(encoded(value)).hexdigest()


def pack_vector(values: list[Any]) -> tuple[str, bytes]:
    """Preserve JSON element types; never coerce mixed integers to doubles."""
    n = len(values)
    if all(type(v) is int and v in (0, 1) for v in values):
        bits = bytearray((n + 7) // 8)
        for i, v in enumerate(values):
            bits[i // 8] |= v << (i % 8)
        return "bits", bytes(bits)
    if all(v is None or type(v) is float for v in values):
        missing = bytearray((n + 7) // 8)
        numbers = array("d")
        for i, v in enumerate(values):
            if v is None:
                missing[i // 8] |= 1 << (i % 8)
            numbers.append(0.0 if v is None else v)
        if sys.byteorder != "little":
            numbers.byteswap()
        return "f64", bytes(missing) + numbers.tobytes()
    return "json", encoded(values)


def identity(kind: str, n: int, raw: bytes) -> str:
    h = hashlib.sha256((kind + ":" + str(n) + ":").encode())
    h.update(raw)
    return h.hexdigest()


def vector_digest(values: list[Any]) -> str:
    kind, raw = pack_vector(values)
    return identity(kind, len(values), raw)


def record_digest(record: Json) -> str:
    """Merkle identity avoids serializing large numeric arrays as text."""
    base = dict(record)
    vectors: Json = {}
    for path in VECTOR_PATHS:
        parts = path.split(".")
        parent: Any = base if len(parts) == 1 else base.get(parts[0])
        if not isinstance(parent, dict):
            continue
        name = parts[-1]
        values: Any = cast(Json, parent).get(name)
        if isinstance(values, list):
            vectors[path] = vector_digest(cast(list[Any], values))
            copied = dict(cast(Json, parent))
            copied.pop(name)
            if len(parts) == 1:
                base = copied
            else:
                base[parts[0]] = copied
    return digest([base, vectors])


def _compress(kind: str, n: int, raw: bytes) -> bytes:
    if kind == "f64":
        cut = (n + 7) // 8
        numbers = raw[cut:]
        raw = raw[:cut] + b"".join(numbers[i::8] for i in range(8))
    return zlib.compress(raw, 6)


def _expand(kind: str, n: int, wire: bytes) -> bytes:
    decoder = zlib.decompressobj()
    try:
        raw = decoder.decompress(wire, MEMBER_LIMIT + 1)
    except zlib.error as exc:
        raise ValueError("Corrupt retained object") from exc
    if len(raw) > MEMBER_LIMIT or not decoder.eof or decoder.unused_data:
        raise ValueError("Corrupt or oversized retained object")
    if kind == "f64":
        cut = (n + 7) // 8
        if len(raw) != cut + n * 8:
            raise ValueError("Retained float64 shape mismatch")
        numbers = bytearray(n * 8)
        for i in range(8):
            numbers[i::8] = raw[cut + i * n : cut + (i + 1) * n]
        raw = raw[:cut] + numbers
    return bytes(raw)


def unpack_vector(kind: str, n: int, raw: bytes) -> list[Any]:
    cut = (n + 7) // 8
    if kind == "bits":
        if len(raw) != cut:
            raise ValueError("Retained bit-vector shape mismatch")
        return [(raw[i // 8] >> (i % 8)) & 1 for i in range(n)]
    if kind == "f64":
        if len(raw) != cut + n * 8:
            raise ValueError("Retained float64 shape mismatch")
        numbers = array("d")
        numbers.frombytes(raw[cut:])
        if sys.byteorder != "little":
            numbers.byteswap()
        return [
            None if raw[i // 8] & (1 << (i % 8)) else v
            for i, v in enumerate(numbers)
        ]
    value: Any = json.loads(raw)
    if (
        kind != "json"
        or not isinstance(value, list)
        or len(cast(list[Any], value)) != n
    ):
        raise ValueError("Retained vector type or shape mismatch")
    return cast(list[Any], value)


def wire_vector(values: list[Any]) -> list[Any]:
    kind, raw = pack_vector(values)
    return [
        kind,
        len(values),
        base64.b64encode(_compress(kind, len(values), raw)).decode("ascii"),
    ]


def read_wire_vector(value: Any) -> list[Any]:
    if not isinstance(value, list) or len(cast(list[Any], value)) != 3:
        raise ValueError("Invalid replay vector envelope")
    kind, n, payload = cast(list[Any], value)
    if (
        kind not in ("bits", "f64", "json")
        or not isinstance(payload, str)
        or type(n) is not int
        or n < 0
        or n > MEMBER_LIMIT
    ):
        raise ValueError("Invalid replay vector shape")
    raw = _expand(kind, n, base64.b64decode(payload, validate=True))
    return unpack_vector(kind, n, raw)


class LRU:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.size = 0
        self.values: OrderedDict[str, tuple[Any, int]] = OrderedDict()

    def get(self, key: str) -> Any:
        if key not in self.values:
            return None
        value = self.values.pop(key)
        self.values[key] = value
        return value[0]

    def put(self, key: str, value: Any, size: int) -> None:
        if key in self.values:
            self.size -= self.values.pop(key)[1]
        while self.values and self.size + size > self.limit:
            self.size -= self.values.popitem(last=False)[1][1]
        if size <= self.limit:
            self.values[key] = value, size
            self.size += size


class Evidence:
    """One shared store; run publication is a separate, final commit point."""

    def __init__(
        self,
        path: str | Path,
        *,
        writable: bool = False,
        cache_bytes: int = 64 << 20,
    ) -> None:
        self.path = Path(path).resolve()
        self.lock = threading.RLock()
        self.cache = LRU(cache_bytes)
        self.writable = writable
        if writable:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(
                self.path, timeout=30, check_same_thread=False
            )
            self.db.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS objects (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
                    n INTEGER NOT NULL, data BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS summaries (
                    id TEXT PRIMARY KEY, data BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS archives (
                    id TEXT PRIMARY KEY, state TEXT NOT NULL, run TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS refs (
                    archive TEXT NOT NULL, object TEXT NOT NULL,
                    PRIMARY KEY (archive, object));
                CREATE TABLE IF NOT EXISTS model_jobs (
                    id TEXT PRIMARY KEY, prep TEXT NOT NULL,
                    data BLOB NOT NULL, recipe TEXT);
                CREATE TABLE IF NOT EXISTS artifact_recipes (
                    runtime TEXT NOT NULL, kind TEXT NOT NULL,
                    identity TEXT NOT NULL, recipe TEXT NOT NULL,
                    PRIMARY KEY (runtime, kind, identity));
                CREATE TABLE IF NOT EXISTS round_index (
                    archive TEXT NOT NULL, occurrence INTEGER NOT NULL,
                    round_id TEXT, offset INTEGER NOT NULL,
                    PRIMARY KEY (archive, occurrence));
                CREATE INDEX IF NOT EXISTS round_lookup
                    ON round_index(archive, round_id, occurrence DESC);
                CREATE TABLE IF NOT EXISTS info (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT OR IGNORE INTO info VALUES ('format', '1');
            """)
            self.db.commit()
        else:
            self.db = sqlite3.connect(
                self.path.as_uri() + "?mode=ro",
                uri=True,
                timeout=30,
                check_same_thread=False,
            )
        self.db.execute("PRAGMA cache_size=-8192")
        row = self.db.execute(
            "SELECT value FROM info WHERE key='format'"
        ).fetchone()
        if row != ("1",):
            raise ValueError("Unknown evidence store format")

    def close(self) -> None:
        with self.lock:
            if self.writable:
                self.db.commit()
                self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.db.close()

    @contextmanager
    def batch(self) -> Generator[None, None, None]:
        with self.lock:
            try:
                yield
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def put(self, kind: str, n: int, raw: bytes) -> str:
        key = identity(kind, n, raw)
        with self.lock:
            if not self.db.execute(
                "SELECT 1 FROM objects WHERE id=?", (key,)
            ).fetchone():
                wire = _compress(kind, n, raw)
                if _expand(kind, n, wire) != raw:
                    raise ValueError("Lossless evidence codec failed")
                self.db.execute(
                    "INSERT INTO objects VALUES (?,?,?,?)",
                    (key, kind, n, wire),
                )
        return key

    def put_vector(self, values: list[Any]) -> str:
        kind, raw = pack_vector(values)
        return self.put(kind, len(values), raw)

    def get(self, key: str) -> tuple[str, int, bytes]:
        if not DIGEST.fullmatch(key):
            raise ValueError("Invalid retained object identity")
        with self.lock:
            row = self.db.execute(
                "SELECT kind,n,data FROM objects WHERE id=?", (key,)
            ).fetchone()
        if row is None:
            raise ValueError("Missing retained object " + key)
        kind, n, wire = cast(tuple[str, int, bytes], row)
        if n < 0 or n > MEMBER_LIMIT:
            raise ValueError("Invalid retained object size")
        raw = _expand(kind, n, wire)
        if identity(kind, n, raw) != key:
            raise ValueError("Retained object digest mismatch")
        return kind, n, raw

    def vector(self, key: str) -> list[Any]:
        with self.lock:
            saved: Any = self.cache.get(key)
            if saved is not None:
                return list(cast(tuple[Any, ...], saved))
            kind, n, raw = self.get(key)
            value = unpack_vector(kind, n, raw)
            self.cache.put(key, tuple(value), n * 40 + 256)
            return value

    def summary(self, key: str) -> Any:
        with self.lock:
            row = self.db.execute(
                "SELECT data FROM summaries WHERE id=?", (key,)
            ).fetchone()
        return json.loads(row[0]) if row is not None else None

    def save_summary(self, key: str, value: Any) -> None:
        with self.lock:
            self.db.execute(
                "INSERT OR IGNORE INTO summaries VALUES (?,?)",
                (key, encoded(value)),
            )


class Reducer:
    """Cache only successful native reductions under their complete inputs."""

    def __init__(
        self,
        evidence: Evidence | None = None,
        *,
        durable_each_round: bool = False,
    ) -> None:
        self.evidence = evidence
        self.memory = LRU(16 << 20)
        self.lock = threading.Lock()
        self.pending = 0
        self.durable_each_round = durable_each_round

    def _read(self, key: str) -> Any:
        with self.lock:
            value: Any = self.memory.get(key)
        if value is None and self.evidence is not None:
            value = self.evidence.summary(key)
        return value

    def _save(self, key: str, value: Any) -> None:
        with self.lock:
            self.memory.put(key, value, len(encoded(value)) * 4 + 256)
            if self.evidence is not None:
                self.evidence.save_summary(key, value)
                self.pending += 1
                if self.pending >= 64:
                    with self.evidence.lock:
                        self.evidence.db.commit()
                    self.pending = 0

    def reduce(self, record: Json) -> RoundSummary:
        # Validate occurrence metadata even when the large arrays are cached.
        shell = {
            k: v
            for k, v in record.items()
            if k not in ("probs", "execution", "market")
        }
        index, dropped, _, _ = round_object(shell)
        hashes: Json = {}
        for name in ("probs", "execution", "market"):
            value: Any = record.get(name)
            if isinstance(value, list):
                hashes[name] = vector_digest(cast(list[Any], value))
            elif isinstance(value, dict):
                hashes[name] = {
                    k: vector_digest(cast(list[Any], v))
                    if isinstance(v, list)
                    else v
                    for k, v in cast(Json, value).items()
                }
            else:
                hashes[name] = value
        model_key = digest(
            [
                CONTRACT,
                "model",
                hashes["probs"],
                record.get("optimal_threshold"),
                record.get("threshold_rule"),
            ]
        )
        execution_key = digest(
            [CONTRACT, "execution", hashes["execution"], hashes["market"]]
        )
        outputs: Any = self._read(model_key)
        fresh: list[tuple[str, Any]] = []
        if outputs is None:
            outputs = [model_outputs(record, index)]
            fresh.append((model_key, outputs))
        execution: Any = self._read(execution_key)
        if execution is None:
            execution = [execution_summary(record, index)]
            fresh.append((execution_key, execution))
        for key, value in fresh:
            self._save(key, value)
        if fresh and self.durable_each_round and self.evidence is not None:
            with self.evidence.lock:
                self.evidence.db.commit()
            self.pending = 0
        return index, dropped, outputs[0], execution[0]


class MarketCache:
    def __init__(self, limit: int = 16 << 20) -> None:
        self.memory = LRU(limit)
        self.lock = threading.Lock()

    def restore(
        self,
        record: Json,
        directory: str,
        read: Callable[[str], bytes] | None = None,
    ) -> Json:
        if "market_ref" not in record:
            return record
        ref: Any = record["market_ref"]
        if not isinstance(ref, str) or not DIGEST.fullmatch(ref):
            raise ValueError("Invalid market reference")
        key = ref
        with self.lock:
            market: Any = self.memory.get(key)
        if market is None:
            hydrated = restore(
                record, read or (lambda n: read_local(directory, n))
            )
            market = hydrated["market"]
            with self.lock:
                self.memory.put(key, market, len(market["ret"]) * 40 + 256)
            return hydrated
        preds: Any = record.get("preds")
        if "market" in record or (
            isinstance(preds, list)
            and len(cast(list[Any], preds)) != len(market["ret"])
        ):
            raise ValueError("Invalid market returns or prediction length")
        return {
            ("market" if k == "market_ref" else k): (
                market if k == "market_ref" else v
            )
            for k, v in record.items()
        }
