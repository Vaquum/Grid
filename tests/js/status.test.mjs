// The status pill: what it says of a run, from its rows, its log and the
// link to the server; and the times the page gives, on the reader's clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runStatus, rowsSince } from "../../web/js/status.js";
import { fmtClock, fmtStamp, runName } from "../../web/js/ui.js";

process.env.TZ = "UTC";  // the reader's clock, for these tests

const now = 1_000_000;
const base = { meta: { live: true, source: "results.jsonl" }, n: 100, edge: null, mode: "live", connected: true,
  playing: false, seg: null, writing: false, lastRow: now - 5, since: now - 3600, now };
const st = (patch = {}) => runStatus({ ...base, ...patch, meta: { ...base.meta, ...(patch.meta || {}) } });
const said = s => [s.kind, s.label, s.detail];

test("a run being written is live, and quiet after ten minutes without a row", () => {
  assert.deepEqual(said(st()), ["live", "Live", "last row 5 s ago"]);
  assert.deepEqual(said(st({ lastRow: now - 700 })), ["quiet", "Quiet", "last row 12 min ago"]);
  // no row since the server began reading: live, then quiet ten minutes on
  assert.deepEqual(said(st({ lastRow: NaN, since: now - 60 })), ["live", "Live", "no new row yet"]);
  assert.deepEqual(said(st({ lastRow: NaN })), ["quiet", "Quiet", "no row in 60 min"]);
});

test("a run that has just started over is not quiet for the time before it", () => {
  // the server has read for an hour; the run started over a minute ago
  const meta = { resets: [{ at: now - 60, reason: "truncated", rows: 3900 }] };
  assert.equal(rowsSince(now - 3600, meta), now - 60);
  assert.equal(rowsSince(now - 3600, {}), now - 3600);
  assert.deepEqual(said(st({ lastRow: NaN, since: rowsSince(now - 3600, meta) })), ["live", "Live", "no new row yet"]);
});

test("a crash in the run's latest segment says so, until a progress line says it went on", () => {
  const seg = { status: "crashed", crash: { line: 40 }, progress: [[30, 100, 14]] };
  assert.equal(st({ seg }).label, "Crashed");
  assert.equal(st({ seg: { ...seg, progress: [[30, 100, 14], [50, 200, 28]] } }).label, "Live");
  assert.equal(st({ writing: true, seg: { status: "open", progress: [] } }).label, "Crashed");
  assert.equal(st({ seg: { status: "finished", progress: [] } }).label, "Finished");
});

test("rows kept, recorded or of an earlier run are not called live", () => {
  const kept = st({ meta: { live: false, archivedFrom: "r0", archivedAt: 18 * 3600 + 24 * 60, archivedReason: "truncated" } });
  assert.deepEqual(said(kept), ["kept", "Archived", "until 18:24"]);
  assert.match(kept.tip, /started over/);
  assert.equal(st({ meta: { live: false } }).label, "Earlier run");
  assert.equal(st({ mode: "recorded" }).label, "Recorded");
  assert.equal(st({ connected: false }).label, "Reconnecting");
  assert.deepEqual(said(st({ edge: 40 })), ["replay", "Replay", "row 40 of 100"]);
  assert.equal(st({ edge: 40, playing: true }).label, "Replaying");
});

test("times read on the reader's clock, and in full with its zone", () => {
  assert.equal(fmtClock(18 * 3600 + 24 * 60), "18:24");
  assert.equal(fmtClock(18 * 3600 + 24 * 60 + 11, true), "18:24:11");
  assert.equal(fmtStamp(18 * 3600 + 24 * 60 + 11), "1970-01-01 18:24:11 UTC");
  assert.equal(runName({ label: "current", archivedFrom: "r0", archivedAt: 18 * 3600 + 24 * 60 }), "current · until 18:24");
  assert.equal(runName({ label: "current" }), "current");
});
