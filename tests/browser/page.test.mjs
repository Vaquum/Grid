// Browser tests: the built page on a synthetic sweep, recorded and live.
//
//   GRID_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//     node --test --test-reporter=spec tests/browser/
//
// The page is built with a synthetic pack (tools/synth.py) so no sweep's
// real data is needed; the live test runs tools/live_demo.py on a free port.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { limenOutputsRun } from "../fixtures/limen_outputs.mjs";
import { limenExecutionRun } from "../fixtures/limen_execution.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PW = process.env.GRID_PLAYWRIGHT;
if (!PW) throw new Error("set GRID_PLAYWRIGHT to a playwright index.mjs (see the header of this file)");
const { chromium } = await import(PW);

let dir, server, base, browser;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "grid-browser-"));
  execFileSync("python3", ["tools/synth.py", "--rows", "6000", "--seed", "5", "--out", dir], { cwd: ROOT });
  execFileSync("python3", ["-m", "grid", "pack", "--results", join(dir, "results.jsonl"), "--log", join(dir, "sweep.log"),
    "--name", "Synthetic sweep", "--out", join(dir, "pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "pack.json.gz"), "--out", join(dir, "demo.html")], { cwd: ROOT, stdio: "ignore" });
  // a real Limen run's first rounds, read from its result directory
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_run", "--out", join(dir, "limen.pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "limen.pack.json.gz"), "--out", join(dir, "limen.html")], { cwd: ROOT, stdio: "ignore" });
  // the first 200 rounds of a longer run: enough rounds to fall into groups
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_run_200", "--out", join(dir, "limen200.pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "limen200.pack.json.gz"), "--out", join(dir, "limen200.html")], { cwd: ROOT, stdio: "ignore" });
  server = createServer(async (req, res) => {
    try {
      const page = req.url.startsWith("/limen200") ? "limen200.html" : req.url.startsWith("/limen") ? "limen.html" : "demo.html";
      const body = await readFile(join(dir, page));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    } catch (err) { res.writeHead(500); res.end(String(err)); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

async function open(width = 1440, height = 900) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base);
  await page.waitForSelector(".pcard");
  return { page, errors };
}

test("the board sums itself up in a strip and plots every parameter", async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator(".view h1").innerText(), "What moves Tradeable");
  const strip = await page.locator(".strip").innerText();
  assert.match(strip, /Rows\s+6,000/);
  assert.match(strip, /Moves the needle/);
  const on = await page.locator(".pcard:not(.off)").count();
  assert.ok(on >= 3, `cards that move the needle: ${on}`);
  // the planted strong effects move the needle, the inert one does not
  const names = await page.locator(".pcard:not(.off) .pc-name").allInnerTexts();
  assert.ok(names.includes("model"), names.join(","));
  assert.ok(names.includes("tp"), names.join(","));
  const off = await page.locator(".pcard.off .pc-name").allInnerTexts();
  assert.ok(off.includes("sizing"), "sizing has no detectable effect");
  // a category is drawn as bars, a number as dots joined in order
  const model = page.locator(".pcard", { has: page.locator(".pc-name", { hasText: /^model$/ }) });
  assert.equal(await model.locator(".plot[data-kind=cat] .bar").count(), 8);
  const tp = page.locator(".pcard", { has: page.locator(".pc-name", { hasText: /^tp$/ }) });
  assert.ok(await tp.locator(".plot[data-kind=num] .pt").count() >= 5);
  assert.equal(await tp.locator(".trend polyline").count(), 1);
  // every card reads the same scale
  const scales = await page.$$eval(".plot-y", ys => ys.map(y => [...y.querySelectorAll(".yl:not(.ref-l)")].map(l => l.textContent).join("|")));
  assert.equal(new Set(scales).size, 1, `scales: ${[...new Set(scales)].join(" / ")}`);
  // no two shown x labels of one card overlap
  const clashes = await page.$$eval(".plot-x", rows => rows.flatMap(row => {
    const rs = [...row.querySelectorAll(".xl")].filter(l => !l.hidden).map(l => l.getBoundingClientRect());
    return rs.flatMap((a, i) => rs.slice(i + 1).filter(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom).map(() => row.closest(".pcard").dataset.focus));
  }));
  assert.deepEqual(clashes, []);
  // where each parameter acts arrives in the background
  await page.waitForSelector(".sc[data-ready=true]", { timeout: 20000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("the strip copies the board as notes", async () => {
  const { page, errors } = await open();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.locator(".strip-copy").click();
  await page.waitForSelector("text=Board copied.");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(text, /Synthetic sweep/);
  assert.match(text, /Moves it \(\d+ of \d+ parameters, q < 0.05\):/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a nested parameter has one name on its card, in the inspector and in the notes, and a row of cards keeps its plots level", async () => {
  const { page, errors } = await open();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const { name, sub } = await page.$eval(".pcard .pc-name[title*=' · ']", n => ({ name: n.title, sub: n.closest(".pcard").querySelector(".pc-sub").textContent }));
  assert.match(name, /^\w+ · \w+$/);
  // the whole name shows, on a second line if it must
  assert.deepEqual(await page.$$eval(".pc-name", ns => ns.filter(n => n.scrollHeight > n.clientHeight + 1).map(n => n.title)), []);
  // where it applies, said the same on its card and in the inspector
  assert.match(sub, /^only when \w+ = \w+ · \d+%$/);
  await page.locator(`.pcard .pc-name[title="${name}"]`).click();
  assert.equal(await page.locator("#inspector h2").innerText(), name);
  assert.ok((await page.locator("#inspector .eyebrow").first().innerText()).endsWith(` · ${sub}`));
  await page.keyboard.press("Escape");
  await page.locator(".strip-copy").click();
  await page.waitForSelector("text=Board copied.");
  const notes = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(notes.includes(name), notes);
  assert.doesNotMatch(notes, /@|\(\w+ = \w+\)/);
  // the cards of a row start their plots at one height
  const tops = await page.$$eval(".pgrid", grids => grids.flatMap(g => {
    const rows = new Map();
    for (const c of g.querySelectorAll(".pcard")) {
      const at = Math.round(c.getBoundingClientRect().top);
      if (!rows.has(at)) rows.set(at, new Set());
      rows.get(at).add(Math.round(c.querySelector(".plot").getBoundingClientRect().top));
    }
    return [...rows.values()].map(s => s.size);
  }));
  assert.ok(tops.length > 1 && tops.every(n => n === 1), `plot tops per row: ${tops.join(",")}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("every view draws without an error", async () => {
  const { page, errors } = await open();
  for (const key of ["2", "3", "4", "5", "6", "7", "1"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    assert.equal(await page.locator("text=This view failed to draw").count(), 0, `view ${key}`);
  }
  await page.keyboard.press("3");
  await page.waitForSelector(".pr-map", { timeout: 20000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("pairs: the strip, the ranked pairs and those drawn together, and a chosen pair with its margins", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("3");
  await page.waitForSelector(".pr-map", { timeout: 20000 });
  const strip = await page.locator(".strip").innerText();
  assert.match(strip, /Interacting pairs\s+\d+\s+of 190/);
  assert.match(strip, /Drawn together\s+1\b/);
  // with no interaction, the pair the sampler drew together opens by
  // itself, named in the same order as in the list, and tagged as the
  // board tags it, in the warning colour
  assert.match(await page.locator(".pr-pair .isl-count").innerText(), /drawn together the most/);
  assert.equal(await page.locator(".pr-pair .tag.warn").count(), 1);
  assert.equal(await page.locator(".pr-row.together").count(), 1);
  assert.equal(await page.locator("#pr-pair-title").innerText(), await page.locator(".pr-row.together .pr-name").innerText());
  // each value's margin and the base close the grid
  assert.equal(await page.locator(".pr-heat th.margin-h").count(), 2);
  assert.equal(await page.locator(".pr-heat td.base-cell").count(), 1);
  // a cell of the map opens its pair, and the address keeps it
  const names = (s) => s.split(" × ").map(x => x.trim()).sort().join(" ");
  const cell = page.locator(".pr-map td.cell:not(.sel)").first();
  const label = await cell.getAttribute("aria-label");
  const want = names(label);
  await cell.click();
  assert.equal(await page.locator("#pr-pair-title").innerText(), label, "a pair is named in one order");
  assert.equal(await page.locator(".pr-map td.cell.sel").count() >= 1, true);
  await page.reload();
  await page.waitForSelector(".pr-map", { timeout: 20000 });
  assert.equal(names(await page.locator("#pr-pair-title").innerText()), want);
  // three at a time: tested in the background, and the size kept by the address
  await page.locator('.pr-size button[aria-label="3 parameters at once"]').click();
  await page.waitForFunction(() => !document.querySelector(".pr-list [role=status]"), null, { timeout: 30000 });
  assert.match(await page.locator(".strip").innerText(), /Interacting triples\s+\d+\s+of [\d,]+ tested/);
  assert.match(await page.locator(".pr-list").innerText(), /Every triple of the \d+ strongest parameters: [\d,]+ triples; [\d,]+ tested, [\d,]+ too sparse/);
  // a triple opens as the grid of two for each value of the third
  await page.locator(".pr-list .pr-row").first().click();
  assert.equal((await page.locator("#pr-pair-title").innerText()).split(" × ").length, 3);
  assert.ok(await page.locator(".pr-facet").count() >= 2);
  assert.ok(await page.locator(".pr-map td.cell.in-set").count() >= 1);
  await page.reload();
  await page.waitForSelector(".pr-facet", { timeout: 30000 });
  assert.equal(await page.locator('.pr-size button[aria-pressed="true"]').innerText(), "3");
  assert.deepEqual(errors, []);
  await page.close();
});

test("pairs of three: when none acts, the closest, each meter against the strongest of them", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("3");
  await page.waitForSelector(".pr-map", { timeout: 20000 });
  await page.locator(".pr-size button", { hasText: /^3$/ }).click();
  await page.waitForSelector(".pr-row.quiet", { timeout: 60000 });
  const rows = await page.$$eval(".pr-row.quiet", rs => rs.map(r => ({
    width: parseFloat(r.querySelector(".pr-meter i").style.width),
    omega: parseFloat(r.querySelector(".pr-fig").textContent.replace(/[^\d.]/g, "")) })));
  assert.ok(rows.length >= 2, JSON.stringify(rows));
  // no meter runs past its track, and the full ones are the strongest
  assert.ok(rows.every(r => r.width <= 100), JSON.stringify(rows));
  const full = rows.filter(r => r.width === 100);
  assert.ok(full.length >= 1 && full.every(r => r.omega === Math.max(...rows.map(x => x.omega))), JSON.stringify(rows));
  assert.deepEqual(errors, []);
  await page.close();
});

test("a card opens in the inspector and a value goes into the pocket", async () => {
  const { page, errors } = await open();
  await page.locator(".pcard .pc-name", { hasText: /^model$/ }).click();
  await page.waitForSelector("#inspector .part");
  const parts = await page.locator("#inspector .part h3").allInnerTexts();
  assert.deepEqual(parts, ["Attributes", "Where it acts", "Values", "How the estimates settled"]);
  // a value chosen on the card is chosen in the table
  await page.locator(".pcard", { has: page.locator(".pc-name", { hasText: /^model$/ }) }).locator(".col[data-key=xgb_tuned]").click();
  assert.equal(await page.locator("#inspector table.vals tr.sel td.v").innerText(), "xgb_tuned");
  // the chosen value, clicked again on the card, closes the inspector, and so does the card
  const modelCard = page.locator(".pcard", { has: page.locator(".pc-name", { hasText: /^model$/ }) });
  await modelCard.locator(".col[data-key=xgb_tuned]").click();
  assert.equal(await page.evaluate(() => document.getElementById("app").dataset.insp), "closed");
  await modelCard.locator(".pc-name").click();
  assert.equal(await page.evaluate(() => document.getElementById("app").dataset.insp), "open");
  await modelCard.locator(".pc-name").click();
  assert.equal(await page.evaluate(() => document.getElementById("app").dataset.insp), "closed");
  await modelCard.locator(".pc-name").click();
  await page.waitForSelector("#inspector .part");
  await page.locator("#inspector table.vals tbody tr", { hasText: "xgb_def" }).click();
  await page.keyboard.press("p");
  await page.keyboard.press("2");
  await page.waitForSelector(".stack .brick");
  assert.match(await page.locator(".stack .brick").first().innerText(), /model = xgb_def/);
  // the strip leads with the needle inside the pocket, a rate here
  assert.match(await page.locator(".strip .sc").first().innerText(), /%/);
  // a sweep without a manifest has no manifest at its foot
  assert.equal(await page.locator(".manifest").count(), 0);
  // a pinned pocket is kept in the address, as every other choice is
  await page.locator("button", { hasText: "Pin to compare" }).click();
  await page.waitForSelector("#pin-title");
  await page.reload();
  await page.waitForSelector("#pin-title");
  assert.match(await page.locator("#pin-title").innerText(), /pinned pocket/);
  // and it says which blocks it holds
  assert.equal(await page.locator(".pin-blocks").innerText(), "Pinned: model = xgb_def");
  // a set's members stand together under the set, as on the board
  const feats = page.locator(".pal-item", { has: page.locator(".pal-name", { hasText: /^feats$/ }) });
  assert.equal(await feats.count(), 1);
  assert.ok(await feats.locator(".vchip").count() >= 10);
  assert.deepEqual(errors, []);
  await page.close();
});

test("trials: a strip, and column sets that toggle, join the table under their names and stay", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("5");
  await page.waitForSelector(".tr-island table.trials");
  const strip = await page.locator(".strip").innerText();
  for (const k of ["Best row", "Like the best", "Luck line", "Clear of luck", "Since the best", "Rows"]) assert.match(strip, new RegExp(k));
  // the plate sweep records every set: seven toggles, the movers on
  assert.deepEqual(await page.locator(".tr-tools [data-cols]").evaluateAll(bs => bs.map(b => b.dataset.cols)),
    ["movers", "rest", "like", "activity", "risk", "skill", "time"]);
  // each toggle says what it is, not only an icon
  assert.deepEqual(await page.locator(".tr-tools [data-cols]").allInnerTexts(),
    ["Movers", "Other parameters", "Rows like it", "Activity", "Risk", "Model skill", "Run time"]);
  assert.deepEqual(await page.locator(".tr-tools [aria-pressed=true]").evaluateAll(bs => bs.map(b => b.dataset.cols)), ["movers"]);
  const groups = () => page.locator("table.trials th.grp:not(.blank)").allInnerTexts();
  assert.deepEqual(await groups(), ["Movers"]);
  // more than one at once, in the toggles' order whatever the clicks' order
  await page.locator('[data-cols="time"]').click();
  await page.locator('[data-cols="like"]').click();
  assert.deepEqual(await groups(), ["Movers", "Rows like it", "Run time"]);
  assert.match(await page.locator("table.trials thead tr:last-child").innerText(), /Seconds per row/);
  await page.locator('[data-cols="movers"]').click();
  assert.deepEqual(await groups(), ["Rows like it", "Run time"]);
  // the address keeps them
  await page.reload();
  await page.waitForSelector(".tr-island table.trials");
  assert.deepEqual(await page.locator(".tr-tools [aria-pressed=true]").evaluateAll(bs => bs.map(b => b.dataset.cols)), ["like", "time"]);
  // a row opens in the inspector and closes on a second click
  const first = page.locator("table.trials tbody tr").first();
  await first.click();
  assert.equal(await page.evaluate(() => document.getElementById("app").dataset.insp), "open");
  assert.match(await page.locator("#inspector .eyebrow").first().innerText(), /^#1=? by gates, then mean %\/mo$/);
  await first.click();
  assert.equal(await page.evaluate(() => document.getElementById("app").dataset.insp), "closed");
  assert.deepEqual(errors, []);
  await page.close();
});

test("trials: a toggle names itself and its key after half a second of rest", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("5");
  await page.waitForSelector(".tr-tools");
  await page.clock.install();
  await page.locator('[data-cols="like"]').hover();
  await page.clock.runFor(400);
  assert.equal(await page.locator("#tip").isVisible(), false);
  await page.clock.runFor(200);
  assert.equal(await page.locator("#tip").isVisible(), true);
  assert.match(await page.locator("#tip").innerText(), /^Rows like it X\n.+/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("trials on a Limen run: tied rounds share a rank, values as written, the table as notes", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "limen");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("5");
  await page.waitForSelector(".tr-island table.trials");
  assert.match(await page.locator(".tr-island .isl-count").innerText(), /by net PnL per bar$/);
  assert.ok(await page.locator("table.trials td.rk .eq:not(.no)").count() > 0, "no tie is marked");
  // net PnL per bar as Limen wrote it, to 0.1 bps
  const pnl = await page.locator("table.trials tbody tr td:nth-child(3)").allInnerTexts();
  for (const v of pnl) assert.match(v, /^−?\d+\.\d$/, `a row's value ${v}`);
  // Limen records activity, risk, model skill and time: entries are whole
  await page.locator('[data-cols="activity"]').click();
  const head = await page.locator("table.trials thead tr:last-child th").allInnerTexts();
  const at = head.findIndex(x => /^Entries/.test(x));
  assert.ok(at > 0, `no entries column in ${head}`);
  for (const v of await page.locator(`table.trials tbody tr td:nth-child(${at + 1})`).allInnerTexts()) assert.match(v, /^\d+$/);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.locator(".strip-copy").click();
  await page.waitForSelector("text=Best rows copied.");
  const notes = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(notes, /^lightgbm_binary_full · .* by net PnL per bar/);
  assert.match(notes, /\n\| # \| Row \| Net PnL per bar \(bps\) \|.* Entries \|/);
  assert.match(notes, /\n\| 1 \| \d+ \| \d\.\d \|/);
  assert.match(notes, /\nLuck line: .*, the best of 40 rows by noise alone; \d+ rows? clears? it\.$/);
  assert.deepEqual(errors, []);
  await page.close();
});

async function limenPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  return { page, errors };
}

test("gates: the factory sets a gate, the view comes alive, and each gate is a needle", async () => {
  const { page, errors } = await limenPage();
  await page.goto(base + "limen");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("6");
  await page.waitForSelector(".gt-maker");
  // none set: the strip says so, and an empty card says what will come
  assert.match(await page.locator(".strip").innerText(), /none set yet/);
  assert.equal(await page.locator(".gt-ghost").count(), 1);
  // a need on a needle, its rows against it as it is typed
  const maker = page.locator(".gt-maker");
  await page.selectOption(".gt-maker .gt-needle", "backtest_pnl_per_bar_bps");
  await maker.locator('[data-focus="gate-op->"]').click();
  await maker.locator(".gt-need").fill("0");
  assert.match(await maker.locator(".gt-cap").innerText(), /of the rows pass · \d+ of 40$/);
  await maker.locator(".gt-need").press("Enter");
  await page.waitForSelector("article.gt-card");
  assert.deepEqual(await page.locator("article.gt-card .gt-title").allInnerTexts(), ["Net PnL per bar > 0 bps"]);
  assert.match(await page.locator(".strip").innerText(), /Pass every gate[\s\S]*Hardest/);
  assert.equal(await maker.locator(".btn.primary").innerText(), "Already set");
  // a second: what stops the rows that pass the most is at the foot
  await page.selectOption(".gt-maker .gt-needle", "entries");
  await maker.locator('[data-focus="gate-op->="]').click();
  await maker.locator(".gt-need").fill("5");
  await maker.locator(".btn.primary").click();
  await page.waitForFunction(() => document.querySelectorAll("article.gt-card").length === 2);
  assert.equal(await page.locator(".gt-stops").count(), 1);
  // each gate, and every gate together, is a needle
  const needles = await page.$$eval("#target-pick option", os => os.map(o => o.textContent));
  for (const n of ["Net PnL per bar > 0 bps", "Entries ≥ 5", "Passes every gate", "Gates passed"]) assert.ok(needles.includes(n), n);
  // the address keeps them
  await page.reload();
  await page.waitForSelector("article.gt-card");
  assert.equal(await page.locator("article.gt-card").count(), 2);
  // editing a need changes the gate, not its place
  await page.locator("article.gt-card", { hasText: "Net PnL per bar > 0 bps" }).getByRole("button", { name: "Edit" }).click();
  await page.locator(".gt-maker .gt-need").fill("0.1");
  await page.locator(".gt-maker").getByRole("button", { name: "Save" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll("article.gt-card .gt-title")].some(t => t.textContent === "Net PnL per bar > 0.1 bps"));
  assert.deepEqual(await page.locator("article.gt-card .gt-title").allInnerTexts(), ["Net PnL per bar > 0.1 bps", "Entries ≥ 5"]);
  // what moves a gate: the board on it
  await page.locator("article.gt-card", { hasText: "Entries ≥ 5" }).getByRole("button", { name: "What moves it" }).click();
  await page.waitForSelector(".pcard");
  assert.equal(await page.locator(".view h1").innerText(), "What moves Entries ≥ 5");
  // removed, the factory is empty again, and the needle that was a gate goes too
  await page.keyboard.press("6");
  await page.waitForSelector("article.gt-card");
  for (let k = 0; k < 2; k++) await page.locator("article.gt-card").first().getByRole("button", { name: "Remove" }).click();
  await page.waitForSelector(".gt-ghost");
  assert.equal(await page.locator("#target-pick").inputValue(), "backtest_pnl_per_bar_bps");
  assert.deepEqual(errors, []);
  await page.close();
});

test("gates: one that cannot be read says why, and goes on request", async () => {
  const { page, errors } = await limenPage();
  // the address can hold any JSON; odd values are told, never thrown on
  const odd = { toString: null };
  const g = [{ id: "g1", target: "nope", op: ">=", value: 1 }, { id: "g2", target: "backtest_pnl_per_bar_bps", op: ">=", value: odd },
    { id: "g3", target: "backtest_pnl_per_bar_bps", op: odd, value: 1 }, null];
  const token = "s1." + Buffer.from(JSON.stringify({ v: "gates", g })).toString("base64url");
  await page.goto(`${base}limen#${token}`);
  await page.waitForSelector(".gt-problem");
  assert.equal(await page.locator(".gt-problem").count(), 4);
  assert.match(await page.locator(".gt-problem").first().innerText(), /It was set as nope ≥ 1, and this run has no needle nope\./);
  assert.match(await page.locator(".gt-problem").nth(1).innerText(), /its need is not a number/);
  for (let k = 4; k > 0; k--) {
    await page.locator(".gt-problem").first().getByRole("button", { name: "Remove" }).click();
    await page.waitForFunction(n => document.querySelectorAll(".gt-problem").length === n, k - 1);
  }
  await page.waitForSelector(".gt-ghost");
  assert.deepEqual(errors, []);
  await page.close();
});

test("run: a sweep with no groups gets its strip, every row's distributions and no clusters", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("7");
  await page.waitForSelector(".rn-card");
  assert.match(await page.locator(".strip").innerText(), /Rows\s+6,000/);
  // the rows of the synthetic sweep do not fall into groups: none is drawn, and the page says why
  await page.waitForFunction(() => (document.querySelector(".rn-pick .isl-count") || {}).textContent === "none", null, { timeout: 20000 });
  assert.match(await page.locator(".rn-pick .isl-note").innerText(), /do not fall into groups: the best grouping \(\d clusters\) has a silhouette of 0\.\d\d, under 0\.26/);
  assert.match(await page.locator(".strip").innerText(), /Clusters\s+0\s+the rows do not group/);
  assert.equal(await page.locator(".rn-chip").count(), 0);
  // a card per outcome, the needle first, every row in one colour
  const names = await page.locator(".rn-card .rn-name").allInnerTexts();
  assert.equal(names[0], "Tradeable");
  assert.ok(names.length >= 8, names.join(", "));
  // the axes print values as the rows have them: a whole number whole, a 0/1 outcome no or yes
  const ticks = id => page.locator(`.rn-card[data-outcome="${id}"] svg text.label:not(.ink)`).allTextContents();
  const gates = await ticks("gates");
  assert.ok(gates.length >= 3 && gates.every(t => /^\d+$/.test(t)), gates.join(" "));
  assert.deepEqual(await ticks("tradeable"), ["no", "yes"]);
  assert.equal(await page.locator(".rn-legend").innerText(), "All rows · 6,000 rows");
  assert.equal(await page.locator(".rn-diff").count(), 0);
  for (const label of ["Best so far against luck", "Pace", "Problems", "The sampler"]) {
    assert.equal(await page.locator(`section[aria-label="${label}"]`).count(), 1, label);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test("charts are drawn at their box's width, so their text is the small size at any width, and a row of cards keeps its charts level", async () => {
  const { page, errors } = await limenPage();
  await page.goto(base + "limen200");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("7");
  await page.waitForSelector(".rn-card .chart", { timeout: 20000 });
  // every chart: drawn at the width it shows at, its labels at 11 px
  const drawn = () => page.$$eval("svg.chart", svgs => svgs.map(s => ({ w: s.getBoundingClientRect().width, vb: s.viewBox.baseVal.width,
    fs: s.querySelector(".label") ? getComputedStyle(s.querySelector(".label")).fontSize : "11px" })));
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => [...document.querySelectorAll("svg.chart")].every(s => Math.abs(s.getBoundingClientRect().width - s.viewBox.baseVal.width) <= 1));
    const charts = await drawn();
    assert.ok(charts.length >= 8, `charts: ${charts.length}`);
    for (const c of charts) assert.equal(c.fs, "11px");
  }
  // the cards of a row start their charts at one height, however their tags
  // wrap: each row's chart tops, by the row's top
  const rows = await page.$$eval(".rn-grid .rn-card", cards => {
    const by = {};
    for (const c of cards) (by[Math.round(c.getBoundingClientRect().top)] ||= []).push(Math.round(c.querySelector(".chart").getBoundingClientRect().top));
    return by;
  });
  const said = `chart tops by row (900 px wide, ${await page.evaluate(() => document.documentElement.scrollWidth)} px of page): ${JSON.stringify(rows)}`;
  assert.ok(Object.keys(rows).length > 1, said);
  assert.ok(Object.values(rows).every(tops => new Set(tops).size === 1), said);
  assert.deepEqual(errors, []);
  await page.close();
});

test("run: a Limen run's clusters, one against every row, two compared, and another number of them", async () => {
  const { page, errors } = await limenPage();
  await page.goto(base + "limen200");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("7");
  await page.waitForSelector(".rn-chip", { timeout: 20000 });
  const strip = await page.locator(".strip").innerText();
  assert.match(strip, /Rows\s+200/);
  assert.match(strip, /Net PnL per bar\s+−?\d\.\d+ bps\s+median 0\.0 bps/);
  assert.match(strip, /Clusters\s+2\s+silhouette 0\.\d\d, (weak|reasonable)/);
  // two clusters: the rounds that never entered, and the ones that did
  const chips = await page.locator(".rn-chip").allInnerTexts();
  assert.equal(chips.length, 2);
  assert.match(chips[0], /^A\s+\d+\s+\d+%\s+Entries 0/);
  const sizes = chips.map(c => +/^[AB]\s+(\d+)/.exec(c)[1]);
  assert.equal(sizes[0] + sizes[1], 200);
  const cards = page.locator(".rn-card");
  assert.equal(await cards.first().locator(".rn-name").innerText(), "Net PnL per bar");
  assert.equal(await page.locator(".rn-legend").innerText(), "All rows · 200 rows");
  // A against every row: two groups on each card; the outcomes the clusters
  // are drawn on are said once and never tested, the others are
  await page.locator('.rn-chip[data-cluster="A"]').click();
  await page.waitForSelector(".rn-drawn");
  assert.equal(await page.locator(".rn-legend").innerText(), `A · ${sizes[0]} rows\nAll rows · 200 rows`);
  assert.equal(await cards.first().locator(".dist-box").count(), 2);
  assert.equal(await page.locator('.rn-card[data-outcome="backtest_pnl_per_bar_bps"] .rn-diff').count(), 0);
  assert.match(await page.locator('.rn-card[data-outcome="execution_time"] .rn-diff').innerText(), /q/);
  assert.equal(await page.locator(".rn-apart .isl-title").innerText(), "What sets A apart");
  // a bin where both groups' bars break says their shares once, in the
  // order the bars stand, and no two such labels cross
  const cuts = await page.locator(".rn-card svg.dist text.label.ink").allTextContents();
  assert.ok(cuts.some(t => /^\d+% · \d+%$/.test(t)), cuts.join(" | "));
  const crossed = await page.$$eval(".rn-card svg.dist", svgs => svgs.filter(svg => {
    const rs = [...svg.querySelectorAll("text.label.ink")].map(t => t.getBoundingClientRect());
    return rs.some((a, i) => rs.slice(i + 1).some(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  }).map(svg => svg.closest(".rn-card").dataset.outcome));
  assert.deepEqual(crossed, []);
  // Compare: A against B
  await page.locator(".rn-compare").click();
  await page.locator('.rn-chip[data-cluster="B"]').click();
  await page.waitForFunction(() => (document.querySelector(".rn-apart .isl-title") || {}).textContent === "What sets A and B apart");
  assert.equal(await page.locator(".rn-legend").innerText(), `A · ${sizes[0]} rows\nB · ${sizes[1]} rows`);
  // a number whose clusters would hold under 30 rows cannot be chosen; three can
  assert.equal(await page.locator('.rn-k button[data-k="5"]').getAttribute("aria-disabled"), "true");
  // three clusters; with Compare on a third choice replaces the first
  await page.locator('.rn-k button[data-k="3"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".rn-chip").length === 3, null, { timeout: 20000 });
  for (const id of ["A", "B", "C"]) await page.locator(`.rn-chip[data-cluster="${id}"]`).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.rn-chip[aria-pressed="true"]')].map(c => c.dataset.cluster).join() === "B,C");
  // the address keeps the choice
  await page.reload();
  await page.waitForSelector('.rn-chip[aria-pressed="true"]', { timeout: 20000 });
  assert.deepEqual(await page.locator('.rn-chip[aria-pressed="true"]').evaluateAll(cs => cs.map(c => c.dataset.cluster)), ["B", "C"]);
  assert.equal(await page.locator(".rn-compare").getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
  await page.close();
});

test("the needle changes target and the replay edge hides later rows", async () => {
  const { page, errors } = await open();
  await page.selectOption("#target-pick", "mean_mo");
  await page.waitForFunction(() => document.querySelector(".view h1").textContent.includes("Mean month"));
  await page.keyboard.press("Home");
  await page.waitForSelector(".status[data-kind=replay]");
  assert.match(await page.locator(".status").innerText(), /row 0 of 6,000/);
  await page.keyboard.press("]");
  await page.keyboard.press("]");
  assert.match(await page.locator(".status").innerText(), /row 120 of 6,000/);
  await page.keyboard.press("End");
  await page.waitForSelector(".status[data-kind=recorded]");
  assert.deepEqual(errors, []);
  await page.close();
});

test("the cards with no detectable effect fold to their names, and stay folded", async () => {
  const { page, errors } = await open();
  const quiet = page.locator(".board-sec", { has: page.locator(".sec-title", { hasText: "No detectable effect" }) });
  const n = Number(await quiet.locator(".sec-title .count").innerText());
  assert.ok(await quiet.locator(".pcard").count() === n && n > 0);
  await quiet.locator("button", { hasText: "Fold to names" }).click();
  await page.waitForSelector(".board-sec .chips button.chip");
  assert.equal(await quiet.locator(".pcard").count(), 0);
  assert.equal(await quiet.locator(".chips button.chip").count(), n);
  // the address keeps it folded; a name opens its parameter
  await page.reload();
  await page.waitForSelector(".board-sec .chips button.chip");
  await quiet.locator(".chips button.chip", { hasText: /^sizing$/ }).click();
  await page.waitForSelector("#inspector .part");
  assert.equal(await page.locator("#inspector h2").innerText(), "sizing");
  await quiet.locator("button", { hasText: "Show the cards" }).click();
  await page.waitForFunction(() => !document.querySelector(".board-sec .chips button.chip"));
  assert.equal(await quiet.locator(".pcard").count(), n);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the tab names the sweep and the view, under Grid's mark", async () => {
  const { page, errors } = await open();
  assert.equal(await page.title(), "Synthetic sweep · Board — Grid");
  await page.keyboard.press("7");
  await page.waitForFunction(() => document.title === "Synthetic sweep · Run — Grid");
  assert.match(await page.locator("#favicon").getAttribute("href"), /^data:image\/svg\+xml,/);
  // a recording is neither live nor in trouble: the mark has no dot
  assert.doesNotMatch(decodeURIComponent(await page.locator("#favicon").getAttribute("href")), /circle/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("the address keeps the view across a reload", async () => {
  const { page } = await open();
  await page.keyboard.press("6");
  await page.waitForFunction(() => location.hash.startsWith("#s1."));
  await page.reload();
  await page.waitForSelector(".view h1");
  assert.equal(await page.locator(".view h1").innerText(), "Gates");
  await page.close();
});

test("theme toggle and phone width", async () => {
  const { page, errors } = await open(390, 844);
  await page.keyboard.press("d");
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  assert.ok(theme === "dark" || theme === "light");
  for (const key of ["1", "2", "5", "6", "7"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `view ${key} scrolls sideways by ${overflow}px at phone width`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test("a Limen run reads with its manifest's parameters and Limen's metrics", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "limen");
  await page.waitForSelector(".pcard");
  assert.equal(await page.locator(".view h1").innerText(), "What moves Net PnL per bar");
  assert.match(await page.locator(".progress-text").innerText(), /40 rows · 8.0% of 500/);
  const names = await page.locator(".pcard .pc-name").allInnerTexts();
  for (const p of ["take_profit_bps", "stop_loss_bps", "fee_bps", "num_leaves"]) assert.ok(names.includes(p), p);
  assert.ok(!names.includes("_round_index") && !names.includes("auc"));
  // 40 rounds leave most values withheld; one past the scale the shown
  // values set sits on its edge as a triangle pointing past it, never as a dot
  assert.ok(await page.locator(".col:is(.past-hi, .past-lo) .past").count() > 0, "no withheld value lies past the scale");
  assert.equal(await page.locator(".col:is(.past-hi, .past-lo) .pt").count(), 0);
  for (const key of ["2", "3", "4", "5", "6", "7", "1"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    assert.equal(await page.locator("text=This view failed to draw").count(), 0, `view ${key}`);
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test("features on a pool: each member's inclusion, then the needle by the number of members", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("4");
  await page.waitForSelector(".ft-island .legend");
  // the interval's two bounds are one legend entry, and no entry is empty
  assert.deepEqual(await page.locator(".ft-island .legend > span").allInnerTexts(), ["Tradeable", "95% interval"]);
  // the chart's part keeps the gap between parts after the members' table
  const gap = await page.evaluate(() => {
    const isl = document.querySelector(".ft-island");
    return isl.querySelector(":scope > .isl-part").getBoundingClientRect().top - isl.querySelector(":scope > .table-wrap").getBoundingClientRect().bottom;
  });
  assert.ok(gap >= 20, `gap ${gap}`);
  assert.deepEqual(errors, []);
  await page.close();
});

test("features on a Limen run: its groups from the manifest, its dropped columns from the round log", async () => {
  const { page, errors } = await limenPage();
  await page.goto(base + "limen");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("4");
  await page.waitForSelector("#ft-groups");
  const strip = await page.locator(".strip").innerText();
  assert.match(strip, /Best groups[\s\S]*Adding a group[\s\S]*Columns dropped\s+\d+\s+in 33 of 40 rows/);
  // the drawn combinations, each with what it switches on
  const drawn = await page.locator("#ft-groups").locator("xpath=ancestor::section").locator("table").first().innerText();
  assert.match(drawn, /lines\|momentum[\s\S]*lines: price_lines, quantile_price_lines · momentum: roc/);
  assert.match(await page.locator("#ft-groups").locator("xpath=ancestor::section").innerText(), /every row also has cyclical_time_features/);
  // the dropped columns, the roc column named by its parameter where it varies
  const cols = await page.locator("#ft-cols").locator("xpath=ancestor::section").innerText();
  assert.match(cols, /Rows dropping it/);
  assert.match(cols, /fewer than 10 drops/);
  assert.match(cols, /One model over \d+ rows/);
  assert.match(await page.locator("#ft-next").locator("xpath=ancestor::section").innerText(), /keep_columns: \[.*\]\s+drop_columns: \[.*\]/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("features on a sweep that draws subsets: each member's inclusion effect", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("4");
  await page.waitForSelector(".ft-island table");
  assert.match(await page.locator(".strip").innerText(), /Members[\s\S]*Help[\s\S]*Hurt/);
  assert.match(await page.locator(".ft-island").first().innerText(), /Including each of feats/);
  assert.ok(await page.locator(".ft-island").first().locator("tbody tr").count() > 5);
  assert.match(await page.locator("#ft-next").locator("xpath=ancestor::section").innerText(), /always_include: \[/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("on a Limen run, a pocket's blocks are judged and the manifest narrows to them", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base + "limen");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("2");
  await page.waitForSelector(".stack-island .drop");
  assert.match(await page.locator(".strip").innerText(), /Best start/);
  // a value from its chip: a block that says what it does
  await page.locator(".pal-item", { hasText: "use_calibration" }).locator(".vchip", { hasText: /^true$/ }).click();
  await page.waitForSelector(".stack .brick");
  assert.match(await page.locator(".brick .vtag").innerText(), /^(Earns its place|Only narrows|Too few rows to tell|Holds the needle back)$/);
  assert.equal(await page.locator(".vchip[aria-pressed=true]").count(), 1);
  // inside the pocket, adding to it raises no toast pointing to it
  assert.equal(await page.locator(".toast").count(), 0);
  // the manifest at the foot: closed until opened, then narrowed
  const details = page.locator("details.manifest");
  assert.equal(await details.evaluate(d => d.open), false);
  await page.locator("details.manifest > summary").click();
  assert.match(await page.locator("details.manifest > summary").innerText(), /lightgbm_binary_full\.yaml[\s\S]*narrowed to the pocket · 1 parameter/);
  assert.deepEqual((await page.locator(".mf-line.changed").allInnerTexts()).map(s => s.trim()), ["use_calibration: [true]  # was [true, false]"]);
  // the chip takes the value out again; the manifest stays open, as run
  await page.locator(".vchip[aria-pressed=true]").click();
  await page.waitForSelector(".stack .drop");
  assert.match(await page.locator("details.manifest > summary").innerText(), /as run/);
  assert.equal(await details.evaluate(d => d.open), true, "the manifest closed on a redraw");
  assert.equal(await page.locator(".mf-line.changed").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a Limen round replays with Limen's Trainer, its board has no dead values, and the views' own controls have keys", async () => {
  const { page, errors } = await limenPage();
  await page.goto(base + "limen");
  await page.waitForSelector(".pcard");
  // a value is dead by its rate: a continuous needle's strip has no such figure
  assert.doesNotMatch(await page.locator(".strip").innerText(), /Dead values/);
  await page.keyboard.press("5");
  await page.locator("table.trials tbody tr").first().click();
  await page.waitForSelector("#inspector .code-head");
  const replay = await page.locator("#inspector pre.code").first().innerText();
  assert.match(replay, /^from limen\.inference import Trainer\n\ntrainer = Trainer\(".*limen_run"\)\nsensor, = trainer\.train\(\["[0-9a-f]{64}"\]\)$/);
  await page.keyboard.press("Escape");
  // N takes the focus to a new gate's needle
  await page.keyboard.press("6");
  await page.waitForSelector(".gt-needle");
  await page.keyboard.press("n");
  assert.ok(await page.evaluate(() => document.activeElement.classList.contains("gt-needle")));
  await page.keyboard.press("Escape");
  // M turns Compare two on, on the Run view
  await page.goto(base + "limen200");
  await page.waitForSelector(".pcard");
  await page.keyboard.press("7");
  await page.waitForSelector(".rn-compare", { timeout: 20000 });
  await page.keyboard.press("m");
  await page.waitForFunction(() => document.querySelector(".rn-compare").getAttribute("aria-pressed") === "true");
  assert.deepEqual(errors, []);
  await page.close();
});

test("S chooses the next number of parameters at once on Pairs, and X reaches Trials' column toggles", async () => {
  const { page, errors } = await open();
  // X reaches the toggles; the arrows move between them, Space turns one on
  await page.keyboard.press("5");
  await page.waitForSelector(".tr-tools");
  await page.keyboard.press("x");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.cols), "movers");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.cols), "rest");
  await page.keyboard.press(" ");
  await page.waitForFunction(() => document.querySelector('[data-cols="rest"]').getAttribute("aria-pressed") === "true");
  await page.keyboard.press("3");
  await page.waitForSelector(".pr-map", { timeout: 20000 });
  await page.keyboard.press("s");
  await page.waitForFunction(() => document.querySelector('.pr-size [aria-pressed="true"]').textContent === "3");
  await page.keyboard.press("Shift+S");
  await page.waitForFunction(() => document.querySelector('.pr-size [aria-pressed="true"]').textContent === "2");
  assert.deepEqual(errors, []);
  await page.close();
});

test("nothing covers what it should not: the reference opens beside the rail, the inspector beside the view", async () => {
  const { page, errors } = await open(1100, 800);
  await page.locator(".pcard .pc-name").first().click();
  await page.waitForSelector("#inspector .part");
  // the strip's tools are in reach with the inspector open
  for (const sel of [".strip [data-info]", ".strip-copy"]) {
    const hit = await page.$eval(sel, el => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && el.contains(at); });
    assert.ok(hit, `${sel} is covered`);
  }
  // and the rail with the reference open
  await page.keyboard.press("i");
  await page.waitForSelector("#reference:not([hidden])");
  const railHit = await page.$eval('.rail button[aria-label="Pairs"]', el => { const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!at && el.contains(at); });
  assert.ok(railHit, "the rail is covered by the reference");
  assert.deepEqual(errors, []);
  await page.close();
});

test("a view's blurb opens on a click, or after five seconds on its (i)", async () => {
  const { page, errors } = await open();
  await page.clock.install();
  const info = page.locator(".strip [data-info]");
  const pop = page.locator("#info-pop");
  await info.click();
  assert.equal(await pop.isVisible(), true);
  assert.match(await pop.innerText(), /^What moves/);
  assert.equal(await info.getAttribute("aria-expanded"), "true");
  await info.click();
  assert.equal(await pop.isVisible(), false, "a second click closes it");
  await info.click();
  await page.keyboard.press("Escape");
  assert.equal(await pop.isVisible(), false, "Escape closes it");
  assert.equal(await page.locator(".pcard").count() > 0, true, "Escape closed only the blurb");
  // resting on the (i): nothing at four seconds, the blurb at five
  await info.hover();
  await page.clock.runFor(4000);
  assert.equal(await pop.isVisible(), false);
  await page.clock.runFor(1200);
  assert.equal(await pop.isVisible(), true);
  // what the mouse opened closes when the mouse leaves
  await page.mouse.move(700, 700);
  await page.clock.runFor(500);
  assert.equal(await pop.isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

// A live sweep for the duration of one test: its page URL and a stop.
async function liveSweep() {
  const live = mkdtempSync(join(tmpdir(), "grid-live-"));
  const proc = spawn("python3", ["tools/live_demo.py", "--out", live, "--port", "0", "--rate", "20"], { cwd: ROOT });
  const url = await serverUrl(proc);
  return { url, stop: () => proc.kill() };
}

// The page's address, as a server just started prints it.
function serverUrl(proc) {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no server line: ${out}`)), 20000);
    proc.stdout.on("data", d => { out += d; const m = /at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.stderr.on("data", d => { out += d; });
  });
}

const shownRows = page => page.evaluate(() => Number(document.querySelector(".progress-text").textContent.split(" rows")[0].replace(/,/g, "")));

test("live: a Limen run's rounds arrive after its rows, and Features reads them", async () => {
  // the fixture's first 30 rounds, then the last 10 written as limen run
  // writes them: the round's row, then its line in the round log
  const dir = mkdtempSync(join(tmpdir(), "grid-limen-live-"));
  const fx = join(ROOT, "tests/fixtures/limen_run");
  const csv = readFileSync(join(fx, "results.csv"), "utf8").trimEnd().split("\n");
  const rounds = readFileSync(join(fx, "round_data.jsonl"), "utf8").trimEnd().split("\n");
  writeFileSync(join(dir, "results.csv"), csv.slice(0, 31).join("\n") + "\n");
  writeFileSync(join(dir, "round_data.jsonl"), rounds.slice(0, 30).join("\n") + "\n");
  for (const name of ["metadata.json", "lightgbm_binary_full.yaml"]) copyFileSync(join(fx, name), join(dir, name));
  const proc = spawn("python3", ["-m", "grid", "serve", "--limen", dir, "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".pcard");
    await page.keyboard.press("4");
    await page.waitForSelector("#ft-cols");
    assert.match(await page.locator(".strip").innerText(), /in \d+ of 30 rows/);
    for (let k = 30; k < 40; k++) {
      appendFileSync(join(dir, "results.csv"), csv[k + 1] + "\n");
      appendFileSync(join(dir, "round_data.jsonl"), rounds[k] + "\n");
    }
    await page.waitForFunction(() => /in 33 of 40 rows/.test(document.querySelector(".strip").textContent), null, { timeout: 20000 });
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("live: several result directories of one manifest read as one run, live while any is written", async () => {
  // the fixture's rounds in two directories, as two limen run side by
  // side with different search seeds write them; the second still running
  const runs = mkdtempSync(join(tmpdir(), "grid-shards-"));
  const fx = join(ROOT, "tests/fixtures/limen_run");
  const csv = readFileSync(join(fx, "results.csv"), "utf8").trimEnd().split("\n");
  const rounds = readFileSync(join(fx, "round_data.jsonl"), "utf8").trimEnd().split("\n");
  const meta = JSON.parse(readFileSync(join(fx, "metadata.json"), "utf8"));
  const make = (name, from, to, seed) => {
    const d = join(runs, name);
    mkdirSync(d);
    writeFileSync(join(d, "results.csv"), [csv[0], ...csv.slice(from + 1, to + 1)].join("\n") + "\n");
    writeFileSync(join(d, "round_data.jsonl"), rounds.slice(from, to).join("\n") + "\n");
    const m = structuredClone(meta);
    m.yaml_reference.uel.search_strategy.seed = seed;
    writeFileSync(join(d, "metadata.json"), JSON.stringify(m));
    copyFileSync(join(fx, "lightgbm_binary_full.yaml"), join(d, "lightgbm_binary_full.yaml"));
    return d;
  };
  const a = make("a", 0, 20, 1), b = make("b", 20, 39, 2);
  const proc = spawn("python3", ["-m", "grid", "serve", "--limen", runs, "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".pcard");
    await page.waitForFunction(() => document.querySelector(".progress-text").textContent.startsWith("39 rows"), null, { timeout: 20000 });
    // each row's directory is a parameter, so the board and the checks on
    // how parameters were drawn cover it
    assert.ok((await page.locator(".pcard .pc-name").allInnerTexts()).includes("shard"));
    // live while any of them is written
    appendFileSync(join(b, "results.csv"), csv[40] + "\n");
    appendFileSync(join(b, "round_data.jsonl"), rounds[39] + "\n");
    await page.waitForFunction(() => document.querySelector(".progress-text").textContent.startsWith("40 rows"), null, { timeout: 20000 });
    // a round replays from its own directory
    await page.keyboard.press("5");
    await page.locator("table.trials tbody tr").first().click();
    await page.waitForSelector("#inspector .code-head");
    const replay = await page.locator("#inspector pre.code").first().innerText();
    assert.ok([a, b].some(d => replay.includes(`Trainer(${JSON.stringify(d)})`)), replay);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("live: a run that stopped before the server started reads quiet at once, and live when a row arrives", async () => {
  // a results file last written an hour ago: its rows are read at the
  // start, with no arrival of their own
  const stopped = mkdtempSync(join(tmpdir(), "grid-stopped-"));
  const path = join(stopped, "results.jsonl");
  const rows = readFileSync(join(dir, "results.jsonl"), "utf8").split("\n");
  writeFileSync(path, rows.slice(0, 400).join("\n") + "\n");
  const hourAgo = Date.now() / 1000 - 3600;
  utimesSync(path, hourAgo, hourAgo);
  const proc = spawn("python3", ["-m", "grid", "serve", "--results", path, "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".pcard");
    // quiet once the stream is open (until then the pill says Reconnecting)
    const pill = page.locator(".sweep-line .status");
    await page.waitForFunction(() => document.querySelector(".sweep-line .status").dataset.kind !== "down", null, { timeout: 20000 });
    assert.equal(await pill.getAttribute("data-kind"), "quiet");
    assert.match(await pill.innerText(), /last row 6\d min ago/);
    // the Run view says when the last row was written
    await page.keyboard.press("7");
    await page.waitForSelector(".stat .k");
    assert.ok((await page.locator(".stat .k").allInnerTexts()).includes("Last row written"));
    appendFileSync(path, rows[400] + "\n");
    await page.waitForFunction(() => document.querySelector(".sweep-line .status").dataset.kind === "live", null, { timeout: 20000 });
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("live: a Limen run with its model outputs sets apart the rounds that never traded", async () => {
  const run = limenOutputsRun(join(mkdtempSync(join(tmpdir(), "grid-outputs-")), "run"));
  const proc = spawn("python3", ["-m", "grid", "serve", "--limen", run, "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".pcard");
    // best_iteration is no card, and a fit diagnostic among the needles
    assert.ok(!(await page.locator(".pcard .pc-name").allInnerTexts()).includes("best_iteration"));
    const diagnostics = await page.$$eval('#target-pick optgroup[label="Fit diagnostics"] option', os => os.map(o => o.textContent));
    for (const name of ["Boosting iterations used", "Highest probability over the threshold", "Bars within reach of the threshold"]) {
      assert.ok(diagnostics.includes(name), `${name} in ${diagnostics.join(", ")}`);
    }
    await page.keyboard.press("7");
    const island = page.locator('section[aria-label="Rounds that never traded"]');
    await island.waitFor({ timeout: 20000 });
    assert.equal(await island.locator(".isl-count").innerText(), "14 of 40 rounds");
    const ks = await island.locator(".stat .k").allInnerTexts();
    assert.deepEqual(ks, ["Held back by the threshold", "Found nothing", "Short of the threshold", "Within reach"]);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("live: a Limen run with its execution has trades, timing, Grid's gates and the test window's halves", async () => {
  const run = limenExecutionRun(join(mkdtempSync(join(tmpdir(), "grid-execution-")), "run"));
  const proc = spawn("python3", ["-m", "grid", "serve", "--limen", run, "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".pcard");
    // the needles a round's bars give, and Grid's gates on them
    const options = async label => page.$$eval(`#target-pick optgroup[label="${label}"] option`, os => os.map(o => o.textContent));
    const outcomes = await options("Outcome");
    for (const name of ["Entries", "Mean trade", "Per-trade t", "Timing per bar"]) assert.ok(outcomes.includes(name), `${name} in ${outcomes.join(", ")}`);
    assert.deepEqual(await options("Gates passing"), ["Entries ≥ 30", "Per-trade t ≥ 2"]);
    // the board counts an effect only in both halves; each value's half
    // means sit beside its mark
    assert.match(await page.locator(".strip").innerText(), /Not in both halves/);
    assert.match(await page.locator(".board-sec .sec-title").first().innerText(), /in both halves/i);
    assert.ok(await page.locator(".pcard .col .hm").count() > 0);
    // Trials sets each row's first-half rank against its halves
    await page.keyboard.press("5");
    await page.waitForSelector(".tr-island table.trials");
    assert.match(await page.locator(".strip").innerText(), /Lead kept/);
    assert.equal(await page.locator('[data-cols="halves"]').getAttribute("aria-pressed"), "true");
    const head = await page.locator("table.trials thead tr:last-child").innerText();
    for (const k of ["Rank, first half", "First half", "Second half"]) assert.match(head, new RegExp(k));
    // 200 rows: too few for tenths of 30
    assert.match(await page.locator('section[aria-labelledby="tr-halves"]').innerText(), /Under 300 rows/);
    // Gates: Grid's two, beside a new one
    await page.keyboard.press("6");
    await page.waitForSelector("article.gt-card");
    assert.deepEqual(await page.locator("article.gt-card .gt-title").allInnerTexts(), ["Entries ≥ 30", "Per-trade t ≥ 2"]);
    assert.equal(await page.locator("article.gt-card .tag", { hasText: "Grid's" }).count(), 2);
    // Run: the reliability, and the market and the needles on each half
    await page.keyboard.press("7");
    const halves = page.locator("#rn-halves");
    await halves.waitFor();
    assert.match(await page.locator(".strip").innerText(), /Reliability/);
    assert.deepEqual(await halves.locator(".stat .k").allInnerTexts(), ["The market, first half", "The market, second half"]);
    assert.ok((await halves.locator("tbody tr").count()) >= 8);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

// Wait until more rows are on screen than now, then one more redraw.
async function moreRows(page, by = 30) {
  const n = await shownRows(page);
  await page.waitForFunction(([want]) => Number(document.querySelector(".progress-text").textContent.split(" rows")[0].replace(/,/g, "")) >= want, [n + by], { timeout: 20000 });
  await page.waitForTimeout(1500);
}

test("live: arriving rows leave the reader's controls alone", async () => {
  const sweep = await liveSweep();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(sweep.url);
    await page.waitForSelector(".status[data-kind=live]", { timeout: 15000 });
    await page.waitForSelector(".pcard");
    // the needle select: the same element and options, still focused
    const select = await page.$("#target-pick");
    const option = await page.$("#target-pick option");
    await select.focus();
    await moreRows(page);
    assert.equal(await select.evaluate(el => el.isConnected && document.activeElement === el), true, "the needle select was replaced or lost focus");
    assert.equal(await option.evaluate(el => el.isConnected), true, "the needle options were rebuilt");
    // the cards keep their places while rows arrive
    const places = () => page.$$eval(".pcard", cs => cs.map(c => c.dataset.focus).join(" "));
    const before = await places();
    await moreRows(page);
    assert.equal(await places(), before, "the cards moved while rows arrived");
    // the board's blurb stays open, on the (i) the redraw made
    await page.locator(".strip [data-info]").click();
    await moreRows(page);
    assert.equal(await page.locator("#info-pop").isVisible(), true, "the blurb closed when rows arrived");
    assert.equal(await page.locator(".strip [data-info]").getAttribute("aria-expanded"), "true");
    await page.keyboard.press("Escape");
    // the inspector keeps its scroll while the same parameter is open
    await page.locator(".pcard .pc-name", { hasText: /^model$/ }).click();
    await page.waitForSelector("#inspector .part");
    const scrolled = await page.evaluate(() => { const el = document.getElementById("inspector"); el.scrollTop = 400; return el.scrollTop; });
    assert.ok(scrolled > 0, "the inspector has room to scroll");
    await moreRows(page);
    assert.equal(await page.evaluate(() => document.getElementById("inspector").scrollTop), scrolled);
    // the pocket's search keeps what was typed, its focus and its caret
    await page.keyboard.press("Escape");
    await page.keyboard.press("2");
    await page.locator("input[data-search]").click();
    await page.keyboard.type("lea");
    await page.keyboard.press("ArrowLeft");
    await moreRows(page);
    assert.deepEqual(await page.evaluate(() => { const el = document.activeElement; return [el.dataset.focus, el.value, el.selectionStart]; }), ["pocket-search", "lea", 2]);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    sweep.stop();
  }
});

test("live: rows stream in from a running sweep", async () => {
  const sweep = await liveSweep();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(sweep.url);
    await page.waitForSelector(".status[data-kind=live]", { timeout: 15000 });
    const first = await shownRows(page);
    await moreRows(page, 1);
    assert.ok(await shownRows(page) > first);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    sweep.stop();
  }
});


test("live: the Run view's cards keep drawing as rows arrive after the clusters were found", async () => {
  const sweep = await liveSweep();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    // a chart drawn on an outcome of fewer rows than are on screen has NaN coordinates
    page.on("console", m => { if (m.type() === "error" && /NaN/.test(m.text())) errors.push(m.text()); });
    await page.goto(sweep.url);
    await page.waitForSelector(".status[data-kind=live]", { timeout: 15000 });
    await page.keyboard.press("7");
    await page.waitForFunction(() => { const c = document.querySelector(".rn-pick .isl-count"); return !!c && c.textContent !== "being found"; }, null, { timeout: 30000 });
    await moreRows(page);
    const blank = await page.$$eval(".rn-card", cards => cards.filter(c => !c.querySelector("svg.dist g.has-tip rect")).map(c => c.dataset.outcome));
    assert.deepEqual(blank, []);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    sweep.stop();
  }
});

test("live: a relaunch keeps the reader on the rows they had, and the Run view tells what happened", async () => {
  const sweep = await liveSweep();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(sweep.url);
    await page.waitForSelector(".status[data-kind=live]", { timeout: 15000 });
    assert.match(await page.title(), /^Synthetic sweep · Board — Grid$/);
    // the demo crashes 900 rows in and relaunches, its results file started over
    await page.waitForFunction(() => document.querySelectorAll("#run-pick option").length === 2, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const kept = await page.$eval("#run-pick", s => s.value);
    assert.match(kept, /^r0\.g\d+$/, "the page stays on the rows it had");
    assert.ok(await shownRows(page) >= 3900, "the rows kept are all there");
    assert.match(await page.locator(".status").innerText(), /archived/i);
    assert.match(await page.$eval("#run-pick", s => s.selectedOptions[0].textContent), /· until \d\d:\d\d$/);
    // the Run view lists what the toasts said
    await page.keyboard.press("7");
    await page.waitForSelector(".rn-told");
    const told = await page.locator(".rn-told").innerText();
    assert.match(told, /A run crashed\./);
    assert.match(told, /started over\./);
    // and follows the run from its first new row
    await page.locator(".rn-told .issue.go", { hasText: "started over" }).click();
    await page.waitForFunction(() => document.querySelector("#run-pick").value === "r0");
    await page.waitForSelector(".status[data-kind=live]", { timeout: 15000 });
    // the first rows of the new run each set a record; none is told until it has rows to rank
    assert.ok(await page.locator(".toast", { hasText: "New best row" }).count() <= 1);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    sweep.stop();
  }
});

test("experiment: on a Limen project, one is made, checked as it is typed, run in shards, analyzed, and the next made from its run", async () => {
  // a project with no experiment yet, served with a stand-in limen
  const project = mkdtempSync(join(tmpdir(), "grid-project-"));
  writeFileSync(join(project, "limen.toml"), "[store]\n");
  mkdirSync(join(project, "manifests"));
  const proc = spawn("python3", ["-m", "grid", "serve", "--project", project, "--limen-cli", join(ROOT, "tests/fixtures/fake_limen.py"), "--port", "0"],
    { cwd: ROOT, env: { ...process.env, FAKE_LIMEN_PACE: "0.05" } });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    // it opens on the Experiment view, ready to make the first
    await page.waitForSelector(".ex-make");
    assert.equal(await page.locator(".rail button[aria-current=page]").getAttribute("aria-label"), "Experiment");
    assert.match(await page.locator(".strip").innerText(), /Limen\s+5\.20\.0/);
    assert.equal(await page.locator(".ex-make select").inputValue(), "t:lightgbm_binary");
    // the other views have no run to show yet
    await page.keyboard.press("1");
    await page.waitForSelector("text=No run is open yet.");
    await page.keyboard.press("0");
    await page.locator(".ex-make input").fill("first");
    await page.locator(".ex-make .btn.primary").click();
    // its manifest, checked by limen validate as it is typed
    await page.waitForSelector(".ex-status .sev.ok");
    assert.match(await page.locator(".ex-status").innerText(), /Valid · 45 parameters, 3\.76 × 10¹⁸ combinations/);
    await page.locator(".ed-text").evaluate(t => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
    await page.keyboard.type("# BAD_VALUE\n");
    await page.waitForSelector(".ex-status .sev.crit");
    const line = await page.evaluate(() => document.querySelector(".ed-text").value.split("\n").findIndex(l => l.trim().startsWith("n_permutations:")) + 1);
    assert.equal(await page.locator(".ed-gutter .bad").innerText(), String(line));
    assert.match(await page.locator(".ex-problems li").innerText(), new RegExp(`Line ${line}\\s+uel\\.n_permutations\\s+'n_permutations' must be a int`));
    assert.equal(await page.locator(".ex-run-form .btn.primary").isDisabled(), true);
    for (let i = 0; i < "# BAD_VALUE\n".length; i++) await page.keyboard.press("Backspace");
    await page.waitForSelector(".ex-status .sev.ok");
    // run in two shards side by side
    await page.locator("input[aria-label='Rounds']").fill("10");
    await page.locator("input[aria-label='Shards side by side']").fill("2");
    assert.match(await page.locator(".ex-sum").innerText(), /^2 limen runs side by side, 5 rounds each/);
    await page.locator(".ex-run-form .btn.primary").click();
    await page.waitForSelector("text=Started.");
    await page.waitForFunction(() => /Finished/.test((document.querySelector(".ex-runs tbody tr") || {}).textContent || ""), null, { timeout: 30000 });
    // analyzed in the views, both shards' rounds as one run
    await page.waitForFunction(() => { const b = [...document.querySelectorAll(".ex-runs tbody tr:first-child .btn")].find(x => x.textContent === "Analyze"); return b && !b.hasAttribute("aria-disabled"); }, null, { timeout: 30000 });
    await page.locator(".ex-runs tbody tr").first().locator("button", { hasText: "Analyze" }).click();
    await page.waitForSelector(".pcard", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector(".progress-text").textContent.startsWith("10 rows"), null, { timeout: 20000 });
    // the run's manifest starts the next experiment
    await page.locator(".manifest summary").click();
    await page.locator(".mf-acts button", { hasText: "New experiment" }).click();
    await page.waitForSelector(".ex-make");
    assert.equal(await page.locator(".ex-make input").inputValue(), "first_2");
    assert.equal(await page.locator(".ex-make select").inputValue(), "run");
    await page.locator(".ex-make .btn.primary").click();
    await page.waitForSelector(".ex-table tr.sel td:has-text('first_2')");
    await page.waitForSelector(".ex-status .sev.ok");
    // a longer run stops as Limen stops, and resumes from its checkpoints
    await page.locator("input[aria-label='Rounds']").fill("400");
    await page.locator("input[aria-label='Shards side by side']").fill("2");
    await page.locator(".ex-run-form .btn.primary").click();
    const state = (s) => page.waitForFunction(s => (document.querySelector(".ex-runs tbody tr .tag") || {}).textContent === s, s, { timeout: 30000 });
    await state("Running");
    await page.locator(".ex-runs tbody tr").first().locator("button", { hasText: "Stop" }).click();
    await state("Stopped");
    await page.locator(".ex-runs tbody tr").first().locator("button", { hasText: "Resume" }).click();
    await state("Running");
    await page.locator(".ex-runs tbody tr").first().locator("button", { hasText: "Stop" }).click();
    await state("Stopped");
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});
