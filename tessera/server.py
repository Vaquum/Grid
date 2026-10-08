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
"""

from __future__ import annotations

import gzip
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .sweep import Cursor, Sweep

CURSOR_TTL = 600.0
PING_EVERY = 15.0


class Server:
    def __init__(self, sweep: Sweep, page: bytes) -> None:
        self.sweep = sweep
        self.page = page
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

        def do_GET(self) -> None:
            url = urlparse(self.path)
            q = {k: v[-1] for k, v in parse_qs(url.query).items()}
            if url.path in ("/", "/index.html"):
                return self.send_bytes(server.page, "text/html; charset=utf-8")
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


def serve(sweep: Sweep, page: bytes, host: str,
          port: int) -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((host, port),
                                make_handler(Server(sweep, page)))
    httpd.daemon_threads = True
    return httpd
