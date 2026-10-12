"""JSON CLI and MCP stdio adapter for the same authenticated Grid API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, cast
from urllib.parse import urlparse

from . import __version__
from .agent import TOOL_BY_NAME, TOOLS, Json, failure

PROTOCOLS = ("2025-11-25", "2025-06-18", "2024-11-05")


def write_connection(path: str, url: str, token: str) -> None:
    """Create an exclusive private credential, separate from page config."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"apiVersion": 1, "url": url, "token": token}, f)
        f.write("\n")


class Client:
    def __init__(self, connection: str) -> None:
        with open(connection, encoding="utf-8") as f:
            loaded: Any = json.load(f)
        if not isinstance(loaded, dict):
            raise ValueError("connection file is a JSON object")
        config = cast(Json, loaded)
        for key in ("url", "token"):
            value: Any = config.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError("connection %s is nonempty text" % key)
        self.url = cast(str, config["url"]).rstrip("/")
        self.token = cast(str, config["token"])
        parsed = urlparse(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or \
                parsed.username or parsed.password or parsed.query or \
                parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("connection URL names an HTTP(S) server root")

    def call(self, operation: str, arguments: Json) -> Json:
        data = json.dumps({"operation": operation, "arguments": arguments},
                          allow_nan=False).encode()
        req = urllib.request.Request(self.url + "/api/agent", data=data,
                                     headers={"Content-Type":
                                              "application/json",
                                              "Authorization": "Bearer "
                                              + self.token}, method="POST")
        try:
            # Never follow redirects carrying the credential to another host.
            opener = urllib.request.build_opener(NoAgentRedirect())
            with opener.open(req, timeout=150) as res:
                return cast(Json, json.load(res))
        except urllib.error.HTTPError as exc:
            with exc:
                try:
                    error: Json = json.load(exc)
                    if error.get("apiVersion") == 1 and error.get(
                            "ok") is False:
                        return error
                except ValueError:
                    pass
            return failure("HTTP_ERROR", "Grid answered HTTP %d" % exc.code)
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return failure("CONNECTION_FAILED", str(exc), True)


class NoAgentRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str,
                         headers: Any, newurl: str) -> None:
        return None


def cmd_agent(args: argparse.Namespace) -> int:
    try:
        raw = args.arguments
        if args.arguments_file:
            if args.arguments_file == "-":
                raw = sys.stdin.read()
            else:
                with open(args.arguments_file, encoding="utf-8") as f:
                    raw = f.read()
        loaded: Any = json.loads(raw or "{}")
        if not isinstance(loaded, dict):
            raise ValueError("arguments is a JSON object")
        result = Client(args.connection).call(args.operation,
                                              cast(Json, loaded))
    except (OSError, ValueError, KeyError) as exc:
        result = failure("INVALID_INPUT", str(exc))
    print(json.dumps(result, allow_nan=False))
    return 0 if result["ok"] else 1


def rpc_error(code: int, message: str) -> Json:
    return {"code": code, "message": message}


def mcp_reply(client: Client, request: Any) -> Json | None:
    if not isinstance(request, dict):
        return {"jsonrpc": "2.0", "id": None,
                "error": rpc_error(-32600, "invalid request")}
    req = cast(Json, request)
    if req.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None,
                "error": rpc_error(-32600, "invalid request")}
    if "id" not in req:
        return None
    reply: Json = {"jsonrpc": "2.0", "id": req["id"]}
    method = req.get("method")
    params: Any = req.get("params", {})
    if not isinstance(params, dict):
        return {**reply, "error": rpc_error(-32602, "params is an object")}
    params = cast(Json, params)
    if method == "initialize":
        version = params.get("protocolVersion")
        reply["result"] = {
            "protocolVersion": version if version in PROTOCOLS
            else PROTOCOLS[0],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "grid", "version": __version__},
            "instructions": "Use grid_discover. Analyze schema first; "
            "reuse returned state and generation for subsequent queries. "
            "Reuse requestId only when retrying the identical write intent."}
    elif method == "ping":
        reply["result"] = {}
    elif method == "tools/list":
        reply["result"] = {"tools": TOOLS}
    elif method == "tools/call":
        name: Any = params.get("name")
        arguments: Any = params.get("arguments", {})
        if not isinstance(name, str) or name not in TOOL_BY_NAME or \
                not isinstance(arguments, dict):
            return {**reply, "error": rpc_error(-32602, "unknown tool or "
                                                "invalid arguments")}
        result = client.call(name, cast(Json, arguments))
        reply["result"] = {"content": [{"type": "text", "text": json.dumps(
            result, allow_nan=False)}], "structuredContent": result,
            "isError": not result["ok"]}
    else:
        reply["error"] = rpc_error(-32601, "method not found")
    return reply


def cmd_mcp(args: argparse.Namespace) -> int:
    try:
        client = Client(args.connection)
    except (OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    for line in sys.stdin:
        try:
            loaded: Any = json.loads(line)
            response = mcp_reply(client, loaded)
        except ValueError:
            response = {"jsonrpc": "2.0", "id": None,
                        "error": rpc_error(-32700, "parse error")}
        if response is not None:
            print(json.dumps(response, allow_nan=False), flush=True)
    return 0
