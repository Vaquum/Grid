"""Compressed storage compatibility, live framing and market integrity."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from grid.__main__ import main
from grid.cohort import RoundLines
from grid.experiment import _slim
from grid.follow import FileFollower, _GzipLines
from grid.round_storage import (
    COMPACT,
    FORMAT,
    PLAIN,
    frames,
    read_local,
    restore,
    round_name,
)

FIXTURE = Path(__file__).parents[1] / "fixtures/limen_run"


def compress(directory: Path) -> list[dict]:
    metadata = json.loads((directory / "metadata.json").read_text())
    metadata["round_storage"] = FORMAT
    (directory / "metadata.json").write_text(json.dumps(metadata))
    records = [json.loads(line) for line in
               (directory / PLAIN).read_text().splitlines()]
    (directory / "round_market").mkdir()
    with (directory / COMPACT).open("wb") as out:
        for record in records:
            wire = dict(record)
            if wire.get("market") is not None:
                raw = json.dumps(wire.pop("market"), sort_keys=True,
                                 separators=(",", ":")).encode()
                digest = hashlib.sha256(raw).hexdigest()
                (directory / "round_market" / (digest + ".json.gz")) \
                    .write_bytes(gzip.compress(raw))
                wire["market_ref"] = digest
            out.write(gzip.compress((json.dumps(wire) + "\n").encode()))
    (directory / PLAIN).unlink()
    return records


class Storage(unittest.TestCase):
    def test_metadata_conflicts(self) -> None:
        self.assertEqual(round_name([], {}), PLAIN)
        self.assertEqual(round_name([], {"round_storage": FORMAT}), COMPACT)
        for names, meta in [([PLAIN, COMPACT], {}), ([COMPACT], {}),
                            (["round_market"], {}),
                            ([PLAIN], {"round_storage": FORMAT}),
                            ([], {"round_storage": "future"})]:
            with self.subTest(names=names, meta=meta), \
                    self.assertRaises(ValueError):
                round_name(names, meta)

    def test_members_wait_for_trailer_and_keep_wire_history(self) -> None:
        seen = []
        buffer = _GzipLines(lambda text, pre: seen.append((text, pre)))
        a, b = gzip.compress(b'{"a":1}\n'), gzip.compress(b'{"b":2}\n')
        buffer.preload_end = len(a)
        for byte in a[:-1]:
            buffer.feed(bytes([byte]))
        self.assertEqual(seen, [])
        buffer.feed(a[-1:] + b[:4])
        self.assertEqual(seen, [('{"a":1}', True)])
        buffer.feed(b[4:])
        self.assertEqual(seen[-1], ('{"b":2}', False))
        buffer.restart()
        buffer.feed(a)
        self.assertFalse(seen[-1][1])

    def test_corrupt_and_oversized_members_fail(self) -> None:
        raw = bytearray(gzip.compress(b'{}\n'))
        raw[-5] ^= 1
        for data, limit in [(bytes(raw), 100), (gzip.compress(b'x' * 20), 10),
                            (b'garbage', 100)]:
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                list(frames(io.BytesIO(data), compact=True, tail=False,
                            limit=limit))
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            list(frames(io.BytesIO(gzip.compress(b'{}')[:-1]),
                        compact=True, tail=False))

    def test_pack_cohort_and_training_export_match_legacy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'run'
            shutil.copytree(FIXTURE, source)
            legacy = root / 'legacy.json'
            main(['pack', '--limen', str(source), '--out', str(legacy)])
            records = compress(source)
            compact = root / 'compact.json'
            main(['pack', '--limen', str(source), '--out', str(compact)])
            old = json.loads(legacy.read_text())['runs'][0]
            new = json.loads(compact.read_text())['runs'][0]
            for key in ('rounds', 'roundsBadCount', 'data', 'columns'):
                self.assertEqual(old.get(key), new.get(key), key)
            self.assertTrue(new['experiment']['roundLog'].endswith(COMPACT))
            lines = RoundLines()
            for record in records:
                self.assertEqual(lines.get(str(source), record['round_id']),
                                 record)
            slim = root / 'slim'
            _slim(str(source), str(slim), records[:2])
            self.assertNotIn('round_storage', json.loads(
                (slim / 'metadata.json').read_text()))
            self.assertEqual(RoundLines().get(str(slim),
                                             records[0]['round_id']),
                             records[0])
            self.assertEqual(len((slim / PLAIN).read_text().splitlines()), 2)

    def test_file_append_partial_replace_and_index_invalidation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'metadata.json').write_text(json.dumps(
                {'round_storage': FORMAT}))
            path = root / COMPACT
            a = gzip.compress(b'{"round_id":"a","n":1}\n')
            b = gzip.compress(b'{"round_id":"b","n":2}\n')
            path.write_bytes(a + b[:5])
            seen, resets = [], []
            follower = FileFollower(str(path), lambda t, p: seen.append(
                (json.loads(t), p)), resets.append, self.fail)
            follower.read_available()
            lines = RoundLines()
            self.assertEqual(lines.get(tmp, 'a')['n'], 1)
            with self.assertRaisesRegex(ValueError, 'not in'):
                lines.get(tmp, 'b')
            with path.open('ab') as out:
                out.write(b[5:])
            follower.read_available()
            self.assertEqual(len(seen), 2)
            self.assertFalse(seen[-1][1])
            self.assertEqual(lines.get(tmp, 'b')['n'], 2)
            replacement = root / 'replacement'
            replacement.write_bytes(gzip.compress(
                b'{"round_id":"b","n":3}\n'))
            os.replace(replacement, path)
            follower.read_available()
            self.assertEqual(resets, ['replaced'])
            self.assertEqual(lines.get(tmp, 'b')['n'], 3)
            with self.assertRaisesRegex(ValueError, 'not in'):
                lines.get(tmp, 'a')

    def test_shared_market_integrity(self) -> None:
        raw = b'{"ret":[null,0.25]}'
        digest = hashlib.sha256(raw).hexdigest()
        record = {'market_ref': digest, 'preds': [0, 1]}
        self.assertEqual(restore(record, lambda _: gzip.compress(raw))[
            'market'], {'ret': [None, 0.25]})
        bad = [dict(record, market={}), dict(record, market_ref='../escape'),
               dict(record, preds=[0])]
        for rec in bad:
            with self.assertRaises(ValueError):
                restore(rec, lambda _: gzip.compress(raw))
        with self.assertRaisesRegex(ValueError, 'digest'):
            restore(record, lambda _: gzip.compress(b'{"ret":[]}'))
        with self.assertRaises(FileNotFoundError):
            restore(record, lambda name: read_local('/nonexistent', name))
