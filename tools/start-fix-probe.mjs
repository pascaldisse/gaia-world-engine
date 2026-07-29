// tools/start-fix-probe.mjs — THE WEDGED-FILM PROBE (start-fix lane).
//
// Both WITNESS paths on this lane's iso stack (client 5195 · world 8462 ·
// quest 4695), headless + muted, screenshots at every station:
//   (a) fresh profile, first visit  → click "Witness the Beginning"
//   (b) register an account, reload → click "Witness the Beginning again"
// Both must be VISUALLY ROLLING by +5s (director playing, audio element
// advancing, title gone) with zero console errors.
//
// Usage: node tools/start-fix-probe.mjs [a|b|both]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'proof', 'start-fix');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, 'stations.log');

const CLIENT = process.env.CLIENT ?? 'http://localhost:5195';
const QUEST = process.env.QUEST ?? 'http://localhost:4695';
const URL_ = `${CLIENT}/?quest=${QUEST}`;
const GATE_PASSWORD = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt', 'utf8').replace(/\n$/, '');
const PASS = 'TestPass1234';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const stations = [];
function station(name, ok, detail = '') {
  stations.push({ name, ok, detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

async function poll(page, fn, { timeout = 40000, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    await wait(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const SNAP = () => {
  const g = window.gaia || {};
  const intro = g.atlasIntro;
  const d = g.director;
  let st = null; try { st = d?.status?.() ?? null; } catch (e) { st = 'err:' + e.message; }
  let ist = null; try { ist = intro?.status?.() ?? { state: intro?.state ?? null }; } catch (e) { ist = 'err:' + e.message; }
  const audio = [...document.querySelectorAll('audio')].map((x) => ({ t: +x.currentTime.toFixed(2), paused: x.paused, rs: x.readyState, src: (x.currentSrc || '').split('/').pop() }));
  const introEl = document.getElementById('atlas-intro');
  return {
    intro: ist,
    director: st,
    audio,
    introVisible: !!introEl && !!introEl.offsetParent,
    introSub: introEl?.querySelector('.in-sub')?.textContent ?? null,
    watchText: introEl?.querySelector('[data-act="watch"]')?.textContent ?? null,
    filmChrome: document.body.classList.contains('director-film'),
    arm: !!document.getElementById('atlas-director-arm'),
  };
};

async function openBrowser() {
  return chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN, args: ['--mute-audio', '--headless=new'] });
}

async function passGate(page) {
  const typed = await page.evaluate((pw) => {
    const i = [...document.querySelectorAll('input')].find((x) => x.offsetParent);
    if (!i) return false;
    i.focus(); i.value = pw; i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, GATE_PASSWORD);
  if (typed) { await page.keyboard.press('Enter'); await wait(3000); }
  return typed;
}

// a real trusted click grants user activation; page.evaluate(el.click()) does not
async function trustedClick(page, re) {
  const box = await page.evaluate((src) => {
    const rx = new RegExp(src, 'i');
    const el = [...document.querySelectorAll('button,div,span,a')].filter((e) => e.offsetParent && rx.test(e.textContent || '') && e.children.length === 0)[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent.trim().slice(0, 60) };
  }, re.source ?? re);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  return box.text;
}

async function run(path) {
  const tag = path;
  const b = await openBrowser();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 200)));

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(3000);
  await passGate(page);
  await page.screenshot({ path: `${SHOTS}/${tag}-01-gate.png` });

  if (path === 'b') {
    // register a hunter through the creator on the FIRST visit, then reload
    await poll(page, () => document.querySelector('#atlas-intro.ready') ? 1 : 0, { label: 'title ready', timeout: 90000 });
    const user = `startfix-${Date.now()}`;
    const reg = await page.evaluate(async ([u, p, q]) => {
      const r = await fetch(`${q}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      const j = await r.json().catch(() => ({}));
      if (j?.token) { document.cookie = `quest_token=${j.token}; path=/; max-age=86400`; try { localStorage.setItem('quest_token', j.token); } catch {} }
      return { ok: r.ok, keys: Object.keys(j || {}), status: r.status };
    }, [user, PASS, QUEST]);
    station(`${tag} register ${user}`, reg.ok, JSON.stringify(reg));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(3000);
    await passGate(page);
  }

  // wait for the intro screen to be ready to take a click
  let ready = null;
  try {
    ready = await poll(page, () => {
      const el = document.getElementById('atlas-intro');
      if (!el) return 0;
      const has = [...el.querySelectorAll('button,div')].some((e) => e.offsetParent && /witness the beginning/i.test(e.textContent || ''));
      const sub = el.querySelector('.in-sub');
      const clickable = has || (sub && !sub.hidden && /click to begin/i.test(sub.textContent || ''));
      return clickable ? JSON.stringify({ has, sub: sub?.textContent }) : 0;
    }, { label: 'a clickable witness', timeout: 120000 });
  } catch (e) { station(`${tag} screen ready`, false, e.message); }
  station(`${tag} screen ready`, !!ready, String(ready));
  const pre = await page.evaluate(SNAP);
  appendFileSync(LOG, `${tag} PRE-CLICK ${JSON.stringify(pre)}\n`);
  await page.screenshot({ path: `${SHOTS}/${tag}-02-screen.png` });

  const clicked = (await trustedClick(page, /witness the beginning/)) ?? (await (async () => { await page.mouse.click(640, 400); return '(overlay click)'; })());
  station(`${tag} clicked`, !!clicked, String(clicked));

  const snaps = [];
  for (const at of [2, 5, 8, 12]) {
    await wait(at === 2 ? 2000 : 3000 * (at === 8 ? 1 : 1) + (at === 12 ? 1000 : 0));
    const s = await page.evaluate(SNAP);
    snaps.push({ at, s });
    appendFileSync(LOG, `${tag} t+${at}s ${JSON.stringify(s)}\n`);
    await page.screenshot({ path: `${SHOTS}/${tag}-03-plus${at}s.png` });
  }

  const five = snaps.find((x) => x.at === 5).s;
  const rolling = !!(five.director && five.director.playing && five.audio.some((a) => !a.paused && a.t > 0.2));
  station(`${tag} film rolling by +5s`, rolling, JSON.stringify({ director: five.director, audio: five.audio }));
  station(`${tag} title gone by +5s`, !five.introVisible, `introVisible=${five.introVisible} sub=${five.introSub}`);
  station(`${tag} zero console errors`, errs.length === 0, errs.slice(0, 5).join(' | '));
  await b.close();
  return { tag, rolling, errs, snaps };
}

const which = process.argv[2] ?? 'both';
writeFileSync(LOG, `start-fix probe ${new Date().toISOString()} — ${URL_} — path ${which}\n`);
const out = [];
if (which === 'a' || which === 'both') out.push(await run('a'));
if (which === 'b' || which === 'both') out.push(await run('b'));
const verdict = stations.every((s) => s.ok);
console.log('\nVERDICT:', verdict ? 'PASS' : 'FAIL', `(${stations.filter((s) => !s.ok).length} failing stations)`);
appendFileSync(LOG, `\nVERDICT ${verdict ? 'PASS' : 'FAIL'}\n`);
process.exit(verdict ? 0 : 1);
