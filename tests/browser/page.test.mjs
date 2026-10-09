// Browser tests: the built page on a synthetic sweep, recorded and live.
//
//   TESSERA_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
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
const PW = process.env.TESSERA_PLAYWRIGHT;
if (!PW) throw new Error("set TESSERA_PLAYWRIGHT to a playwright index.mjs (see the header of this file)");
const { chromium } = await import(PW);

let dir, server, base, browser;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "tessera-browser-"));
  execFileSync("python3", ["tools/synth.py", "--rows", "6000", "--seed", "5", "--out", dir], { cwd: ROOT });
  execFileSync("python3", ["-m", "tessera", "pack", "--results", join(dir, "results.jsonl"), "--log", join(dir, "sweep.log"),
    "--name", "Synthetic sweep", "--out", join(dir, "pack.json.gz")], { cwd: ROOT });
  execFileSync("python3", ["tools/build.py", "--pack", join(dir, "pack.json.gz"), "--out", join(dir, "demo.html")], { cwd: ROOT, stdio: "ignore" });
  // a real Limen run's first rounds, read from its result directory
  execFileSync("python3", ["-m", "tessera", "pack", "--limen", "tests/fixtures/limen_run", "--out", join(dir, "limen.pack.json.gz")], { cwd: ROOT });
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
  await page.waitForSelector("text=Strongest interactions", { timeout: 20000 });
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
  assert.match(await page.locator(".card .big").first().innerText(), /%/);
  assert.ok(await page.locator("text=def in_pocket(r):").count() === 1);
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

test("live: rows stream in from a running sweep", async () => {
  const live = mkdtempSync(join(tmpdir(), "tessera-live-"));
  const proc = spawn("python3", ["tools/live_demo.py", "--out", live, "--port", "0", "--rate", "20"], { cwd: ROOT });
  const url = await new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no server line: ${out}`)), 20000);
    proc.stdout.on("data", d => { out += d; const m = /at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]); } });
    proc.stderr.on("data", d => { out += d; });
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(url);
    await page.waitForSelector(".status[data-kind=live]", { timeout: 15000 });
    const rows = async () => Number((await page.locator(".progress-text").innerText()).split(" rows")[0].replace(/,/g, ""));
    const first = await rows();
    await page.waitForFunction((n) => {
      const t = document.querySelector(".progress-text").textContent;
      return Number(t.split(" rows")[0].replace(/,/g, "")) > n;
    }, first, { timeout: 20000 });
    assert.ok(await rows() > first);
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    proc.kill();
  }
});

