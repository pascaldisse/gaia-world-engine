// tools/start-fix-diag.mjs — where does the arm sequence stall?
// Loads the app, passes the gate, then times every step of the film's arm
// chain (preload → loadLyrics → prewarmAll → buildAudio) from the page.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const CLIENT = process.env.CLIENT ?? 'http://localhost:5195';
const QUEST = process.env.QUEST ?? 'http://localhost:4695';
const PW = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt', 'utf8').replace(/\n$/, '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN, args: ['--mute-audio', '--headless=new'] });
const page = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 400)));
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
await page.goto(`${CLIENT}/?quest=${QUEST}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await wait(3000);
await page.evaluate((pw) => { const i = [...document.querySelectorAll('input')].find((x) => x.getClientRects().length); if (i) { i.focus(); i.value = pw; i.dispatchEvent(new Event('input', { bubbles: true })); } }, PW);
await page.keyboard.press('Enter');
await wait(6000);
console.log('--- waiting for director ---');
await page.waitForFunction(() => !!window.gaia?.director, null, { timeout: 90000 }).catch((e) => console.log('no director:', e.message));
const out = await page.evaluate(async () => {
  const d = window.gaia.director.director;
  const T = (p, label, ms = 25000) => Promise.race([
    p.then((v) => ({ label, ok: true, v: typeof v === 'object' ? JSON.stringify(v).slice(0, 200) : String(v) }), (e) => ({ label, ok: false, err: String(e).slice(0, 200) })),
    new Promise((r) => setTimeout(() => r({ label, ok: false, err: 'TIMEOUT' }), ms)),
  ]);
  const steps = [];
  const t0 = performance.now();
  d.prepare?.();
  steps.push(await T(d.loadLyrics(), 'loadLyrics'));
  steps.push({ label: 'after loadLyrics ms', v: Math.round(performance.now() - t0) });
  steps.push(await T(d.film2.prewarmAll(), 'prewarmAll', 60000));
  steps.push({ label: 'after prewarmAll ms', v: Math.round(performance.now() - t0) });
  steps.push(await T(d.buildAudio(), 'buildAudio', 20000));
  steps.push({ label: 'after buildAudio ms', v: Math.round(performance.now() - t0) });
  return { steps, intro: window.gaia.atlasIntro?.state, audioEls: document.querySelectorAll('audio').length, status: d.status() };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
