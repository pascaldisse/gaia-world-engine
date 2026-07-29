// tools/start-fix-diag3.mjs — watch the app's OWN arm chain, no poking.
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
for (let i = 0; i < 30; i += 1) {
  const s = await page.evaluate(() => {
    const g = window.gaia || {};
    const api = g.director; const d = api?.director; const f = d?.film2;
    const el = document.getElementById('atlas-intro');
    return {
      introState: g.atlasIntro?.state ?? null,
      preloaded: g.atlasIntro?.preloaded ?? null,
      sub: el?.querySelector('.in-sub')?.textContent ?? null,
      ready: !!el?.classList.contains('ready'),
      lyrics: !!d?.lyrics, f2lyrics: !!f?.lyrics,
      prewarming: !!f?.prewarming, prewarmed: !!f?.prewarmed,
      report: (f?.report ?? []).map((r) => r.id + (r.ok ? '' : '!')).join(','),
      audio: !!d?.audio, audioEls: document.querySelectorAll('audio').length,
      strategy: !!g.atlasStrategy?.active, cosmosReady: !!g.atlasStrategy?.cosmos?.ready,
    };
  }).catch((e) => ({ err: e.message.slice(0, 80) }));
  console.log(i * 2 + 's', JSON.stringify(s));
  await wait(2000);
}
await b.close();
