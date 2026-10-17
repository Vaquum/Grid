"""Sealed-run retention. The descriptor is the durable publication boundary.

Originals remain authoritative until every dependency and archive file is
durable and verified. Live producers must be stopped before this command.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import tempfile
import uuid
from collections.abc import Callable, Generator, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, TextIO, cast

from .evidence import (
    CONTRACT,
    VECTOR_PATHS,
    Evidence,
    MarketCache,
    Reducer,
    digest,
    encoded,
    record_digest,
)
from .limen import RoundResult, RoundSummary, round_object
from .round_storage import (
    COMPACT,
    DESCRIPTOR,
    PLAIN,
    RETAINED,
    Json,
    frames,
    round_path,
)

CSV = "results.csv.gz"
ARCHIVE_FORMAT = "grid-evidence-v1"
TRANSITION = ".grid-materialized.json"


def file_hash(path: Path, limit: int | None = None) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        left = limit
        while left is None or left > 0:
            block = stream.read(
                1 << 20 if left is None else min(1 << 20, left)
            )
            if not block:
                if left:
                    raise ValueError("Truncated evidence file " + str(path))
                break
            h.update(block)
            if left is not None:
                left -= len(block)
    return h.hexdigest()


def sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sync_tree(root: Path) -> None:
    for path in root.rglob("*"):
        if path.is_file():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    for path in sorted(
        root.rglob("*"), key=lambda p: len(p.parts), reverse=True
    ):
        if path.is_dir():
            sync_dir(path)
    sync_dir(root)


def atomic_json(path: Path, value: Any) -> None:
    fd, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encoded(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def descriptor(directory: str | Path) -> Json | None:
    path = Path(directory) / DESCRIPTOR
    if not path.exists():
        return None
    value: Any = json.loads(path.read_bytes())
    if (
        not isinstance(value, dict)
        or cast(Json, value).get("format") != ARCHIVE_FORMAT
    ):
        raise ValueError("Unknown retained-run descriptor")
    result = cast(Json, value)
    if (
        result.get("rounds") != RETAINED
        or result.get("csv") != CSV
        or not isinstance(result.get("store"), str)
    ):
        raise ValueError("Invalid retained-run descriptor")
    original: Any = result.get("original_rounds")
    if (
        original not in (PLAIN, COMPACT)
        or not isinstance(result.get("originals"), dict)
        or set(result["originals"]) != {original, "results.csv"}
    ):
        raise ValueError("Invalid retained original file names")
    return result


def results_path(directory: str | Path) -> str:
    return str(
        Path(directory) / (CSV if descriptor(directory) else "results.csv")
    )


def check_training_sources(directory: str | Path) -> None:
    desc = descriptor(directory)
    if desc is None:
        return
    for name, source in cast(Json, desc.get("sources") or {}).items():
        if (
            not Path(name).is_file()
            or file_hash(Path(name)) != source["sha256"]
        ):
            raise ValueError(
                "Training source differs from retained evidence: "
                + name
                + "; restore its immutable source snapshot"
            )


@contextmanager
def open_results(path: str | Path) -> Generator[TextIO, None, None]:
    source = Path(path)
    if source.name == "results.csv":
        source = Path(results_path(source.parent))
    opener = gzip.open if source.name == CSV else open
    with opener(source, "rt", encoding="utf-8", newline="") as stream:
        yield stream


def read_lease(directory: str | Path) -> int | None:
    """Lock the directory inode without mutating a read-only dataset."""
    if os.name != "posix":
        return None
    import fcntl

    try:
        fd = os.open(directory, os.O_RDONLY)
    except PermissionError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    return fd


@contextmanager
def _exclusive(directory: Path) -> Generator[None, None, None]:
    if os.name != "posix":
        raise ValueError("Sealed migration requires POSIX advisory locks")
    import fcntl

    fd = os.open(directory, os.O_RDONLY)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError(
                "Run is open in Grid; close its readers before compaction"
            ) from exc
        yield
    finally:
        os.close(fd)


def _stamp(path: Path) -> tuple[int, int, int, int]:
    st = path.stat()
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns


def _producer_guard(directory: Path) -> None:
    for ancestor in (directory, *directory.parents):
        record = ancestor / "grid-run.json"
        if record.is_file():
            state: Any = json.loads(record.read_bytes())
            for shard in state.get("shards", []):
                if shard.get("state") == "running" and (
                    ancestor == directory
                    or str(shard.get("label")) == directory.name
                ):
                    raise ValueError("Run still has a running producer")
            break
    # External writers do not use Grid's lease. Detect their open write FDs
    # on Linux as an additional guard; --sealed remains an operator contract.
    proc = Path("/proc")
    if proc.is_dir():
        wanted = {
            str(directory / name) for name in (PLAIN, COMPACT, "results.csv")
        }
        for process in proc.iterdir():
            if not process.name.isdigit():
                continue
            try:
                for fd in (process / "fd").iterdir():
                    if os.readlink(fd) not in wanted:
                        continue
                    info = (process / "fdinfo" / fd.name).read_text()
                    flags = next(
                        (
                            line.split()[1]
                            for line in info.splitlines()
                            if line.startswith("flags:")
                        ),
                        "0",
                    )
                    if int(flags, 8) & os.O_ACCMODE != os.O_RDONLY:
                        raise ValueError("Run has an open producer write FD")
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue


def _vector(base: Json, path: str) -> Any:
    parts = path.split(".")
    if len(parts) == 1:
        return base.get(path)
    parent: Any = base.get(parts[0])
    return (
        cast(Json, parent).get(parts[1]) if isinstance(parent, dict) else None
    )


def _remove(base: Json, path: str) -> None:
    parts = path.split(".")
    if len(parts) == 1:
        base.pop(path, None)
    elif isinstance(base.get(parts[0]), dict):
        parent = dict(cast(Json, base[parts[0]]))
        parent.pop(parts[1], None)
        base[parts[0]] = parent


def _assign(base: Json, path: str, value: Any) -> None:
    if path not in VECTOR_PATHS:
        raise ValueError("Unknown retained vector path")
    parts = path.split(".")
    if len(parts) == 1:
        base[path] = value
    else:
        parent = dict(cast(Json, base.get(parts[0]) or {}))
        parent[parts[1]] = value
        base[parts[0]] = parent


def source_snapshots(metadata: Json, evidence: Evidence) -> Json:
    declaration: Any = (
        metadata.get("yaml_reference", {})
        .get("sfd", {})
        .get("manifest", {})
        .get("data_source", {})
        .get("params", {})
    )
    if not isinstance(declaration, dict):
        return {}
    sources: Json = {}
    for name in ("file_path_or_url", "file_path"):
        location: Any = cast(Json, declaration).get(name)
        if not isinstance(location, str) or not Path(location).is_file():
            continue
        source = Path(location).resolve()
        before = _stamp(source)
        if before[2] > 512 << 20:
            continue
        sha = file_hash(source)
        suffix = (
            source.suffix
            if source.suffix in (".parquet", ".arrow", ".csv", ".json", ".ipc")
            else ".data"
        )
        assets = evidence.path.parent / "assets"
        assets.mkdir(exist_ok=True)
        target = assets / (sha + suffix)
        if not target.exists():
            fd, temporary = tempfile.mkstemp(prefix=".source-", dir=assets)
            try:
                with os.fdopen(fd, "wb") as out, source.open("rb") as stream:
                    shutil.copyfileobj(stream, out, 1 << 20)
                    out.flush()
                    os.fsync(out.fileno())
                if file_hash(Path(temporary)) != sha:
                    raise ValueError("Source changed during snapshot")
                os.replace(temporary, target)
                sync_dir(assets)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        if _stamp(source) != before or file_hash(target) != sha:
            raise ValueError("Source changed or retained source is corrupt")
        sources[location] = {
            "sha256": sha,
            "asset": target.name,
            "bytes": before[2],
        }
    return sources


class Reader:
    def __init__(
        self,
        directory: str | Path,
        *,
        staged: tuple[Json, Path] | None = None,
        evidence: Evidence | None = None,
    ) -> None:
        self.directory = Path(directory).resolve()
        self.payload = staged[1] if staged is not None else self.directory
        desc = staged[0] if staged is not None else descriptor(self.directory)
        if desc is None:
            raise ValueError("Run has no retained evidence")
        self.desc = desc
        if (
            desc.get("metadata_sha256")
            and file_hash(self.directory / "metadata.json")
            != desc["metadata_sha256"]
        ):
            raise ValueError("Retained metadata changed")
        self.owned = evidence is None
        self.evidence = evidence or Evidence(self.directory / desc["store"])
        self.markets = MarketCache()
        self.replay: Any = None

    def close(self) -> None:
        if self.owned:
            self.evidence.close()

    def _market(self, name: str) -> bytes:
        key: Any = self.desc.get("markets", {}).get(name)
        if not isinstance(key, str):
            raise ValueError("Missing retained market " + name)
        kind, _, raw = self.evidence.get(key)
        if kind != "bytes":
            raise ValueError("Invalid retained market type")
        return raw

    def restore(self, entry: Json) -> Json:
        packet: Any = entry.get("grid")
        if not isinstance(packet, dict):
            raise ValueError("Invalid retained round")
        node = cast(Json, packet)
        if "raw" in node:
            kind, _, raw = self.evidence.get(node["raw"])
            if kind != "bytes":
                raise ValueError("Invalid retained raw record")
            value: Any = json.loads(raw.decode("utf-8", errors="replace"))
            if not isinstance(value, dict):
                raise ValueError("a round line is a JSON object")
            record = self.markets.restore(
                cast(Json, value), str(self.directory), self._market
            )
        else:
            record = dict(cast(Json, node["record"]))
            for path, key in cast(Json, node.get("vectors") or {}).items():
                _assign(record, path, self.evidence.vector(key))
            if node.get("replay"):
                from .replay import ReplayClient

                if self.replay is None:
                    self.replay = ReplayClient(
                        self.evidence.path.parent,
                        node["replay"]["runtime"],
                        self.evidence,
                    )
                patch: Json = self.replay.materialize(node["replay"], record)
                record.update(patch)
        if record_digest(record) != node.get("sha256"):
            raise ValueError("Reconstructed round digest mismatch")
        return record

    def entries(self) -> Iterator[Json]:
        with (self.payload / RETAINED).open("rb") as stream:
            for raw, _, _ in frames(stream, compact=True, tail=False):
                value: Any = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError("Invalid retained round frame")
                yield cast(Json, value)

    def get(self, round_id: str) -> Json:
        row = self.evidence.db.execute(
            "SELECT offset FROM round_index WHERE archive=? AND round_id=? "
            "ORDER BY occurrence DESC LIMIT 1",
            (self.desc["id"], round_id),
        ).fetchone()
        if row is None:
            raise ValueError(
                "round %s is not in %s"
                % (round_id[:12], self.directory / RETAINED)
            )
        with (self.payload / RETAINED).open("rb") as stream:
            stream.seek(int(row[0]))
            frame = next(frames(stream, compact=True, tail=False), None)
        if frame is None:
            raise ValueError("Missing retained round frame")
        entry = cast(Json, json.loads(frame[0]))
        if entry.get("round_id") != round_id:
            raise ValueError("Retained round index disagrees with its record")
        return self.restore(entry)

    def summary(self, entry: Json) -> RoundSummary:
        node = cast(Json, entry["grid"])
        if node.get("contract") != CONTRACT:
            return round_object(self.restore(entry))
        value: Any = node.get("summary")
        if not isinstance(value, list) or len(cast(list[Any], value)) != 4:
            raise ValueError(
                str(node.get("error") or "Invalid cached summary")
            )
        return cast(RoundSummary, tuple(cast(list[Any], value)))


def cached_result(
    entry: Json, restore_record: Callable[[], Json] | None = None
) -> RoundResult:
    packet: Any = entry.get("grid")
    if not isinstance(packet, dict):
        raise ValueError("Invalid retained round")
    node = cast(Json, packet)
    if node.get("blank"):
        return RoundResult(None)
    if "error" in node:
        return RoundResult(None, str(node["error"]), str(node.get("text", "")))
    if node.get("contract") != CONTRACT:
        if restore_record is None:
            raise ValueError(
                "Retained summary contract changed; materialize "
                "on its host or read the archive locally"
            )
        return RoundResult(round_object(restore_record()))
    summary: Any = node.get("summary")
    if (
        not isinstance(summary, list)
        or len(cast(list[Any], summary)) != 4
        or cast(list[Any], summary)[0] != entry.get("_round_index")
        or not isinstance(cast(list[Any], summary)[1], list)
        or not all(isinstance(v, str) for v in cast(list[Any], summary)[1])
        or any(
            value is not None and not isinstance(value, dict)
            for value in cast(list[Any], summary)[2:]
        )
    ):
        raise ValueError("Invalid retained analytical summary")
    return RoundResult(cast(RoundSummary, tuple(cast(list[Any], summary))))


def _gzip_copy(source: Path, target: Path) -> None:
    with source.open("rb") as stream, target.open("wb") as out:
        while block := stream.read(4 << 20):
            out.write(gzip.compress(block, compresslevel=6, mtime=0))
        out.flush()
        os.fsync(out.fileno())
    h = hashlib.sha256()
    with gzip.open(target, "rb") as restored:
        for block in iter(lambda: restored.read(1 << 20), b""):
            h.update(block)
    if h.hexdigest() != file_hash(source):
        raise ValueError("CSV compression changed original bytes")


def _prune(directory: Path, desc: Json) -> None:
    for name, expected in cast(Json, desc["originals"]).items():
        path = directory / name
        if path.exists() and file_hash(path) != expected:
            raise ValueError(
                "Original changed since archive publication: " + name
            )
    market = directory / "round_market"
    evidence = Evidence(directory / desc["store"])
    try:
        for name, key in cast(Json, desc.get("markets") or {}).items():
            path = directory / name
            if path.parent != market or not path.name.endswith(".json.gz"):
                raise ValueError("Invalid retained market location")
            _, _, raw = evidence.get(key)
            if (
                path.exists()
                and file_hash(path) != hashlib.sha256(raw).hexdigest()
            ):
                raise ValueError("Original market changed since publication")
    finally:
        evidence.close()
    for name in cast(Json, desc["originals"]):
        (directory / name).unlink(missing_ok=True)
    for name in cast(Json, desc.get("markets") or {}):
        (directory / name).unlink(missing_ok=True)
    if market.is_dir() and not any(market.iterdir()):
        market.rmdir()
    sync_dir(directory)


def compact(
    directory: str | Path,
    store: str | Path,
    *,
    sealed: bool,
    prune: bool = False,
    runtime: str | None = None,
) -> Json:
    if not sealed:
        raise ValueError(
            "--sealed requires stopped producers and closed "
            "Grid readers; live logs cannot be pruned"
        )
    root = Path(directory).resolve()
    if Path(store).resolve().is_relative_to(root):
        raise ValueError(
            "The shared evidence store must be outside the result directory"
        )
    with _exclusive(root):
        _producer_guard(root)
        prior = descriptor(root)
        if prior is not None:
            verify(root)
            if prune:
                _prune(root, prior)
            return prior
        source = Path(round_path(str(root)))
        csv_path = root / "results.csv"
        metadata = cast(
            Json, json.loads((root / "metadata.json").read_bytes())
        )
        watched = [source, csv_path, root / "metadata.json"]
        watched.extend(root.glob("*.yaml"))
        watched.extend(root.glob("*.yml"))
        stamps = {path: _stamp(path) for path in watched}
        archive_id = uuid.uuid4().hex
        stage = Path(tempfile.mkdtemp(prefix=".grid-retain-", dir=root))
        evidence = Evidence(store, writable=True)
        pending = [
            str(row[0])
            for row in evidence.db.execute(
                "SELECT id FROM archives WHERE run=? AND state='staging'",
                (str(root),),
            )
        ]
        for abandoned in pending:
            # Publication precedes the final DB state commit. A staging row
            # may therefore belong to a published archive, including history
            # preserved by in-place recovery. Keep its evidence and index;
            # reclaiming either needs an explicit reference-aware GC policy.
            evidence.db.execute(
                "UPDATE archives SET state='unreconciled' WHERE id=?",
                (abandoned,),
            )
        for old_stage in root.glob(".grid-retain-*"):
            owner = old_stage / "owner.json"
            if old_stage != stage and old_stage.is_dir() and owner.is_file():
                value: Any = json.loads(owner.read_bytes())
                if value.get("archive") in pending and value.get("run") == str(
                    root
                ):
                    shutil.rmtree(old_stage)
        evidence.db.execute(
            "INSERT INTO archives VALUES (?,?,?)",
            (archive_id, "staging", str(root)),
        )
        evidence.db.commit()
        atomic_json(
            stage / "owner.json", {"archive": archive_id, "run": str(root)}
        )
        reducer, markets = Reducer(evidence), MarketCache()
        replay: Any = None
        try:
            if runtime is not None:
                from .replay import ReplayClient

                replay = ReplayClient(evidence.path.parent, runtime, evidence)
            sources = source_snapshots(metadata, evidence)
            market_nodes: Json = {}
            for path in sorted((root / "round_market").glob("*.json.gz")):
                raw = path.read_bytes()
                market_nodes["round_market/" + path.name] = evidence.put(
                    "bytes", len(raw), raw
                )
            checking = Reader(
                root,
                staged=(
                    {"store": str(evidence.path), "markets": market_nodes},
                    stage,
                ),
                evidence=evidence,
            )
            checking.replay = replay
            count = bad = replayed_execution = replayed_models = 0
            with (
                source.open("rb") as stream,
                (stage / RETAINED).open("wb") as out,
            ):
                for raw, start, end in frames(
                    stream, compact=source.name == COMPACT, tail=False
                ):
                    if not raw.endswith(b"\n"):
                        raise ValueError(
                            "Unterminated round; seal only "
                            "complete producer records"
                        )
                    node: Json = {"contract": CONTRACT, "offset": [start, end]}
                    entry: Json = {"grid": node}
                    record: Json | None = None
                    text = raw.decode("utf-8", errors="replace").rstrip("\n")
                    try:
                        if not text.strip():
                            node["blank"] = True
                            node["raw"] = evidence.put("bytes", len(raw), raw)
                            node["proof"] = digest(node)
                            out.write(
                                gzip.compress(encoded(entry) + b"\n", mtime=0)
                            )
                            count += 1
                            continue
                        value: Any = json.loads(text)
                        if not isinstance(value, dict):
                            raise ValueError("a round line is a JSON object")
                        record = markets.restore(cast(Json, value), str(root))
                        entry.update(
                            round_id=record.get("round_id"),
                            _round_index=record.get("_round_index"),
                        )
                        node["sha256"] = record_digest(record)
                        node["summary"] = reducer.reduce(record)
                    except (ValueError, OSError, OverflowError) as exc:
                        node["error"] = str(exc)
                        node["text"] = text[:300]
                        bad += 1
                    # Unsupported schemas preserve the original complete wire
                    # record; no replay assumptions or typed evidence are lost.
                    admitted = (
                        record is not None
                        and "error" not in node
                        and metadata.get("limen_version") == "5.29.0"
                    )
                    if not admitted:
                        node["raw"] = evidence.put("bytes", len(raw), raw)
                    else:
                        assert record is not None
                        base = dict(record)
                        vectors: Json = {}
                        if replay is not None:
                            evidence.db.commit()
                            recipe: Any = replay.verify(
                                metadata, record, sources
                            )
                            if recipe is not None:
                                node["replay"] = recipe
                                replayed_execution += "execution" in recipe
                                replayed_models += "model" in recipe
                                for name in recipe.get("fields", []):
                                    base.pop(name, None)
                        for path in VECTOR_PATHS:
                            values: Any = _vector(base, path)
                            if isinstance(values, list):
                                key = evidence.put_vector(
                                    cast(list[Any], values)
                                )
                                vectors[path] = key
                                _remove(base, path)
                        node.update(record=base, vectors=vectors)
                    if "error" not in node:
                        # The worker's just-verified outputs are still in its
                        # bounded cache: validate storage/transport without a
                        # second fit or execution evaluation.
                        evidence.db.commit()
                        checking.restore(
                            cast(Json, json.loads(encoded(entry)))
                        )
                    node["proof"] = digest(node)
                    evidence.db.execute(
                        "INSERT INTO round_index VALUES (?,?,?,?)",
                        (archive_id, count, entry.get("round_id"), out.tell()),
                    )
                    out.write(gzip.compress(encoded(entry) + b"\n", mtime=0))
                    count += 1
                    evidence.db.commit()
                out.flush()
                os.fsync(out.fileno())
            _gzip_copy(csv_path, stage / CSV)
            evidence.db.commit()
            evidence.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            desc: Json = {
                "format": ARCHIVE_FORMAT,
                "id": archive_id,
                "store": os.path.relpath(evidence.path, root),
                "rounds": RETAINED,
                "csv": CSV,
                "original_rounds": source.name,
                "originals": {
                    path.name: file_hash(path) for path in (source, csv_path)
                },
                "metadata_sha256": file_hash(root / "metadata.json"),
                "rounds_sha256": file_hash(stage / RETAINED),
                "csv_sha256": file_hash(stage / CSV),
                "records": count,
                "bad_records": bad,
                "markets": market_nodes,
                "sources": sources,
                "replayed_execution_records": replayed_execution,
                "replayed_probability_records": replayed_models,
                "input_bytes": sum(stamps[p][2] for p in (source, csv_path)),
            }
            verify(root, staged=(desc, stage), full=False)
            for path, before in stamps.items():
                if _stamp(path) != before:
                    raise ValueError(
                        "Run changed during compaction: " + str(path)
                    )
            _producer_guard(root)
            if replay is not None:
                if replay.call({"op": "identity"}).get("runtime") != runtime:
                    raise ValueError(
                        "Pinned runtime changed before publication"
                    )
            for name, original in ((RETAINED, source), (CSV, csv_path)):
                os.utime(
                    stage / name,
                    ns=(original.stat().st_atime_ns, stamps[original][3]),
                )
                os.replace(stage / name, root / name)
            sync_dir(root)
            # This rename commits the archive only after durable dependencies.
            atomic_json(root / DESCRIPTOR, desc)
            evidence.db.execute(
                "UPDATE archives SET state='committed' WHERE id=?",
                (archive_id,),
            )
            evidence.db.commit()
            if prune:
                _prune(root, desc)
            return desc
        finally:
            evidence.close()
            shutil.rmtree(stage)


def verify(
    directory: str | Path,
    *,
    staged: tuple[Json, Path] | None = None,
    full: bool = True,
) -> Json:
    reader = Reader(directory, staged=staged)
    try:
        root, desc = reader.directory, reader.desc
        for path, expected in (
            (reader.payload / RETAINED, desc["rounds_sha256"]),
            (reader.payload / CSV, desc["csv_sha256"]),
            (root / "metadata.json", desc["metadata_sha256"]),
        ):
            if file_hash(path) != expected:
                raise ValueError(
                    "Retained run file digest mismatch: " + path.name
                )
        count = 0
        for entry in reader.entries():
            node = cast(Json, entry["grid"])
            if node.get("proof") != digest(
                {k: v for k, v in node.items() if k != "proof"}
            ):
                raise ValueError("Retained record verification proof changed")
            if full and "error" not in node and not node.get("blank"):
                record = reader.restore(entry)
                if encoded(round_object(record)) != encoded(
                    reader.summary(entry)
                ):
                    raise ValueError("Cached analytical summary changed")
            elif ("error" in node or node.get("blank")) and "raw" not in node:
                raise ValueError("Bad round lost its original evidence")
            elif "raw" in node:
                reader.evidence.get(node["raw"])
            count += 1
        if count != desc["records"]:
            raise ValueError("Retained occurrence count mismatch")
        return {"records": count, "exact": True}
    finally:
        reader.close()


def materialize(directory: str | Path, destination: str | Path) -> Json:
    root, target = Path(directory).resolve(), Path(destination).resolve()
    if target.exists():
        raise ValueError("Materialization destination must be new")
    # CRC alone cannot detect removal of complete gzip members. Verify the
    # published files, proofs and occurrence count before producing an export.
    verify(root, full=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    reader = Reader(root)
    stage = Path(
        tempfile.mkdtemp(prefix=".grid-materialize-", dir=target.parent)
    )
    try:
        for path in root.iterdir():
            if path.name in {
                PLAIN,
                COMPACT,
                RETAINED,
                "results.csv",
                CSV,
                "round_market",
            } or path.name.startswith(".grid-"):
                continue
            if path.is_dir():
                shutil.copytree(path, stage / path.name)
            else:
                shutil.copyfile(path, stage / path.name)
        name = str(reader.desc["original_rounds"])
        count = 0
        with (stage / name).open("wb") as out:
            for entry in reader.entries():
                node = cast(Json, entry["grid"])
                if "raw" in node:
                    _, _, raw = reader.evidence.get(node["raw"])
                else:
                    raw = encoded(reader.restore(entry)) + b"\n"
                out.write(
                    gzip.compress(raw, mtime=0) if name == COMPACT else raw
                )
                count += 1
            out.flush()
            os.fsync(out.fileno())
        if count != reader.desc["records"] or file_hash(root / RETAINED) != \
                reader.desc["rounds_sha256"]:
            raise ValueError("Retained round file changed during export")
        for name, key in cast(Json, reader.desc.get("markets") or {}).items():
            path = stage / name
            if path.parent != stage / "round_market" or not path.name.endswith(
                ".json.gz"
            ):
                raise ValueError("Invalid retained market location")
            path.parent.mkdir(exist_ok=True)
            _, _, raw = reader.evidence.get(key)
            path.write_bytes(raw)
        with (
            gzip.open(root / CSV, "rb") as stream,
            (stage / "results.csv").open("wb") as out,
        ):
            shutil.copyfileobj(stream, out, 1 << 20)
            out.flush()
            os.fsync(out.fileno())
        if (
            file_hash(stage / "results.csv")
            != reader.desc["originals"]["results.csv"]
        ):
            raise ValueError("Materialized CSV differs from original")
        sync_tree(stage)
        os.rename(stage, target)
        sync_dir(target.parent)
        return {"directory": str(target), "records": reader.desc["records"]}
    finally:
        reader.close()
        if stage.exists():
            shutil.rmtree(stage)


def materialize_in_place(directory: str | Path) -> None:
    root = Path(directory).resolve()
    desc = descriptor(root)
    if desc is None:
        return
    with _exclusive(root):
        _producer_guard(root)
        check_training_sources(root)
        target = root.parent / (".grid-native-" + uuid.uuid4().hex)
        try:
            materialize(root, target)
            history = root / ".grid-history" / desc["id"]
            if not history.exists():
                history.parent.mkdir(exist_ok=True)
                temporary = Path(
                    tempfile.mkdtemp(prefix=".history-", dir=history.parent)
                )
                try:
                    for source in root.iterdir():
                        if source.name.startswith(".grid-") or source.name in (
                            PLAIN,
                            COMPACT,
                            "results.csv",
                            "round_market",
                        ):
                            continue
                        if source.name in (RETAINED, CSV):
                            os.link(source, temporary / source.name)
                        elif source.is_dir():
                            shutil.copytree(source, temporary / source.name)
                        else:
                            shutil.copyfile(source, temporary / source.name)
                    archived = dict(desc)
                    archived["store"] = os.path.relpath(
                        (root / desc["store"]).resolve(), history
                    )
                    atomic_json(temporary / DESCRIPTOR, archived)
                    sync_tree(temporary)
                    os.rename(temporary, history)
                    sync_dir(history.parent)
                finally:
                    if temporary.exists():
                        shutil.rmtree(temporary)
            names = {"csv": "results.csv", "rounds": desc["original_rounds"]}
            plan: Json = {"archive": desc["id"], "history": str(history)}
            for role, name in names.items():
                produced = target / name
                plan[role] = {
                    "file": name,
                    "bytes": produced.stat().st_size,
                    "sha256": file_hash(produced),
                }
                current = root / name
                if current.exists() and file_hash(current) not in (
                    desc["originals"][name],
                    plan[role]["sha256"],
                ):
                    raise ValueError(
                        "Native destination changed during recovery"
                    )
            atomic_json(root / ".grid-materializing.json", plan)
            for name in names.values():
                os.replace(target / name, root / name)
            for source in (target / "round_market").glob("*.json.gz"):
                market = root / "round_market"
                market.mkdir(exist_ok=True)
                destination = market / source.name
                if destination.exists() and file_hash(
                    destination
                ) != file_hash(source):
                    raise ValueError("Native market changed during recovery")
                os.replace(source, destination)
            if (root / "round_market").is_dir():
                sync_dir(root / "round_market")
            sync_dir(root)
            atomic_json(root / TRANSITION, plan)
            os.replace(root / DESCRIPTOR, root / (DESCRIPTOR + ".history"))
            sync_dir(root)
            (root / ".grid-materializing.json").unlink(missing_ok=True)
        finally:
            if target.exists():
                shutil.rmtree(target)
