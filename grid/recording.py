"""Named launch policies and truthful descriptions of historical recordings."""

from __future__ import annotations

import re
from typing import Any, cast

Json = dict[str, Any]
GROUPS = ("predictions", "alignment", "trade_ledger", "fold_details")
MARKER = re.compile(r"^# grid-recording-mode: (sweep|inspect)\s*$", re.M)


def policy(mode: object) -> Json:
    if mode not in ("sweep", "inspect"):
        raise ValueError("recording mode must be sweep or inspect")
    enabled = mode == "inspect"
    return {"record_execution": enabled, "record_model_outputs": enabled,
            "recording": dict.fromkeys(GROUPS, enabled)}


def manifest_values(mode: object) -> dict[str, object]:
    chosen = policy(mode)
    return {"uel.record_execution": chosen["record_execution"],
            "uel.record_model_outputs": chosen["record_model_outputs"],
            **{"uel.recording." + key: value for key, value in
               cast(Json, chosen["recording"]).items()}}


def mark_manifest(text: str, mode: object) -> str:
    policy(mode)
    # Comments survive Limen's exact manifest copy without adding schema keys.
    return "# grid-recording-mode: %s\n" % mode + MARKER.sub("", text).lstrip(
        "\n")


def _mapping(value: object) -> Json:
    return cast(Json, value) if isinstance(value, dict) else {}


def infer_recording(manifest: object, metadata: object = None,
                    record: object = None,
                    manifest_text: str | None = None) -> Json:
    """Read effective switches without relabelling historical defaults.

    Runtime metadata takes precedence over a YAML declaration. A named mode
    needs its explicit marker and matching switches; partial historical
    recordings keep their original policy and the ``legacy`` label.
    """
    uel = _mapping(_mapping(manifest).get("uel"))
    meta, saved = _mapping(metadata), _mapping(record)
    recorded = _mapping(saved.get("recordingPolicy"))
    old_flags = _mapping(saved.get("record"))
    groups = _mapping(uel.get("recording"))
    if isinstance(metadata, dict):
        groups = _mapping(meta.get("recording"))
    elif not uel and recorded:
        groups = _mapping(recorded.get("recording"))
    effective: Json = {"recording": {
        key: groups.get(key, True) if isinstance(groups.get(key, True), bool)
        else None for key in GROUPS}}
    for key, old in (("record_execution", "execution"),
                     ("record_model_outputs", "outputs")):
        value = meta.get(key, False) if isinstance(metadata, dict) else \
            uel.get(key, recorded.get(key, old_flags.get(old, False)))
        effective[key] = value if isinstance(value, bool) else None
    named = saved.get("recordingMode")
    if named is None and manifest_text is not None:
        marker = MARKER.search(manifest_text)
        named = marker.group(1) if marker else None
    reason = None
    if named in ("sweep", "inspect"):
        if effective != policy(named):
            reason = "Recorded switches disagree with the named mode; " \
                     "showing the recorded policy."
            named = "legacy"
    else:
        named = "legacy"
    return {"recordingMode": named, "recordingPolicy": effective,
            "recordingReason": reason}
