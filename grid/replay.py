"""Checked replay through a physically retained, isolated native runtime."""

from __future__ import annotations

import base64
import json
import socket
from pathlib import Path
from typing import Any, cast

from .evidence import (
    DIGEST,
    Evidence,
    digest,
    encoded,
    pack_vector,
    read_wire_vector,
    record_digest,
    vector_digest,
)
from .round_storage import Json

PROTOCOL = 1
WIRE_LIMIT = 512 << 20


def code_identity(root: Path) -> str:
    import hashlib

    return digest(
        [
            (
                str(p.relative_to(root)),
                hashlib.sha256(p.read_bytes()).hexdigest(),
            )
            for p in sorted(root.rglob("*.py"))
            if "__pycache__" not in p.parts
        ]
    )


def numeric_platform() -> Json:
    import os
    import platform
    import sys
    from pathlib import Path

    wanted = {
        "vendor_id",
        "cpu family",
        "model",
        "stepping",
        "model name",
        "flags",
        "Features",
        "CPU implementer",
        "CPU architecture",
        "CPU variant",
        "CPU part",
        "CPU revision",
    }
    cpu: dict[str, str] = {}
    path = Path("/proc/cpuinfo")
    if path.exists():
        block = path.read_text().split("\n\n", 1)[0]
        for line in block.splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip() in wanted:
                cpu[key.strip()] = " ".join(sorted(value.split()))
    environment = {
        key: os.environ.get(key)
        for key in (
            "OMP_NUM_THREADS",
            "OPENBLAS_NUM_THREADS",
            "MKL_NUM_THREADS",
            "POLARS_MAX_THREADS",
            "PYTHONHASHSEED",
        )
    }
    return {
        "machine": platform.machine(),
        "byteorder": sys.byteorder,
        "cpu": cpu,
        "environment": environment,
    }


def runtime_identity(image: str, code: str, numeric: Json) -> str:
    return digest([PROTOCOL, image, code, numeric])


class ReplayClient:
    def __init__(
        self, base: str | Path, runtime: str, evidence: Evidence | None = None
    ) -> None:
        if not DIGEST.fullmatch(runtime):
            raise ValueError(
                "Replay runtime must be a registered SHA-256 identity"
            )
        self.base = Path(base)
        self.runtime = runtime
        self.root = self.base / "runtimes" / runtime[:16]
        self.socket = self.root / "socket" / "worker.sock"
        self.evidence = evidence
        self.definitions: dict[str, Json] = {}
        pin: Any = json.loads((self.root / "pin.json").read_bytes())
        if (
            pin.get("runtime") != runtime
            or pin.get("retention") != "docker-container"
            or not pin.get("container")
            or not pin.get("image", "").startswith("sha256:")
        ):
            raise ValueError("Replay environment has no physical runtime pin")
        self.pin = cast(Json, pin)
        identity = self.call({"op": "identity"})
        if (
            identity.get("runtime") != runtime
            or identity.get("image") != pin["image"]
            or identity.get("code") != pin["code"]
            or identity.get("numeric")
            != pin.get("identity", {}).get("numeric")
        ):
            raise ValueError("Available replay runtime differs from its pin")

    def call(self, request: Json) -> Json:
        payload = encoded({"protocol": PROTOCOL, **request}) + b"\n"
        if len(payload) > WIRE_LIMIT:
            raise ValueError("Replay request size limit exceeded")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(300)
            try:
                client.connect(str(self.socket))
                client.sendall(payload)
                with client.makefile("rb") as stream:
                    raw = stream.readline(WIRE_LIMIT + 1)
            except OSError as exc:
                raise ValueError(
                    "Pinned replay runtime unavailable; retain "
                    "vectors or restart its retained container"
                ) from exc
        if len(raw) > WIRE_LIMIT or not raw.endswith(b"\n"):
            raise ValueError("Incomplete or oversized replay response")
        response: Any = json.loads(raw)
        if (
            not isinstance(response, dict)
            or cast(Json, response).get("protocol") != PROTOCOL
        ):
            raise ValueError("Invalid replay response")
        response = cast(Json, response)
        if response.get("error"):
            raise ValueError("Native replay failed: " + str(response["error"]))
        return cast(Json, response)

    def definition(
        self, metadata: Json, sources: Json
    ) -> tuple[str, Json] | None:
        if metadata.get("limen_version") != "5.29.0" or len(sources) != 1:
            return None
        source = next(iter(sources.values()))
        definition: Json = {"metadata": metadata, "source": source}
        key = digest(definition)
        if key not in self.definitions:
            from .retention import atomic_json

            assets = self.base / "assets"
            assets.mkdir(exist_ok=True)
            path = assets / (key + ".definition.json")
            if not path.exists():
                atomic_json(path, definition)
            plan = self.call({"op": "plan", "definition": key})
            if len(self.definitions) >= 128:
                self.definitions.pop(next(iter(self.definitions)))
            self.definitions[key] = plan
        return key, self.definitions[key]

    def _recipe(self, value: Json) -> str:
        assert self.evidence is not None
        raw = encoded(value)
        return self.evidence.put("recipe", len(raw), raw)

    def _get_recipe(self, key: str) -> Json:
        assert self.evidence is not None
        kind, _, raw = self.evidence.get(key)
        if kind != "recipe":
            raise ValueError("Invalid retained replay recipe")
        value: Any = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Invalid retained replay recipe")
        return cast(Json, value)

    def _certified(self, recipe: Json) -> bool:
        return recipe.get("_grid_proof") == [self.runtime, PROTOCOL]

    def proven_fields(self, recipe: Json, original: Json) -> Json:
        """Bind source values to a checked immutable replay artifact."""
        if recipe.get("runtime") != self.runtime:
            raise ValueError("Retained replay runtime changed")
        fields: Json = {}
        for name in ("model", "execution"):
            if name not in recipe:
                continue
            saved = self._get_recipe(recipe[name])
            if not self._certified(saved):
                raise ValueError("Replay artifact has no transport proof")
            if name == "model":
                probs = original.get("probs")
                if not isinstance(probs, list) or vector_digest(
                    cast(list[Any], probs)
                ) != saved["expected"]["probs"]:
                    raise ValueError("Replay probabilities differ from source")
                fields["probs"] = probs
            else:
                values = {key: original.get(key)
                          for key in ("execution", "market")}
                if record_digest(values) != saved["expected"]:
                    raise ValueError("Replay execution differs from source")
                fields.update(values)
        return fields

    def verify(
        self, metadata: Json, record: Json, sources: Json
    ) -> Json | None:
        assert self.evidence is not None
        planned = self.definition(metadata, sources)
        if planned is None:
            return None
        definition, plan = planned
        if not plan.get("execution"):
            return None
        preds: Any = record.get("preds")
        if (
            not isinstance(preds, list)
            or not preds
            or not all(
                type(p) is int and p in (0, 1) for p in cast(list[Any], preds)
            )
        ):
            return None
        preds = cast(list[Any], preds)
        kind, bits = pack_vector(preds)
        if kind != "bits":
            return None
        params: Any = record.get("round_params")
        alignment: Any = record.get("alignment")
        if not isinstance(params, dict) or not isinstance(alignment, dict):
            return None
        params = cast(Json, params)
        alignment = cast(Json, alignment)
        expected: Json = {
            "execution": record_digest(
                {
                    "execution": record.get("execution"),
                    "market": record.get("market"),
                }
            )
        }
        model: str | None = None
        fit_key: str | None = None
        deterministic = (
            params.get("deterministic") is True
            and type(params.get("random_state")) is int
            and params.get("n_jobs") == 1
        )
        if (
            plan.get("model")
            and deterministic
            and isinstance(record.get("probs"), list)
        ):
            expected["model"] = {
                "probs": vector_digest(record["probs"]),
                "preds": vector_digest(cast(list[Any], preds)),
                "alignment": digest(alignment),
                "threshold": record.get("optimal_threshold"),
                "rule": record.get("threshold_rule"),
            }
            fit_key = digest(
                [
                    self.runtime,
                    plan["family"],
                    {
                        k: v
                        for k, v in cast(Json, params).items()
                        if k not in plan["axes"]
                    },
                ]
            )
            row = self.evidence.db.execute(
                "SELECT recipe FROM model_jobs WHERE id=?", (fit_key,)
            ).fetchone()
            if row is not None and row[0]:
                saved = self._get_recipe(str(row[0]))
                if self._certified(saved) and \
                        saved.get("expected") == expected["model"]:
                    model = str(row[0])
            artifact = self.evidence.db.execute(
                "SELECT recipe FROM artifact_recipes WHERE runtime=? "
                "AND kind='model' AND identity=?",
                (self.runtime, expected["model"]["probs"]),
            ).fetchone()
            if artifact is not None:
                saved = self._get_recipe(str(artifact[0]))
                if saved["expected"]["probs"] != expected["model"]["probs"]:
                    raise ValueError(
                        "Retained model artifact identity disagrees"
                    )
                if self._certified(saved):
                    model = str(artifact[0])
        execution = self.evidence.db.execute(
            "SELECT recipe FROM artifact_recipes WHERE runtime=? "
            "AND kind='execution' AND identity=?",
            (self.runtime, expected["execution"]),
        ).fetchone()
        result: Json = {"runtime": self.runtime, "fields": []}
        if execution is not None:
            saved = self._get_recipe(str(execution[0]))
            if saved["expected"] != expected["execution"]:
                raise ValueError(
                    "Retained execution artifact identity disagrees"
                )
            if self._certified(saved):
                result["execution"] = str(execution[0])
                result["fields"].extend(["execution", "market"])
            else:
                execution = None
        need_model = fit_key is not None and model is None
        response: Json = {}
        if execution is None or need_model:
            response = self.call(
                {
                    "op": "verify",
                    "definition": definition,
                    "params": params,
                    "alignment": alignment,
                    "preds": base64.b64encode(bits).decode(),
                    "n": len(preds),
                    "expected": expected,
                    "check_model": need_model,
                    "check_execution": execution is None,
                }
            )
        fresh = {name: response[name] for name in ("model", "execution")
                 if response.get(name)}
        if fresh:
            # Check native results AND their exact transport once per immutable
            # artifact. Repeated occurrences bind to that durable proof rather
            # than refitting after eviction from the bounded worker cache.
            fields = self._materialize_recipes(fresh, record)
            if "model" in fresh and vector_digest(fields["probs"]) != \
                    expected["model"]["probs"]:
                raise ValueError("Replay probability transport differs")
            if "execution" in fresh and record_digest(
                {key: fields[key] for key in ("execution", "market")}
            ) != expected["execution"]:
                raise ValueError("Replay execution transport differs")
        if "execution" in fresh:
            result["execution"] = self._recipe(
                {**fresh["execution"], "_grid_proof": [self.runtime, PROTOCOL]}
            )
            result["fields"].extend(["execution", "market"])
            self.evidence.db.execute(
                "INSERT OR REPLACE INTO artifact_recipes VALUES (?,?,?,?)",
                (
                    self.runtime,
                    "execution",
                    expected["execution"],
                    result["execution"],
                ),
            )
        if "model" in fresh and fit_key is not None:
            model = self._recipe(
                {**fresh["model"], "_grid_proof": [self.runtime, PROTOCOL]}
            )
            self.evidence.db.execute(
                "INSERT OR REPLACE INTO model_jobs VALUES (?,?,?,?)",
                (fit_key, response.get("prep", ""), b"{}", model),
            )
            self.evidence.db.execute(
                "INSERT OR REPLACE INTO artifact_recipes VALUES (?,?,?,?)",
                (self.runtime, "model", expected["model"]["probs"], model),
            )
        if model is not None:
            result["model"] = model
            result["fields"].append("probs")
        return result if result["fields"] else None

    def materialize(self, recipe: Json, record: Json) -> Json:
        if recipe.get("runtime") != self.runtime:
            raise ValueError("Retained replay runtime changed")
        expected: Json = {}
        for name in ("model", "execution"):
            if name in recipe:
                expected[name] = {
                    k: v for k, v in self._get_recipe(recipe[name]).items()
                    if k != "_grid_proof"
                }
        return self._materialize_recipes(expected, record)

    def _materialize_recipes(self, expected: Json, record: Json) -> Json:
        preds: Any = record.get("preds")
        if not isinstance(preds, list):
            raise ValueError("Retained replay lost its exact predictions")
        preds = cast(list[Any], preds)
        kind, bits = pack_vector(preds)
        if kind != "bits":
            raise ValueError(
                "Retained replay needs binary integer predictions"
            )
        response = self.call(
            {
                "op": "materialize",
                "recipes": expected,
                "preds": base64.b64encode(bits).decode(),
                "n": len(preds),
            }
        )
        vectors: Any = response.get("vectors")
        names: set[str] = set()
        if "model" in expected:
            names.add("probs")
        if "execution" in expected:
            names.update(
                (
                    "execution.pos",
                    "execution.gross",
                    "execution.net",
                    "market.ret",
                )
            )
        if not isinstance(vectors, dict) or set(cast(Json, vectors)) != names:
            raise ValueError("Native replay returned incomplete evidence")
        fields: Json = {}
        for path, wire in cast(Json, vectors).items():
            parts = path.split(".")
            values = read_wire_vector(wire)
            if len(parts) == 1:
                fields[path] = values
            else:
                fields.setdefault(parts[0], {})[parts[1]] = values
        return fields
