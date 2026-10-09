"""Assemble the page: one self-contained HTML file, no runtime dependency.

    python3 tools/build.py                       # dist/grid.html
    python3 tools/build.py --pack PACK.json.gz --out dist/demo.html
    python3 tools/build.py --pack ... --fragment --out dist/artifact.html

The ES modules in web/js are joined in dependency order into one script
(imports dropped, exports kept as plain declarations); two modules may not
declare the same top-level name, and the build stops if they do. A pack,
when given, is embedded as base64 gzip and read by the page at start.
``--fragment`` leaves out the document skeleton (doctype, html, head and
body tags) for hosts that add their own.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
RE_IMPORT = re.compile(r'^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+'
                       r'"\./([\w./-]+)";\s*$', re.M)
RE_EXPORT = re.compile(r"^export\s+(?=(?:async\s+)?function|const|let|class)",
                       re.M)
RE_DECL = re.compile(r"^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|"
                     r"class)\s+([A-Za-z_$][\w$]*)", re.M)


def module_order(entry: str) -> list[str]:
    """Modules reachable from ``entry``, dependencies first."""
    seen: list[str] = []
    stack: list[str] = []

    def visit(name: str) -> None:
        if name in seen:
            return
        if name in stack:
            raise SystemExit("import cycle: %s -> %s" % (" -> ".join(stack),
                                                          name))
        stack.append(name)
        path = os.path.join(WEB, "js", name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        for m in RE_IMPORT.finditer(text):
            if m.group(2):
                raise SystemExit("%s: namespace imports are not supported by "
                                 "the build (import names instead)" % name)
            dep = os.path.normpath(os.path.join(os.path.dirname(name),
                                                m.group(3)))
            visit(dep)
        stack.pop()
        seen.append(name)

    visit(entry)
    return seen


def join_modules(entry: str) -> str:
    owners: dict[str, str] = {}
    parts: list[str] = []
    for name in module_order(entry):
        with open(os.path.join(WEB, "js", name), encoding="utf-8") as f:
            text = f.read()
        for m in RE_DECL.finditer(text):
            if m.group(1) in owners:
                raise SystemExit("%s and %s both declare %r at top level" % (
                    owners[m.group(1)], name, m.group(1)))
            owners[m.group(1)] = name
        text = RE_IMPORT.sub("", text)
        text = RE_EXPORT.sub("", text)
        if re.search(r"^\s*(import|export)\b", text, re.M):
            raise SystemExit("%s: an import or export the build does not "
                             "understand is left" % name)
        parts.append("// ---- %s\n%s" % (name, text))
    # one scope for everything: no top-level name becomes a window global
    return '(() => {\n"use strict";\n%s\n})();\n' % "\n".join(parts)


def build(pack: str | None, fragment: bool, config: str | None) -> str:
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as f:
        html = f.read()
    with open(os.path.join(WEB, "css", "grid.css"), encoding="utf-8") as f:
        css = f.read()
    script = join_modules("app.js")
    if "</script" in script.lower():
        raise SystemExit("a module contains </script, which would end the "
                         "inline script")
    payload = ""
    if pack:
        with open(pack, "rb") as f:
            raw = f.read()
        if raw[:2] != b"\x1f\x8b":
            raw = gzip.compress(raw, 9)
        payload = base64.b64encode(raw).decode("ascii")
    marks = {"/*{{CSS}}*/": css, "/*{{SCRIPT}}*/": script,
             "{{PACK}}": payload, "{{CONFIG}}": config or '{"mode":"demo"}'}
    for mark in marks:
        if html.count(mark) != 1:
            raise SystemExit("index.html must hold %s exactly once" % mark)
    for mark in marks:
        if any(mark in v for v in marks.values()):
            raise SystemExit("content would fill placeholder %s" % mark)
    for mark, value in marks.items():
        html = html.replace(mark, value)
    if fragment:
        head = re.search(r"<head>(.*?)</head>", html, re.S)
        body = re.search(r"<body[^>]*>(.*)</body>", html, re.S)
        if not head or not body:
            raise SystemExit("index.html needs <head> and <body> to make a "
                             "fragment")
        keep = re.sub(r'<meta charset="utf-8">\s*', "", head.group(1))
        keep = re.sub(r'<meta name="viewport"[^>]*>\s*', "", keep)
        html = keep.strip() + "\n" + body.group(1).strip() + "\n"
    return html


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", help="embed this pack (json or json.gz)")
    ap.add_argument("--config", help="JSON for the page's config block")
    ap.add_argument("--fragment", action="store_true",
                    help="no document skeleton (for hosts that add one)")
    ap.add_argument("--out", default=os.path.join(ROOT, "dist",
                                                  "grid.html"))
    a = ap.parse_args()
    html = build(a.pack, a.fragment, a.config)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(html)
    print("wrote %s (%d bytes)" % (a.out, len(html.encode("utf-8"))),
          file=sys.stderr)


if __name__ == "__main__":
    main()
