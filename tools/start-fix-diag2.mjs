// tools/start-fix-diag2.mjs — WHICH segment prewarm hangs?
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const CLIENT = process.env.CLIENT ?? 'http://localhost:5195';
const QUEST = process.env.QUEST ?? 'http://localhost:4695';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt', 'utf8').replace(/\n$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN, args: ['--mute-audio', '--headless=new'] });
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('console', (m) => { const t = m.text(); if (!/Invalid|While /.test(t)) console.log(`[${m.type()}]`, t.slice(0, 300)); });
await page.goto(`${CLIENT}/?quest=${QUEST}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await wait(3000);
await page.evaluate((pw) => { const i = [...document.querySelectorAll('input')].find((x) => x.getClientRects().length); if (i) { i.focus(); i.value = pw; i.dispatchEvent(new Event('input', { bubbles: true })); } }, PW);
await page.keyboard.press('Enter');
await wait(8000);
await page.waitForFunction(() => !!window.gaia?.director, null, { timeout: 90000 });
const out = await page.evaluate(async () => {
  const d = window.gaia.director.director;
  const f = d.film2;
  d.prepare?.();
  const T = (p, ms) => Promise.race([Promise.resolve(p).then((v) => 'ok', (e) => 'err:' + String(e?.message ?? e).slice(0, 120)), new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
  const res = [];
  res.push({ step: 'loadLyrics', r: await T(f.loadLyrics(), 15000) });
  for (const rec of f.segs) {
    const t0 = performance.now();
    const r = await T(f.callSeg(rec, 'prewarm'), 20000);
    res.push({ step: rec.id, r, ms: Math.round(performance.now() - t0) });
  }
  const t1 = performance.now();
  const rr = f.renderer;
  res.push({ step: 'compileAsync', r: rr?.compileAsync && f.scene && f.camera ? await T(rr.compileAsync(f.scene, f.camera), 25000) : 'skipped', ms: Math.round(performance.now() - t1) });
  return res;
});
console.log(JSON.stringify(out, null, 1));
await b.close();
