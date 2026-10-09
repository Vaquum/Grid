// The system reference: every surface and every number, each with its
// Purpose, how to Read it, and how to Use it.

import { h, clear, icon } from "./ui.js";

const TOPICS = [
  { id: "overview", title: "Grid",
    purpose: "Watch a parameter sweep while it runs and see how each parameter moves its outcome, with the uncertainty of every number.",
    read: "The top bar names the sweep, the run on screen and its state (live, recorded or replay), and its pace. The needle is the outcome every view measures; the context chips narrow every view to the rows that hold them. The rail switches views; the inspector on the right opens whatever you choose.",
    use: "Start on the Board. Choose a parameter to open it in the inspector. Choose a value to look inside it (C) or stack it into a pocket (P). Switch the needle (T) to see what moves another outcome." },
  { id: "board", title: "Board",
    purpose: "Rank every sampled parameter by how much it moves the needle, and show the needle at each of its values.",
    read: "The strip on top sums the board up: the needle over the rows in view with its 95% interval, the rows, how many parameters move it after correcting for testing them all (q < 0.05), the strongest, the best single value, the dead values, and how many parameters act only under a condition. Below it, one card per parameter, strongest first; the parameters with no detectable effect have their own section. Top right on a card is ω², the share of the needle's variance the parameter explains on its own (inside its scope for a nested parameter), with a bar against the strongest on the board, and under it the corrected q. Tags at the bottom say where it acts, which values are dead, whether the sampler drew it independently, and how many values have too few rows to show.",
    use: "Arrow keys move between cards; Enter or a click opens one in the inspector, and a click on a value opens it with that value chosen. The copy button on the strip copies the board as notes. The set card (feats) opens the Features view." },
  { id: "plot", title: "A card's plot",
    purpose: "Show how the needle changes from one value of a parameter to the next.",
    read: "The needle runs up the y axis, and every card shares the scale, so a flat card and a steep card compare at a glance. A number's values sit at their place on x, small to large (on a log axis, marked log, when they are spaced by factors), each a dot with a line for its 95% interval, joined in order; none stands apart on the left. A category's values are bars from zero with their interval on top. The dashed line is the base, labelled in bold on the axis (for a nested parameter, the level inside its scope). The best and worst values of a parameter that moves the needle carry their number. Blue marks a parameter that moves the needle, grey one that does not. A hollow dot or an outlined bar has fewer than 30 rows: it is placed, but no number is claimed for it. A dotted interval runs past the edge of the scale.",
    use: "Rest the pointer on a value for its number, interval, rows and distance from the base; click it to open it in the inspector." },
  { id: "inspector", title: "The inspector",
    purpose: "Open a parameter as deep as you need.",
    read: "Its kind (category, number, switch, set member, nested number) with its scope, and one sentence on what it does. Attributes: strength, the test and its corrected q, the rows it applies to, and whether the sampler drew its values evenly and independently. Where it acts: the parameters that change its effect. Values: every value with its rows, needle, distance from the base and interval. How the estimates settled: each value's estimate as the rows arrived.",
    use: "Choose a value in the table to look inside it (C) or add it to the pocket (P). The settling chart tells you whether more rows are still changing the picture." },
  { id: "pocket", title: "Pocket",
    purpose: "Compose the slice of the space worth sweeping next, and know what it would hit.",
    read: "The strip gives the pocket's needle with its interval, how far it sits from the base, its rows, how many blocks earn their place, and whether the two halves of the arrivals agree (for a rate, also its hits and their share of all hits). The stack reads from the bottom: the rows in view, then each block with the rows and the needle once it is added, every bar on one axis, so the stack is a path. Each block says what it does: it earns its place when the pocket's rows differ detectably from the rows it takes away (corrected across the blocks), and only narrows when they do not; its edge is blue when it earns its place. Next block ranks additions by the conservative end of their interval; Every value lists every value of every parameter.",
    use: "Add a value from the suggestions or from its chip, drag a chip onto the stack, or press P on a value in the inspector; a chip already in the pocket takes its value out again. Drag a block to reorder the path. Pin a pocket to compare. Open the manifest at the foot of the page for the experiment narrowed to the pocket, ready for the next sweep. The needle inside a pocket estimates what a new sweep drawn uniformly inside it would get, because every parameter is drawn independently and uniformly." },
  { id: "pairs", title: "Pairs",
    purpose: "Find parameters that change each other's effect, and check that the sampler drew them independently.",
    read: "The strip counts the pairs that interact and the pairs the sampler drew together, names the strongest, and says how many parameters are paired (the strongest 26 at most). Interactions ranks the pairs whose combinations explain the needle beyond their two separate effects (ω², q corrected across every pair), with any pair the sampler linked below. The chosen pair (the strongest, until you choose) opens as the needle in every combination of their values, coloured against the base (blue better, persimmon worse, grey at the base), each value's margin over the other's every value, and hatched cells under 30 rows. Every pair is the map: the interaction under the diagonal, more coloured when stronger; above it, Cramér's V of the pair as drawn, aqua when the two are linked.",
    use: "Choose a pair in Interactions or a cell of the map to open it beside them; choose a grid cell to look inside that combination on the board. Choose 3 to 6 on Interactions for larger sets: what they explain together beyond every smaller set within them, tested only when every combination of their values holds 5 rows, among the strongest parameters (at most 2,000 sets a size), in the background. When no set of a size is detectable, the smaller sets give the full picture, and the closest ones can still be opened: three as the grid of two for each value of the third, more as their best and worst combinations." },
  { id: "features", title: "Features",
    purpose: "Say which members of a sampled subset to keep and which to drop.",
    read: "For each member, the difference in the needle between rows that included it and rows that left it out, compared inside each subset size and averaged (subset size is drawn too, and larger subsets include every member more often, which would otherwise leak the size's effect into every member). The bar is the 95% interval; the vertical line is no difference. Helps and hurts are q < 0.05 across the members.",
    use: "Sort by effect or name; choose a member to open it in the inspector; copy the keep and drop lists." },
  { id: "trials", title: "Trials",
    purpose: "See the best rows the way the runner ranks them, what each score rests on, and open any of them in full.",
    read: "The strip sets the best row against the luck line, what noise alone would reach in as many rows, and against the rows like it: the other rows that share its values of the parameters that move the needle, which is what those values earn without its luck. It counts the rows clear of the luck line and the rows that arrived since the best. The table ranks rows by the runner's objective (Limen: net PnL per bar; plate sweeps: gates passed, then mean %/mo). Rows that tie share a rank (4=) and keep the order they arrived in; a tie too large for the list of 100 is told in one line instead, since inside it the order means nothing. A value shows no finer than the runner wrote it (Limen writes net PnL per bar to 0.1 bps). The pills are the nine gates, dark when passed. The icons above the table add column sets: Movers (the parameters that move the needle, strongest first), Other parameters, Rows like it, and where the sweep records them Activity (Limen: entries and deployed notional), Risk (drawdown and losses), Model skill (AUC and its errors) and Run time.",
    use: "Toggle the icons for the columns you need, as many as you like; rest on one for what it adds. Choose a row, or the best row on the strip, for every field, its gates, its parameters and the command that replays it; choose it again to close it. The copy button on the strip copies the table as notes." },
  { id: "gates", title: "Gates",
    purpose: "Know which gates the space can pass at all, and what stops the best rows.",
    read: "Each gate's pass rate with its interval, the distribution of its value against its need, and for a gate that never passed, the upper bound on its true rate (three over the rows, the rule of three) and the outcome it moves with, which bounds it. The top card lists the sets of gates the best rows fail together.",
    use: "What moves this gate makes the gate's pass the needle and opens the board." },
  { id: "run", title: "Run",
    purpose: "Watch the sweep as a process: pace, segments, crashes, warnings, the sampler and the luck line.",
    read: "Pace in rows a second, the time left, the compute a row takes and the number of workers that pace keeps busy. Each log segment is one launch of the sweep, with its relaunch marker and how it ended. A crash names the exception and the innermost frame in the sweep's own code. Invariants are rules the runner promises, checked on every row. Warnings are counted once per kind. The sampler card flags values drawn unevenly and pairs drawn together.",
    use: "Choose a row under a broken invariant to open it. The luck line card says whether the best so far beats what noise would give." },
  { id: "stats", title: "Statistics",
    purpose: "Every number on the page, defined.",
    read: "Intervals are 95%: Wilson for rates, Student t for means. A value with fewer than 30 rows is withheld. One-way effects: ω² = (SSB − (k−1)·MSW) / (SST + MSW), with the F test, or for a 0/1 needle the likelihood-ratio G-test of equal rates. q-values are Benjamini–Hochberg over the family of tests shown together (the board's parameters, a set's members, all pairs, all interaction tests of the board). Interactions: the share of variance the pair's cells explain beyond an additive fit, with the F test, or for a 0/1 needle the likelihood-ratio test of an additive logistic model against the cells. A parameter acts only when a moderator has a value if its effect is detectable inside that value and a pooled test over the other values finds nothing; otherwise its effect is modulated. A dead value has n ≥ 30 and an interval whose top is under a fifth of the base rate. The luck line is mean + sd · ((1−γ)Φ⁻¹(1−1/n) + γΦ⁻¹(1−1/(n·e))), the expected best of n equally good configurations (the false strategy theorem). The rows like a row are the other rows that share its values of the strongest parameters that move the needle, as many of them as leave at least 30 rows; their mean has a 95% interval like any other. Independence is Cramér's V with its χ² test.",
    use: "Rest the pointer on any number for its test and its rows. Nothing is called inert: a parameter with no detectable effect is bounded by its interval, not declared zero." },
  { id: "data", title: "Data",
    purpose: "Know what Grid read and how it classified it.",
    read: "Each results line is one row. Nested dicts become dotted names (hpcfg.learning_rate), short lists of numbers one column per position, lists of strings a set. A null value (tp: null, no take-profit) is a value of its own; an absent key (no max_depth on a logreg row) means the parameter does not apply. A profile names the roles of a known sweep's fields; fields it does not name are inferred and marked. A nested parameter becomes one knob for each value of the parameter it varies under (learning_rate under lgbm_hp, under xgb_hp), and only there. A knob that is the same as another (hpcfg.C under logreg is C_dir) is an alias and is left off the board.",
    use: "The Not on the board chips list fixed fields, aliases and parameters the runner derived, each with its reason." },
  { id: "live", title: "Live and replay",
    purpose: "Follow a sweep while it writes, or replay how it arrived.",
    read: "Live: python3 -m grid serve follows the results file and the log, locally or with --ssh on the sweep's host (it runs tail -F there; nothing is installed). A results file that starts over (a relaunch) keeps the rows already read as a run of its own. Replay hides every row after an edge in every view, so you see what the sweep knew then.",
    use: "Space plays the arrivals, [ and ] step, Home goes to the first row, End back to the latest (live)." },
];

const KEYS = [
  ["1 – 7", "Board, Pocket, Pairs, Features, Trials, Gates, Run"],
  ["T", "Choose the needle (target)"],
  ["/", "Find a parameter or value (Pocket)"],
  ["← → ↑ ↓", "Move between cards on the board"],
  ["Enter", "Open the card or row in focus"],
  ["C", "Look inside the chosen value (add it to the context)"],
  ["Shift C", "Clear the context"],
  ["P", "Add the chosen value to the pocket"],
  ["Space", "Play or pause the replay"],
  ["[  ]", "Step the replay edge back or forward"],
  ["Home  End", "First row; latest row (live)"],
  ["D", "Light or dark"],
  ["I", "This reference"],
  ["?", "These keys"],
  ["Esc", "Close the reference, then the inspector"],
];

export function renderReference(pane, topic, close) {
  clear(pane);
  pane.append(h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
    h("h2", { text: "System reference" }),
    h("button", { class: "icon-btn", style: { marginLeft: "auto" }, "aria-label": "Close the reference", onclick: close }, icon("close"))),
  h("p", { text: "Each topic says what a surface is for, how to read it and how to use it." }));
  const toc = h("div", { class: "chips", style: { margin: "8px 0 4px" } },
    TOPICS.map(t => h("a", { class: "chip", href: `#ref-${t.id}`, style: { paddingRight: "8px", textDecoration: "none", color: "inherit" },
      onclick: (e) => { e.preventDefault(); pane.querySelector(`#ref-${t.id}`).scrollIntoView({ behavior: "smooth" }); }, text: t.title })),
    h("a", { class: "chip", href: "#ref-keys", style: { paddingRight: "8px", textDecoration: "none", color: "inherit" },
      onclick: (e) => { e.preventDefault(); pane.querySelector("#ref-keys").scrollIntoView({ behavior: "smooth" }); }, text: "Keys" }));
  pane.append(toc);
  for (const t of TOPICS) {
    pane.append(h("section", { class: "topic", id: `ref-${t.id}` }, h("h3", { text: t.title }),
      h("dl", { class: "pru" }, h("dt", { text: "Purpose" }), h("dd", { text: t.purpose }), h("dt", { text: "Read" }), h("dd", { text: t.read }), h("dt", { text: "Use" }), h("dd", { text: t.use }))));
  }
  pane.append(h("section", { class: "topic", id: "ref-keys" }, h("h3", { text: "Keys" }),
    h("div", { class: "keys" }, KEYS.map(([k, v]) => [h("div", null, k.split("  ").map(x => h("kbd", { text: x, style: { marginRight: "4px" } }))), h("div", { text: v })]))));
  if (topic === "keys") pane.querySelector("#ref-keys").scrollIntoView();
}
