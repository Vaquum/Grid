"""Serve the page and the live sweep over HTTP (standard library only).

Routes:

- ``/``             the page, told to read the live sweep from this server;
- ``/api/pack``     everything as of now (gzip when accepted), with a cursor
                    token for the stream;
- ``/api/stream``   server-sent events that bring a page holding the cursor
                    up to date, as rows and log lines arrive;
- ``/api/row``      one row rebuilt from its columns (``?run=ID&i=N``);
- ``/api/health``   rows per run and recent errors.

A cursor token is used by one stream. A page that loses its stream fetches
the pack again rather than guessing what it missed.

On a Limen project (``serve --project``), the Experiment view's routes:

- ``GET /api/experiment``           the project: its experiments, runs, and
                                     Limen's version and templates;
- ``GET /api/experiment/manifest``  an experiment's manifest (``?name=``);
- ``POST /api/experiment/ACTION``   validate, save, create, start, stop,
                                     resume, open or diff, with a JSON body.

A POST starts processes and writes files, so it is refused unless it
carries the page's own token (``X-Grid-Token``, in the page's config, which
another site cannot read) and comes from the page's own origin, as JSON:
a local server must not run what another site asks of it. And on a
project, every request must name this server by its address or as
localhost (its Host header): a name another site's DNS could point here
would make that site the page's origin, token and all (DNS rebinding).
"""

from __future__ import annotations

import gzip
import ipaddress
import json
import re
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, cast
from urllib.parse import parse_qs, urlparse

from .experiment import Project
from .sweep import Cursor, Sweep

CURSOR_TTL = 600.0
PING_EVERY = 15.0
MAX_BODY = 4 << 20     # a manifest is a few kilobytes
ACTIONS = ("validate", "save", "create", "start", "stop", "resume", "open",
           "diff")


PageFn = Callable[[], bytes]


def direct_host(host: str) -> bool:
    """Whether a Host header names the machine itself: an IP address or
    localhost, with or without a port. A domain name could be pointed here
    by another site's DNS, so it is not taken on a project."""
    m = re.fullmatch(r"\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?"
                     r"|([^:\[\]]+)(?::\d{1,5})?", host.strip())
    if not m:
        return False
    name = (m.group(1) or m.group(2) or "").lower()
    if name == "localhost" or name.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


class Server:
    def __init__(self, sweep: Sweep, page: PageFn,
                 project: Project | None = None,
                 token: str | None = None) -> None:
        self.sweep = sweep
        self.page = page
        self.project = project      # the Limen project, with --project
        self.token = token          # the page's own, for the project's POSTs
        self.cursors: dict[str, tuple[float, Cursor]] = {}
        self.lock = threading.Lock()

    def save_cursor(self, cursor: Cursor) -> str:
        token = secrets.token_urlsafe(12)
        now = time.time()
        with self.lock:
            for t in [t for t, (at, _) in self.cursors.items()
                      if now - at > CURSOR_TTL]:
                del self.cursors[t]
            self.cursors[token] = (now, cursor)
        return token

    def take_cursor(self, token: str) -> Cursor | None:
        with self.lock:
            got = self.cursors.pop(token, None)
        return got[1] if got else None


def make_handler(server: Server) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            pass

        def handle(self) -> None:
            # a page that navigates away closes its connections; that is
            # not an error of the server's
            try:
                super().handle()
            except (ConnectionResetError, BrokenPipeError):
                pass

        def send_bytes(self, body: bytes, ctype: str,
                       compressible: bool = True) -> None:
            gz = compressible and "gzip" in self.headers.get(
                "Accept-Encoding", "") and len(body) > 1024
            if gz:
                body = gzip.compress(body, 6)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if gz:
                self.send_header("Content-Encoding", "gzip")
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, obj: Any) -> None:
            self.send_bytes(json.dumps(obj).encode(), "application/json")

        def fail(self, code: int, message: str) -> None:
            body = json.dumps({"error": message}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def misaddressed(self) -> bool:
            """On a project, a request that names this server by a name it
            cannot vouch for is refused (DNS rebinding)."""
            if server.project is None or direct_host(
                    self.headers.get("Host", "")):
                return False
            self.fail(403, "on a project, this server answers requests to "
                           "its address or to localhost, not to %r"
                      % self.headers.get("Host", ""))
            return True

        def do_GET(self) -> None:
            if self.misaddressed():
                return
            url = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            if url.path in ("/", "/index.html"):
                return self.send_bytes(server.page(),
                                       "text/html; charset=utf-8")
            if url.path == "/api/pack":
                text, cursor = server.sweep.pack_text()
                token = server.save_cursor(cursor)
                body = ('{"cursor":%s,"pack":%s}' % (json.dumps(token), text))
                return self.send_bytes(body.encode(), "application/json")
            if url.path == "/api/stream":
                cursor = server.take_cursor(q.get("cursor", ""))
                if cursor is None:
                    return self.fail(410, "cursor unknown or used; fetch "
                                          "/api/pack again")
                return self.stream(cursor)
            if url.path == "/api/row":
                return self.row(q)
            if url.path == "/api/experiment" and server.project:
                return self.send_json(server.project.state())
            if url.path == "/api/experiment/manifest" and server.project:
                try:
                    return self.send_json(server.project.manifest(
                        q.get("name", "")))
                except ValueError as exc:
                    return self.fail(400, str(exc))
            if url.path == "/api/health":
                s = server.sweep
                with s.lock:
                    runs = [{"id": r.id, "rows": r.store.rows,
                             "generation": r.generation,
                             "bad": r.bad_count} for r in s.runs]
                    errors = s.errors[-10:]
                return self.send_json({"ok": True, "runs": runs,
                                       "errors": errors})
            return self.fail(404, "no route " + url.path)

        def do_POST(self) -> None:
            if self.misaddressed():
                return
            url = urlparse(self.path)
            action = url.path.removeprefix("/api/experiment/")
            project = server.project
            if project is None or action == url.path or action not in ACTIONS:
                return self.fail(404, "no route " + url.path)
            why = self.refused()
            if why:
                return self.fail(403, why)
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                size = -1
            if not 0 <= size <= MAX_BODY:
                return self.fail(413, "a request body of at most %d bytes"
                                 % MAX_BODY)
            try:
                loaded: Any = json.loads(self.rfile.read(size) or b"{}")
            except ValueError:
                return self.fail(400, "the body is not JSON")
            if not isinstance(loaded, dict):
                return self.fail(400, "the body is a JSON object")
            body = cast(dict[str, Any], loaded)
            try:
                return self.send_json(act(project, action, body))
            except ValueError as exc:
                return self.fail(400, str(exc))

        def refused(self) -> str | None:
            """Why a POST is refused: no token or another, another origin,
            or not JSON."""
            token = self.headers.get("X-Grid-Token", "")
            if not server.token or not secrets.compare_digest(
                    token.encode(), server.token.encode()):
                return "the page's token is missing or wrong"
            origin = self.headers.get("Origin")
            host = self.headers.get("Host", "")
            if origin is not None and origin != "http://" + host:
                return "a request from another origin (%s)" % origin
            site = self.headers.get("Sec-Fetch-Site")
            if site is not None and site not in ("same-origin", "none"):
                return "a request from another site"
            if not self.headers.get("Content-Type", "").startswith(
                    "application/json"):
                return "the body must be JSON (application/json)"
            return None

        def row(self, q: dict[str, str]) -> None:
            s = server.sweep
            with s.lock:
                run = next((r for r in s.runs if r.id == q.get("run")), None)
                if run is None:
                    return self.fail(404, "no run %r" % q.get("run"))
                try:
                    i = int(q.get("i", ""))
                    obj = run.store.row_object(i)
                except (ValueError, IndexError) as exc:
                    return self.fail(400, str(exc))
                gen = run.generation
            self.send_json({"run": run.id, "generation": gen, "i": i,
                            "row": obj})

        def stream(self, cursor: Cursor) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            sweep = server.sweep
            last_ping = time.monotonic()
            try:
                while True:
                    sweep.wait_change(cursor.version, PING_EVERY)
                    msgs = sweep.delta_text(cursor)
                    if msgs:
                        for m in msgs:
                            self.wfile.write(b"data: " + m.encode() +
                                             b"\n\n")
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    elif time.monotonic() - last_ping >= PING_EVERY:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = time.monotonic()
                    time.sleep(0.25)  # coalesce bursts of lines
            except (BrokenPipeError, ConnectionResetError):
                return

    return Handler


def act(project: Project, action: str, body: dict[str, Any]) -> Any:
    """One of the Experiment view's actions, on the project."""
    def text(key: str) -> str:
        v: Any = body.get(key)
        if not isinstance(v, str):
            raise ValueError("%s is text" % key)
        return v

    if action == "validate":
        return {"errors": project.validate(text("text"))}
    if action == "save":
        return {"version": project.save(text("name"), text("text"),
                                        body.get("version"))}
    if action == "create":
        return {"name": project.create(text("name"), body.get("template"),
                                       body.get("text"))}
    if action == "start":
        return {"run": project.start(text("name"), body.get("rounds"),
                                     body.get("shards"),
                                     body.get("execution"),
                                     body.get("outputs"),
                                     body.get("version"))}
    if action == "stop":
        project.stop(body.get("run"))
        return {"ok": True}
    if action == "resume":
        project.resume(body.get("run"))
        return {"ok": True}
    if action == "open":
        return {"sweepRun": project.open(body.get("run"))}
    return project.diff(text("name"), text("text"))


def serve(sweep: Sweep, page: PageFn, host: str, port: int,
          project: Project | None = None,
          token: str | None = None) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port), make_handler(
        Server(sweep, page, project, token)))
    httpd.daemon_threads = True
    return httpd
