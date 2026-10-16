"""Effective CPU capacity: host, affinity and visible cgroup ancestors."""

from __future__ import annotations

import os
from pathlib import Path


def _read(path: Path) -> str:
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def _quota(folder: Path, version: int) -> int | None:
    try:
        if version == 2:
            quota, period = _read(folder / "cpu.max").split()
        else:
            quota = _read(folder / "cpu.cfs_quota_us")
            period = _read(folder / "cpu.cfs_period_us")
        q, p = int(quota), int(period)
        # Whole worker slots, rounded down; a fractional CPU still needs
        # one worker. Unlimited, missing and malformed limits add no cap.
        return max(1, q // p) if q > 0 and p > 0 else None
    except ValueError:
        return None


def effective_cpus() -> int:
    limits = [os.cpu_count() or 1]
    try:
        limits.append(len(os.sched_getaffinity(0)))
    except (AttributeError, OSError):
        pass
    groups: list[tuple[str, str]] = []
    for line in _read(Path("/proc/self/cgroup")).splitlines():
        parts = line.split(":", 2)
        if len(parts) == 3:
            groups.append((parts[1], parts[2]))
    locations = {(Path("/sys/fs/cgroup"), Path("/sys/fs/cgroup"), 2),
                 (Path("/sys/fs/cgroup/cpu"),
                  Path("/sys/fs/cgroup/cpu"), 1)}
    for line in _read(Path("/proc/self/mountinfo")).splitlines():
        fields = line.split()
        if "-" not in fields or len(fields) < 6:
            continue
        tail = fields[fields.index("-") + 1:]
        if len(tail) < 3 or tail[0] not in ("cgroup", "cgroup2"):
            continue
        version = 2 if tail[0] == "cgroup2" else 1
        if version == 1 and "cpu" not in tail[2].split(","):
            continue
        # mountinfo escapes spaces, tabs, newlines and backslashes.
        def unescape(value: str) -> str:
            for octal, char in (("040", " "), ("011", "\t"),
                                ("012", "\n"), ("134", "\\")):
                value = value.replace("\\" + octal, char)
            return value
        root, mount = Path(unescape(fields[3])), Path(unescape(fields[4]))
        locations.add((mount, mount, version))
        for controllers, group in groups:
            if (version == 2 and controllers) or (
                    version == 1 and "cpu" not in controllers.split(",")):
                continue
            try:
                relative = Path(group).relative_to(root)
            except ValueError:
                continue
            # A namespace may name an inaccessible host ancestor (../).
            if ".." not in relative.parts:
                locations.add((mount / relative, mount, version))
    for folder, mount, version in locations:
        while True:
            quota = _quota(folder, version)
            if quota is not None:
                limits.append(quota)
            if folder == mount:
                break
            folder = folder.parent
    return max(1, min(limits))
