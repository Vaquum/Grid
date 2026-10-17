"""Limen's gzip-jsonl-v1 wire format, without importing its runtime.

Offsets count compressed bytes. Publish a round only after its gzip trailer
validates; an unfinished last member can arrive in a later poll.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import zlib
from collections.abc import Callable, Iterable, Iterator
from typing import Any, BinaryIO, cast

FORMAT = "gzip-jsonl-v1"
PLAIN = "round_data.jsonl"
COMPACT = PLAIN + ".gz"
RETAINED = "round_data.grid.jsonl.gz"
DESCRIPTOR = ".grid-retained.json"
MEMBER_LIMIT = 512 * 1024 * 1024
MARKET_LIMIT = 128 * 1024 * 1024
Json = dict[str, Any]


def round_name(names: Iterable[str], metadata: Json) -> str:
    have = set(names)
    if DESCRIPTOR in have:
        return RETAINED
    storage = metadata.get("round_storage")
    if storage not in (None, FORMAT) or {PLAIN, COMPACT} <= have:
        raise ValueError("Conflicting or unknown round storage")
    if (storage is None and (COMPACT in have or "round_market" in have)) \
            or (storage == FORMAT and PLAIN in have):
        raise ValueError("Round storage conflicts with metadata")
    return COMPACT if storage == FORMAT else PLAIN


def round_path(directory: str) -> str:
    try:
        with open(os.path.join(directory, "metadata.json")) as stream:
            metadata: Any = json.load(stream)
    except FileNotFoundError:
        metadata = {}
    if not isinstance(metadata, dict):
        raise ValueError("Invalid round storage metadata")
    name = round_name(os.listdir(directory), cast(Json, metadata))
    return os.path.join(directory, name)


class Members:
    """Incremental gzip members; callback receives payload and wire offsets."""

    def __init__(self, emit: Callable[[bytes, int, int], None],
                 limit: int = MEMBER_LIMIT) -> None:
        self.emit = emit
        self.limit = limit
        self.offset = 0
        self.start = 0
        self.decoder = zlib.decompressobj(31)
        self.data = bytearray()

    def feed(self, chunk: bytes) -> None:
        while chunk:
            try:
                self.data.extend(self.decoder.decompress(
                    chunk, self.limit - len(self.data) + 1))
            except zlib.error as exc:
                raise ValueError("Corrupt gzip member at byte %d: %s"
                                 % (self.start, exc)) from exc
            if len(self.data) > self.limit:
                raise ValueError("Decompressed member size limit exceeded")
            unused = self.decoder.unused_data
            self.offset += len(chunk) - len(unused)
            if not self.decoder.eof:
                return
            self.emit(bytes(self.data), self.start, self.offset)
            self.start = self.offset
            self.data.clear()
            self.decoder = zlib.decompressobj(31)
            chunk = unused


def frames(stream: BinaryIO, *, compact: bool, tail: bool = True,
           limit: int = MEMBER_LIMIT) -> Iterator[tuple[bytes, int, int]]:
    """Complete records with offsets relative to the stream's initial seek."""
    if not compact:
        while raw := stream.readline(limit + 1):
            end = stream.tell()
            if len(raw) > limit:
                raise ValueError("Round size limit exceeded")
            if not raw.endswith(b"\n") and tail:
                return
            yield raw, end - len(raw), end
        return
    base = stream.tell()
    pending: list[tuple[bytes, int, int]] = []
    decoder = Members(lambda raw, start, end: pending.append(
        (raw, base + start, base + end)), limit)
    while chunk := stream.read(65536):
        decoder.feed(chunk)
        yield from pending
        pending.clear()
    if not tail and decoder.offset != decoder.start:
        raise ValueError("Incomplete gzip member")


def _finite_return(value: Any) -> bool:
    if value is None:
        return True
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def restore(record: Json, read: Callable[[str], bytes]) -> Json:
    """Hydrate a content-addressed market after verifying bytes and shape."""
    if "market_ref" not in record:
        return record
    digest = record["market_ref"]
    if "market" in record or not isinstance(digest, str) or \
            re.fullmatch("[0-9a-f]{64}", digest) is None:
        raise ValueError("Invalid market reference")
    raw = read("round_market/" + digest + ".json.gz")
    blobs = list(frames(io.BytesIO(raw), compact=True, tail=False,
                        limit=MARKET_LIMIT))
    if len(blobs) != 1:
        raise ValueError("Expected one market gzip member")
    payload = blobs[0][0]
    if hashlib.sha256(payload).hexdigest() != digest:
        raise ValueError("Market digest mismatch")
    market: Any = json.loads(payload)
    values: Any = cast(Json, market).get("ret") \
        if isinstance(market, dict) else None
    preds: Any = record.get("preds")
    if not isinstance(market, dict) or set(cast(Json, market)) != {"ret"} \
            or not isinstance(values, list):
        raise ValueError("Invalid market returns")
    returns = cast(list[Any], values)
    if (isinstance(preds, list) and
            len(returns) != len(cast(list[Any], preds))) or any(
                not _finite_return(v) for v in returns):
        raise ValueError("Invalid market returns or prediction length")
    return {("market" if k == "market_ref" else k):
            (market if k == "market_ref" else v) for k, v in record.items()}


def read_local(directory: str, name: str) -> bytes:
    with open(os.path.join(directory, name), "rb") as stream:
        return stream.read()
