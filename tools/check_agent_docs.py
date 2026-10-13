"""Check agent documentation links, JSON blocks and public-contract coverage."""

from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    paths = [ROOT / "README.md", *ROOT.glob("docs/agent*.md")]
    for path in paths:
        body = path.read_text(encoding="utf-8")
        for target in re.findall(r"(?<!!)\[[^\]]*\]\(([^)]+)\)", body):
            if "://" in target or target.startswith("#"):
                continue
            destination = path.parent / target.split("#")[0]
            if not destination.exists():
                raise ValueError("%s links to missing %s" % (path, target))
        for block in re.findall(r"```json\n(.*?)\n```", body, re.S):
            json.loads(block)
    reference = (ROOT / "docs/agent-reference.md").read_text(encoding="utf-8")
    agent = (ROOT / "grid/agent.py").read_text(encoding="utf-8")
    names = re.findall(r'tool\("(grid_[a-z_]+)"', agent)
    for name in names:
        if "`" + name + "`" not in reference:
            raise ValueError("undocumented tool: " + name)
    match = re.search(r"ANALYSES = (\[.*?\])", agent, re.S)
    if match is None:
        raise ValueError("analysis list not found")
    analyses: Any = ast.literal_eval(match[1])
    for analysis in analyses:
        if "### `" + analysis + "`" not in reference:
            raise ValueError("undocumented analysis: " + analysis)
    errors = (ROOT / "docs/agent-errors.md").read_text(encoding="utf-8")
    sources = ["grid/agent.py", "grid/agent_client.py", "grid/server.py",
               "tools/agent_query.mjs"]
    for source in sources:
        body = (ROOT / source).read_text(encoding="utf-8")
        codes = re.findall(r'(?:AgentError|failure)\("([A-Z_]+)"', body)
        codes += re.findall(r'code: "([A-Z_]+)"', body)
        for code in codes:
            if "`" + code + "`" not in errors:
                raise ValueError("undocumented error: " + code)
    print("Agent documentation: links, JSON, %d tools, %d analyses and "
          "emitted error codes checked." % (len(names), len(analyses)))


if __name__ == "__main__":
    main()
