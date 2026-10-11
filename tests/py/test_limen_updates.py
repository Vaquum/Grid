"""An issue for each Limen release (tools/limen_updates.py, run every hour
by the limen-updates workflow): what a release says it merged, the
releases published after the last one Grid followed, what is filed
already, and the issues opened, against a stand-in for GitHub's API. The
releases' bodies are Limen's as it writes them ("Merged pull requests:
#912"), cut short."""

from __future__ import annotations

import unittest
from typing import Any

from tools.limen_updates import SINCE, filed, fresh, issue_for, merged, run

Json = dict[str, Any]


def release(tag: str, at: str, body: str, draft: bool = False) -> Json:
    return {"tag_name": tag, "published_at": at, "draft": draft,
            "body": body, "html_url": "https://github.com/Vaquum/Limen/"
                                      "releases/tag/" + tag}


RELEASES = [
    release("v5.26.0", "2026-10-12T09:00:00Z",
            "## Traceability\n\n- Merged pull requests: #920\n", draft=True),
    release("v5.25.1", "2026-10-12T08:00:00Z",
            "## Summary\n\n- Pinned a dependency\n"),
    release("v5.25.0", "2026-10-11T19:30:00Z",
            "## Traceability\n\n- Merged pull requests: #915, #916\n"
            "- Compare: https://github.com/Vaquum/Limen/compare/"
            "v5.24.0...v5.25.0\n"),
    release("v5.24.0", SINCE,
            "## Traceability\n\n- Merged pull requests: #912\n"),
]
PRS = {915: "feat(experiment): run rounds in parallel within one limen run",
       916: "docs: parallel rounds"}


class GitHub:
    """GitHub's API as the script reads and writes it: Limen's releases
    and pull requests, this repository's issues, and the issues opened."""

    def __init__(self, issues: list[Json]) -> None:
        self.issues = issues
        self.opened: list[tuple[str, Json]] = []

    def get(self, path: str) -> Any:
        if path == "/repos/Vaquum/Limen/releases?per_page=30":
            return RELEASES
        if path.startswith("/repos/Vaquum/Grid/issues?state=all"):
            return self.issues
        if path.startswith("/repos/Vaquum/Limen/pulls/"):
            return {"title": PRS[int(path.rsplit("/", 1)[1])]}
        raise AssertionError("not read: %s" % path)

    def post(self, path: str, body: Json) -> Any:
        self.opened.append((path, body))
        return {"html_url": "https://github.com/Vaquum/Grid/issues/%d"
                            % (60 + len(self.opened))}


class Releases(unittest.TestCase):
    def test_what_a_release_says_it_merged_once_each_in_its_order(
            self) -> None:
        self.assertEqual(merged(RELEASES[2]["body"]), [915, 916])
        self.assertEqual(merged("- Merged pull requests: #910, #911, #910"),
                         [910, 911])
        self.assertEqual(merged(RELEASES[1]["body"]), [])
        self.assertEqual(merged(""), [])

    def test_the_releases_after_the_last_one_followed_oldest_first(
            self) -> None:
        # v5.24.0 is the last Grid followed by hand, and a draft is no
        # release yet
        self.assertEqual([r["tag_name"] for r in fresh(RELEASES, SINCE)],
                         ["v5.25.0", "v5.25.1"])

    def test_the_versions_filed_already(self) -> None:
        self.assertEqual(filed([
            {"title": "Limen v5.25.0: feat(x): y"},
            {"title": "Limen v5.25.1"},
            # a pull request is no issue, and other issues are not Limen's
            {"title": "Limen v5.23.0: z", "pull_request": {}},
            {"title": "feat: a cohort from every shard of a run"}]),
            {"v5.25.0", "v5.25.1"})

    def test_an_issue_is_its_version_and_pull_request_and_their_link(
            self) -> None:
        self.assertEqual(issue_for(RELEASES[2], PRS), (
            "Limen v5.25.0: feat(experiment): run rounds in parallel within "
            "one limen run (and 1 more)",
            "https://github.com/Vaquum/Limen/pull/915\n"
            "https://github.com/Vaquum/Limen/pull/916"))
        # a title not read names the pull request by its number
        self.assertEqual(issue_for(RELEASES[3], {})[0],
                         "Limen v5.24.0: pull request #912")
        # a release that names none links itself
        self.assertEqual(issue_for(RELEASES[1], PRS), (
            "Limen v5.25.1",
            "https://github.com/Vaquum/Limen/releases/tag/v5.25.1"))


class Run(unittest.TestCase):
    def test_each_new_release_is_filed_once(self) -> None:
        gh = GitHub([{"title": "Limen v5.25.1"}])
        said = run("Vaquum/Grid", gh.get, gh.post)
        self.assertEqual(gh.opened, [("/repos/Vaquum/Grid/issues", {
            "title": "Limen v5.25.0: feat(experiment): run rounds in "
                     "parallel within one limen run (and 1 more)",
            "body": "https://github.com/Vaquum/Limen/pull/915\n"
                    "https://github.com/Vaquum/Limen/pull/916"})])
        self.assertEqual(said, [
            "opened https://github.com/Vaquum/Grid/issues/61: Limen v5.25.0: "
            "feat(experiment): run rounds in parallel within one limen run "
            "(and 1 more)",
            "filed already: Limen v5.25.1"])

    def test_without_a_way_to_write_nothing_is_opened(self) -> None:
        gh = GitHub([])
        said = run("Vaquum/Grid", gh.get, None)
        self.assertEqual(gh.opened, [])
        self.assertEqual([s.split(" | ")[0] for s in said], [
            "would open: Limen v5.25.0: feat(experiment): run rounds in "
            "parallel within one limen run (and 1 more)",
            "would open: Limen v5.25.1"])

    def test_nothing_new_opens_nothing_and_reads_no_issue(self) -> None:
        gh = GitHub([])
        self.assertEqual(run("Vaquum/Grid", gh.get, gh.post,
                             since="2026-10-12T08:00:00Z"),
                         ["no Limen release since 2026-10-12T08:00:00Z"])
        self.assertEqual(gh.opened, [])


if __name__ == "__main__":
    unittest.main()
