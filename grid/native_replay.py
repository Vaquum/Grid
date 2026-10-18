"""Native numerical worker, run only in its retained Limen image.

The serving Grid process has no scientific dependencies or Docker access.
The worker accepts evidence operations over a private filesystem socket.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import importlib
import json
import os
import socket
import socketserver
import stat
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from .evidence import (
    DIGEST,
    LRU,
    digest,
    encoded,
    read_wire_vector,
    record_digest,
    vector_digest,
    wire_vector,
)
from .replay import (
    PROTOCOL,
    WIRE_LIMIT,
    code_identity,
    numeric_platform,
    runtime_identity,
)
from .round_storage import RETENTION_VERSIONS, Json


class Native:
    def __init__(self, assets: Path, image: str) -> None:
        self.assets = assets.resolve()
        self.np: Any = importlib.import_module("numpy")
        self.pl: Any = importlib.import_module("polars")
        self.limen: Any = importlib.import_module("limen")
        self.compiler: Any = importlib.import_module("limen.yaml.compiler")
        self.backtest: Any = importlib.import_module(
            "limen.sfd.reference_architecture._backtest_evaluation"
        )
        self.code = code_identity(Path(__file__).parent)
        self.image = image
        self.numeric = numeric_platform()
        self.runtime = runtime_identity(image, self.code, self.numeric)
        self.definitions = LRU(8 << 20)
        self.frames = LRU(64 << 20)
        self.windows = LRU(64 << 20)
        self.prepared = LRU(192 << 20)
        self.features = LRU(128 << 20)
        self.signals = LRU(64 << 20)
        self.executions = LRU(64 << 20)
        self.statistics = {"fit_attempts": 0, "model_hits": 0,
                           "execution_evaluations": 0, "execution_hits": 0,
                           "preparations": 0, "preparation_hits": 0}

    def identity(self) -> Json:
        versions = {
            name: str(
                getattr(
                    importlib.import_module(name), "__version__", "unavailable"
                )
            )
            for name in ("numpy", "polars", "sklearn", "lightgbm", "scipy")
        }
        return {
            "runtime": self.runtime,
            "image": self.image,
            "code": self.code,
            "python": sys.version,
            "numeric": self.numeric,
            "limen": str(self.limen.__version__),
            "libraries": versions,
            "statistics": dict(self.statistics),
            "caches": {name: {"entries": len(cache.values),
                              "accounted_bytes": cache.size,
                              "limit": cache.limit}
                       for name, cache in (("signals", self.signals),
                                           ("executions", self.executions),
                                           ("prepared", self.prepared),
                                           ("features", self.features))},
        }

    def definition(self, key: str) -> Json:
        if not DIGEST.fullmatch(key):
            raise ValueError("Invalid replay definition identity")
        saved: Any = self.definitions.get(key)
        if saved is not None:
            return cast(Json, saved)
        raw = (self.assets / (key + ".definition.json")).read_bytes()
        if len(raw) > 4 << 20:
            raise ValueError("Replay definition size limit exceeded")
        value: Any = json.loads(raw)
        if not isinstance(value, dict) or digest(value) != key:
            raise ValueError("Replay definition digest mismatch")
        metadata = cast(Json, value)["metadata"]
        source = cast(Json, value)["source"]
        if (
            self.limen.__version__ not in RETENTION_VERSIONS
            or metadata.get("limen_version") != self.limen.__version__
        ):
            raise ValueError("Unsupported native replay version")
        asset = source["asset"]
        path = (self.assets / asset).resolve()
        if path.parent != self.assets or not DIGEST.fullmatch(
            source["sha256"]
        ):
            raise ValueError("Invalid retained source location")
        with path.open("rb") as stream:
            if (
                hashlib.file_digest(stream, "sha256").hexdigest()
                != source["sha256"]
            ):
                raise ValueError("Retained source digest mismatch")
        declaration = copy.deepcopy(metadata["yaml_reference"])
        inner = declaration["sfd"]["manifest"]
        data_source = inner.get("data_source", {})
        supported = (
            source["asset"].endswith(".parquet")
            and data_source.get("method")
            == "limen.data.HistoricalData.get_any_file"
            and set(data_source.get("params", {})) == {"file_path_or_url"}
            and isinstance(inner.get("backtest"), dict)
            and not inner.get("bar_formation")
            and not inner.get("split_walk_forward")
            and inner.get("reference_architecture")
            in (
                "limen.sfd.reference_architecture.lightgbm_binary.lightgbm_binary",
                "limen.sfd.reference_architecture.rule_based.rule_based",
            )
        )
        result: Json = {
            "execution": supported,
            "model": False,
            "source": source,
            "declaration": declaration,
        }
        if not supported:
            self.definitions.put(key, result, len(raw) * 4 + 1024)
            return result
        data_source["params"]["file_path_or_url"] = str(path)
        manifest: Any = self.compiler.build_manifest(declaration)
        result["manifest"] = manifest
        family = copy.deepcopy(inner)
        family.pop("backtest", None)
        family["data_source"]["params"]["file_path_or_url"] = source["sha256"]
        result["family"] = digest([self.runtime, family])
        if inner.get("type") == "ml":
            factorize: Any = importlib.import_module(
                "limen.experiment._factorize"
            )
            preparation: Any = importlib.import_module(
                "limen.experiment._factorized_prep"
            )
            domain = declaration["sfd"]["params"]
            try:
                axes = factorize._axes(manifest, domain)
                factorize._check_manifest(manifest, domain, axes)
                fitted: Any = preparation.FittedPreparation(
                    manifest, domain, axes, factorize._references
                )
                result.update(
                    model=True,
                    axes=sorted(axes),
                    names=sorted(fitted.names),
                    domain=sorted(domain),
                )
            except ValueError as exc:
                result["model_reason"] = str(exc)
        self.definitions.put(key, result, len(raw) * 4 + 4096)
        return result

    def plan(self, key: str) -> Json:
        definition = self.definition(key)
        return {
            name: definition.get(name)
            for name in (
                "execution",
                "model",
                "family",
                "axes",
                "names",
                "model_reason",
            )
        }

    def frame(self, source: Json) -> Any:
        key = source["sha256"]
        frame: Any = self.frames.get(key)
        if frame is None:
            frame = self.pl.read_parquet(self.assets / source["asset"])
            if frame.estimated_size() > 128 << 20:
                raise ValueError(
                    "Native source exceeds replay memory admission"
                )
            self.frames.put(key, frame, int(frame.estimated_size()))
        return frame

    def execution(self, recipe: Json, predictions: list[int]) -> Json:
        cache_key = digest(recipe)
        cached: Any = self.executions.get(cache_key)
        if cached is not None:
            self.statistics["execution_hits"] += 1
            return cast(Json, cached)
        source, alignment = recipe["source"], recipe["alignment"]
        key = digest([source, alignment])
        prices: Any = self.windows.get(key)
        if prices is None:
            frame = self.frame(source)
            dtype = frame.schema["datetime"]
            naive = dtype.time_zone is None

            def stamp(text: str) -> datetime:
                value = datetime.fromisoformat(text)
                return value.replace(tzinfo=None) if naive else value

            where = (
                self.pl.col("datetime")
                >= stamp(alignment["first_test_datetime"])
            ) & (
                self.pl.col("datetime")
                <= stamp(alignment["last_test_datetime"])
            )
            gone = [
                stamp(value)
                for value in alignment.get("missing_datetimes", [])
            ]
            if gone:
                missing = self.pl.Series("missing", gone, dtype=dtype)
                where = where & ~self.pl.col("datetime").is_in(
                    missing.implode()
                )
            prices = frame.filter(where).select(
                [
                    name
                    for name in ("datetime", "open", "high", "low", "close")
                    if name in frame.columns
                ]
            )
            self.windows.put(key, prices, int(prices.estimated_size()))
        if prices.height != len(predictions):
            raise ValueError("Source/alignment does not reproduce test rows")
        options = recipe["options"]
        self.statistics["execution_evaluations"] += 1
        _, execution = self.backtest.evaluate_prices(
            prices, predictions, options, configured=True
        )
        data: Json = {"_record_execution": True, "_alignment": {}}
        self.backtest.record_execution(
            data, execution, options.get("notional_rate", 1.0), prices
        )
        result = cast(Json, data["_alignment"])
        fields = {"execution": result["execution"], "market": result["market"]}
        if record_digest(fields) != recipe["expected"]:
            raise ValueError(
                "Execution replay differs from recorded float64 evidence"
            )
        vectors = {
            name + "." + column: wire_vector(values)
            for name, value in fields.items()
            for column, values in cast(Json, value).items()
        }
        self.executions.put(
            cache_key, vectors, len(encoded(vectors)) * 2 + 1024)
        return vectors

    def signal(self, recipe: Json) -> Json:
        definition = self.definition(recipe["definition"])
        if not definition.get("model"):
            raise ValueError("Model is outside deterministic replay admission")
        params = recipe["params"]
        if (
            params.get("deterministic") is not True
            or type(params.get("random_state")) is not int
            or params.get("n_jobs") != 1
        ):
            raise ValueError(
                "Model needs fixed deterministic single-thread parameters"
            )
        key = digest(
            [
                definition["family"],
                {
                    k: v
                    for k, v in params.items()
                    if k not in definition["axes"]
                },
            ]
        )
        saved: Any = self.signals.get(key)
        if saved is not None:
            if encoded(saved["signature"]) != encoded(recipe["expected"]):
                raise ValueError(
                    "Conflicting model outputs under identical replay inputs"
                )
            self.statistics["model_hits"] += 1
            return cast(Json, saved)
        names = set(definition["names"]) | (
            set(params) - set(definition["domain"])
        )
        prep_key = digest(
            [
                definition["family"],
                {name: params[name] for name in sorted(names)},
            ]
        )
        prepared: Any = self.prepared.get(prep_key)
        if prepared is None:
            manifest = definition["manifest"]
            prepared = manifest.prepare_data(
                self.frame(definition["source"]), params
            )
            self.statistics["preparations"] += 1
            total = 4096
            for name in (
                "x_train",
                "y_train",
                "x_val",
                "y_val",
                "x_test",
                "y_test",
            ):
                if name not in prepared:
                    continue
                matrix = self.np.asarray(prepared[name])
                if name.startswith("x_"):
                    matrix_key = digest(
                        [
                            matrix.shape,
                            matrix.strides,
                            matrix.dtype.str,
                            hashlib.sha256(
                                matrix.tobytes(order="A")
                            ).hexdigest(),
                        ]
                    )
                    shared: Any = self.features.get(matrix_key)
                    if shared is not None:
                        matrix = shared
                    else:
                        matrix.flags.writeable = False
                        self.features.put(
                            matrix_key, matrix, int(matrix.nbytes)
                        )
                matrix.flags.writeable = False
                prepared[name] = matrix
                total += int(matrix.nbytes)
            self.prepared.put(prep_key, prepared, total)
        else:
            self.statistics["preparation_hits"] += 1
        data = dict(prepared)
        data["_alignment"] = copy.deepcopy(prepared["_alignment"])
        if "_fitted_params" in prepared:
            data["_fitted_params"] = copy.deepcopy(prepared["_fitted_params"])
        data.update(_record_execution=False, _record_model_outputs=True)
        self.statistics["fit_attempts"] += 1
        result = definition["manifest"].run_model(data, dict(params))
        output = data["_alignment"]["model_outputs"]
        alignment = data["_alignment"]
        actual_alignment = {
            name: [value.isoformat() for value in alignment[name]]
            if name == "missing_datetimes"
            else alignment[name].isoformat()
            for name in (
                "first_test_datetime",
                "last_test_datetime",
                "missing_datetimes",
            )
        }
        probabilities = self.np.asarray(output["probs"]).tolist()
        predictions = self.np.asarray(result["_preds"]).tolist()
        signature = {
            "probs": vector_digest(probabilities),
            "preds": vector_digest(predictions),
            "alignment": digest(actual_alignment),
            "threshold": output["optimal_threshold"],
            "rule": output["threshold_rule"],
        }
        if encoded(signature) != encoded(recipe["expected"]):
            raise ValueError(
                "Model replay differs from recorded float64 evidence"
            )
        signal: Json = {
            "wire": wire_vector(probabilities),
            "signature": signature,
            "prep": prep_key,
        }
        self.signals.put(key, signal, len(encoded(signal)) * 2 + 4096)
        return signal

    def verify(self, request: Json, predictions: list[int]) -> Json:
        definition = self.definition(request["definition"])
        if not definition.get("execution"):
            return {}
        params, expected = request["params"], request["expected"]
        result: Json = {}
        execution: Json = {
            "source": definition["source"],
            "alignment": request["alignment"],
            "options": definition["manifest"].resolve_backtest_config(params),
            "preds": vector_digest(predictions),
            "expected": expected["execution"],
            "predictions": wire_vector(predictions),
        }
        if request.get("check_execution", True):
            try:
                self.execution(execution, predictions)
                result["execution"] = execution
            except ValueError as exc:
                result["execution_reason"] = str(exc)
        if request.get("check_model") and definition.get("model"):
            model: Json = {
                "definition": request["definition"],
                "params": params,
                "expected": expected["model"],
            }
            try:
                signal = self.signal(model)
                result.update(model=model, prep=signal["prep"])
            except ValueError as exc:
                result["model_reason"] = str(exc)
        return result

    def request(self, request: Json) -> Json:
        if request.get("protocol") != PROTOCOL:
            raise ValueError("Unknown replay protocol")
        operation = request.get("op")
        if operation == "identity":
            return self.identity()
        if operation == "plan":
            return self.plan(request["definition"])
        n = request.get("n")
        if type(n) is not int or n < 1 or n > 10_000_000:
            raise ValueError("Invalid replay prediction count")
        packed = base64.b64decode(request["preds"], validate=True)
        if len(packed) != (n + 7) // 8:
            raise ValueError("Replay prediction shape mismatch")
        predictions = [(packed[i // 8] >> (i % 8)) & 1 for i in range(n)]
        if operation == "verify":
            return self.verify(request, predictions)
        if operation == "materialize":
            recipes = request["recipes"]
            vectors: Json = {}
            if "execution" in recipes:
                recipe = recipes["execution"]
                original = read_wire_vector(recipe["predictions"])
                if vector_digest(original) != recipe["preds"]:
                    raise ValueError(
                        "Execution replay prediction digest mismatch"
                    )
                vectors.update(self.execution(recipe, original))
            if "model" in recipes:
                recipe = recipes["model"]
                signal = self.signal(recipe)
                if encoded(signal["signature"]) != encoded(recipe["expected"]):
                    raise ValueError(
                        "Cached model output differs from its recipe"
                    )
                vectors["probs"] = signal["wire"]
            return {"vectors": vectors}
        raise ValueError("Unknown native replay operation")


def serve(socket_path: Path, assets: Path, image: str) -> None:
    native = Native(assets, image)
    if socket_path.exists():
        if not stat.S_ISSOCK(socket_path.stat().st_mode):
            raise ValueError("Replay socket path is occupied by another file")
        socket_path.unlink()
    socket_path.parent.mkdir(parents=True, exist_ok=True)

    class Handler(socketserver.StreamRequestHandler):
        def handle(self) -> None:
            self.connection.settimeout(300)
            raw = self.rfile.readline(WIRE_LIMIT + 1)
            try:
                if len(raw) > WIRE_LIMIT or not raw.endswith(b"\n"):
                    raise ValueError("Replay request size limit exceeded")
                request: Any = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError("Replay request must be an object")
                response = native.request(cast(Json, request))
            except Exception as exc:
                response = {"error": type(exc).__name__ + ": " + str(exc)}
            self.wfile.write(
                encoded({"protocol": PROTOCOL, **response}) + b"\n"
            )

    with socketserver.UnixStreamServer(str(socket_path), Handler) as server:
        os.chmod(socket_path, 0o600)
        server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    if args.probe:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(30)
            client.connect(args.socket)
            client.sendall(
                encoded({"protocol": PROTOCOL, "op": "identity"}) + b"\n"
            )
            with client.makefile("rb") as stream:
                print(stream.readline(WIRE_LIMIT).decode(), end="")
        return
    serve(Path(args.socket), Path(args.assets), args.image)


if __name__ == "__main__":
    main()
