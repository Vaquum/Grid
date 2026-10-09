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
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
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
  server = createServer(async (req, res) => {
    try {
      const body = await readFile(join(dir, req.url.startsWith("/limen") ? "limen.html" : "demo.html"));
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
  assert.match(strip, /Move the needle/);
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

test("pairs: the strip, the ranked and linked pairs, and a chosen pair with its margins", async () => {
  const { page, errors } = await open();
  await page.keyboard.press("3");
  await page.waitForSelector(".pr-map", { timeout: 20000 });
  const strip = await page.locator(".strip").innerText();
  assert.match(strip, /Interacting pairs\s+\d+\s+of 190/);
  assert.match(strip, /Drawn together\s+1\b/);
  // with no interaction, the pair the sampler linked opens by itself
  assert.match(await page.locator(".pr-pair .isl-count").innerText(), /the most linked/);
  assert.equal(await page.locator(".pr-pair .tag.crit").count(), 1);
  assert.equal(await page.locator(".pr-row.linked").count(), 1);
  // each value's margin and the base close the grid
  assert.equal(await page.locator(".pr-heat th.margin-h").count(), 2);
  assert.equal(await page.locator(".pr-heat td.base-cell").count(), 1);
  // a cell of the map opens its pair, and the address keeps it
  const names = (s) => s.split(" × ").map(x => x.trim()).sort().join(" ");
  const cell = page.locator(".pr-map td.cell:not(.sel)").first();
  const want = names(await cell.getAttribute("aria-label"));
  await cell.click();
  assert.equal(names(await page.locator("#pr-pair-title").innerText()), want);
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

test("a card opens in the inspector and a value goes into the pocket", async () => {
  const { page, errors } = await open();
  await page.locator(".pcard .pc-name", { hasText: /^model$/ }).click();
  await page.waitForSelector("#inspector .part");
  const parts = await page.locator("#inspector .part h3").allInnerTexts();
  assert.deepEqual(parts, ["Attributes", "Where it acts", "Values", "How the estimates settled"]);
  // a value chosen on the card is chosen in the table
  await page.locator(".pcard", { has: page.locator(".pc-name", { hasText: /^model$/ }) }).locator(".col[data-key=xgb_tuned]").click();
  assert.equal(await page.locator("#inspector table.vals tr.sel td.v").innerText(), "xgb_tuned");
  await page.locator("#inspector table.vals tbody tr", { hasText: "xgb_def" }).click();
  await page.keyboard.press("p");
  await page.keyboard.press("2");
  await page.waitForSelector(".stack .brick");
  assert.match(await page.locator(".stack .brick").first().innerText(), /model = xgb_def/);
  // the strip leads with the needle inside the pocket, a rate here
  assert.match(await page.locator(".strip .sc").first().innerText(), /%/);
  // a sweep without a manifest has no manifest at its foot
  assert.equal(await page.locator(".manifest").count(), 0);
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

test("the address keeps the view across a reload", async () => {
  const { page } = await open();
  await page.keyboard.press("6");
  await page.waitForFunction(() => location.hash.startsWith("#s1."));
  await page.reload();
  await page.waitForSelector(".view h1");
  assert.equal(await page.locator(".view h1").innerText(), "What the gates allow");
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
  for (const key of ["2", "3", "5", "6", "7", "1"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(150);
    assert.equal(await page.locator("text=This view failed to draw").count(), 0, `view ${key}`);
  }
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
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no server line: ${out}`)), 20000);
    proc.stdout.on("data", d => { out += d; const m = /at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.stderr.on("data", d => { out += d; });
  });
  return { url, stop: () => proc.kill() };
}

const shownRows = page => page.evaluate(() => Number(document.querySelector(".progress-text").textContent.split(" rows")[0].replace(/,/g, "")));

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

