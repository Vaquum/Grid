"""Making and running Limen experiments from the page (the Experiment
view), in a Limen project: a folder with ``limen.toml``, its working
manifests in ``manifests/`` and the runs ``limen run`` writes in
``results/``.

Grid reaches Limen only through its command line, run in the project:
``limen validate`` checks a manifest, ``limen list-templates`` and ``limen
init`` start one, ``limen run`` runs it and ``limen run --resume`` resumes
it. A manifest the page accepts is therefore one ``limen run`` accepts, and
nothing of Limen runs inside Grid.

A run Grid starts is a folder, ``results/[dev/]<experiment>/<stamp>/``,
with a result directory per shard (``s1``, ``s2``, ...): ``limen run``
side by side on copies of the experiment's manifest that differ in their
search seed, their share of the rounds and their output path, which Grid
reads as one run. The folder also keeps the manifest as it was started
(``experiment.yaml``), the copies (``manifests/``), each shard's output
(``logs/``) and the run's record (``grid-run.json``): when it started,
each shard's process and how it ended.

A manifest is edited as text, so its comments and spelling stay as
written: ``get_value`` and ``set_values`` read and write the plain values
of block mappings (``uel.search_strategy.seed``) line by line, and refuse
a mapping written inline.
"""

from __future__ import annotations

import difflib
import hashlib
import json
import os
import random
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from typing import IO, Any, cast

Json = dict[str, Any]

RECORD = "grid-run.json"
BASE_COPY = "experiment.yaml"
NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\Z")
# the thread pools a round's libraries size from these; a shard gets its
# share of the cores, as threads past the cores cost more than they give
THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
               "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")
CLI_TIMEOUT = 180.0
MAX_ROUNDS = 10_000_000

# ---------------------------------------------------------------------------
# A manifest's plain values, as text

_KEY = re.compile(r"^(?P<indent> *)(?P<key>[A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:"
                  r"(?P<rest>(?:[ \t].*)?)$")


def _content(line: str) -> bool:
    s = line.strip()
    return bool(s) and not s.startswith("#")


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _comment_at(text: str) -> int:
    """Where a value's comment starts: a # after a space (or first),
    outside quotes; -1 when it has none."""
    quote = ""
    for i, c in enumerate(text):
        if quote:
            if c == quote:
                quote = ""
            continue
        if c in "\"'":
            quote = c
        elif c == "#" and (i == 0 or text[i - 1].isspace()):
            return i
    return -1


def _written(rest: str) -> str:
    """A key's value as written on its line, without its comment."""
    c = _comment_at(rest)
    return (rest[:c] if c >= 0 else rest).strip()


def _block_end(lines: list[str], start: int, indent: int) -> int:
    """The line after the last content line deeper than ``indent`` below
    line ``start``: the end of that key's block. Blank and comment lines
    after it belong to what follows."""
    end = start + 1
    for i in range(start + 1, len(lines)):
        if not _content(lines[i]):
            continue
        if _indent(lines[i]) <= indent:
            break
        end = i + 1
    return end


def _find(lines: list[str], lo: int, hi: int, indent: int,
          key: str) -> int | None:
    for i in range(lo, hi):
        m = _KEY.match(lines[i])
        if m and len(m["indent"]) == indent and m["key"] == key:
            return i
    return None


def _mapping(lines: list[str], path: list[str],
             create: bool) -> tuple[int, int, int] | None:
    """The lines [lo, hi) of the block mapping at ``path`` (keys from the
    top), and its keys' indent; None when a key is missing, unless
    ``create`` adds it at the end of its parent. A mapping written inline
    (``uel: {n_permutations: 5}``) cannot be edited line by line."""
    lo, hi, indent = 0, len(lines), 0
    for depth, key in enumerate(path):
        i = _find(lines, lo, hi, indent, key)
        if i is None:
            if not create:
                return None
            lines.insert(hi, " " * indent + key + ":")
            i = hi
        m = _KEY.match(lines[i])
        assert m is not None
        if _written(m["rest"]):
            raise ValueError("%s is written inline (%s); Grid edits a "
                             "manifest's mappings written as blocks"
                             % (".".join(path[:depth + 1]),
                                _written(m["rest"])))
        end = _block_end(lines, i, indent)
        child = indent + 2
        for j in range(i + 1, end):
            if _content(lines[j]):
                child = _indent(lines[j])
                break
        lo, hi, indent = i + 1, end, child
    return lo, hi, indent


def _scalar(written: str) -> str:
    """A plain value as text: quotes taken off."""
    if len(written) >= 2 and written[0] == written[-1] == '"':
        try:
            loaded: Any = json.loads(written)
            if isinstance(loaded, str):
                return loaded
        except ValueError:
            pass
    if len(written) >= 2 and written[0] == written[-1] == "'":
        return written[1:-1].replace("''", "'")
    return written


def _lines(text: str) -> tuple[list[str], bool]:
    lines = text.split("\n")
    ends = len(lines) > 1 and lines[-1] == ""
    if ends:
        lines.pop()
    return lines, ends


def get_value(text: str, dotted: str) -> str | None:
    """The plain value at a dotted path (``metadata.mode``) as text, or None
    where the manifest has none (or writes the mapping inline)."""
    lines, _ = _lines(text)
    *path, key = dotted.split(".")
    try:
        span = _mapping(lines, path, create=False)
    except ValueError:
        return None
    if span is None:
        return None
    lo, hi, indent = span
    i = _find(lines, lo, hi, indent, key)
    if i is None:
        return None
    m = _KEY.match(lines[i])
    assert m is not None
    return _scalar(_written(m["rest"])) or None


def yaml_text(value: object) -> str:
    """A value as YAML writes it plainly: true/false, a number, or a string
    in double quotes."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    return json.dumps(str(value))


def set_values(text: str, values: dict[str, object]) -> str:
    """The manifest with each dotted path set to its value: the line that
    holds it rewritten (its comment kept), or a line added at the end of
    its mapping, the mapping too when it is missing. Everything else stays
    as written."""
    lines, ends = _lines(text)
    for dotted, value in values.items():
        *path, key = dotted.split(".")
        span = _mapping(lines, path, create=True)
        assert span is not None
        lo, hi, indent = span
        i = _find(lines, lo, hi, indent, key)
        if i is None:
            lines.insert(hi, "%s%s: %s" % (" " * indent, key,
                                           yaml_text(value)))
            continue
        m = _KEY.match(lines[i])
        assert m is not None
        if not _written(m["rest"]) and _block_end(lines, i, indent) > i + 1:
            raise ValueError("%s holds a mapping, not a value" % dotted)
        c = _comment_at(m["rest"])
        comment = "  " + m["rest"][c:].strip() if c >= 0 else ""
        lines[i] = "%s%s: %s%s" % (m["indent"], key, yaml_text(value),
                                   comment)
    return "\n".join(lines) + ("\n" if ends else "")


def remove_value(text: str, dotted: str) -> str:
    """The manifest without the plain value at a dotted path (its line
    gone); unchanged when it has none."""
    lines, ends = _lines(text)
    *path, key = dotted.split(".")
    try:
        span = _mapping(lines, path, create=False)
    except ValueError:
        return text
    if span is None:
        return text
    lo, hi, indent = span
    i = _find(lines, lo, hi, indent, key)
    if i is None or _block_end(lines, i, indent) > i + 1:
        return text
    del lines[i]
    return "\n".join(lines) + ("\n" if ends else "")


# ---------------------------------------------------------------------------
# What `limen validate` says

_ERROR = re.compile(r"^ {2}(?:PARSE ERROR|ERROR)"
                    r"(?: +\[(?P<path>.+?)\](?= \(line |: ))?"
                    r"(?: \(line (?P<line>\d+)\))?"
                    r": (?P<message>.*)$")


def validation_errors(output: str) -> list[Json]:
    """``limen validate``'s problems: each its line (or None), the path it
    names (or ""), and its message, with the lines a parse error runs on
    to."""
    out: list[Json] = []
    current: Json | None = None
    for line in output.splitlines():
        m = _ERROR.match(line)
        if m:
            current = {"line": int(m["line"]) if m["line"] else None,
                       "path": m["path"] or "", "message": m["message"]}
            out.append(current)
            continue
        s = line.strip()
        if current is not None and s and not s.startswith(("✗", "✓")):
            current["message"] = str(current["message"]) + "\n" + \
                line.rstrip()
    return out


# ---------------------------------------------------------------------------
# The project


def _now() -> float:
    return round(time.time(), 3)


def _write_json(path: str, obj: Json) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def _write_text(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _write_new(path: str, text: str) -> None:
    """Write a file that must not exist yet; refused when another write
    made it first."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError as err:
        raise ValueError("%s exists already" % os.path.basename(path)) from err
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


def _version_of(text: str) -> str:
    """A manifest's version: what a save must find on disk to write over
    it."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _read_json(path: str) -> Json | None:
    try:
        with open(path, encoding="utf-8") as f:
            loaded: Any = json.load(f)
    except (OSError, ValueError):
        return None
    return cast(Json, loaded) if isinstance(loaded, dict) else None


def _alive(pid: int, needle: str) -> bool:
    """Whether process ``pid`` still runs and is the one meant: its command
    line holds ``needle`` (a process id can be reused)."""
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    except OSError:
        return False
    try:
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return True
    return needle in out.stdout


def _tail(path: str, lines: int = 6) -> str | None:
    """The last lines of a log, for a shard that failed."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 4096))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    kept = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    return "\n".join(kept[-lines:]) or None


def _listdir(path: str) -> list[str]:
    """A folder's entries; none when it is gone (removed while listed)."""
    try:
        return os.listdir(path)
    except OSError:
        return []


def _and(items: list[str]) -> str:
    return items[0] if len(items) == 1 else "%s and %s" % (
        ", ".join(items[:-1]), items[-1])


# opens a run in the sweep: (its folder in the project, the result
# directories to read) -> the sweep's id for it
OpenFn = Callable[[str, list[str]], str]


class Project:
    """A Limen project the page makes and runs experiments in."""

    def __init__(self, root: str, cli: str) -> None:
        self.root = os.path.abspath(root)
        if not os.path.isfile(os.path.join(self.root, "limen.toml")):
            raise ValueError("%s has no limen.toml: not a Limen project "
                             "(make one with `limen new NAME`)" % self.root)
        self.cli = cli
        self.lock = threading.Lock()
        self.version = self._version()
        self.templates = self._templates()
        self.cores = os.cpu_count() or 1
        # runs opened in the sweep: run id -> the sweep's run id; the
        # function that opens one (set by the server's wiring); and why a
        # run did not open, or opened without a shard
        self.opened: dict[str, str] = {}
        self.opener: OpenFn | None = None
        self.open_lock = threading.Lock()
        self.notes: dict[str, str] = {}
        self.procs: dict[tuple[str, str], subprocess.Popen[bytes]] = {}
        # results.csv -> (bytes read, mtime, inode, records, in a quote,
        # the bytes read last)
        self.counts: dict[str, tuple[int, float, int, int, bool, bytes]] = {}
        # manifest -> (mtime_ns, size, version)
        self.versions: dict[str, tuple[int, int, str]] = {}
        self.names: dict[str, tuple[float, str | None, int | None]] = {}
        self._adopt()

    # -- the command line ---------------------------------------------------
    def _limen(self, *args: str, timeout: float = CLI_TIMEOUT
               ) -> subprocess.CompletedProcess[str]:
        try:
            return subprocess.run([self.cli, *args], cwd=self.root,
                                  capture_output=True, text=True,
                                  timeout=timeout, stdin=subprocess.DEVNULL)
        except FileNotFoundError as err:
            raise ValueError("no limen command at %s" % self.cli) from err
        except subprocess.TimeoutExpired as err:
            raise ValueError("limen %s did not answer in %d s"
                             % (args[0], int(timeout))) from err

    def _version(self) -> str:
        out = self._limen("--version", timeout=60)
        m = re.search(r"version (\S+)", out.stdout)
        if out.returncode != 0 or not m:
            raise ValueError("%s --version did not say its version: %s"
                             % (self.cli, (out.stdout + out.stderr)[-300:]))
        return m.group(1)

    def _templates(self) -> list[Json]:
        out = self._limen("list-templates", timeout=60)
        if out.returncode != 0:
            raise ValueError("%s list-templates failed: %s" % (
                self.cli, (out.stdout + out.stderr).strip()[-300:]))
        found: list[Json] = []
        for line in out.stdout.splitlines():
            m = re.match(r"^ {2}(\S+)\s{2,}(.*)$", line)
            if m:
                found.append({"name": m.group(1), "about": m.group(2)})
        return found

    def validate(self, text: str) -> list[Json]:
        """The manifest's problems as ``limen validate`` finds them; none
        when it passes."""
        fd, path = tempfile.mkstemp(suffix=".yaml", prefix="grid-")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            out = self._limen("validate", path)
        finally:
            os.unlink(path)
        if out.returncode == 0:
            return []
        errors = validation_errors(out.stdout)
        if not errors:
            errors = [{"line": None, "path": "",
                       "message": (out.stdout + out.stderr).strip()[-600:]
                       or "limen validate failed without saying why"}]
        return errors

    # -- experiments: the working manifests ---------------------------------
    def _manifest_path(self, name: str) -> str:
        """The experiment's working manifest: manifests/NAME.yaml, or the
        NAME.yml it is written as."""
        if not NAME.match(name):
            raise ValueError("an experiment's name is letters, digits, _ and "
                             "-, at most 64; got %r" % name)
        base = os.path.join(self.root, "manifests", name)
        if not os.path.isfile(base + ".yaml") and \
                os.path.isfile(base + ".yml"):
            return base + ".yml"
        return base + ".yaml"

    def manifest(self, name: str) -> Json:
        """The experiment's manifest and its version, from one read, so the
        two belong together."""
        path = self._manifest_path(name)
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except FileNotFoundError as err:
            raise ValueError("no experiment %s in manifests/" % name) from err
        return {"name": name, "text": text, "version": _version_of(text)}

    def _file_version(self, path: str) -> str | None:
        """A manifest file's version, read again only when it changes."""
        try:
            st = os.stat(path)
        except OSError:
            return None
        seen = self.versions.get(path)
        if seen and seen[0] == st.st_mtime_ns and seen[1] == st.st_size:
            return seen[2]
        try:
            with open(path, encoding="utf-8") as f:
                version = _version_of(f.read())
        except (OSError, UnicodeDecodeError):
            return None
        self.versions[path] = (st.st_mtime_ns, st.st_size, version)
        return version

    def save(self, name: str, text: str, version: object) -> str:
        """Write the experiment's manifest; refused unless the file still
        holds what the page read (``version``), so nothing written since,
        here or elsewhere, is lost. Its new version."""
        if not isinstance(version, str):
            raise ValueError("a save names the version of the manifest it "
                             "read")
        path = self._manifest_path(name)
        with self.lock:
            try:
                with open(path, encoding="utf-8") as f:
                    now: str | None = f.read()
            except FileNotFoundError:
                now = None
            if now is not None and _version_of(now) != version:
                raise ValueError("%s changed on disk since it was opened; "
                                 "open it again" % self._rel(path))
            _write_text(path, text)
        return _version_of(text)

    def create(self, name: str, template: object = None,
               text: object = None) -> str:
        """A new experiment: from one of Limen's templates (``limen init``),
        or from a manifest's text, named after itself."""
        path = self._manifest_path(name)
        if os.path.exists(path):
            raise ValueError("%s exists already" % self._rel(path))
        if isinstance(template, str):
            if template not in {t["name"] for t in self.templates}:
                raise ValueError("Limen has no template %r" % template)
            text = self._from_template(name, template)
        elif not isinstance(text, str) or not text.strip():
            raise ValueError("a new experiment starts from a template or "
                             "from a manifest's text")
        # the output path of the run it came from is that run's
        body = remove_value(set_values(text, {"metadata.name": name}),
                            "uel.output_path")
        with self.lock:
            # the name is the first create's: another one finds it taken
            path = self._manifest_path(name)
            if os.path.exists(path):
                raise ValueError("%s exists already" % self._rel(path))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            _write_new(path, body)
        return name

    def _from_template(self, name: str, template: str) -> str:
        """A template's manifest as ``limen init`` writes it, made apart
        from manifests/ (create writes it there)."""
        tmp = tempfile.mkdtemp(prefix="grid-init-")
        try:
            path = os.path.join(tmp, name + ".yaml")
            out = self._limen("init", path, "--template", template)
            if out.returncode != 0 or not os.path.isfile(path):
                raise ValueError("limen init failed: %s"
                                 % (out.stdout + out.stderr).strip()[-400:])
            with open(path, encoding="utf-8") as f:
                return f.read()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def experiments(self, runs: list[Json]) -> list[Json]:
        """The working manifests, and the experiments only runs name, each
        with its runs, newest first."""
        folder = os.path.join(self.root, "manifests")
        names: dict[str, Json] = {}
        if os.path.isdir(folder):
            for entry in sorted(os.listdir(folder)):
                stem, ext = os.path.splitext(entry)
                path = os.path.join(folder, entry)
                # NAME.yaml before NAME.yml, as _manifest_path reads it
                if ext in (".yaml", ".yml") and os.path.isfile(path) and \
                        NAME.match(stem) and stem not in names:
                    names[stem] = {"name": stem, "file": "manifests/" + entry,
                                   "version": self._file_version(path),
                                   "runs": []}
        for r in runs:
            name = str(r["experiment"])
            names.setdefault(name, {"name": name, "file": None,
                                    "version": None,
                                    "runs": []})["runs"].append(r["id"])
        return sorted(names.values(), key=lambda e: str(e["name"]))

    # -- runs ---------------------------------------------------------------
    def _rows(self, results: str) -> int:
        """The rounds a results.csv holds: its whole records less the
        header (a line break inside a quoted field ends no record). Read
        on from where the last count stopped while the file grows; counted
        again when what was counted has changed (the file shortened,
        replaced, or written again in place: the bytes read last are no
        longer where they were)."""
        try:
            st = os.stat(results)
        except OSError:
            return 0
        seen = self.counts.get(results)
        if seen is not None and seen[2] == st.st_ino and \
                seen[0] == st.st_size and seen[1] == st.st_mtime:
            return max(0, seen[3] - 1)
        try:
            with open(results, "rb") as f:
                pos, records, quoted, last = 0, 0, False, b""
                if seen is not None and seen[2] == st.st_ino and \
                        st.st_size >= seen[0]:
                    f.seek(seen[0] - len(seen[5]))
                    if f.read(len(seen[5])) == seen[5]:
                        pos, records, quoted, last = seen[0], seen[3], \
                            seen[4], seen[5]
                f.seek(pos)
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    pos += len(chunk)
                    last = (last + chunk)[-64:]
                    parts = chunk.split(b"\n")
                    for part in parts[:-1]:
                        if part.count(b'"') % 2:
                            quoted = not quoted
                        if not quoted:
                            records += 1
                    if parts[-1].count(b'"') % 2:
                        quoted = not quoted
        except OSError:
            return 0
        self.counts[results] = (pos, st.st_mtime, st.st_ino, records, quoted,
                                last)
        return max(0, records - 1)

    def _meta(self, directory: str) -> tuple[str | None, int | None]:
        """A Limen result directory's experiment name and planned rounds,
        from its metadata.json (read again only when it changes)."""
        path = os.path.join(directory, "metadata.json")
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return None, None
        seen = self.names.get(path)
        if seen and seen[0] == mtime:
            return seen[1], seen[2]
        meta = _read_json(path) or {}
        ref: Any = meta.get("yaml_reference")
        name: str | None = None
        planned: int | None = None
        if isinstance(ref, dict):
            md: Any = cast(Json, ref).get("metadata")
            if isinstance(md, dict) and isinstance(cast(Json, md).get("name"),
                                                   str):
                name = str(cast(Json, md)["name"])
            uel: Any = cast(Json, ref).get("uel")
            if isinstance(uel, dict) and isinstance(
                    cast(Json, uel).get("n_permutations"), int):
                planned = int(cast(Json, uel)["n_permutations"])
        self.names[path] = (mtime, name, planned)
        return name, planned

    def _run_folders(self) -> list[tuple[str, str]]:
        """Every run under results/: (its folder, "grid" or "limen"). A
        folder Grid started holds grid-run.json; any other result directory
        (``limen run`` from a shell, or a committed manifest's) is a run of
        one directory."""
        out: list[tuple[str, str]] = []
        for base in ("results/dev", "results"):
            top = os.path.join(self.root, base)
            if not os.path.isdir(top):
                continue
            for a in sorted(_listdir(top)):
                p1 = os.path.join(top, a)
                if base == "results" and a == "dev" or not os.path.isdir(p1):
                    continue
                if os.path.isfile(os.path.join(p1, "metadata.json")):
                    out.append((p1, "limen"))
                    continue
                for b in sorted(_listdir(p1)):
                    p2 = os.path.join(p1, b)
                    if os.path.isfile(os.path.join(p2, RECORD)):
                        out.append((p2, "grid"))
                    elif os.path.isfile(os.path.join(p2, "metadata.json")):
                        out.append((p2, "limen"))
        return out

    def _rel(self, path: str) -> str:
        return os.path.relpath(path, self.root)

    def _folder(self, run_id: object) -> str:
        """A run's folder from its id (its path in the project), refused
        unless it is one of the project's runs."""
        if not isinstance(run_id, str):
            raise ValueError("a run is named by its folder in the project")
        for folder, _ in self._run_folders():
            if self._rel(folder) == run_id:
                return folder
        raise ValueError("no run %r in the project" % run_id)

    def runs(self) -> list[Json]:
        """Every run, newest first: its experiment, when it started, its
        shards (rounds written of those planned, how each stands), and
        whether the sweep has it open."""
        out: list[Json] = []
        for folder, kind in self._run_folders():
            rid = self._rel(folder)
            stopping = False
            if kind == "grid":
                with self.lock:
                    record = _read_json(os.path.join(folder, RECORD)) or {}
                shards: list[Json] = []
                raw: Any = record.get("shards")
                for s in cast(list[Any], raw) if isinstance(raw, list) else []:
                    if not isinstance(s, dict):
                        continue
                    sh = cast(Json, s)
                    label = str(sh.get("label"))
                    stopping = stopping or bool(sh.get("stopping"))
                    shards.append({
                        "label": label, "seed": sh.get("seed"),
                        "planned": sh.get("rounds"),
                        "rows": self._rows(os.path.join(folder, label,
                                                        "results.csv")),
                        "state": sh.get("state"), "exit": sh.get("exit"),
                        "checkpoint": os.path.isfile(os.path.join(
                            folder, label, "checkpoint.json")),
                        "tail": sh.get("error") or _tail(os.path.join(
                            folder, "logs", label + ".log"))
                        if sh.get("state") == "failed" else None})
                started = record.get("started_at")
                name = str(record.get("experiment") or "")
            else:
                name_got, planned = self._meta(folder)
                rows = self._rows(os.path.join(folder, "results.csv"))
                shards = [{"label": os.path.basename(folder), "seed": None,
                           "planned": planned, "rows": rows,
                           "state": "finished" if planned is not None and
                           rows >= planned else "incomplete", "exit": None,
                           "checkpoint": False, "tail": None}]
                try:
                    started = os.path.getmtime(os.path.join(folder,
                                                            "metadata.json"))
                except OSError:
                    continue    # removed while listed
                name = name_got or os.path.basename(folder)
            states = {str(s["state"]) for s in shards}
            state = next((x for x in ("running", "failed", "stopped",
                                      "incomplete") if x in states),
                         "finished")
            out.append({
                "id": rid, "kind": kind, "experiment": name,
                "started": started, "state": state, "shards": shards,
                "rows": sum(int(s["rows"] or 0) for s in shards),
                "planned": sum(int(s["planned"] or 0) for s in shards),
                "open": self.opened.get(rid), "note": self.notes.get(rid),
                "stopping": stopping})
        out.sort(key=lambda r: float(r["started"] or 0), reverse=True)
        return out

    def _record_shards(self, folder: str) -> list[Json]:
        with self.lock:
            record = _read_json(os.path.join(folder, RECORD)) or {}
        raw: Any = record.get("shards")
        return [cast(Json, s) for s in cast(list[Any], raw)
                if isinstance(s, dict)] if isinstance(raw, list) else []

    def state(self) -> Json:
        runs = self.runs()
        return {"project": {"root": self.root,
                            "name": os.path.basename(self.root)},
                "limen": {"cli": self.cli, "version": self.version},
                "cores": self.cores, "templates": self.templates,
                "experiments": self.experiments(runs), "runs": runs}

    # -- starting, stopping, resuming ----------------------------------------
    def _spawn(self, args: list[str], log: str,
               threads: int) -> subprocess.Popen[bytes]:
        env = dict(os.environ)
        for var in THREAD_VARS:
            env[var] = str(threads)
        env["TQDM_DISABLE"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        out: IO[bytes] = open(log, "ab")
        try:
            return subprocess.Popen([self.cli, *args], cwd=self.root,
                                    stdout=out, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, env=env,
                                    start_new_session=True)
        finally:
            out.close()

    def start(self, name: str, rounds: object, shards: object,
              execution: object, outputs: object) -> str:
        """Run an experiment: its manifest copied once per shard with the
        shard's seed, its share of the rounds, its output path and the
        recording asked for, and ``limen run`` on each copy side by side.
        The shards share the rounds evenly (rounded up), so that their
        manifests differ only in the seed and the output path, as a run
        read from several directories must. The run's id is its folder in
        the project."""
        path = self._manifest_path(name)
        if not os.path.isfile(path):
            raise ValueError("no experiment %s in manifests/" % name)
        if not isinstance(rounds, int) or isinstance(rounds, bool) or \
                not 1 <= rounds <= MAX_ROUNDS:
            raise ValueError("rounds is a whole number from 1 to %d"
                             % MAX_ROUNDS)
        if not isinstance(shards, int) or isinstance(shards, bool) or \
                not 1 <= shards <= self.cores:
            raise ValueError("shards is a whole number from 1 to %d, this "
                             "machine's cores" % self.cores)
        if shards > rounds:
            raise ValueError("%d shards cannot share %d rounds"
                             % (shards, rounds))
        with open(path, encoding="utf-8") as f:
            text = f.read()
        problems = self.validate(text)
        if problems:
            raise ValueError("limen validate finds %d problem%s in the "
                             "manifest; it is not run"
                             % (len(problems), "" if len(problems) == 1
                                else "s"))
        search = get_value(text, "uel.search_strategy.type")
        if shards > 1 and search != "random":
            raise ValueError("shards draw apart only in a random search "
                             "(uel.search_strategy.type: random); this "
                             "manifest's is %s" % (search or "not set"))
        seed_text = get_value(text, "uel.search_strategy.seed")
        try:
            seed = int(seed_text) if seed_text is not None else None
        except ValueError:
            seed = None
        if shards > 1 and seed is None:
            seed = random.randrange(1, 2 ** 31)
        mode = get_value(text, "metadata.mode")
        base = "results" if mode == "production" else "results/dev"
        stamp = time.strftime("%Y%m%d_%H%M%S")
        parent = os.path.join(self.root, base, name)
        os.makedirs(parent, exist_ok=True)
        k = 1
        while True:
            # the folder is this run's once made: a start beside it takes
            # the next
            folder = os.path.join(parent, stamp if k == 1
                                  else "%s_%d" % (stamp, k))
            try:
                os.mkdir(folder)
                break
            except FileExistsError:
                k += 1
        rel_out = os.path.relpath(folder, os.path.join(self.root, base))
        os.makedirs(os.path.join(folder, "manifests"))
        os.makedirs(os.path.join(folder, "logs"))
        _write_text(os.path.join(folder, BASE_COPY), text)
        threads = max(1, self.cores // shards)
        share = -(-rounds // shards)
        records: list[Json] = []
        for j in range(shards):
            label = "s%d" % (j + 1)
            values: dict[str, object] = {
                "uel.n_permutations": share,
                "uel.output_path": "%s/%s" % (rel_out, label),
                "uel.record_execution": bool(execution),
                "uel.record_model_outputs": bool(outputs)}
            if shards > 1 and seed is not None:
                values["uel.search_strategy.seed"] = seed + j
            _write_text(os.path.join(folder, "manifests", label + ".yaml"),
                        set_values(text, values))
            records.append({"label": label, "rounds": share,
                            "seed": seed + j if shards > 1 and
                            seed is not None else seed,
                            "pid": None, "state": "running", "exit": None,
                            "stopping": False})
        # the copies must pass too: the recording keys are Limen 5.16 and
        # 5.17's
        with open(os.path.join(folder, "manifests", "s1.yaml"),
                  encoding="utf-8") as f:
            problems = self.validate(f.read())
        if problems:
            raise ValueError("the run's copy of the manifest does not pass "
                             "limen validate: %s"
                             % problems[0]["message"].split("\n")[0])
        record: Json = {"experiment": name, "started_at": _now(),
                        "rounds": share * shards, "threads": threads,
                        "record": {"execution": bool(execution),
                                   "outputs": bool(outputs)},
                        "shards": records}
        rid = self._rel(folder)
        failed: str | None = None
        with self.lock:
            _write_json(os.path.join(folder, RECORD), record)
            for s in records:
                label = str(s["label"])
                if failed is None:
                    try:
                        proc = self._spawn(
                            ["run", "--no-progress-bar",
                             os.path.join(folder, "manifests",
                                          label + ".yaml")],
                            os.path.join(folder, "logs", label + ".log"),
                            threads)
                    except OSError as err:
                        failed = str(err)
                    else:
                        s["pid"] = proc.pid
                        self.procs[(rid, label)] = proc
                        continue
                # the shards started go on, watched; the rest are recorded
                # as failed, with why
                s.update(state="failed",
                         error="limen run could not be started: %s" % failed)
            _write_json(os.path.join(folder, RECORD), record)
        for s in records:
            if s["state"] == "running":
                self._watch(rid, folder, str(s["label"]))
        threading.Thread(target=self._open_when_written,
                         args=(rid, folder), daemon=True).start()
        if failed is not None:
            raise ValueError("limen run could not be started for %s: %s" % (
                _and([str(s["label"]) for s in records
                      if s["state"] == "failed"]), failed))
        return rid

    def _watch(self, rid: str, folder: str, label: str) -> None:
        proc = self.procs[(rid, label)]

        def wait() -> None:
            code = proc.wait()
            self._ended(folder, label, code)
        threading.Thread(target=wait, daemon=True).start()

    def _ended(self, folder: str, label: str, code: int | None) -> None:
        """A shard's process has ended: stopped when a stop was asked for;
        failed when it exited with an error; else (a clean exit, or one
        this server did not see) finished when its rounds are all written
        and stopped when not, as a SIGTERM from outside Grid stops it,
        with a checkpoint to resume from."""
        with self.lock:
            path = os.path.join(folder, RECORD)
            record = _read_json(path)
            if record is None:
                return
            for s in cast(list[Json], record.get("shards") or []):
                if s.get("label") != label:
                    continue
                if s.get("stopping"):
                    s["state"] = "stopped"
                elif code is None or code == 0:
                    done = self._rows(os.path.join(folder, label,
                                                   "results.csv"))
                    planned = s.get("rounds")
                    s["state"] = "finished" if isinstance(planned, int) and \
                        done >= planned else "stopped"
                else:
                    s["state"] = "failed"
                s["exit"] = code
                s["stopping"] = False
            _write_json(path, record)

    def _adopt(self) -> None:
        """Shards a previous server started and left running: still running
        when their process is (it is watched until it ends), else ended
        (how, by their rounds)."""
        for folder, kind in self._run_folders():
            if kind != "grid":
                continue
            for s in self._record_shards(folder):
                if s.get("state") != "running":
                    continue
                pid = s.get("pid")
                label = str(s.get("label"))
                if isinstance(pid, int) and _alive(pid, folder):
                    threading.Thread(target=self._poll_ended,
                                     args=(folder, label, pid),
                                     daemon=True).start()
                else:
                    self._ended(folder, label, None)

    def _poll_ended(self, folder: str, label: str, pid: int) -> None:
        while _alive(pid, folder):
            time.sleep(2.0)
        self._ended(folder, label, None)

    def _open_when_written(self, rid: str, folder: str) -> None:
        """Open a run Grid started in the sweep once each shard has written
        its first round (its results.csv and its round log), or has ended."""
        while True:
            shards = self._record_shards(folder)
            ready = all(
                s.get("state") != "running" or all(os.path.isfile(
                    os.path.join(folder, str(s.get("label")), f))
                    for f in ("results.csv", "round_data.jsonl"))
                for s in shards)
            if ready:
                break
            time.sleep(1.0)
        try:
            self.open(rid)
        except ValueError as err:
            # said where the run is listed, not lost
            with self.open_lock:
                self.notes[rid] = str(err)

    def _readable(self, folder: str) -> tuple[list[str], list[str]]:
        """A run's result directories that can be read now, and its shards
        that ended without writing a round (read without them). Refused
        while a shard still running has written no round: a run Grid
        started then opens by itself once each has."""
        rid = self._rel(folder)
        if not os.path.isfile(os.path.join(folder, RECORD)):
            if not os.path.isfile(os.path.join(folder, "results.csv")):
                raise ValueError("%s has written no round yet" % rid)
            return [folder], []
        dirs: list[str] = []
        left: list[str] = []
        for s in self._record_shards(folder):
            label = str(s.get("label"))
            d = os.path.join(folder, label)
            if all(os.path.isfile(os.path.join(d, f))
                   for f in ("results.csv", "metadata.json")):
                dirs.append(d)
            elif s.get("state") == "running":
                raise ValueError("%s is writing its first rounds; it opens "
                                 "by itself once each shard has written one"
                                 % rid)
            else:
                left.append(label)
        if not dirs:
            raise ValueError("%s ended without writing a round; its logs/ "
                             "say why" % rid)
        return dirs, left

    def open(self, rid: object) -> str:
        """The run in the sweep, opened once (a run being opened is not
        opened again meanwhile), without the shards that ended without
        writing a round; the sweep's id for it."""
        folder = self._folder(rid)
        key = self._rel(folder)
        with self.open_lock:
            if key in self.opened:
                return self.opened[key]
            if self.opener is None:
                raise ValueError("this server cannot open runs")
            dirs, left = self._readable(folder)
            sweep_id = self.opener(key, dirs)
            self.opened[key] = sweep_id
            if left:
                self.notes[key] = ("%s ended without writing a round, so the "
                                   "run is read without %s" % (
                                       _and(left),
                                       "it" if len(left) == 1 else "them"))
            else:
                self.notes.pop(key, None)
        return sweep_id

    def follow(self) -> None:
        """Once the server can open runs: each run Grid started that is
        still running opens once its shards have written a round, as it
        would have had this server started it; and the newest run, when
        it is not running, opens now."""
        runs = self.runs()
        for r in runs:
            if r["kind"] == "grid" and r["state"] == "running":
                threading.Thread(target=self._open_when_written,
                                 args=(r["id"], self._folder(r["id"])),
                                 daemon=True).start()
        if runs and runs[0]["state"] != "running":
            rid = str(runs[0]["id"])
            try:
                self.open(rid)
            except ValueError as err:
                with self.open_lock:
                    self.notes[rid] = str(err)

    def stop(self, rid: object) -> None:
        """Ask each running shard to stop as Limen stops: the round in hand
        finishes and a checkpoint is written. Asked again, the round in
        hand is cut short (Limen then checkpoints the last whole round)."""
        folder = self._folder(rid)
        with self.lock:
            path = os.path.join(folder, RECORD)
            record = _read_json(path)
            if record is None:
                raise ValueError("%s is not a run Grid started" % rid)
            asked = 0
            key = self._rel(folder)
            for s in cast(list[Json], record.get("shards") or []):
                pid = s.get("pid")
                if s.get("state") != "running" or not isinstance(pid, int):
                    continue
                proc = self.procs.get((key, str(s.get("label"))))
                if proc is not None:
                    # a process of this server's: signalled only while it
                    # has not ended
                    if proc.poll() is not None:
                        continue
                    proc.send_signal(signal.SIGTERM)
                else:
                    # one a previous server started: its id may have gone
                    # to another process since, so it must still be the
                    # shard's
                    if not _alive(pid, folder):
                        continue
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except ProcessLookupError:
                        continue
                asked += 1
                s["stopping"] = True
            _write_json(path, record)
        if not asked:
            raise ValueError("no shard of %s is running" % rid)

    def resume(self, rid: object) -> None:
        """Run on from each stopped or failed shard's checkpoint (``limen
        run --resume``), in the same folder and log."""
        folder = self._folder(rid)
        key = self._rel(folder)
        with self.lock:
            path = os.path.join(folder, RECORD)
            record = _read_json(path)
            if record is None:
                raise ValueError("%s is not a run Grid started" % rid)
            threads = record.get("threads")
            started: list[str] = []
            failed: str | None = None
            for s in cast(list[Json], record.get("shards") or []):
                label = str(s.get("label"))
                directory = os.path.join(folder, label)
                if s.get("state") not in ("stopped", "failed") or \
                        not os.path.isfile(os.path.join(directory,
                                                        "checkpoint.json")):
                    continue
                if failed is None:
                    try:
                        proc = self._spawn(
                            ["run", "--no-progress-bar", "--resume",
                             directory],
                            os.path.join(folder, "logs", label + ".log"),
                            threads if isinstance(threads, int) else 1)
                    except OSError as err:
                        failed = str(err)
                    else:
                        s.update(pid=proc.pid, state="running", exit=None,
                                 stopping=False, error=None)
                        self.procs[(key, label)] = proc
                        started.append(label)
                        continue
                s["error"] = ("limen run --resume could not be started: %s"
                              % failed)
            _write_json(path, record)
        for label in started:
            self._watch(key, folder, label)
        if started and key not in self.opened:
            threading.Thread(target=self._open_when_written,
                             args=(key, folder), daemon=True).start()
        if failed is not None:
            raise ValueError("limen run --resume could not be started: %s"
                             % failed)
        if not started:
            raise ValueError("no shard of %s has a checkpoint to resume from"
                             % rid)

    def diff(self, name: str, text: str) -> Json:
        """The experiment's manifest against the one its last run started
        from (a run Grid started keeps it as experiment.yaml; another
        keeps the copy ``limen run`` made)."""
        self._manifest_path(name)
        for r in self.runs():
            if r["experiment"] != name:
                continue
            folder = os.path.join(self.root, str(r["id"]))
            copy = os.path.join(folder, BASE_COPY)
            if r["kind"] != "grid":
                found = [n for n in os.listdir(folder)
                         if n.endswith((".yaml", ".yml"))]
                copy = os.path.join(folder, found[0]) if len(found) == 1 \
                    else ""
            if not copy or not os.path.isfile(copy):
                continue
            with open(copy, encoding="utf-8") as f:
                old = f.read()
            lines = list(difflib.unified_diff(
                old.splitlines(keepends=True), text.splitlines(keepends=True),
                fromfile="%s (as run)" % r["id"],
                tofile=self._rel(self._manifest_path(name)), n=2))
            return {"against": r["id"], "diff": "".join(lines)}
        return {"against": None, "diff": ""}
