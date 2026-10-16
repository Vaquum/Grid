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
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
  // a walk-forward run of Limen 5.24, with the reports it writes at the end
  execFileSync("python3", ["-m", "grid", "pack", "--limen", "tests/fixtures/limen_walk_forward", "--out", join(dir, "limenwf.pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "limenwf.pack.json.gz"), "--out", join(dir, "limenwf.html")], { cwd: ROOT, stdio: "ignore" });
  // A known metric whose name is also a cost control, plus scoped fit metrics.
  const contextRun = limenExecutionRun(join(dir, "context-run"));
  const contextCsv = join(contextRun, "results.csv");
  const contextLines = readFileSync(contextCsv, "utf8").trimEnd().split(/\r?\n/);
  writeFileSync(contextCsv, contextLines.map((line, i) => `${line},${i ? "1.25" : "backtest_slippage"}`).join("\n") + "\n");
  execFileSync("python3", ["-m", "grid", "pack", "--limen", contextRun, "--out", join(dir, "context.pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "context.pack.json.gz"), "--out", join(dir, "context.html")], { cwd: ROOT, stdio: "ignore" });
  const paramRows = readFileSync(join(dir, "results.jsonl"), "utf8").trimEnd().split("\n")
    .map((line, i) => JSON.stringify({ ...JSON.parse(line), p: i % 2 ? 2 : 4, q: i % 2 ? 3 : 5 }));
  writeFileSync(join(dir, "parameter-context.jsonl"), paramRows.join("\n") + "\n");
  execFileSync("python3", ["-m", "grid", "pack", "--results", join(dir, "parameter-context.jsonl"), "--out", join(dir, "parameter-context.pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "parameter-context.pack.json.gz"), "--out", join(dir, "parameter-context.html")], { cwd: ROOT, stdio: "ignore" });
  server = createServer(async (req, res) => {
    try {
      const page = req.url.startsWith("/parameter-context") ? "parameter-context.html" : req.url.startsWith("/context") ? "context.html" : req.url.startsWith("/limen200") ? "limen200.html" : req.url.startsWith("/limenwf") ? "limenwf.html"
        : req.url.startsWith("/limen") ? "limen.html" : "demo.html";
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

async function expectContext(page, node, pattern) {
  await node.hover();
  await node.dispatchEvent("pointermove");
  await page.waitForFunction(() => !document.querySelector("#tip").hidden, null, { timeout: 2000 });
  assert.match(await page.locator("#tip").innerText(), pattern);
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
  const clockStart = new Date();
  await page.clock.install({ time: clockStart });
  await page.mouse.move(0, 0);
  await page.clock.pauseAt(new Date(clockStart.getTime() + 5000));
  await page.locator('[data-cols="like"]').hover();
  // Ensure Chromium has delivered the pointer event before advancing fake time.
  await page.locator('[data-cols="like"]').dispatchEvent("pointermove");
  await page.clock.runFor(400);
  assert.equal(await page.locator("#tip").isVisible(), false);
  await page.clock.runFor(200);
  assert.equal(await page.locator("#tip").isVisible(), true);
  assert.match(await page.locator("#tip").innerText(), /^Rows like it X\n.+/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement context waits 500 ms on every hover and cancels on leave or Escape", async () => {
  const { page, errors } = await open();
  await page.waitForSelector(".sc[data-ready=true]");
  const start = new Date();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 5000));
  const label = page.locator(".pc-name").first();
  await label.hover();
  await label.dispatchEvent("pointermove");
  await page.clock.runFor(499);
  assert.equal(await page.locator("#tip").isVisible(), false);
  await page.clock.runFor(1);
  assert.match(await page.locator("#tip").innerText(), /Results grouped by/);
  const axis = page.locator(".pcard").first().locator(".yl.ref-l");
  await axis.hover();
  await axis.dispatchEvent("pointermove");
  assert.equal(await page.locator("#tip").isVisible(), false);
  await page.clock.runFor(499);
  assert.equal(await page.locator("#tip").isVisible(), false);
  await page.clock.runFor(1);
  assert.match(await page.locator("#tip").innerText(), /comparison average of Tradeable/);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#tip").isVisible(), false);
  await label.hover();
  await label.dispatchEvent("pointermove");
  await page.clock.runFor(200);
  await page.mouse.move(0, 0);
  await page.clock.runFor(600);
  assert.equal(await page.locator("#tip").isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

test("trial figures, grouped labels and inspector fields explain their actual metric", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("5");
  await page.waitForSelector("table.trials");
  const column = await page.locator("table.trials thead tr").last().locator("th", { hasText: /^Mean month/ }).evaluate(th => th.cellIndex);
  const metric = page.locator("table.trials tbody tr").first().locator("td").nth(column);
  await metric.hover();
  await page.waitForTimeout(550);
  assert.match(await page.locator("#tip").innerText(), /average monthly return/);
  await page.locator('[data-cols="risk"]').click();
  const group = page.locator("table.trials th.grp", { hasText: /^Risk$/ });
  await group.hover();
  await page.waitForTimeout(550);
  assert.match(await page.locator("#tip").innerText(), /losses and drawdowns/);
  await page.locator("table.trials tbody tr").first().click();
  const field = page.locator("#inspector dt", { hasText: /^Mean month$/ });
  await field.hover();
  await page.waitForTimeout(550);
  assert.equal(await page.locator("#tip").isVisible(), true, "a field scrolled into view keeps its pending hover context");
  assert.match(await page.locator("#tip").innerText(), /average monthly return/);
  await field.locator("xpath=following-sibling::dd[1]").hover();
  await page.waitForTimeout(550);
  assert.match(await page.locator("#tip").innerText(), /average monthly return/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement labels and figures have context throughout the recorded views", async () => {
  const { page, errors } = await open();
  await page.waitForSelector(".sc[data-ready=true]");
  const start = new Date();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 5000));
  const missing = [];
  for (const key of ["1", "2", "3", "4", "5", "6", "7"]) {
    await page.keyboard.press(key);
    await page.clock.runFor(3000);
    const probes = await page.locator(".view").evaluate(root => {
      const seen = new Set(), out = [];
      for (const node of root.querySelectorAll(".num, h2, h3, dt, dd, th, td, .pc-name, .pc-sub, .rn-fig, .chart text")) {
        if (!node.getClientRects().length || node.closest("[hidden], .sr, pre, code") || !node.textContent.trim()) continue;
        if (node.matches("td") && node.querySelector("button") && !node.querySelector(".num")) continue;
        const section = node.closest(".island, .board-sec, .pcard");
        const shape = [section?.getAttribute("aria-labelledby") || section?.querySelector("h2, h3, .pc-name")?.textContent,
          node.tagName, String(node.className), node.matches("td") ? node.cellIndex : node.matches("th, h2, h3, dt, .pc-name") ? node.textContent : ""].join("|");
        if (seen.has(shape)) continue;
        seen.add(shape);
        const id = String(out.length);
        node.dataset.contextProbe = id;
        out.push({ id, text: node.textContent.trim(), shape });
      }
      return out;
    });
    for (const probe of probes) {
      const node = page.locator(`[data-context-probe="${probe.id}"]`);
      if (!await node.count()) continue; // a completed background analysis replaced it
      await page.locator("#app").dispatchEvent("pointerleave");
      await node.dispatchEvent("pointermove");
      await page.clock.runFor(500);
      if (!await page.locator("#tip").isVisible()) missing.push(`${key}: ${probe.shape}: ${probe.text}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement context stays within phone and desktop viewports and follows the active needle", async () => {
  for (const width of [320, 1440]) {
    const { page, errors } = await open(width, 900);
    await page.waitForSelector(".sc[data-ready=true]");
    const figure = page.locator(".strip .sc").first();
    await expectContext(page, figure, /at least 6 gates/);
    await page.selectOption("#target-pick", "mean_mo");
    await expectContext(page, page.locator(".strip .sc").first(), /average monthly return/);
    const box = await page.locator("#tip").boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 900, JSON.stringify(box));
    if (process.env.GRID_CONTEXT_ARTIFACTS) {
      mkdirSync(process.env.GRID_CONTEXT_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: join(process.env.GRID_CONTEXT_ARTIFACTS, `context-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
});

test("measurement context keeps metric scopes distinct in Run, Pocket and the inspector", async () => {
  const { page, errors } = await open();
  await page.goto(base + "context");
  await page.waitForSelector(".pcard");
  await page.selectOption("#target-pick", "backtest_slippage");
  await page.keyboard.press("7");
  await expectContext(page, page.locator('.rn-card[data-outcome="backtest_slippage"] .rn-name'), /quote currency/);
  await page.selectOption("#target-pick", "recall");
  await expectContext(page, page.locator('.rn-card[data-outcome="recall"] .rn-name'), /positive examples/);
  await page.keyboard.press("5");
  await page.locator("table.trials tbody tr").first().click();
  await page.keyboard.press("2");
  await expectContext(page, page.locator("#inspector dt", { hasText: /^Recall$/ }), /positive examples/);
  await expectContext(page, page.locator("#inspector dt", { hasText: /^Recall \(test window\)$/ }), /test bars/);
  await expectContext(page, page.locator("#inspector dt", { hasText: /^Precision$/ }), /examples/);
  await expectContext(page, page.locator("#inspector dt", { hasText: /^Precision \(test window\)$/ }), /test bars/);
  await expectContext(page, page.locator("#inspector dt", { hasText: /^Slippage$/ }), /quote currency/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement context describes a gate's recorded Value as its outcome", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("6");
  await page.selectOption(".gt-needle", "mean_mo");
  await page.locator(".gt-need").fill("2");
  await page.locator(".gt-maker .btn.primary").click();
  await page.keyboard.press("5");
  await page.locator("table.trials tbody tr").first().click();
  const row = page.locator("#inspector table tbody tr", { has: page.locator("td", { hasText: /^Mean month$/ }) });
  await expectContext(page, row.locator("td").nth(1), /average monthly return/);
  assert.doesNotMatch(await page.locator("#tip").innerText(), /parameter value/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement context explains standalone association and p readouts", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("7");
  const reading = page.locator(".view .muted.num").filter({ hasText: /V [\d.].*p [=<]/ }).first();
  await expectContext(page, reading, /0 means no link.*if there were no real difference/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement context distinguishes interactions from one parameter's effect", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("3");
  await expectContext(page, page.locator(".pr-figs .num").filter({ hasText: /ω²/ }).first(), /together.*beyond.*separate effects/);
  assert.doesNotMatch(await page.locator("#tip").innerText(), /on its own/);
  assert.deepEqual(errors, []);
  await page.close();
});

test("measurement context treats selected p and q settings as parameters", async () => {
  const { page, errors } = await open();
  await page.goto(base + "parameter-context");
  await page.waitForSelector(".pcard");
  for (const [name, value] of [["p", 2], ["q", 3]]) {
    await page.locator(`.pcard[data-dim="${name}"] .col[data-key="${value}"]`).click();
    const selected = page.locator("#inspector .muted", { hasText: new RegExp(`^${name} = ${value}$`) });
    await expectContext(page, selected, new RegExp(`Results grouped by ${name}.*Selected value: ${value}`));
    assert.doesNotMatch(await page.locator("#tip").innerText(), /chance|test result|unusual/);
    await page.keyboard.press("Escape");
  }
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

test("a Limen run: its bookkeeping is no needle, and a long name wraps after an underscore", async () => {
  const { page, errors } = await limenPage();
  // 200 rounds: values that reach the 30 rows a suggestion needs
  await page.goto(base + "limen200");
  await page.waitForSelector(".pcard");
  // neither the needle picker nor the gates' maker offers the round's bookkeeping
  const bookkeeping = ["_round_index", "_generation_index", "_injected"];
  const picked = await page.$$eval("#target-pick option", os => os.map(o => o.value));
  assert.ok(picked.includes("execution_time"), "the fit diagnostics are still needles");
  for (const id of bookkeeping) assert.ok(!picked.includes(id), id);
  // a card's name in a box too narrow for it wraps after an underscore,
  // every part whole on its line, and reads and copies as written; after
  // a word, it moves to the next line whole, as a word does. Found and
  // measured in one task: the Board draws its cards again when its
  // background analysis ends, and a card found a moment before is gone.
  const got = await page.evaluate(() => {
    const el = document.querySelector('.pcard .pc-name[title="long_threshold_percentile"]');
    el.style.width = "16ch";
    const range = document.createRange();
    const tops = n => { range.selectNodeContents(n); return [...new Set([...range.getClientRects()].map(r => Math.round(r.top)))]; };
    const texts = () => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), out = []; while (w.nextNode()) out.push(w.currentNode); return out; };
    // the lines a name takes, read off its text (its box, .nm, has a rect
    // of its own), and what a copy takes, its text as rendered
    const parts = texts();
    const alone = { text: el.textContent, copied: el.innerText, parts: parts.map(n => n.textContent), lines: parts.map(n => tops(n).length), all: new Set(parts.flatMap(tops)).size };
    el.prepend("xxxxxxxx ");
    const [word, ...after] = texts();
    return { ...alone, moved: tops(after[0])[0] > tops(word)[0], afterLines: after.map(n => tops(n).length) };
  });
  assert.equal(got.text, "long_threshold_percentile");
  assert.equal(got.copied, "long_threshold_percentile");
  assert.deepEqual(got.parts, ["long_", "threshold_", "percentile"]);
  assert.deepEqual(got.lines, [1, 1, 1], "a part broken across lines");
  assert.equal(got.all, 2, "the name did not wrap");
  assert.ok(got.moved, "the name's first part stayed behind on the word's line");
  assert.deepEqual(got.afterLines, [1, 1, 1]);
  // a name in a table's cell is a box of its own too
  await page.keyboard.press("2");
  await page.waitForSelector("table.suggest td.v");
  const cells = await page.$$eval("table.suggest td.v", tds => tds.map(td => ({ name: td.textContent.split(" ")[0], boxed: !!td.firstElementChild && td.firstChild === td.firstElementChild && td.firstElementChild.matches(".nm") })));
  assert.ok(cells.some(c => c.boxed), "no suggestion names a parameter of more than one part");
  for (const c of cells) assert.equal(c.boxed, /[^_]_[^_]/.test(c.name), c.name);
  await page.keyboard.press("6");
  await page.waitForSelector(".gt-maker");
  const made = await page.$$eval(".gt-maker .gt-needle option", os => os.map(o => o.value));
  assert.ok(made.includes("execution_time"));
  for (const id of bookkeeping) assert.ok(!made.includes(id), id);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a walk-forward Limen run: Limen's reports in the Run view, no replay and no cohort", async () => {
  const { page, errors } = await limenPage();
  await page.goto(base + "limenwf");
  await page.waitForSelector(".pcard");
  // whether a round converged is a needle of the fit, not a parameter
  assert.ok((await page.$$eval("#target-pick option", os => os.map(o => o.value))).includes("_convergence_warning"));
  assert.equal(await page.locator('.board-sec [title="_convergence_warning"], .board-sec .chip', { hasText: "_convergence_warning" }).count(), 0);
  await page.keyboard.press("7");
  const reports = page.locator("section[aria-labelledby=rn-reports]");
  await reports.waitFor();
  const text = await reports.innerText();
  assert.match(text, /Walk-forward: each row is a trial's means over its 2 folds of 49 test bars \(anchored; 4 purged and 3 embargoed between them\)/);
  assert.match(text, /2 of 4 rounds observed \(50%\) recorded a convergence warning\./);
  assert.match(text, /Most with max_iter = 2 \(2 of 2\); C = 0\.01 \(1 of 2\); C = 1\.0 \(1 of 2\)/);
  assert.match(text, /Trials\s+4, over 96 bars in 2 blocks/);
  assert.match(text, /Deflated Sharpe probability\s+0\.033/);
  assert.match(text, /Probability of backtest overfitting\s+1\.00/);
  assert.deepEqual(await reports.locator(".issue .sev").allInnerTexts(), ["convergence", "fails", "fails"]);
  // the best trial opens in the inspector, which replays none
  await reports.locator("button", { hasText: /^row \d+$/ }).click();
  await page.waitForSelector("#inspector p.note");
  assert.match(await page.locator("#inspector").innerText(), /Limen replays no walk-forward trial: its model is fitted afresh in each fold/);
  assert.equal(await page.locator("#inspector .code-head", { hasText: "Replay it exactly" }).count(), 0);
  // what moves the warnings, read on the Board
  await reports.locator("button", { hasText: "What moves it, on the Board" }).click();
  await page.waitForFunction(() => document.querySelector("#target-pick").value === "_convergence_warning"
    && document.querySelector(".rail button[aria-current=page]").getAttribute("aria-label") === "Board");
  // its trials make no cohort
  await page.keyboard.press("8");
  await page.waitForSelector(".view .empty");
  assert.match(await page.locator(".view .empty").innerText(), /^A walk-forward run's trials make no cohort\./);
  assert.deepEqual(errors, []);
  await page.close();
});

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
  // wrap: each row's chart tops, by the row's top, measured in one frame
  // once the cards are laid out in rows at this width (a measure taken
  // while the view is drawn again after the resize reads every box at 0,
  // so it is taken again until the view has settled, up to 5 s)
  const measure = () => page.$$eval(".rn-grid .rn-card", cards => {
    const by = {};
    for (const c of cards) (by[Math.round(c.getBoundingClientRect().top)] ||= []).push(Math.round(c.querySelector(".chart").getBoundingClientRect().top));
    return by;
  });
  const level = (by) => Object.keys(by).length > 1 && Object.values(by).every(tops => new Set(tops).size === 1);
  let rows = await measure();
  for (let k = 0; k < 50 && !level(rows); k++) {
    await page.waitForTimeout(100);
    rows = await measure();
  }
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
  // the strip's tools are in reach with the inspector open: measured with
  // the strip in view (the view scrolls below the top bar), and a failure
  // names what is at the point and how far the view had scrolled
  await page.$eval(".strip", el => el.scrollIntoView({ block: "nearest" }));
  for (const sel of [".strip [data-info]", ".strip-copy"]) {
    const found = await page.$eval(sel, el => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at && el.contains(at) ? null
        : `${at ? at.outerHTML.slice(0, 160) : "nothing"}, the view scrolled ${document.querySelector(".view").scrollTop}px`;
    });
    assert.equal(found, null, `${sel} is covered by ${found}`);
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
    // the name offered follows what it starts from, until one is typed
    await page.locator(".ex-make select").selectOption("t:logreg_binary");
    assert.equal(await page.locator(".ex-make input").inputValue(), "logreg_binary");
    await page.locator(".ex-make select").selectOption("t:lightgbm_binary");
    assert.equal(await page.locator(".ex-make input").inputValue(), "lightgbm_binary");
    // the other views have no run to show yet
    await page.keyboard.press("1");
    await page.waitForSelector("text=No run is open yet.");
    await page.keyboard.press("0");
    await page.locator(".ex-make input").fill("first");
    await page.locator(".ex-make .btn.primary").click();
    // its manifest, checked by limen validate as it is typed
    await page.waitForSelector(".ex-status .sev.ok");
    assert.match(await page.locator(".ex-status").innerText(), /^Valid\s+· 45 parameters, 3\.76 × 10¹⁸ combinations$/);
    await expectContext(page, page.locator("input[aria-label=Rounds]"), /configurations.*in total.*shards/);
    await expectContext(page, page.locator('input[aria-label="Shards side by side"]'), /independent parts.*parallel/);
    await expectContext(page, page.locator("#ex-list"), /Saved search setups/);
    await page.locator(".ed-text").evaluate(t => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
    await page.keyboard.type("# BAD_VALUE\n");
    await page.waitForSelector(".ex-status .sev.crit");
    const line = await page.evaluate(() => document.querySelector(".ed-text").value.split("\n").findIndex(l => l.trim().startsWith("n_permutations:")) + 1);
    assert.equal(await page.locator(".ed-gutter .bad").innerText(), String(line));
    assert.match(await page.locator(".ex-problems li").innerText(), new RegExp(`Line ${line}\\s+uel\\.n_permutations\\s+'n_permutations' must be a int`));
    assert.equal(await page.locator(".ex-run-form .btn.primary").isDisabled(), true);
    for (let i = 0; i < "# BAD_VALUE\n".length; i++) await page.keyboard.press("Backspace");
    await page.waitForSelector(".ex-status .sev.ok");
    // saved, it stays the same editor (its undo with it) past the next
    // reading of the project
    const editor = await page.locator(".ed-text").elementHandle();
    await page.keyboard.type("# a note\n");
    await page.waitForFunction(() => /unsaved/.test(document.querySelector(".ex-status").textContent));
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !/unsaved/.test(document.querySelector(".ex-status").textContent));
    await page.waitForTimeout(2500);
    assert.equal(await editor.evaluate(t => t.isConnected && t.value.endsWith("# a note\n")), true);
    assert.equal(await page.locator(".ex-mf .btn:has-text('Open it again')").isVisible(), false);
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
    // A published PID can precede Limen's stop handler and checkpoint setup.
    const initialized = await page.evaluate(async () => {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        const project = await (await fetch("api/experiment")).json();
        const run = project.runs.find(r => r.experiment === "first_2");
        if (run && run.shards.length === 2 && run.shards.every(s => s.rows > 0)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return false;
    });
    assert.equal(initialized, true, "both shards wrote a round before Stop");
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

test("experiment: what is typed while a manifest changed on disk is read again stays, and Open it again offers the file's", async () => {
  const project = mkdtempSync(join(tmpdir(), "grid-project-"));
  writeFileSync(join(project, "limen.toml"), "[store]\n");
  mkdirSync(join(project, "manifests"));
  const file = join(project, "manifests", "exp.yaml");
  copyFileSync(join(ROOT, "tests/fixtures/limen_run/lightgbm_binary_full.yaml"), file);
  const proc = spawn("python3", ["-m", "grid", "serve", "--project", project, "--limen-cli", join(ROOT, "tests/fixtures/fake_limen.py"), "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".ex-status .sev.ok");
    // the file changes elsewhere; its new text is slow to come
    await page.route(/\/api\/experiment\/manifest/, async (route) => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
    const asked = page.waitForRequest(/\/api\/experiment\/manifest/, { timeout: 20000 });
    appendFileSync(file, "# changed elsewhere\n");
    await asked;
    const answered = page.waitForResponse(/\/api\/experiment\/manifest/);
    await page.locator(".ed-text").evaluate(t => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
    await page.keyboard.type("# mine");
    await answered;
    await page.waitForSelector(".ex-mf .btn:has-text('Open it again'):visible");
    const text = await page.locator(".ed-text").inputValue();
    assert.ok(text.endsWith("# mine") && !text.includes("changed elsewhere"), text.slice(-80));
    assert.match(await page.locator(".ex-status").innerText(), /unsaved/);
    // asked for, the file's text replaces the edits
    await page.locator(".ex-mf .btn", { hasText: "Open it again" }).click();
    await page.waitForFunction(() => document.querySelector(".ed-text").value.endsWith("# changed elsewhere\n"), null, { timeout: 20000 });
    assert.equal(await page.locator(".ex-mf .btn:has-text('Open it again')").isVisible(), false);
    // saved here, then put back elsewhere before the project is read again:
    // the file's text comes back
    const before = readFileSync(file, "utf8");
    await page.locator(".ed-text").evaluate(t => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); });
    await page.keyboard.type("# saved here\n");
    await page.keyboard.press("Control+s");
    await page.waitForFunction(() => !/unsaved/.test(document.querySelector(".ex-status").textContent));
    writeFileSync(file, before);
    await page.waitForFunction(b => document.querySelector(".ed-text").value === b, before, { timeout: 20000 });
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("experiment: a manifest that could not be read is read again when its file changes, and when asked", async () => {
  const project = mkdtempSync(join(tmpdir(), "grid-project-"));
  writeFileSync(join(project, "limen.toml"), "[store]\n");
  mkdirSync(join(project, "manifests"));
  const file = join(project, "manifests", "exp.yaml");
  copyFileSync(join(ROOT, "tests/fixtures/limen_run/lightgbm_binary_full.yaml"), file);
  const proc = spawn("python3", ["-m", "grid", "serve", "--project", project, "--limen-cli", join(ROOT, "tests/fixtures/fake_limen.py"), "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    // the first reading of the manifest fails
    let fails = 1;
    await page.route(/\/api\/experiment\/manifest/, (route) => (fails-- > 0
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the disk is busy" }) })
      : route.continue()));
    await page.goto(url);
    await page.waitForSelector("text=could not be read.");
    assert.match(await page.locator(".ex .empty").innerText(), /the disk is busy\. It is read again when it changes\./);
    // its file changes: read again
    appendFileSync(file, "# touched\n");
    await page.waitForSelector(".ex-status .sev.ok", { timeout: 20000 });
    assert.ok((await page.locator(".ed-text").inputValue()).endsWith("# touched\n"));
    // a page that failed to read it reads it again when asked
    fails = 1;
    await page.reload();
    await page.waitForSelector("text=could not be read.");
    await page.locator(".ex .btn", { hasText: "Read it again" }).click();
    await page.waitForSelector(".ex-status .sev.ok", { timeout: 20000 });
    assert.deepEqual(errors.filter(e => !/status of 500/.test(e)), []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("experiment: a reading of the project asked for before a new experiment was made does not take the choice back", async () => {
  const project = mkdtempSync(join(tmpdir(), "grid-project-"));
  writeFileSync(join(project, "limen.toml"), "[store]\n");
  mkdirSync(join(project, "manifests"));
  copyFileSync(join(ROOT, "tests/fixtures/limen_run/lightgbm_binary_full.yaml"), join(project, "manifests", "a.yaml"));
  const proc = spawn("python3", ["-m", "grid", "serve", "--project", project, "--limen-cli", join(ROOT, "tests/fixtures/fake_limen.py"), "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".ex-status .sev.ok");
    // the project's readings come slowly, so one is under way while the
    // new experiment is made
    const reading = (u) => new URL(u).pathname === "/api/experiment";
    await page.route(reading, async (route) => {
      if (route.request().method() === "GET") await new Promise(r => setTimeout(r, 2500));
      await route.continue();
    });
    await page.waitForRequest(req => reading(req.url()) && req.method() === "GET", { timeout: 20000 });
    await page.locator(".ex-tools .btn", { hasText: "New experiment" }).click();
    await page.locator(".ex-make input").fill("b");
    await page.locator(".ex-make .btn.primary").click();
    await page.waitForSelector(".ex-table tr.sel td:has-text('b')", { timeout: 20000 });
    await page.waitForTimeout(6000);
    assert.equal(await page.locator(".ex-table tr.sel td.v").innerText(), "b");
    assert.equal(await page.locator(".ex-mf .mf-file").innerText(), "manifests/b.yaml");
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("cohort: on the rail only for a Limen run", async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator(".rail button[aria-label=Cohort]").count(), 0);
  assert.equal(await page.locator(".rail button").last().getAttribute("aria-label"), "Run");
  await page.keyboard.press("8");
  assert.equal(await page.locator(".rail button[aria-current=page]").getAttribute("aria-label"), "Board");
  assert.deepEqual(errors, []);
  await page.close();
});

test("cohort: a Limen run's pool chosen on the first half, judged on the second, and made a predictor in its project", async () => {
  // a Limen project holding a run of two shards, as Grid's Experiment view
  // ran it; its predictors are made with a stand-in limen package
  const project = mkdtempSync(join(tmpdir(), "grid-project-"));
  writeFileSync(join(project, "limen.toml"), "[store]\n");
  mkdirSync(join(project, "manifests"));
  const folder = join(project, "results", "dev", "lgbm", "20261010_220749");
  for (const s of ["s1", "s2"]) {
    mkdirSync(join(folder, s), { recursive: true });
    for (const f of readdirSync(join(ROOT, "tests/fixtures/limen_cohort", s))) copyFileSync(join(ROOT, "tests/fixtures/limen_cohort", s, f), join(folder, s, f));
  }
  writeFileSync(join(folder, "grid-run.json"), JSON.stringify({ experiment: "lgbm", started_at: Date.now() / 1000, rounds: 4, threads: 1,
    record: { execution: true, outputs: true },
    shards: ["s1", "s2"].map((label, k) => ({ label, rounds: 2, seed: k + 1, pid: null, state: "finished", exit: 0, stopping: false })) }));
  const proc = spawn("python3", ["-m", "grid", "serve", "--project", project, "--limen-cli", join(ROOT, "tests/fixtures/fake_limen.py"),
    "--limen-python", "python3", "--port", "0"], { cwd: ROOT, env: { ...process.env, PYTHONPATH: join(ROOT, "tests/fixtures/fake_limen_pkg") } });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    // Historical results are selected on demand from the project catalog.
    await page.waitForSelector("#run-pick option[value^=\"project:\"]");
    await page.locator("#run-pick").selectOption({ index: 1 });
    await page.waitForSelector(".rail button[aria-label=Cohort]", { timeout: 20000 });
    // the project's predictors cannot be read at first: the view says so,
    // and reads them again until they are read
    const unread = /\/api\/experiment$/;
    await page.route(unread, route => route.request().method() === "GET"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "the project could not be read" }) })
      : route.continue());
    const logged = errors.length;
    await page.keyboard.press("8");
    await page.waitForSelector(".co-table");
    // the run has written every round it planned (2 a shard): finished,
    // not quiet, though Limen keeps no log to say so
    assert.equal(await page.locator(".status").getAttribute("data-kind"), "finished");
    assert.equal(await page.locator(".status b").textContent(), "Finished");
    const failed = "section[aria-labelledby=co-make] .co-error";
    await page.waitForSelector(failed, { timeout: 20000 });
    assert.equal(await page.locator(failed).innerText(), "The project's predictors could not be read: the project could not be read");
    await page.unroute(unread);
    await page.waitForSelector(failed, { state: "detached", timeout: 20000 });
    // (the browser logs each failed read)
    assert.ok(errors.slice(logged).every(e => /status of 500/.test(e)), errors.slice(logged).join("\n"));
    errors.splice(logged);
    // the pool: no pocket and no gate set (Grid's own gates are not the pool's)
    assert.match(await page.locator(".strip").innerText(), /Pool\s+4\s+of 4 in view/);
    // the members, the best on the first half, from both of the run's
    // result directories (each shard a manifest of its own), each row's said
    assert.deepEqual(await page.locator(".co-table thead th").allInnerTexts(), ["Member", "Rank", "Row", "From", "First half", "Second half"]);
    assert.deepEqual([...new Set(await page.locator(".co-table tbody td:nth-child(4)").allInnerTexts())].sort(), ["s1", "s2"]);
    assert.equal(await page.locator(".co-table tbody input:checked").count(), 4);
    assert.match(await page.locator(".strip").innerText(), /Members\s+4\s+from 2 result directories/);
    // judged on the second half, from what the run recorded
    await page.waitForSelector(".co-verdict", { timeout: 20000 });
    assert.match(await page.locator(".co-verdict").innerText(), /^Chosen on the first half, the cohort makes 0\.00 bps a bar on the second/);
    assert.match(await page.locator(".co-costs").innerText(), /696 bars they share/);
    await expectContext(page, page.locator(".co-judge tbody tr").first().locator("td").nth(1), /after costs.*For Cohort.*First half/);
    await expectContext(page, page.locator(".co-judge tbody tr").first().locator("td").nth(6), /trades started.*For Cohort.*Second half/);
    await expectContext(page, page.locator(".co-cost", { has: page.locator("input[aria-label=Slippage]") }).locator("span").first(), /basis points per fill/);
    // a member taken out: judged again on the one left
    await page.locator(".co-table tbody input").nth(1).uncheck();
    await page.waitForFunction(() => /Members\s+3\s/.test(document.querySelector(".strip").innerText), null, { timeout: 20000 });
    await page.locator(".co-table tbody input").nth(1).check();
    await page.waitForFunction(() => /Members\s+4\s/.test(document.querySelector(".strip").innerText), null, { timeout: 20000 });
    // a needle not measured on each half: the members are chosen on the
    // whole window, one value a row, and the second half chose them too
    const needle = await page.locator("#target-pick").inputValue();
    await page.selectOption("#target-pick", "auc");
    await page.waitForFunction(() => /^Chosen with the second half too \(.+ is not measured on each half\), the cohort makes .+ a bar on the second half, which chose it too;/
      .test((document.querySelector(".co-verdict") || {}).textContent || ""), null, { timeout: 20000 });
    assert.equal(await page.locator(".co-table").getAttribute("aria-label"), "The pool, best first");
    assert.equal(await page.locator(".co-table thead th").count(), 5);
    assert.equal(await page.locator(".co-table tbody tr").first().locator("td").count(), 5);
    assert.deepEqual(await page.locator(".co-judge th.co-half").allInnerTexts(), ["First half", "Second half (chose it too)"]);
    await page.selectOption("#target-pick", needle);
    await page.waitForFunction(() => /^Chosen on the first half,/.test((document.querySelector(".co-verdict") || {}).textContent || ""), null, { timeout: 20000 });
    assert.deepEqual(await page.locator(".co-judge th.co-half").allInnerTexts(), ["First half (chose it)", "Second half (judges it)"]);
    // a fee past the view's bound is marked and not taken; one within it is
    const fee = page.locator("input[aria-label=Fee]");
    const own = await fee.inputValue();
    await fee.fill("1001");
    await fee.press("Enter");
    assert.equal(await fee.getAttribute("aria-invalid"), "true");
    await fee.fill("1000");
    await fee.press("Enter");
    await page.waitForFunction(() => { const f = document.querySelector("input[aria-label=Fee]"); return f && f.value === "1000" && !f.hasAttribute("aria-invalid")
      && !document.querySelector(".co-judged[aria-busy]"); }, null, { timeout: 20000 });
    await page.locator("input[aria-label=Fee]").fill(own);
    await page.locator("input[aria-label=Fee]").press("Enter");
    await page.waitForFunction(own => document.querySelector("input[aria-label=Fee]").value === own && !document.querySelector(".co-judged[aria-busy]"), own, { timeout: 20000 });
    // made a predictor in the project: Limen's Trainer and Cohort (the
    // stand-in), across the two result directories
    assert.match(await page.locator("section[aria-labelledby=co-make] .isl-note").first().innerText(),
      /^4 members from 2 result directories, which Limen 5\.24 or later binds into one cohort\./);
    await page.locator(".co-form input").fill("lgbm_pair");
    await page.locator(".co-form .btn.primary").click();
    await page.waitForSelector(".co-made tbody tr .tag", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector(".co-made tbody tr .tag").textContent === "Made", null, { timeout: 30000 });
    const row = await page.locator(".co-made tbody tr").first().innerText();
    const spec = JSON.parse(readFileSync(join(project, "cohorts", "lgbm_pair", "cohort.json"), "utf8"));
    assert.equal(spec.state, "made");
    // its members by source, bound across the shards' manifests: a cohort
    // of several manifests has none of its own
    assert.deepEqual(spec.sources, { s1: "results/dev/lgbm/20261010_220749/s1", s2: "results/dev/lgbm/20261010_220749/s2" });
    assert.equal(spec.rounds.length, 4);
    assert.equal(spec.member_ids.length, 4);
    assert.equal(spec.manifest_id, null);
    // the row names it by Limen's cohort id, made when Limen bound it
    assert.match(row, new RegExp(`^lgbm_pair\\s+4\\s+2 result directories\\s+Made\\s+${spec.cohort_id.slice(7, 19)}\\s+\\d\\d:\\d\\d`));
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("first half: every needle measured on each half reads its first half only, no view shows the second, and the Cohort view still judges on it", async () => {
  const run = limenExecutionRun(join(mkdtempSync(join(tmpdir(), "grid-half-")), "run"));
  const proc = spawn("python3", ["-m", "grid", "serve", "--limen", run, "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    await page.goto(url);
    await page.waitForSelector(".pcard");
    // offered beside the needle on a run measured on each half; off
    const half = page.locator(".half-pick");
    assert.equal(await half.isVisible(), true);
    assert.equal(await half.getAttribute("aria-pressed"), "false");
    const needle = await page.locator("#target-pick option:checked").textContent();
    // on (H): the needle reads its first half, named so; the board no longer
    // asks for both halves, nor marks them
    await page.keyboard.press("h");
    await page.waitForFunction(() => document.querySelector(".half-pick").getAttribute("aria-pressed") === "true");
    assert.equal(await page.locator("#target-pick option:checked").textContent(), `${needle}, first half`);
    await page.waitForFunction(() => !/Not in both halves/.test(document.querySelector(".strip").innerText));
    assert.equal(await page.locator(".pcard .col .hm").count(), 0);
    // the address keeps it
    await page.reload();
    await page.waitForSelector(".pcard");
    assert.equal(await page.locator(".half-pick").getAttribute("aria-pressed"), "true");
    // Both gates read their first halves. With fewer than 30 trades,
    // per-trade t stays unavailable instead of using whole-window values.
    await page.keyboard.press("6");
    await page.waitForSelector("article.gt-card");
    assert.deepEqual(await page.locator("article.gt-card .gt-title").allInnerTexts(), ["Entries, first half ≥ 30", "Per-trade t, first half ≥ 2"]);
    // Trials has no halves; the Run view no halves of the test window, nor
    // a reliability across them
    await page.keyboard.press("5");
    await page.waitForSelector(".tr-island table.trials");
    assert.doesNotMatch(await page.locator("table.trials thead").innerText(), /Second half/);
    await page.keyboard.press("7");
    await page.waitForSelector(".strip");
    assert.equal(await page.locator("#rn-halves").count(), 0);
    assert.doesNotMatch(await page.locator(".strip").innerText(), /Reliability/);
    // the Cohort view reads the needle as measured: chosen on the first
    // half, its second half beside it, and says the pocket was found
    // without it (this run's round lines name no rounds, so the server
    // cannot judge a cohort of them: the browser logs its answer)
    const logged = errors.length;
    await page.keyboard.press("8");
    await page.waitForSelector(".co-table");
    assert.deepEqual(await page.locator(".co-table thead th.r").allInnerTexts(), ["Rank", "Row", "First half", "Second half"]);
    assert.match(await page.locator(".co-half").innerText(), /^First half is on/);
    await page.waitForSelector(".co-judged .co-error", { timeout: 20000 });
    assert.ok(errors.slice(logged).every(e => /status of 400/.test(e)), errors.slice(logged).join("\n"));
    errors.splice(logged);
    // a needle not measured on each half reads the whole window, and says so
    await page.keyboard.press("1");
    await page.selectOption("#target-pick", "auc");
    await page.waitForSelector(".warn-chip:not([hidden])");
    assert.equal(await page.locator(".warn-chip").innerText(), "Whole window");
    assert.doesNotMatch(await page.locator("#target-pick option:checked").textContent(), /first half/);
    // off (H): every view reads the whole window as before
    await page.selectOption("#target-pick", "backtest_pnl_per_bar_bps");
    await page.keyboard.press("h");
    await page.waitForFunction(() => document.querySelector(".half-pick").getAttribute("aria-pressed") === "false");
    await page.waitForFunction(() => /Not in both halves/.test(document.querySelector(".strip").innerText));
    assert.equal(await page.locator(".warn-chip").isVisible(), false);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

test("first half: not offered on a run that is not measured on each half", async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator(".half-pick").isVisible(), false);
  // H does nothing there
  await page.keyboard.press("h");
  assert.equal(await page.locator(".half-pick").getAttribute("aria-pressed"), "false");
  assert.deepEqual(errors, []);
  await page.close();
});

test("an agent snapshot link opens the exact pinned analysis in the human UI", async () => {
  const source = mkdtempSync(join(tmpdir(), "grid-agent-browser-"));
  for (const name of ["metadata.json", "results.csv", "lightgbm_binary_full.yaml"])
    copyFileSync(join(ROOT, "tests/fixtures/limen_run_200", name), join(source, name));
  const connection = join(source, "connection.json");
  const proc = spawn("python3", ["-m", "grid", "serve", "--limen", source, "--agent-file", connection], { cwd: ROOT });
  let page;
  try {
    const url = await serverUrl(proc);
    const opened = await limenPage();
    page = opened.page;
    await page.goto(url);
    await page.waitForSelector(".pcard");
    const credential = JSON.parse(readFileSync(connection, "utf8"));
    const response = await fetch(new URL("api/agent", url), { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${credential.token}`
    }, body: JSON.stringify({ operation: "grid_analyze", arguments: { analysis: "board", state: { edge: 150 } } }) });
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.snapshot.rows, 150);
    const reading = page.waitForResponse(/\/api\/agent\/snapshot\?/);
    await page.goto(new URL(body.result.viewLink, url).href);
    const packet = await (await reading).json();
    assert.equal(packet.pack.runs[0].rows, 200);
    await page.waitForSelector(".pcard");
    assert.match(await page.locator(".strip").innerText(), /150/);
    assert.equal(await page.locator(".rail button[aria-current=page]").getAttribute("aria-label"), "Board");
    assert.deepEqual(opened.errors, []);
  } finally {
    if (page) await page.close();
    proc.kill("SIGTERM");
    await new Promise(resolve => proc.once("exit", resolve));
  }
});


test("project catalog loads before history; selected runs stream and survive navigation", async () => {
  const project = mkdtempSync(join(tmpdir(), "grid-catalog-"));
  writeFileSync(join(project, "limen.toml"), "[store]\n");
  for (const name of ["first", "second"]) cpSync(join(ROOT, "tests/fixtures/limen_run"), join(project, "results/dev", name), { recursive: true });
  const proc = spawn("python3", ["-m", "grid", "serve", "--project", project, "--limen-cli", join(ROOT, "tests/fixtures/fake_limen.py"), "--port", "0"], { cwd: ROOT });
  try {
    const url = await serverUrl(proc);
    const { page, errors } = await limenPage();
    const packs = [];
    page.on("response", async response => { if (response.url().includes("/api/pack")) packs.push(await response.json()); });
    await page.goto(url);
    await page.waitForSelector(".ex-make");
    assert.equal(packs[0].pack.runs.length, 0);
    assert.equal(packs[0].pack.catalog.length, 2);
    assert.ok(JSON.stringify(packs[0]).length < 10000);
    const first = packs[0].pack.catalog[0].id, second = packs[0].pack.catalog[1].id;
    await page.selectOption("#run-pick", first);
    await page.waitForSelector(".pcard");
    await page.waitForFunction(() => /40 rows/.test(document.querySelector(".progress-text").textContent));
    const firstId = await page.locator("#run-pick").inputValue();
    assert.equal(packs.at(-1).pack.runs.length, 1);
    // A delayed selection cannot replace a newer choice of the loaded run.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let asked;
    const requested = new Promise(resolve => { asked = resolve; });
    const delayed = /\/api\/pack\?run=project%3A.*second/;
    await page.route(delayed, async route => { asked(); await held; await route.continue(); });
    await page.selectOption("#run-pick", second);
    await requested;
    await page.selectOption("#run-pick", firstId);
    const answered = page.waitForResponse(delayed);
    release();
    await answered;
    await page.unroute(delayed);
    await page.waitForTimeout(1200);
    assert.equal(await page.locator("#run-pick").inputValue(), firstId);
    const secondNow = await page.locator("#run-pick option").evaluateAll(xs => xs.find(x => /second$/.test(x.textContent)).value);
    await page.selectOption("#run-pick", secondNow);
    await page.waitForFunction(id => document.querySelector("#run-pick").value !== id, firstId);
    assert.equal(packs.at(-1).pack.runs.length, 1);
    await page.goBack();
    await page.waitForFunction(id => document.querySelector("#run-pick").value === id, firstId);
    // Its file is still followed after loading it on demand.
    const csv = join(project, "results/dev/first/results.csv");
    const lines = readFileSync(csv, "utf8").trimEnd().split("\n");
    appendFileSync(csv, lines.at(-1) + "\n");
    await page.waitForFunction(() => /41 rows/.test(document.querySelector(".progress-text").textContent), null, { timeout: 15000 });
    await page.reload();
    await page.waitForSelector(".pcard");
    await page.waitForFunction(() => /41 rows/.test(document.querySelector(".progress-text").textContent));
    assert.deepEqual(errors, []);
    await page.close();
  } finally { proc.kill(); }
});

test("Trials headings sort numeric and parameter columns with accessible direction", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("6");
  await page.waitForSelector("table.trials");
  const rows = () => page.locator("table.trials tbody tr").evaluateAll(xs => xs.map(x => ({ rank: x.querySelector(".rk").textContent, row: Number(x.querySelector(".ri").textContent.replaceAll(",", "")) })));
  const original = await rows();
  const rowHead = page.getByRole("button", { name: "Sort by Row", exact: true });
  await rowHead.click();
  assert.equal(await rowHead.locator("..").getAttribute("aria-sort"), "ascending");
  let sorted = await rows();
  assert.deepEqual(sorted.map(x => x.row), original.map(x => x.row).sort((a, b) => a - b));
  await rowHead.click();
  assert.equal(await rowHead.locator("..").getAttribute("aria-sort"), "descending");
  sorted = await rows();
  assert.deepEqual(sorted.map(x => x.row), original.map(x => x.row).sort((a, b) => b - a));
  assert.deepEqual(new Map(sorted.map(x => [x.row, x.rank])), new Map(original.map(x => [x.row, x.rank])));
  const parameter = page.locator("table.trials th.g-start .tr-sort").first();
  await parameter.focus();
  await page.keyboard.press("Enter");
  assert.equal(await parameter.locator("..").getAttribute("aria-sort"), "ascending");
  assert.deepEqual(errors, []);
  await page.close();
});
