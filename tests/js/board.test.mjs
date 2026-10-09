// The board while rows arrive: its cards keep their places until the
// reader re-sorts, and it says how many would move.

import { test } from "node:test";
import assert from "node:assert/strict";
import { holdPlaces } from "../../web/js/view-board.js";

test("the cards keep their places while the rows change their order", () => {
  const hold = { on: ["a", "b", "c"], off: ["d", "e"] };
  // the rows now rank c first, d moves the needle and b no longer does
  const live = { on: ["c", "a", "d"], off: ["b", "e"] };
  const p = holdPlaces(live, hold);
  assert.deepEqual([p.on, p.off], [["a", "b", "c"], ["d", "e"]]);
  assert.equal(p.moved, 4, "a, b, c and d stand elsewhere once sorted; e does not");
  // a card new since joins the end of the section the rows put it in
  assert.deepEqual(holdPlaces({ on: ["a", "f"], off: [] }, { on: ["a"], off: [] }), { on: ["a", "f"], off: [], moved: 0 });
  // a card gone since leaves its place
  assert.deepEqual(holdPlaces({ on: ["b"], off: [] }, { on: ["a", "b"], off: [] }), { on: ["b"], off: [], moved: 0 });
  assert.equal(holdPlaces(hold, hold).moved, 0);
  // the cards with no detectable effect swapping places is the order of noise
  assert.equal(holdPlaces({ on: ["a"], off: ["e", "d"] }, { on: ["a"], off: ["d", "e"] }).moved, 0);
});
