// What the status pill says: the run's own state, as plainly as the page
// can know it, not only how the page gets its rows. The replay edge comes
// first, then the link to the server, then the run: kept after its file
// started over, an earlier run, a recording, crashed or finished in its own
// log segment, quiet for ten minutes, or live.

import { fmtInt, fmtAgo, fmtClock, fmtDuration } from "./ui.js";

// Seconds without a row before a run being written is quiet.
export const QUIET_AFTER = 600;

// When a run's rows could first arrive: the later of the server's start
// and the run's last start-over, so a run that has just started again is
// not quiet for the time before it.
export function rowsSince(started, meta) {
  const resets = meta.resets || [];
  return Math.max(started, resets.length ? resets[resets.length - 1].at : -Infinity);
}

// When the latest row was written, as the page knows it: when it arrived
// at the server, or, for rows read when the server started (which have no
// arrival of their own), when the run's files were last written; NaN when
// neither is known.
export function lastRowAt(ds) {
  if (!ds.n) return NaN;
  const t = ds.arrivals[ds.n - 1];
  if (Number.isFinite(t)) return t;
  return Number.isFinite(ds.meta.writtenAt) ? ds.meta.writtenAt : NaN;
}

// s: { meta, n, edge (null: the latest row), mode ("live" or a recording),
// connected, playing, seg (the run's log segment, or null), writing (a
// traceback is being written to the log), lastRow (lastRowAt), since
// (rowsSince), now }
// -> { kind, label, detail, tip }
export function runStatus(s) {
  const { meta } = s;
  if (s.edge !== null && s.edge < s.n) {
    return { kind: "replay", label: s.playing ? "Replaying" : "Replay", detail: `row ${fmtInt(s.edge)} of ${fmtInt(s.n)}`,
      tip: s.playing ? "Rows appear in the order the sweep wrote them. Every view shows only the rows up to the edge." : "Every view shows only the rows up to the replay edge. End returns to the latest row." };
  }
  if (s.mode === "live" && !s.connected) {
    return { kind: "down", label: "Reconnecting", detail: null, tip: "The stream from the server stopped; the page reads the sweep again." };
  }
  if (meta.archivedFrom) {
    return { kind: "archived", label: "Archived", detail: Number.isFinite(meta.archivedAt) ? `until ${fmtClock(meta.archivedAt)}` : null,
      tip: `The rows read before its results file ${meta.archivedReason === "replaced" ? "was replaced" : "started over"}, kept as they were. The run goes on under its own name in the run picker.` };
  }
  if (s.mode !== "live") {
    return { kind: "recorded", label: "Recorded", detail: s.mode === "demo" ? null : "file", tip: "A snapshot of the sweep's files. Press play to replay its rows as they arrived." };
  }
  if (!meta.live) {
    return { kind: "earlier", label: "Earlier run", detail: null, tip: `An earlier run of this sweep, read from ${meta.source}: not the one being written.` };
  }
  const ago = Number.isFinite(s.lastRow) ? s.now - s.lastRow : NaN;
  const last = Number.isFinite(ago) ? `last row ${fmtAgo(ago)}` : null;
  // a crash ends its segment; a progress line after it would say the run went on
  const seg = s.seg;
  const crashed = !!seg && ((seg.status === "crashed" && !seg.progress.some(p => seg.crash && p[0] > seg.crash.line)) || s.writing);
  if (crashed) {
    return { kind: "down", label: "Crashed", detail: last,
      tip: "The run's log shows a crash in its latest segment, and no relaunch since. The Run view (7) has the traceback." };
  }
  if (seg && seg.status === "finished") {
    return { kind: "finished", label: "Finished", detail: last, tip: "The run's log has its closing summary: the sweep is done." };
  }
  const quiet = Number.isFinite(ago) ? ago : s.now - s.since;
  if (quiet > QUIET_AFTER) {
    return { kind: "quiet", label: "Quiet", detail: last || `no row in ${fmtDuration(quiet)}`,
      tip: `No row has arrived for over ${QUIET_AFTER / 60} minutes. The Run view (7) shows a crash or a stop when the log has one.` };
  }
  return { kind: "live", label: "Live", detail: last || "no new row yet", tip: `Following ${meta.source}.` };
}
