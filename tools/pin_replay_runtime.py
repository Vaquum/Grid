#!/usr/bin/env python3
"""Retain a real image/container and expose only its private replay socket.

Run on the Docker host. Grid itself receives no Docker socket or credentials.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, cast

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from grid.replay import (  # noqa: E402
    code_identity,
    numeric_platform,
    runtime_identity,
)
from grid.retention import atomic_json  # noqa: E402
from grid.round_storage import Json  # noqa: E402


def pin(
    store: Path,
    image: str,
    docker: list[str],
    *,
    cpus: float = 1.0,
    memory: str = "1g",
    uid: int = 10001,
    gid: int = 10001,
) -> Json:
    def run(
        args: list[str], *, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            docker + args, capture_output=True, text=True, timeout=60
        )
        if check and result.returncode:
            raise ValueError(
                "Docker runtime pin failed: " + result.stderr[-2000:]
            )
        return result

    inspected: Any = json.loads(run(["image", "inspect", image]).stdout)[0]
    image_id = str(inspected["Id"])
    probe_code = (
        "import json\nfrom typing import Any\nJson=dict[str,Any]\n"
        + inspect.getsource(numeric_platform)
        + "\nprint(json.dumps(numeric_platform()))\n"
    )
    numeric: Any = json.loads(
        run(
            [
                "run",
                "--rm",
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--cpus",
                "1",
                "--memory",
                "256m",
                "--pids-limit",
                "32",
                "--env",
                "OMP_NUM_THREADS=1",
                "--env",
                "OPENBLAS_NUM_THREADS=1",
                "--env",
                "MKL_NUM_THREADS=1",
                "--env",
                "POLARS_MAX_THREADS=1",
                "--env",
                "PYTHONHASHSEED=0",
                "--entrypoint",
                "python",
                image_id,
                "-c",
                probe_code,
            ]
        ).stdout
    )
    package = Path(__file__).resolve().parents[1] / "grid"
    code = code_identity(package)
    runtime = runtime_identity(image_id, code, cast(Json, numeric))
    store = store.resolve()
    root = store / "runtimes" / runtime[:16]
    for directory in (store, store / "assets", root, root / "socket"):
        new = not directory.exists()
        directory.mkdir(parents=True, exist_ok=True)
        if new and os.geteuid() == 0:
            os.chown(directory, uid, gid)
    frozen = root / "code" / "grid"
    if not frozen.exists():
        frozen.parent.mkdir(exist_ok=True)
        shutil.copytree(
            package, frozen, ignore=shutil.ignore_patterns("__pycache__")
        )
    if code_identity(frozen) != code:
        raise ValueError("Frozen replay code differs from its identity")
    name = "grid-replay-" + runtime[:16]
    existing = run(["container", "inspect", name], check=False)
    if existing.returncode:
        if "No such" not in existing.stderr:
            raise ValueError(
                "Cannot inspect retained runtime: " + existing.stderr[-2000:]
            )
        run(
            [
                "create",
                "--name",
                name,
                "--label",
                "grid.replay.runtime=" + runtime,
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--pids-limit",
                "128",
                "--cpus",
                str(cpus),
                "--memory",
                memory,
                "--restart",
                "unless-stopped",
                "--user",
                "%d:%d" % (uid, gid),
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=256m",
                "--log-opt",
                "max-size=10m",
                "--log-opt",
                "max-file=2",
                "--mount",
                "type=bind,src=%s,dst=/replay,readonly" % frozen.parent,
                "--mount",
                "type=bind,src=%s,dst=/assets,readonly" % (store / "assets"),
                "--mount",
                "type=bind,src=%s,dst=/socket" % (root / "socket"),
                "--workdir",
                "/replay",
                "--entrypoint",
                "python",
                "--env",
                "PYTHONDONTWRITEBYTECODE=1",
                "--env",
                "OMP_NUM_THREADS=1",
                "--env",
                "OPENBLAS_NUM_THREADS=1",
                "--env",
                "MKL_NUM_THREADS=1",
                "--env",
                "POLARS_MAX_THREADS=1",
                "--env",
                "PYTHONHASHSEED=0",
                image_id,
                "-m",
                "grid.native_replay",
                "--socket",
                "/socket/worker.sock",
                "--assets",
                "/assets",
                "--image",
                image_id,
            ]
        )
    actual: Any = json.loads(run(["container", "inspect", name]).stdout)[0]
    if (
        actual.get("Image") != image_id
        or actual.get("Config", {})
        .get("Labels", {})
        .get("grid.replay.runtime")
        != runtime
    ):
        raise ValueError("Container name belongs to a different runtime")
    if not actual["State"]["Running"]:
        run(["start", name])
    ready: Json | None = None
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        probe = run(
            [
                "exec",
                name,
                "python",
                "-m",
                "grid.native_replay",
                "--socket",
                "/socket/worker.sock",
                "--assets",
                "/assets",
                "--image",
                image_id,
                "--probe",
            ],
            check=False,
        )
        if probe.returncode == 0:
            value: Any = json.loads(probe.stdout)
            if (
                value.get("runtime") != runtime
                or value.get("image") != image_id
                or value.get("code") != code
            ):
                raise ValueError(
                    "Running native environment differs from its pin"
                )
            ready = cast(Json, value)
            break
        time.sleep(0.5)
    if ready is None:
        raise ValueError(
            "Retained replay worker did not become ready; inspect " + name
        )
    receipt: Json = {
        "runtime": runtime,
        "retention": "docker-container",
        "container": actual["Id"],
        "name": name,
        "image": image_id,
        "code": code,
        "identity": ready,
        "image_virtual_bytes": inspected.get("Size"),
        "code_bytes": sum(p.stat().st_size for p in frozen.rglob("*.py")),
    }
    atomic_json(root / "pin.json", receipt)
    if os.geteuid() == 0:
        os.chown(root / "pin.json", uid, gid)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--image", required=True)
    parser.add_argument("--docker-host")
    parser.add_argument("--cpus", type=float, default=1.0)
    parser.add_argument("--memory", default="1g")
    parser.add_argument(
        "--uid", type=int, default=10001 if os.geteuid() == 0 else os.getuid()
    )
    parser.add_argument(
        "--gid", type=int, default=10001 if os.geteuid() == 0 else os.getgid()
    )
    args = parser.parse_args()
    if not 0 < args.cpus <= 8:
        parser.error("--cpus must be positive and at most eight")
    docker = ["docker"] + (
        ["--host", args.docker_host] if args.docker_host else []
    )
    print(
        json.dumps(
            pin(
                args.store,
                args.image,
                docker,
                cpus=args.cpus,
                memory=args.memory,
                uid=args.uid,
                gid=args.gid,
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
