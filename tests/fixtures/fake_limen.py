#!/usr/bin/env python3
"""A stand-in for Limen's ``limen`` command, for the Experiment view's
tests: the subcommands Grid runs, answering as Limen does.

- ``--version``, ``list-templates``: as Limen prints them;
- ``validate FILE``: valid, unless the file holds ``BAD_VALUE`` (an error
  on a path, as Limen reports one) or ``PARSE_ME`` (a parse error on its
  line, running on to more lines, as YAML's are);
- ``init OUT --template NAME``: the limen_run fixture's manifest, named
  after OUT;
- ``run [--no-progress-bar] FILE``: a result directory where Limen puts
  one (``results/dev/`` and ``uel.output_path``), with the manifest's copy,
  the fixture's metadata.json (its name, seed and rounds the manifest's),
  and the fixture's rounds written one by one (``FAKE_LIMEN_PACE`` seconds
  apart), each with its round_data.jsonl line. SIGTERM stops it as Limen
  stops: the round in hand finishes and checkpoint.json records the last;
- ``run --resume DIR``: on from the checkpoint.
"""

import csv
import json
import os
import re
import signal
import sys
import time

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "limen_run")
stop = False


def on_term(signum, frame):
    global stop
    stop = True


def value(text, key):
    m = re.search(r"^\s*%s:\s*\"?([^\"#\n]*?)\"?\s*(#.*)?$" % key, text,
                  re.M)
    return m.group(1).strip() if m else None


def validate(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    print("Validating %s ..." % path)
    lines = text.splitlines()
    for n, line in enumerate(lines, 1):
        if "PARSE_ME" in line:
            print("  PARSE ERROR (line %d): while parsing a block mapping" % n)
            print("expected <block end>, but found '<scalar>'")
            print("  ✗ 1 error(s) found")
            return 1
    if "BAD_VALUE" in text:
        print("  ERROR  [uel.n_permutations]: 'n_permutations' must be a int")
        print("  ✗ 1 error(s) found")
        return 1
    print("  ✓ Valid")
    return 0


def rows_of_fixture():
    with open(os.path.join(FIXTURE, "results.csv"), encoding="utf-8",
              newline="") as f:
        return list(csv.reader(f))


def write_rounds(directory, start, total, seed):
    records = rows_of_fixture()
    header, body = records[0], records[1:]
    at, idc = header.index("_round_index"), header.index("id")
    pace = float(os.environ.get("FAKE_LIMEN_PACE", "0.02"))
    results = os.path.join(directory, "results.csv")
    fresh = not os.path.exists(results)
    with open(results, "a", encoding="utf-8", newline="") as out, \
            open(os.path.join(directory, "round_data.jsonl"), "a",
                 encoding="utf-8") as log:
        w = csv.writer(out)
        if fresh:
            w.writerow(header)
            out.flush()
        done = start - 1
        for i in range(start, total):
            if stop:
                break
            time.sleep(pace)
            row = list(body[(i + seed) % len(body)])
            row[at] = str(i)
            row[idc] = "fake-%s-%d" % (seed, i)
            w.writerow(row)
            out.flush()
            log.write(json.dumps({"round_id": row[idc], "_round_index": i,
                                  "round_params": {}}) + "\n")
            log.flush()
            done = i
    with open(os.path.join(directory, "checkpoint.json"), "w",
              encoding="utf-8") as f:
        json.dump({"last_round": done, "total": total, "seed": seed}, f)
    return done


def run(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    name = value(text, "name") or "experiment"
    total = int(value(text, "n_permutations") or 10)
    seed = int(value(text, "seed") or 0)
    out = value(text, "output_path") or "%s_%s" % (
        name, time.strftime("%Y%m%d_%H%M%S"))
    base = "results" if value(text, "mode") == "production" else \
        os.path.join("results", "dev")
    directory = os.path.join(base, out.replace("{name}", name))
    os.makedirs(directory)
    with open(os.path.join(directory, os.path.basename(path)), "w",
              encoding="utf-8") as f:
        f.write(text)
    with open(os.path.join(FIXTURE, "metadata.json"), encoding="utf-8") as f:
        meta = json.load(f)
    ref = meta["yaml_reference"]
    ref["metadata"]["name"] = name
    ref["uel"]["n_permutations"] = total
    ref["uel"]["search_strategy"]["seed"] = seed
    ref["uel"]["output_path"] = out
    with open(os.path.join(directory, "metadata.json"), "w",
              encoding="utf-8") as f:
        json.dump(meta, f)
    print("Running '%s' — %d of 3.8e+18 permutations (random)" % (name, total))
    print("  Results → %s" % directory, flush=True)
    done = write_rounds(directory, 0, total, seed)
    print("  ✓ Experiment complete" if done == total - 1 else
          "  Stopped after round %d" % done, flush=True)
    return 0


def resume(directory):
    with open(os.path.join(directory, "checkpoint.json"),
              encoding="utf-8") as f:
        cp = json.load(f)
    print("Resuming %s from round %d" % (directory, cp["last_round"] + 1),
          flush=True)
    done = write_rounds(directory, cp["last_round"] + 1, cp["total"],
                        cp["seed"])
    print("  ✓ Experiment complete" if done == cp["total"] - 1 else
          "  Stopped after round %d" % done, flush=True)
    return 0


def init(out, template):
    with open(os.path.join(FIXTURE, "lightgbm_binary_full.yaml"),
              encoding="utf-8") as f:
        text = f.read()
    name = os.path.splitext(os.path.basename(out))[0]
    text = re.sub(r"(?m)^(\s*name:\s*).*$", r"\g<1>" + name, text, count=1)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print("  ✓ Created %s from template %s" % (out, template))
    return 0


def main(argv):
    signal.signal(signal.SIGTERM, on_term)
    if argv[:1] == ["--version"]:
        print("limen, version 5.20.0")
        return 0
    if argv[:1] == ["list-templates"]:
        print("Available templates (fake):\n")
        print("  lightgbm_binary              LightGBM tradeline long-binary "
              "classifier")
        print("  logreg_binary                Logistic regression binary "
              "classifier")
        return 0
    if argv[:1] == ["validate"]:
        return validate(argv[1])
    if argv[:1] == ["init"]:
        return init(argv[1], argv[argv.index("--template") + 1])
    if argv[:1] == ["run"]:
        args = [a for a in argv[1:] if a != "--no-progress-bar"]
        if args[:1] == ["--resume"]:
            return resume(args[1])
        return run(args[0])
    print("fake limen: unknown command %r" % argv, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
