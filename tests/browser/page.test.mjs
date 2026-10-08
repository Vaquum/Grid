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
  server = createServer(async (req, res) => {
    try {
      const body = await readFile(join(dir, "demo.html"));
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
  await page.waitForSelector(".block");
  return { page, errors };
}

test("the board draws the sweep with its base and raised blocks", async () => {
  const { page, errors } = await open();
  assert.equal(await page.locator(".view h1").innerText(), "What moves Tradeable");
  assert.match(await page.locator(".hero").innerText(), /over 6,000 rows/);
  const raised = await page.locator(".block:not(.flat)").count();
  assert.ok(raised >= 3, `raised blocks: ${raised}`);
  // the planted strong effects are raised, the inert one is flat
  const names = await page.locator(".block:not(.flat) .block-name").allInnerTexts();
  assert.ok(names.some(n => n.startsWith("model")), names.join(","));
  assert.ok(names.some(n => n.startsWith("tp")), names.join(","));
  const flat = await page.locator(".block.flat .block-name").allInnerTexts();
  assert.ok(flat.some(n => n.startsWith("sizing")), "sizing is flat");
  // moderators arrive in the background
  await page.waitForSelector("text=interaction tests checked", { timeout: 20000 });
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

test("a block opens in five degrees and a value goes into the pocket", async () => {
  const { page, errors } = await open();
  await page.locator(".block", { has: page.locator(".block-name", { hasText: /^model$/ }) }).click();
  await page.waitForSelector("#inspector .degree");
  const degrees = await page.locator("#inspector .degree h3").allInnerTexts();
  for (const d of ["ATTRIBUTES", "ARGUMENTS", "CODE"]) assert.ok(degrees.some(x => x.toUpperCase().includes(d)), `${d} in ${degrees}`);
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

