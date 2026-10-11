"""An issue in this repository for each Limen release it has none for yet
(the limen-updates workflow, every hour): its title the release's version
and the title of the pull request it merged, its body the link to that
pull request (the release's own, when it names none).

    python3 tools/limen_updates.py --repo Vaquum/Grid [--dry-run]

Limen's releases say what they merged ("Merged pull requests: #912").
Those published after ``--since`` are read (by default Limen v5.24.0,
which Grid follows already), and those this repository has an issue for
already (titled "Limen <version>...") are passed over. GitHub is read and
written with ``GITHUB_TOKEN``, in the workflow its own token, so the
polling weighs on no one's API quota; without one, Limen is read as
anyone may read it and nothing is opened, as with ``--dry-run``: the
issues it would open are printed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from collections.abc import Callable
from typing import Any, cast

Json = dict[str, Any]
API = "https://api.github.com"
UPSTREAM = "Vaquum/Limen"
# Limen v5.24.0's publication: the last release Grid followed by hand
SINCE = "2026-10-11T10:18:06Z"
_MERGED = re.compile(r"Merged pull requests:\s*([^\n]*)")
_FILED = re.compile(r"Limen (\S+?)(?::|$)")

Get = Callable[[str], Any]
Post = Callable[[str, Json], Any]


def merged(body: str) -> list[int]:
    """The pull requests a release says it merged, in its order, once."""
    m = _MERGED.search(body or "")
    out: list[int] = []
    for n in re.findall(r"#(\d+)", m.group(1) if m else ""):
        if int(n) not in out:
            out.append(int(n))
    return out


def fresh(releases: list[Json], since: str) -> list[Json]:
    """The releases published after ``since`` (an ISO time, as GitHub
    writes them), drafts left out, the oldest first."""
    out = [r for r in releases if not r.get("draft")
           and str(r.get("published_at") or "") > since]
    return sorted(out, key=lambda r: str(r.get("published_at")))


def filed(issues: list[Json]) -> set[str]:
    """The versions this repository has an issue for already."""
    out: set[str] = set()
    for issue in issues:
        if issue.get("pull_request"):
            continue
        m = _FILED.match(str(issue.get("title") or ""))
        if m:
            out.add(m.group(1))
    return out


def issue_for(release: Json, titles: dict[int, str],
              upstream: str = UPSTREAM) -> tuple[str, str]:
    """A release's issue: its title and body."""
    tag = str(release.get("tag_name"))
    prs = merged(str(release.get("body") or ""))
    if not prs:
        return "Limen %s" % tag, str(release.get("html_url") or "")
    what = titles.get(prs[0]) or "pull request #%d" % prs[0]
    more = " (and %d more)" % (len(prs) - 1) if len(prs) > 1 else ""
    return ("Limen %s: %s%s" % (tag, what, more),
            "\n".join("https://github.com/%s/pull/%d" % (upstream, n)
                      for n in prs))


def run(repo: str, get: Get, post: Post | None, since: str = SINCE,
        upstream: str = UPSTREAM) -> list[str]:
    """Open an issue for each new release (none when ``post`` is None);
    what was done, a line each."""
    releases = cast(list[Json], get("/repos/%s/releases?per_page=30"
                                    % upstream))
    new = fresh(releases, since)
    if not new:
        return ["no Limen release since %s" % since]
    have = filed(cast(list[Json], get(
        "/repos/%s/issues?state=all&per_page=100&sort=created"
        "&direction=desc" % repo)))
    said: list[str] = []
    for release in new:
        tag = str(release.get("tag_name"))
        if tag in have:
            said.append("filed already: Limen %s" % tag)
            continue
        titles: dict[int, str] = {}
        for n in merged(str(release.get("body") or "")):
            pr = cast(Json, get("/repos/%s/pulls/%d" % (upstream, n)))
            titles[n] = str(pr.get("title") or "")
        title, body = issue_for(release, titles, upstream)
        if post is None:
            said.append("would open: %s | %s" % (title, body))
            continue
        out = cast(Json, post("/repos/%s/issues" % repo,
                              {"title": title, "body": body}))
        said.append("opened %s: %s" % (out.get("html_url"), title))
        have.add(tag)
    return said


def _request(path: str, token: str | None, body: Json | None = None) -> Any:
    req = urllib.request.Request(
        API + path, method="GET" if body is None else "POST",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28",
                 "User-Agent": "grid-limen-updates",
                 **({"Authorization": "Bearer " + token} if token else {}),
                 **({"Content-Type": "application/json"}
                    if body is not None else {})})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def main(argv: list[str] | None = None) -> int:
    said = (__doc__ or "").split("\n\n")[0]
    ap = argparse.ArgumentParser(description=said)
    ap.add_argument("--repo", required=True,
                    help="the repository to open issues in, OWNER/NAME")
    ap.add_argument("--upstream", default=UPSTREAM,
                    help="the repository whose releases are read")
    ap.add_argument("--since", default=SINCE,
                    help="read releases published after this ISO time")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the issues it would open")
    a = ap.parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN") or None

    def get(path: str) -> Any:
        return _request(path, token)

    def post(path: str, body: Json) -> Any:
        return _request(path, token, body)
    for line in run(a.repo, get, None if a.dry_run or not token else post,
                    a.since, a.upstream):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
