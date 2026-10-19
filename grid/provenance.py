"""Content identities for local source snapshots and the native runtime."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, cast

Json = dict[str, Any]
DATA_KEY = "sfd.manifest.data_source.params.file_path_or_url"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def runtime_probe() -> Json:
    """Executed in Limen's Python; Grid's own runtime imports no Limen."""
    import importlib.metadata
    import importlib.util

    spec = importlib.util.find_spec("limen")
    if spec is None or not spec.submodule_search_locations:
        raise ValueError("native Limen source is unavailable")
    package = Path(next(iter(spec.submodule_search_locations)))
    code = hashlib.sha256()
    for path in sorted(package.rglob("*.py")):
        code.update(str(path.relative_to(package)).encode() + b"\0")
        code.update(path.read_bytes())
    packages = sorted((item.metadata.get("Name", ""), item.version)
                      for item in importlib.metadata.distributions())
    identity: Json = {
        "pythonVersion": sys.version,
        "pythonExecutableSha256": digest(Path(sys.executable).resolve()),
        "limenVersion": importlib.metadata.version("vaquum-limen"),
        "limenSourceSha256": code.hexdigest(), "packages": packages,
    }
    identity["fingerprint"] = hashlib.sha256(json.dumps(
        identity, sort_keys=True).encode()).hexdigest()
    return identity


def runtime_identity(cli: str, python: str | None, version: str) -> Json:
    identity: Json = {"verified": False, "limenVersion": version,
                      "executable": os.path.realpath(cli), "python": python}
    if not python:
        identity["reason"] = "Native Python identity is unavailable."
        return identity
    try:
        process = subprocess.run(
            [python, os.path.abspath(__file__), "--runtime"],
            text=True, capture_output=True, timeout=30, check=False)
        found: Any = json.loads(process.stdout)
        if process.returncode or not isinstance(found, dict):
            raise ValueError("native runtime probe failed")
        native = cast(Json, found)
        if native.get("limenVersion") != version:
            raise ValueError("native Python and CLI versions differ")
        identity.update(native, verified=True)
    except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
        identity["reason"] = "Native runtime identity unavailable: " + str(exc)
    return identity


def snapshot_source(text: str, root: str) -> Json:
    from .experiment import get_value

    source = get_value(text, DATA_KEY)
    unavailable: Json = {
        "available": False,
        "reason": "Source content cannot be verified for this data provider; "
                  "linked Inspect needs a retained local file snapshot.",
        "files": [],
    }
    if not source or "://" in source or "{" in source:
        return unavailable
    original = Path(root, source).resolve()
    if not original.is_file():
        unavailable["reason"] = "Source file is unavailable: " + str(original)
        return unavailable
    directory = Path(root, ".grid", "sources")
    directory.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".source-", dir=directory)
    try:
        with os.fdopen(handle, "wb") as output, original.open("rb") as stream:
            before = os.fstat(stream.fileno())
            shutil.copyfileobj(stream, output)
            output.flush()
            os.fsync(output.fileno())
            after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (
                after.st_size, after.st_mtime_ns, after.st_ino):
            raise ValueError("source changed while its snapshot was copied")
        checksum = digest(Path(temporary))
        target = directory / (checksum + original.suffix)
        if target.exists():
            if digest(target) != checksum:
                raise ValueError("retained source snapshot checksum differs")
        else:
            os.chmod(temporary, 0o444)
            os.replace(temporary, target)
        return {"available": True, "reason": None,
                "manifestKey": DATA_KEY, "executionPath": str(target),
                "files": [{"path": str(target), "originalPath": str(original),
                           "sha256": checksum, "bytes": target.stat().st_size}]}
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def launch_identity(text: str, root: str, cli: str, python: str | None,
                    version: str) -> tuple[Json, Json]:
    source: Json = {"manifestSha256": hashlib.sha256(text.encode()).hexdigest(),
                    "data": snapshot_source(text, root)}
    return source, runtime_identity(cli, python, version)


def verify_identity(source: object, runtime: object, cli: str,
                    python: str | None, version: str) -> None:
    recorded = cast(Json, source) if isinstance(source, dict) else {}
    data: Json = recorded.get("data") or {}
    if data.get("available") is not True or not data.get("files"):
        raise ValueError("Inspect unavailable: source content has no retained "
                         "verifiable snapshot; historical bars cannot be "
                         "reconstructed by changing a recording label")
    for item in cast(list[Json], data["files"]):
        path = Path(item["path"])
        if not path.is_file() or digest(path) != item["sha256"]:
            raise ValueError("Inspect unavailable: retained source content "
                             "changed or is missing")
    previous = cast(Json, runtime) if isinstance(runtime, dict) else {}
    if previous.get("verified") is not True:
        raise ValueError("Inspect unavailable: source runtime has no verified "
                         "identity; retain a new source run first")
    current = runtime_identity(cli, python, version)
    if current.get("verified") is not True or current.get("fingerprint") != \
            previous.get("fingerprint"):
        raise ValueError("Inspect unavailable: native runtime identity changed; "
                         "restore the recorded runtime before launching")


if __name__ == "__main__":
    print(json.dumps(runtime_probe()))
