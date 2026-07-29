// tools/gesture-fix-probe.mjs — THE BEGIN GESTURE, LIVE (gesture-fix lane).
//
// The defect: the 'CLICK TO BEGIN' screen's subtitle layer (.in-sub) sat under
// the middle of the screen and ATE the begin click — elementFromPoint(640,477)
// was .in-sub — and the intro's listener was bound on a DIV, so the click
// died there: director.status() stayed {t:0, playing:false, armed:false,
// error:null} forever, silent.
//
// This probe measures three things on a live stack, in one page:
//   1. THE LAYER AUDIT — every layer of the start screen, pointer-events
//      BEFORE and AFTER the fix. "Before" is not a memory: the fix's CSS rule
//      is deleted from the live stylesheet, the layers are re-measured, and
//      the rule is put back. Same page, same frame, no second build.
//   2. ONE ANYWHERE-CLICK at (640,477) — the very pixel that was eaten —
//      must roll the film: status().t advancing ≥3 by +5s, playing:true,
//      the title gone.
//   3. THE WAIT NAMES ITSELF — status().state is sampled at every station and
//      may never be a silent {t:0,armed:false,error:null}.
// Both witness paths: a = first visit, b = 'Witness the Beginning again'
// (an account is registered through the quest service, then the page reloads).
//
// LAW (Pascal, 07-28): no unmuted browser. --mute-audio on the process AND
// the <audio> element is muted here — currentTime still advances, so the
// clock is measured in silence and the silence is asserted.
// Rig: Brave, hidden (open -n -g -j) — the only browser on this machine with
// a Metal-3 adapter and an AAC decoder; chrome-headless-shell photographs
// black frames on a wall clock.
//
// Usage: CLIENT=http://localhost:5197 QUEST=http://localhost:4695 \
//        node tools/gesture-fix-probe.mjs [a|b|both]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'proof', 'gesture-fix');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, 'stations.log');
const PROFILE = join(REPO, '.scratch', 'gesture-fix', 'brave');
const CDP = Number(process.env.CDP_PORT ?? 9237);
const CLIENT = process.env.CLIENT ?? 'http://localhost:5197';
const QUEST = process.env.QUEST ?? 'http://localhost:4695';
const URL_ = `${CLIENT}/?quest=${QUEST}`;
const GATE_PASSWORD = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt', 'utf8').replace(/\n$/, '');
const PASS = 'TestPass1234';
const HIT = { x: 640, y: 477 };   // nyari's pixel: what elementFromPoint ate
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const stations = [];
function station(name, ok, detail = '') {
  stations.push({ name, ok, detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  console.log(line.slice(0, 400));
  appendFileSync(LOG, line + '\n');
}

const SNAP = () => {
  const g = window.gaia || {};
  const d = g.director?.director ?? null;
  const el = d?.audio?.el ?? null;
  const introEl = document.getElementById('atlas-intro');
  const vis = (e) => !!e && e.getClientRects().length > 0 && Number(getComputedStyle(e).opacity) > 0.02;
  let st = null; try { st = g.director?.status?.() ?? null; } catch (e) { st = { err: e.message }; }
  return {
    intro: g.atlasIntro?.status?.() ?? null,
    director: st,
    audio: el ? { t: +el.currentTime.toFixed(2), paused: el.paused, rs: el.readyState, muted: el.muted, err: el.error?.message ?? null } : null,
    introVisible: vis(introEl),
    under: (() => { const u = document.elementFromPoint(640, 477); return u && (u.id || String(u.className || '').slice(0, 40) || u.tagName); })(),
    filmChrome: document.body.classList.contains('director-film'),
  };
};

// ── 1. THE LAYER AUDIT ───────────────────────────────────────────────────────
// Deletes the fix's own CSS rule, measures, restores it. The BEFORE column is
// therefore a live measurement of the old build, not a recollection.
const AUDIT = () => {
  const SEL = ['#atlas-intro', '.in-mist', '.in-vignette', '.in-wrap', '.in-title',
    '.in-rule', '.in-sub', '.in-menu', '.in-choice', '.in-esc'];
  const root = document.getElementById('atlas-intro');
  const read = () => {
    const out = {};
    for (const s of SEL) {
      const el = s === '#atlas-intro' ? root : root?.querySelector(s);
      out[s] = el ? getComputedStyle(el).pointerEvents : 'ABSENT';
    }
    out['elementFromPoint(640,477)'] = (() => {
      const u = document.elementFromPoint(640, 477);
      return u ? (u.id ? '#' + u.id : (String(u.className || '').trim().split(/\s+/)[0] ? '.' + String(u.className).trim().split(/\s+/)[0] : u.tagName)) : 'null';
    })();
    return out;
  };
  const after = read();
  // pull the fix rule out of the live sheet → the pre-fix cascade
  const sheet = [...document.styleSheets].find((s) => s.ownerNode?.id === 'atlas-intro-style');
  const idx = [...(sheet?.cssRules ?? [])].findIndex((r) => r.selectorText && /\.in-sub/.test(r.selectorText) && /pointer-events/.test(r.cssText));
  let before = { note: 'fix rule not found' };
  if (sheet && idx >= 0) {
    const txt = sheet.cssRules[idx].cssText;
    sheet.deleteRule(idx);
    before = read();
    sheet.insertRule(txt, idx);
  }
  return { before, after };
};

function launchBrave() {
  try { execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' }); } catch { /* none */ }
  mkdirSync(PROFILE, { recursive: true });
  execSync(`open -n -g -j -a "Brave Browser" --args --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP} --mute-audio --window-size=1280,800 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling about:blank`);
}

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${CDP}`); } catch { await wait(1000); }
  }
  throw new Error('Brave never opened its CDP port');
}

async function passGate(page) {
  const typed = await page.evaluate((pw) => {
    const i = [...document.querySelectorAll('input')].find((x) => x.getClientRects().length);
    if (!i) return false;
    i.focus(); i.value = pw; i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, GATE_PASSWORD);
  if (typed) { await page.keyboard.press('Enter'); await wait(3500); }
  return typed;
}

async function run(browser, tag) {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e).slice(0, 200)));
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
  await page.context().clearCookies();
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(3500);
  await passGate(page);

  if (tag === 'b') {
    const user = `gesturefix-${Date.now()}`;
    const reg = await page.evaluate(async ([u, p, q]) => {
      const r = await fetch(`${q}/auth/register`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p, avatar: { lineage: 'probe' } }) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, user: j?.user?.username ?? null, err: j?.error ?? null };
    }, [user, PASS, QUEST]);
    station(`${tag} register ${user}`, reg.ok, JSON.stringify(reg));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await wait(4000);
    await passGate(page);
  }

  // the screen takes the click
  const t0 = Date.now();
  let ready = null;
  while (Date.now() - t0 < 120000) {
    ready = await page.evaluate(() => {
      const el = document.getElementById('atlas-intro');
      if (!el) return 0;
      const btn = [...el.querySelectorAll('button')].find((e) => e.getClientRects().length && /witness the beginning/i.test(e.textContent || ''));
      return (btn || el.classList.contains('ready')) ? JSON.stringify({ btn: btn?.textContent ?? null, sub: el.querySelector('.in-sub')?.textContent ?? null, cls: el.className }) : 0;
    }).catch(() => 0);
    if (ready) break;
    await wait(300);
  }
  station(`${tag} screen ready`, !!ready, String(ready));
  await page.screenshot({ path: `${SHOTS}/${tag}-01-screen.png` });

  // the audit, on the live screen, before anything is clicked
  const audit = await page.evaluate(AUDIT);
  appendFileSync(LOG, `${tag} LAYER AUDIT ${JSON.stringify(audit)}\n`);
  console.log(`${tag} LAYER AUDIT`, JSON.stringify(audit, null, 1));
  station(`${tag} no passive layer takes the pointer`, ['.in-sub', '.in-title', '.in-rule', '.in-wrap', '.in-esc']
    .every((s) => audit.after[s] === 'none' || audit.after[s] === 'ABSENT'),
  JSON.stringify(audit.after));

  // the wait must name itself BEFORE the click
  const pre = await page.evaluate(SNAP);
  appendFileSync(LOG, `${tag} PRE-CLICK ${JSON.stringify(pre)}\n`);
  station(`${tag} the wait names itself before the click`,
    !!pre.director?.state && (pre.intro?.awaitGesture === true || tag === 'b'),
    JSON.stringify({ dstate: pre.director?.state, dfor: pre.director?.stateFor, waiting: pre.intro?.waiting, under: pre.under }));

  // mute the clock itself: currentTime still advances (LAW)
  await page.evaluate(() => {
    const patch = () => { const el = window.gaia?.director?.director?.audio?.el; if (el) el.muted = true; };
    patch(); setInterval(patch, 200);
  });

  // ── ONE gesture. Path a: the anywhere-click on the eaten pixel. Path b:
  // the menu's own button (a real control, which must still work).
  let what;
  if (tag === 'a' && process.env.KEY) {
    // 'press any button': the same wait, spent with a keystroke and no pointer
    await page.keyboard.press(process.env.KEY === '1' ? 'k' : process.env.KEY);
    what = `ONE keystroke (${process.env.KEY === '1' ? 'k' : process.env.KEY}), no pointer at all`;
  } else if (tag === 'a') {
    await page.mouse.click(HIT.x, HIT.y);
    what = `anywhere-click at (${HIT.x},${HIT.y}) — the pixel .in-sub used to eat`;
  } else {
    const box = await page.evaluate(() => {
      const el = document.getElementById('atlas-intro');
      const btn = [...el.querySelectorAll('button')].find((e) => e.getClientRects().length && /witness the beginning/i.test(e.textContent || ''));
      const r = (btn ?? el).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: btn ? btn.textContent.trim() : '(the screen itself)' };
    });
    await page.mouse.click(box.x, box.y);
    what = box.what;
  }
  station(`${tag} clicked ONCE`, true, what);

  const snaps = []; const shots = [];
  for (const at of [2, 5, 8, 12]) {
    await wait(at === 2 ? 2000 : at === 12 ? 4000 : 3000);
    const s = await page.evaluate(SNAP);
    snaps.push({ at, s });
    appendFileSync(LOG, `${tag} t+${at}s ${JSON.stringify(s)}\n`);
    const buf = await page.screenshot({ path: `${SHOTS}/${tag}-02-plus${at}s.png` });
    shots.push({ at, sha: createHash('sha256').update(buf).digest('hex').slice(0, 12), bytes: buf.length });
  }

  const five = snaps.find((x) => x.at === 5).s;
  const d5 = five.director ?? {};
  station(`${tag} t advancing ≥3 by +5s`, (d5.t ?? 0) >= 3, JSON.stringify({ t: d5.t, state: d5.state, clock: d5.clock, audioT: d5.audioT }));
  station(`${tag} playing:true by +5s`, !!d5.playing, JSON.stringify({ playing: d5.playing, state: d5.state }));
  station(`${tag} title gone by +5s`, !five.introVisible, `introVisible=${five.introVisible}`);
  station(`${tag} status() is never silent`, snaps.every((x) => !!x.s.director?.state), JSON.stringify(snaps.map((x) => [x.at, x.s.director?.state, x.s.director?.t])));
  station(`${tag} the clock is the audio element, and it is silent`, d5.clock === 'audio' && five.audio?.muted === true, JSON.stringify(five.audio));
  station(`${tag} status().error empty`, !d5.error, JSON.stringify(d5.error ?? null));
  const uniq = new Set(shots.map((x) => x.sha)).size;
  station(`${tag} the picture changes across +2/5/8/12s`, uniq >= 3, JSON.stringify(shots));
  station(`${tag} zero console errors`, errs.length === 0, errs.slice(0, 4).join(' | '));
  await page.close();
  return { tag, errs, audit };
}

const which = process.argv[2] ?? 'both';
writeFileSync(LOG, `gesture-fix probe ${new Date().toISOString()} — ${URL_} — path ${which}${process.env.KEY ? ` — KEYSTROKE gesture (${process.env.KEY})` : ''}\n`);
launchBrave();
const browser = await connect();
if (which === 'a' || which === 'both') await run(browser, 'a');
if (which === 'b' || which === 'both') await run(browser, 'b');
const verdict = stations.every((s) => s.ok);
console.log('\nVERDICT:', verdict ? 'PASS' : 'FAIL', `(${stations.filter((s) => !s.ok).length} failing)`);
appendFileSync(LOG, `\nVERDICT ${verdict ? 'PASS' : 'FAIL'}\n`);
try { execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(verdict ? 0 : 1);
