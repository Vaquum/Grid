"""Runnable agent examples using only Grid's public JSON CLI.

Run from the checkout: python3 tools/agent_workflow.py --help.
Writes are explicit subcommands and journal their exact retry arguments.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, cast

Json = dict[str, Any]
ROOT = Path(__file__).resolve().parents[1]


class WorkflowError(ValueError):
    """A failed example, with the original operation evidence retained."""


class Workflow:
    def __init__(self, connection: str, journal: str | None = None,
                 timeout: float = 300, poll: float = 1) -> None:
        self.connection = connection
        self.journal = journal
        self.timeout = timeout
        self.poll = poll

    def call(self, operation: str, **arguments: Any) -> Json:
        proc = subprocess.run(
            [sys.executable, "-m", "grid", "agent", "--connection",
             self.connection, operation, "--args-file", "-"],
            input=json.dumps(arguments, allow_nan=False), text=True,
            capture_output=True, cwd=ROOT, check=False)
        response: Json = json.loads(proc.stdout)
        if not response["ok"]:
            error = response["error"]
            raise WorkflowError("%s: %s: %s" %
                                (operation, error["code"], error["message"]))
        return response["result"]

    def write(self, operation: str, **arguments: Any) -> Json:
        if self.journal is None:
            raise WorkflowError("writes need --journal FILE")
        arguments["requestId"] = str(uuid.uuid4())
        # Record intent before sending. Never include the connection token.
        fd = os.open(self.journal, os.O_WRONLY | os.O_CREAT | os.O_APPEND
                     | getattr(os, "O_NOFOLLOW", 0),
                     0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise WorkflowError("journal must be a private regular file "
                                    "(mode 0600)")
            stream.write(json.dumps({"operation": operation,
                                     "arguments": arguments}) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        return self.call(operation, **arguments)

    def project(self) -> Json:
        project = self.call("grid_status")["project"]
        if project is None:
            raise WorkflowError("connect to serve --project DIR")
        return project

    def wait(self, collection: str, key: str, value: str,
             pending: set[str], success: set[str]) -> Json:
        deadline = time.monotonic() + self.timeout
        while True:
            entries = self.project()[collection]
            entry = next((e for e in entries if e[key] == value), None)
            if entry is not None:
                if entry["state"] in success:
                    return entry
                if entry["state"] not in pending:
                    raise WorkflowError(json.dumps(entry, allow_nan=False))
            if time.monotonic() >= deadline:
                raise WorkflowError("wait expired for %s; inspect grid_status. "
                                    "The job may still be running." % value)
            time.sleep(self.poll)

    def inspect(self, run: str | None = None) -> Json:
        status = self.call("grid_status")
        if not status["runs"]:
            raise WorkflowError("no analysis run is loaded; finish and open "
                                "an experiment or serve recorded results")
        state = {"run": run} if run else {}
        schema = self.call("grid_analyze", analysis="schema", state=state)
        pinned = {"snapshot": schema["snapshot"]["id"],
                  "state": schema["state"]}
        board = self.call("grid_analyze", analysis="board", **pinned)
        trials = self.call("grid_analyze", analysis="trials", limit=5,
                           **pinned)
        return {"schema": schema, "board": board, "trials": trials}

    def experiment(self, name: str, template: str | None,
                   manifest: str | None, rounds: int, shards: int) -> Json:
        self.project()
        source = {"template": template} if template else {
            "text": Path(str(manifest)).read_text(encoding="utf-8")}
        self.write("grid_create", name=name, **source)
        opened = self.call("grid_manifest", name=name)
        checked = self.call("grid_validate", text=opened["text"])
        if checked["errors"]:
            raise WorkflowError(json.dumps(checked))
        diff = self.call("grid_diff", name=name, text=opened["text"])
        saved = self.write("grid_save", name=name, text=opened["text"],
                           version=opened["version"])
        run = self.write("grid_start", name=name, rounds=rounds,
                         shards=shards, execution=True, outputs=True,
                         version=saved["version"])["run"]
        completed = self.wait("runs", "id", run, {"running"}, {"finished"})
        sweep_run = self.call("grid_open", run=run)["sweepRun"]
        return {"projectRun": run, "analysisRun": sweep_run,
                "job": completed, "diff": diff,
                "analysis": self.inspect(sweep_run)}

    def cohort(self, run: str, name: str, count: int,
               state_file: str | None, fee: float | None,
               slip: float | None) -> Json:
        self.project()
        state: Json = {"run": run, "firstHalf": True}
        if state_file:
            loaded: Any = json.loads(Path(state_file).read_text(encoding="utf-8"))
            if not isinstance(loaded, dict) or loaded.get("run") != run:
                raise WorkflowError("state file is an object for this run")
            state = cast(Json, loaded)
            if not state.get("firstHalf") or state.get("found") == "whole":
                raise WorkflowError("state must preserve first-half selection")
        schema = self.call("grid_analyze", analysis="schema", state=state)
        chosen = self.call("grid_analyze", analysis="cohort", members=count,
                           state=schema["state"],
                           snapshot=schema["snapshot"]["id"])
        selection = chosen["result"]
        if not selection.get("members") or not selection.get(
                "firstHalfSelection") or chosen["state"]["found"] == "whole":
            raise WorkflowError("cohort requires available members and a "
                                "measured first-half needle")
        costs = {k: v for k, v in {"fee": fee, "slip": slip}.items()
                 if v is not None}
        evaluation = self.call("grid_cohort_evaluate",
                               members=selection["members"], **costs)
        predictor = self.write(
            "grid_predictor_create", name=name, members=selection["members"],
            how={"query": chosen["state"], "snapshot": chosen["snapshot"],
                 "costs": {"fee": evaluation["fee"],
                           "slip": evaluation["slip"]}})["cohort"]
        completed = self.wait("cohorts", "name", predictor,
                              {"training"}, {"made"})
        return {"selection": chosen, "evaluation": evaluation,
                "predictor": completed}

    def control(self, run: str, operation: str) -> Json:
        self.write("grid_" + operation, run=run)
        if operation == "stop":
            return self.wait("runs", "id", run, {"running"}, {"stopped"})
        return self.wait("runs", "id", run, {"stopped"},
                         {"running", "finished"})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection", required=True)
    parser.add_argument("--journal", help="private JSONL intent log for writes")
    parser.add_argument("--timeout", type=float, default=300,
                        help="seconds waiting for a job; timeout does not stop it")
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="read one pinned capture")
    inspect.add_argument("--run", help="analysis run ID from grid_status")
    experiment = commands.add_parser("experiment", help="create and run")
    experiment.add_argument("--name", required=True)
    source = experiment.add_mutually_exclusive_group(required=True)
    source.add_argument("--template")
    source.add_argument("--manifest")
    experiment.add_argument("--rounds", type=int, default=100)
    experiment.add_argument("--shards", type=int, default=1)
    cohort = commands.add_parser("cohort", help="evaluate, train and bind")
    cohort.add_argument("--run", required=True, help="analysis run ID")
    cohort.add_argument("--name", required=True)
    cohort.add_argument("--members", type=int, default=5)
    cohort.add_argument("--state-file", help="raw returned analysis state JSON")
    cohort.add_argument("--fee", type=float)
    cohort.add_argument("--slip", type=float)
    control = commands.add_parser("control", help="stop or resume a project run")
    control.add_argument("operation", choices=["stop", "resume"])
    control.add_argument("--run", required=True, help="project run ID")
    recover = commands.add_parser("recover", help="read a durable receipt")
    recover.add_argument("--request-id", required=True)
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("--timeout must be positive")
    workflow = Workflow(args.connection, args.journal, args.timeout)
    try:
        if args.command == "inspect":
            result = workflow.inspect(args.run)
        elif args.command == "experiment":
            result = workflow.experiment(args.name, args.template,
                                         args.manifest, args.rounds, args.shards)
        elif args.command == "cohort":
            result = workflow.cohort(args.run, args.name, args.members,
                                     args.state_file, args.fee, args.slip)
        elif args.command == "control":
            result = workflow.control(args.run, args.operation)
        else:
            result = workflow.call("grid_receipt", requestId=args.request_id)
        print(json.dumps({"ok": True, "result": result}, allow_nan=False))
        return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
