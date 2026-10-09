import json
import math
import unittest

from grid.columns import ABSENT_CODE, ABSENT_TEXT, NULL_CODE, Store, flatten


def decode_num(col):
    """Values of an exported numeric column as the page reads them."""
    def one(x):
        if x == ABSENT_TEXT:
            return "absent"
        if x is None:
            return None
        if isinstance(x, str):
            return float(x.replace("Infinity", "inf"))
        return x
    if "codes" in col:
        return [("absent" if c == ABSENT_CODE else None if c == NULL_CODE
                 else one(col["levels"][c])) for c in col["codes"]]
    return [one(x) for x in col["data"]]


class FlattenTest(unittest.TestCase):
    def test_nested_sets_and_number_lists(self):
        row = {"a": 1, "hp": {"lr": 0.1, "deep": {"x": True}},
               "feats": ["f1", "f2"], "skew": [413.65, 366.17],
               "mixed": [1, "a"], "empty": {}}
        flat = flatten(row)
        self.assertEqual(flat["hp.lr"], 0.1)
        self.assertEqual(flat["hp.deep.x"], True)
        self.assertEqual(flat["feats"], ("set", ["f1", "f2"]))
        self.assertEqual(flat["skew.0"], 413.65)
        self.assertEqual(flat["skew.1"], 366.17)
        self.assertEqual(flat["mixed"], ("json", '[1,"a"]'))
        self.assertEqual(flat["empty"], ("json", "{}"))


class StoreTest(unittest.TestCase):
    def test_numbers_round_trip_exactly_through_json(self):
        values = [37810.79, 0.1, 1e-300, 123456789.123456, -0.0, 3,
                  2 ** 52 + 1, 0.30000000000000004]
        s = Store()
        for v in values:
            s.append({"x": v})
        for compact in (True, False):
            col = s.export(compact=compact)[0]
            text = json.dumps(col)
            back = decode_num(json.loads(text))
            for a, b in zip(values, back, strict=True):
                assert isinstance(b, (int, float))
                self.assertEqual(float(a), float(b))
                self.assertEqual(math.copysign(1, a), math.copysign(1, b))

    def test_non_finite_numbers_are_sent_as_strings(self):
        s = Store()
        for v in (float("nan"), float("inf"), float("-inf"), 1.5):
            s.append({"x": v})
        col = s.export()[0]
        self.assertNotIn("codes", col)  # non-finite disables the dictionary
        self.assertEqual(col["data"], ["NaN", "Infinity", "-Infinity", 1.5])

    def test_null_and_absent_are_kept_apart(self):
        s = Store()
        s.append({"tp": None, "model": "logreg"})
        s.append({"tp": 0.25, "model": "xgb_hp", "hp": {"depth": 3}})
        s.append({"tp": 0.4, "model": "logreg"})
        cols = {c["name"]: c for c in s.export()}
        self.assertEqual(decode_num(cols["tp"]), [None, 0.25, 0.4])
        self.assertEqual(decode_num(cols["hp.depth"]),
                         ["absent", 3, "absent"])
        self.assertEqual(s.row_object(0), {"tp": None, "model": "logreg"})
        self.assertEqual(s.row_object(1),
                         {"tp": 0.25, "model": "xgb_hp", "hp": {"depth": 3}})

    def test_string_dictionary_and_level_bases_for_deltas(self):
        s = Store()
        for m in ["a", "b", "a"]:
            s.append({"m": m})
        first = s.export(0, 3)[0]
        self.assertEqual(first["levels"], ["a", "b"])
        self.assertEqual(first["data"], [0, 1, 0])
        s.append({"m": "c"})
        s.append({"m": "b"})
        delta = s.export(3, compact=False)[0]
        self.assertEqual(delta["levelBase"], 2)
        self.assertEqual(delta["levels"], ["c"])
        self.assertEqual(delta["data"], [2, 1])

    def test_a_level_new_in_the_last_row_sent_is_not_sent_again(self):
        s = Store()
        s.append({"m": "a", "f": ["x"]})
        s.append({"m": "b", "f": ["y"]})
        first = {c["name"]: c for c in s.export(0, 2)}
        self.assertEqual(first["m"]["levels"], ["a", "b"])
        s.append({"m": "c", "f": ["z"]})
        delta = {c["name"]: c for c in s.export(2, compact=False)}
        self.assertEqual((delta["m"]["levelBase"], delta["m"]["levels"]),
                         (2, ["c"]))
        self.assertEqual((delta["f"]["levelBase"], delta["f"]["levels"]),
                         (2, ["z"]))

    def test_sets_become_hex_bitmasks(self):
        s = Store()
        s.append({"f": ["x", "y"]})
        s.append({"f": ["z"]})
        s.append({"f": []})
        s.append({"f": None})
        s.append({})
        col = s.export()[0]
        self.assertEqual(col["levels"], ["x", "y", "z"])
        self.assertEqual(col["data"], ["3", "4", "0", None, ABSENT_TEXT])
        self.assertEqual(s.row_object(0)["f"], ["x", "y"])
        self.assertNotIn("f", s.row_object(4))

    def test_kind_conflict_converts_to_json_and_is_recorded(self):
        s = Store()
        s.append({"v": 1})
        s.append({"v": "one"})
        s.append({})
        col = s.export()[0]
        self.assertEqual(col["kind"], "json")
        self.assertEqual(col["levels"], ["1", '"one"'])
        self.assertEqual(col["data"], [0, 1, ABSENT_CODE])
        self.assertEqual(s.events[-1]["event"], "kind")
        self.assertEqual(s.row_object(1), {"v": "one"})

    def test_null_only_column_adopts_the_first_real_kind(self):
        s = Store()
        s.append({"v": None})
        s.append({"v": "x"})
        col = s.export()[0]
        self.assertEqual(col["kind"], "str")
        self.assertEqual(col["data"], [NULL_CODE, 0])
        self.assertFalse([e for e in s.events if e["event"] == "kind"])

    def test_bools_and_new_columns_mid_stream(self):
        s = Store()
        s.append({"a": True})
        s.append({"a": False, "b": 2})
        cols = {c["name"]: c for c in s.export()}
        self.assertEqual(cols["a"]["data"], [1, 0])
        self.assertEqual(decode_num(cols["b"]), ["absent", 2])
        self.assertEqual(s.events, [{"row": 1, "column": "b",
                                     "event": "added", "kind": "num"}])

    def test_non_object_row_is_refused(self):
        s = Store()
        with self.assertRaises(ValueError):
            s.append([1, 2])

    def test_large_integers_stay_exact_as_json_text(self):
        s = Store()
        s.append({"id": 2 ** 60 + 7})
        col = s.export()[0]
        self.assertEqual(col["kind"], "json")
        self.assertEqual(col["levels"], [str(2 ** 60 + 7)])


if __name__ == "__main__":
    unittest.main()
