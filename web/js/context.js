// Plain-language context for measurements. Resolve it when the reader hovers,
// so live updates, new table columns and resized charts use their current data.
// Unknown fields keep their recorded name; we never guess their formula.

const METRIC_CONTEXT = {
  gates: "How many of the runner's checks this configuration passed.",
  mean_mo: "The average monthly return, as a percentage.",
  total: "The total profit or loss, in dollars.",
  maxDD: "The largest fall from a previous equity peak, in dollars.",
  winday: "The percentage of days that made a profit.",
  avgwin: "The average profit on a winning day, in dollars.",
  avgloss: "The average loss on a losing day, in dollars.",
  nsig: "How many days had a trading signal.",
  meansz: "The average position size, in dollars.",
  sec: "How many seconds it took to evaluate one configuration.",
  execution_time: "How many seconds it took to evaluate one configuration.",
  auc: "How well the model ranks positive examples above negative ones: 0.5 is chance, 1 is perfect.",
  ll_dir: "How far the direction model's probabilities are from the answers. Lower is better.",
  ll_meta: "How far the meta model's probabilities are from the answers. Lower is better.",
  lr_nit_dir: "How many fitting steps the direction model used.",
  lr_nit_meta: "How many fitting steps the meta model used.",
  cal_fb: "How many folds used a fallback instead of the requested calibration.",
  accuracy: "The share of predictions that matched the answer.",
  precision: "Of the examples the model called positive, the share that were positive.",
  recall: "Of the positive examples, the share the model found.",
  fpr: "Of the negative examples, the share the model wrongly called positive.",
  val_score: "The validation score at the threshold chosen by the run.",
  confusion_precision: "Of test bars called positive, the share that were positive.",
  confusion_recall: "Of positive test bars, the share the model found.",
  confusion_tp: "Test bars correctly called positive.",
  confusion_fp: "Test bars wrongly called positive.",
  confusion_tn: "Test bars correctly called negative.",
  confusion_fn: "Positive test bars the model missed.",
  backtest_pnl_per_bar_bps: "The average profit or loss per test bar after costs, in basis points. 1 bps is 0.01%.",
  backtest_wins_per_bar: "The share of test bars with a positive net return.",
  backtest_avg_win_bps: "The average net return of winning test bars, in basis points.",
  backtest_avg_loss_bps: "The average net return of losing test bars, in basis points.",
  backtest_cvar_95_pnl_bps: "The average net return of the worst 5% of test bars, in basis points.",
  backtest_trades_per_bar: "How many new trades started per test bar, on average.",
  backtest_inventory_per_bar: "The average amount deployed in the market per test bar.",
  backtest_cost_per_bar_bps: "The average trading cost per test bar, in basis points.",
  backtest_total_return: "The total return on the test window, as a fraction of starting equity.",
  val_backtest_total_return: "The total return on the validation window, as a fraction of starting equity.",
  backtest_ending_equity: "The money left at the end of the test window, in the quote currency.",
  backtest_max_drawdown: "The deepest fall from an equity peak, as a fraction. Closer to zero is better.",
  backtest_net_pnl: "The test window's profit or loss after all costs, in the quote currency.",
  backtest_gross_pnl: "The test window's profit or loss before costs, in the quote currency.",
  backtest_fees: "The fees paid during the test window, in the quote currency.",
  backtest_slippage: "The execution cost from slippage during the test window, in the quote currency.",
  backtest_funding_pnl: "The profit or loss from funding during the test window, in the quote currency.",
  backtest_completed_trades: "How many trades closed during the test window.",
  backtest_open_trades: "How many trades were still open when the test window ended.",
  backtest_episode_win_rate: "The share of completed trades that made a profit.",
  backtest_avg_absolute_exposure: "The average size of the position, ignoring its direction.",
  optimal_threshold: "The probability cutoff the run chose for opening a position.",
  best_iteration: "How many boosting steps the fitted model kept.",
  _convergence_warning: "Whether the fit warned that it had not settled. Across rows, the share with a warning.",
  entries: "How many trades started in the test window.",
  trade_mean: "The average net return of a trade, compounded over its bars, in basis points.",
  trade_t: "How far the average trade is from zero compared with its uncertainty. Read only with at least 30 trades.",
  timing: "The return from choosing when to be in the market, beyond holding the average deployed amount.",
  tradeable: "Configurations that passed at least 6 gates and made at least $3,000.",
  gates7: "Configurations that passed at least 7 gates.",
  probs_margin: "The highest test probability minus the trading cutoff. Below zero means no bar could trigger a trade.",
  probs_reach: "The share of test bars that reached the cutoff or came within 0.05 of it.",
};

export function targetContext(target) {
  if (!target) return "The outcome selected as the needle: the quantity these results compare.";
  const id = String(target.id || "").replace(/~[12]$/, "");
  const quantile = /^(backtest_edge_bps|backtest_pnl_bps|backtest_cost_bps|backtest_drawdown_bps)_(p5|p50|p95)$/.exec(id);
  const returns = /^confusion_(tp|fp|tn|fn)_mean_return_pct$/.exec(id);
  const inferred = target.source === "inferred";
  let text = inferred ? target.definition : METRIC_CONTEXT[id];
  if (quantile && !inferred) {
    const of = { backtest_edge_bps: "gross return per bar", backtest_pnl_bps: "net return per bar", backtest_cost_bps: "cost per bar", backtest_drawdown_bps: "drawdown" }[quantile[1]];
    text = `${{ p5: "The value 5% of bars fall at or below", p50: "The middle value across bars", p95: "The value 95% of bars fall at or below" }[quantile[2]]} for ${of}, in basis points.`;
  } else if (returns && !inferred) {
    const of = { tp: "correctly called positive", fp: "wrongly called positive", tn: "correctly called negative", fn: "that were positive but missed" }[returns[1]];
    text = `The average market return of test bars ${of}, as a percentage.`;
  }
  if (!text) text = target.definition || `The outcome recorded as “${target.label || "this field"}”${target.unit ? `, in ${target.unit}` : ""}. The run supplies no further definition.`;
  if (target.base || target.half) text += ` Measured on the ${target.half === 2 ? "second" : "first"} half of the test window.`;
  return text;
}

export function dimensionContext(dim) {
  if (!dim) return "The parameter values used to group the results below.";
  const text = dim.kind === "member" ? `Results with ${dim.label} included versus left out.`
    : `Results grouped by ${dim.label}, ${dim.role === "effective" ? "a setting resolved by the runner" : dim.role === "fixed" ? "a setting that stayed the same" : "a setting recorded for each configuration"}.`;
  return text + (dim.scope ? ` Applies only when ${dim.scope.label}.` : "");
}

const LABEL_CONTEXT = {
  rows: "How many evaluated configurations contribute to this result. Missing outcomes are left out of their averages.",
  row: "The configuration's position in the run's arrival order, starting at zero.",
  rank: "The configuration's place in the stated ordering. Tied results share a rank.",
  "#": "Place in the runner's objective ordering. Tied results share a rank.",
  value: "The recorded parameter value used to group these configurations.",
  needle: "The outcome being measured and compared.",
  "95% interval": "A range showing the estimate's uncertainty. More supporting data usually makes it narrower.",
  difference: "How much the outcome changes between the two groups being compared, in the outcome's own units.",
  strength: "How much of the outcome's variation this parameter explains on its own. Larger means a stronger effect.",
  test: "Checks whether the observed differences could be explained by random variation alone.",
  corrected: "The chance-based test result after allowing for all the comparisons made. Below 0.05 counts as detectable.",
  "after correction": "The test result after allowing for all the comparisons made. Below 0.05 counts as detectable.",
  "first half": "Results measured on the first half of each round's test window.",
  "second half": "Results measured on the second half of each round's test window.",
  "on each half": "Whether the effect repeats on two separate halves of the test window.",
  "ranks agree": "How similarly configurations rank on the two halves: 1 means the same order, 0 means no agreement.",
  hits: "How many configurations meet the selected yes-or-no outcome.",
  blocks: "How many parameter restrictions are stacked to define this pocket.",
  recall: "The share of all matching configurations kept by the pocket.",
  lift: "The pocket's outcome minus the outcome over the rows it is compared with.",
  pinned: "Results for the pocket saved as the comparison.",
  "this pocket": "Results for configurations meeting every restriction in the current pocket.",
  gates: "Checks a configuration must pass; each card shows its requirement and how many pass it.",
  gate: "A check a configuration must pass.",
  need: "The requirement the recorded value must meet to pass this gate.",
  state: "The current recorded status of this run, experiment or predictor.",
  from: "The result directory or source these configurations came from.",
  made: "When the predictor was created, on your local clock.",
  started: "When the run started, on your local clock.",
  "last run": "The most recent run of this experiment.",
  "the runs of this sweep": "Each run's results measured on the same selected outcome, for comparison.",
  runs: "Runs of the experiment, with their progress and status.",
  rounds: "How many configurations the run has evaluated, against its planned count when available.",
  shards: "How many parallel parts this run is split into.",
  experiments: "Saved search setups and the runs made from them.",
  experiment: "The saved search setup used to produce these results.",
  combination: "The parameter or feature values used together in these configurations.",
  "switches on": "The feature functions enabled by this combination.",
  adding: "The feature group added between two otherwise matching combinations.",
  column: "An input feature the ablation can remove from the model.",
  "rows dropping it": "How many configurations were evaluated without this input feature.",
  "keeping it": "The estimated change in the outcome from keeping this feature instead of dropping it.",
  member: "A feature in the subset, or a configuration chosen for the cohort.",
  "included in": "How many configurations included this feature.",
  pool: "Configurations eligible for the cohort after its pocket and gate restrictions.",
  members: "Configurations chosen to act together as one predictor.",
  cohort: "Results of the chosen configurations acting together as one predictor.",
  "best member alone": "Results of the highest-ranked chosen configuration acting on its own.",
  "members' mean": "The average of the members' individual results, rather than their combined predictor.",
  "net per bar": METRIC_CONTEXT.backtest_pnl_per_bar_bps,
  trades: "How many trades started in the stated test window.",
  fee: "The fee charged for each fill, in basis points. 1 bps is 0.01%.",
  slippage: "The cost of filling at a worse price, in basis points per fill.",
  predictor: "The saved model made from these configurations for use on new data.",
  "cohort id": "The saved cohort's identifier.",
  "feature groups": "Results for combinations of feature groups, and the change from adding one group.",
  clusters: "Configurations grouped by similar recorded outcomes. Each group shows its size and the outcomes that distinguish it.",
  distributions: "How each recorded outcome is spread across the configurations in view. Each bar shows a group's share of its own rows.",
  "the best rows": "Configurations ranked by the runner's objective, with the settings and measurements behind each result.",
  "shards side by side": "How many independent parts of the run to evaluate in parallel.",
  activity: "How much trading supports the score: entries, time in the market and the number of observations.",
  risk: "The losses and drawdowns that came with the score.",
  skill: "How well the model's predictions match the recorded outcomes.",
  time: "The computation time taken to evaluate each configuration.",
  "rows like it": "Other configurations with the same values of the parameters that move the outcome; the selected row itself is left out.",
  "moves the needle": "Parameters with an effect that can be distinguished from random variation, strongest first.",
  "no detectable effect": "Parameters whose observed differences cannot be distinguished from random variation with these rows.",
  "not in both halves": "Parameters whose effect does not repeat in both halves of the test window.",
  "the first half against the second": "Rank configurations on the first half, then see how their results compare on the second half.",
  "columns the ablation dropped": "How removing individual input features changes the outcome, allowing for which features were removed together.",
  "adding one group": "Compare combinations that differ by exactly one feature group.",
  drawn: "The feature combinations actually evaluated by this run.",
  "every value": "The outcome for each recorded parameter value.",
  "interacting pairs": "Pairs of parameters whose combined effect changes the outcome beyond their separate effects.",
  "every pair": "Every tested pair of parameters; stronger marks mean more interaction.",
  "drawn together": "Parameters whose sampled values are linked, so their effects need to be read together.",
  "where it acts": "Other parameter values under which this parameter's effect changes.",
  attributes: "The parameter's effect, supporting rows and how its values were sampled.",
  outcomes: "Measurements recorded for this one evaluated configuration.",
  parameters: "Settings used for this one evaluated configuration.",
  stack: "Restrictions applied one after another to form the pocket; each step shows the rows it keeps.",
  "add a block": "Choose another parameter restriction to narrow the pocket and compare the configurations it keeps.",
  "for the next pool": "Feature choices suggested by these results for a future sweep.",
  "for the next sweep": "Parameter or feature choices suggested by these results for a future sweep.",
  "new gate": "Choose an outcome and a cutoff; the preview shows how many configurations would pass.",
  "edit the gate": "Change this gate's cutoff; the preview shows how many configurations would pass.",
  "against the pinned pocket": "Compare the current pocket with the one saved as the reference.",
  "what stops the best rows": "Checks failed by configurations that rank highest on the runner's objective.",
  "the halves of the test window": "Compare results on two separate stretches of the market and see whether their rankings repeat.",
  "rounds that never traded": "Configurations whose probabilities never triggered a trade, and whether the threshold or the model held them back.",
  pace: "How quickly configurations are evaluated and how long the run may take.",
  remaining: "The estimated time to finish the planned configurations at the measured pace.",
  "last row read": "How long ago the server received the newest configuration's result.",
  problems: "Recorded failures or inconsistencies in the run's results.",
  warnings: "Warnings from the runner's log, grouped by kind.",
  warning: "The kind of warning the runner recorded.",
  where: "The stage or location in which the runner recorded the warning.",
  times: "How many times the runner recorded this warning.",
  "the sampler": "Whether parameter values were drawn evenly and independently.",
  sampler: "Whether the parameter's values were drawn about equally often.",
  independence: "Whether this parameter's values were sampled independently of other settings.",
  "while this page was open": "Changes observed during this browser session, with their local times.",
  "limen's reports": "The run's saved fit and selection reports, as Limen recorded them.",
  trials: "How many configurations were compared in the selection report.",
  "deflated sharpe probability": "How likely the selected Sharpe score exceeds chance after allowing for the number of configurations tried.",
  "probability of backtest overfitting": "How often choosing the best configuration on one part gives a poor choice on the other part.",
  "judged on the second half": "Compare the combined cohort with its members on market bars separate from those used to choose it, unless the page says those bars chose it too.",
  "not on the board": "Fields that are fixed, duplicate other settings, or are resolved by the runner rather than sampled independently.",
};

const CONTEXT_NODES = "th, td, dt, dd, h1, h2, h3, h4, label, .num, .count, .muted, .sc-k, .pc-name, .pc-sub, .pcard, .lbl, .picker .label, .stat .k, .legend > span, .rn-name, .rn-unit, .rn-fig, .rn-chip-what, .gt-need-line, .gt-cap, .ex-field .k, .eyebrow, .part-title, .chart text, .bk-name, .bk-vals, .mf-file";
const contextLookups = new WeakMap();

const contextText = node => (node?.textContent || "").replace(/\s+/g, " ").trim();
const contextKey = text => text.toLowerCase().replace(/\s+/g, " ").trim();

export function statisticContext(text, kind = "effect") {
  const parts = [];
  if (/ω²/.test(text)) parts.push(kind === "interaction"
    ? "The extra variation in the outcome explained by these settings acting together, beyond their separate effects or smaller combinations."
    : LABEL_CONTEXT.strength);
  if (/\bV\s+[\d.]/.test(text)) parts.push("How closely two sets of values are linked: 0 means no link; larger means a stronger link.");
  if (/\bq\s*[=<]/.test(text)) parts.push(LABEL_CONTEXT.corrected);
  if (/\bp\s*[=<]/.test(text)) parts.push("How unusual the observed difference would be if there were no real difference. Smaller means less consistent with chance alone.");
  return parts.length ? parts.join(" ") : null;
}

const GATE_CONTEXT = {
  m_green: "How many months returned at least −0.5%.",
  m_avg: METRIC_CONTEXT.mean_mo,
  m_min: "The return of the worst month, as a percentage.",
  wr: METRIC_CONTEXT.winday,
  skew: "The average winning day's profit divided by the average losing day's loss.",
  top5: "The share of total profit earned on the five best days.",
  dynsize: "Whether the configuration used different position sizes.",
  dynexit: "How many positions exited during a holding period, rather than only at its end.",
  dd: METRIC_CONTEXT.maxDD,
};

function contextLookup(m) {
  const schema = m?.schema;
  if (!schema) return new Map();
  if (!contextLookups.has(schema)) {
    const fields = new Map();
    for (const d of schema.dims || []) for (const key of [d.label, d.id]) fields.set(contextKey(key), dimensionContext(d));
    for (const t of schema.targets || []) for (const key of [t.label, t.id, `${t.label} (${t.unit})`]) fields.set(contextKey(key), targetContext(t));
    for (const g of schema.gates || []) {
      const text = `${g.target ? targetContext(g.target) : GATE_CONTEXT[g.id] || "The recorded measurement used for this check."} To pass: ${g.need}.`;
      fields.set(contextKey(g.label), text);
      if (!fields.has(contextKey(g.id))) fields.set(contextKey(g.id), text);
    }
    contextLookups.set(schema, fields);
  }
  return contextLookups.get(schema);
}

export function labelContext(label, m, heading = false) {
  const key = contextKey(label);
  if (heading && LABEL_CONTEXT[key]) return LABEL_CONTEXT[key];
  const known = contextLookup(m).get(key);
  if (known) return known;
  if (LABEL_CONTEXT[key]) return LABEL_CONTEXT[key];
  if (key.startsWith("95% interval")) return LABEL_CONTEXT["95% interval"];
  if (/^first half\b/.test(key)) return LABEL_CONTEXT["first half"];
  if (/^second half\b/.test(key)) return LABEL_CONTEXT["second half"];
  if (/^rank.*first half/.test(key)) return "The configuration's rank on the first half of the test window, before judging it on the second.";
  if (/^manifest\b/.test(key)) return "The experiment's saved settings and the search space they define.";
  if (/^what moves\b/.test(key)) return `How each parameter changes ${m?.target?.label || "the selected outcome"} across the configurations in view.`;
  if (/^best.*against luck/.test(key)) return "The best result reached as configurations arrive, compared with what random variation alone could reach.";
  if (/^what (makes|sets)\b/.test(key)) return "The parameter values that occur more often in this group than in the comparison group.";
  if (/^interacting\b/.test(key)) return "Sets of parameters whose combined effect exceeds what their smaller subsets explain.";
  if (/^including each of\b/.test(key)) return "Compare the outcome with each feature included versus left out, allowing for subset size.";
  if (/by the number of members/.test(key)) return `How ${m?.target?.label || "the outcome"} changes with the number of features included in the configuration.`;
  if (/^the selection\b/.test(key)) return "The runner's selection report: its best configuration and how much of that score could come from trying many configurations.";
  if (/^row \d/.test(key)) return "One evaluated configuration, with its recorded settings and outcomes.";
  return null;
}

// Logical column positions respect grouped headers and colspan. Numeric labels
// in a heat map use explicit tips from its dimensions instead of this fallback.
function contextColumn(cell) {
  let index = 0;
  for (const sibling of cell.parentElement.cells) {
    if (sibling === cell) return index;
    index += sibling.colSpan;
  }
  return index;
}

function contextHeader(row, index) {
  let start = 0;
  for (const cell of row.cells) {
    if (start <= index && index < start + cell.colSpan) return cell;
    start += cell.colSpan;
  }
  return null;
}

function contextTable(cell, m) {
  const table = cell.closest("table"), row = cell.closest("tr");
  if (!table || !row) return null;
  if (cell.tagName === "TH") {
    const text = labelContext(contextText(cell), m, cell.scope === "colgroup" || cell.colSpan > 1);
    return table.matches(".co-table") && /^(First|Second) half/.test(contextText(cell)) ? `${text} ${targetContext(m?.target?.base || m?.target)}` : text;
  }
  const index = contextColumn(cell);
  const heads = table.tHead ? [...table.tHead.rows] : [];
  const head = heads.length ? contextHeader(heads.at(-1), index) : null;
  const label = contextText(head), rowLabel = table.matches(".trials") ? `row ${contextText(row.querySelector(".ri"))}` : contextText(row.cells[0]);
  const rowField = contextLookup(m).get(contextKey(rowLabel));
  const transposed = /^(Pinned|This pocket)$/i.test(label);
  let text = index === 0 ? labelContext(rowLabel, m) || labelContext(label, m)
    : transposed ? labelContext(rowLabel, m) : labelContext(label, m);
  if (label === "Value" && contextText(heads.at(-1)?.cells[0]) === "Gate") text = rowField || "The recorded outcome used to decide whether this configuration passes the gate.";
  if (!text) return null;
  if (rowField && /^(first half|second half)/i.test(label)) text = `${text} ${rowField}`;
  if (table.matches(".co-table") && /^(first|second) half/i.test(label)) text += ` ${targetContext(m?.target?.base || m?.target)}`;
  if (/^95% interval/i.test(label) && heads.some(h => [...h.cells].some(c => contextText(c) === "Ranks agree"))) text = "The uncertainty range for the agreement between the first-half and second-half rankings.";
  const group = heads.length > 1 ? contextText(contextHeader(heads[0], index)) : "";
  const scope = [index > 0 && rowLabel ? `For ${rowLabel}.` : "", group && group !== label ? `Group: ${group}.` : ""].filter(Boolean).join(" ");
  return `${text}${scope ? ` ${scope}` : ""}${contextText(cell) === "–" ? " No value is shown; this is not zero." : ""}`;
}

export function measurementContext(node, m) {
  if (!node?.closest || node.closest("pre, code, #tip, .info-pop, .reference")) return null;
  for (let el = node.closest(CONTEXT_NODES); el; el = el.parentElement?.closest(CONTEXT_NODES)) {
    let text;
    if (el.matches("td, th")) text = contextTable(el, m);
    else if (el.matches("dd")) text = labelContext(contextText(el.previousElementSibling), m);
    else if (el.matches("h1, h2, h3, h4, .part-title")) text = labelContext(contextText(el), m, !el.matches(".rn-name"))
      || labelContext(contextText(el.querySelector(":scope > span:first-child")), m, true);
    else if (el.matches(".pcard")) text = el.dataset.dim ? dimensionContext(m?.schema?.dimById.get(el.dataset.dim)) : "Results with each member of this feature subset included.";
    else if (el.closest(".co-cost")) text = LABEL_CONTEXT[contextKey(contextText(el.closest("label")?.querySelector("span")))];
    else if (el.matches("input, select")) text = labelContext(el.getAttribute("aria-label") || "", m);
    else if (el.matches(".num, .count, .muted")) {
      const fact = el.closest("dd");
      const cell = el.closest("td, th");
      const stat = el.closest(".stat, .sc");
      text = fact ? labelContext(contextText(fact.previousElementSibling), m)
        : cell ? contextTable(cell, m)
        : stat ? labelContext(contextText(stat.querySelector(".k, .sc-k")), m) : statisticContext(contextText(el), el.closest("[data-statistic]")?.dataset.statistic);
    } else text = labelContext(contextText(el), m);
    if (!text) {
      const section = el.closest(".isl-part, .part, .rn-card, .island, .board-sec, .pcard, .brick, .manifest-sec");
      const name = section?.querySelector("h2, h3, .pc-name");
      text = name ? labelContext(contextText(name), m, !name.matches(".rn-name")) || labelContext(contextText(name.querySelector(":scope > span:first-child")), m, true) : null;
      if (!text) {
        const note = section?.querySelector(":scope > .isl-note, :scope > .note, :scope > header .note");
        text = contextText(note) || null;
      }
    }
    if (text) return { target: el, text };
  }
  return null;
}
