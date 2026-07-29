// tools/start-fix-brave.mjs — THE VISUAL PROOF (start-fix lane).
//
// Headless chromium cannot judge this film on this machine: it has no Metal
// WebGPU adapter (SwiftShader → the film's fragment shaders do not compile,
// GPUPipelineError, and every screenshot is a 4799-byte black frame) and no
// AAC decoder (the mix cannot play, so the clock is the wall clock). Brave —
// hidden, backgrounded and muted — has both: Metal-3 and the proprietary
// decoders. So the PICTURE and the AUDIO CLOCK are proven here, and the state
// machine's stations are proven in tools/start-fix-probe.mjs.
//
// LAW (Pascal, 07-28): no unmuted browser may exist — `--mute-audio` on the
// process, and this script also asserts the element is silent (muted=true)
// while currentTime advances, so the clock is measured without a sound.
//
// Usage: node tools/start-fix-brave.mjs [a|b|both]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'proof', 'start-fix', 'brave');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, 'stations.log');
const PROFILE = join(REPO, '.scratch', 'start-fix', 'brave');
const CDP = Number(process.env.CDP_PORT ?? 9231);
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
  console.log(line.slice(0, 300));
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
    filmChrome: document.body.classList.contains('director-film'),
  };
};

function launchBrave() {
  try { execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' }); } catch { /* none running */ }
  mkdirSync(PROFILE, { recursive: true });
  // -g -j: no activation, no window brought forward — the browser never takes
  // the screen. --mute-audio: the process itself is silent (LAW).
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
  const ctx = await browser.newContext ? null : null;
  // connectOverCDP hands back the real browser: use its default context, and
  // clear the site's storage between paths so (a) is a genuine first visit
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
  await page.screenshot({ path: `${SHOTS}/${tag}-01-gate.png` });

  if (tag === 'b') {
    const user = `startfix-${Date.now()}`;
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
      return (btn || el.classList.contains('ready')) ? JSON.stringify({ btn: btn?.textContent ?? null, cls: el.className }) : 0;
    }).catch(() => 0);
    if (ready) break;
    await wait(300);
  }
  station(`${tag} screen ready`, !!ready, String(ready));
  await page.screenshot({ path: `${SHOTS}/${tag}-02-screen.png` });

  // MUTE THE CLOCK ITSELF before the click: currentTime still advances, so the
  // audio clock is measured in silence (LAW).
  await page.evaluate(() => {
    const d = window.gaia?.director?.director;
    if (d?.audio?.el) d.audio.el.muted = true;
    const patch = () => { const el = window.gaia?.director?.director?.audio?.el; if (el) el.muted = true; };
    setInterval(patch, 200);
  });

  const box = await page.evaluate(() => {
    const el = document.getElementById('atlas-intro');
    const btn = [...el.querySelectorAll('button')].find((e) => e.getClientRects().length && /witness the beginning/i.test(e.textContent || ''));
    const target = btn ?? el;
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, what: btn ? btn.textContent.trim() : '(the title screen itself)' };
  });
  await page.mouse.click(box.x, box.y);
  station(`${tag} clicked`, true, box.what);

  const snaps = [];
  const shots = [];
  for (const at of [2, 5, 8, 12]) {
    await wait(at === 2 ? 2000 : at === 12 ? 4000 : 3000);
    const s = await page.evaluate(SNAP);
    snaps.push({ at, s });
    appendFileSync(LOG, `${tag} t+${at}s ${JSON.stringify(s)}\n`);
    const buf = await page.screenshot({ path: `${SHOTS}/${tag}-03-plus${at}s.png` });
    shots.push({ at, sha: createHash('sha256').update(buf).digest('hex').slice(0, 12), bytes: buf.length });
  }

  const five = snaps.find((x) => x.at === 5).s;
  const d5 = five.director ?? {};
  station(`${tag} film rolling by +5s`, !!(d5.playing && d5.t > 0.2), JSON.stringify({ t: d5.t, playing: d5.playing, clock: d5.clock, audioT: d5.audioT, error: d5.error }));
  station(`${tag} the audio element IS the clock`, d5.clock === 'audio' && (d5.audioT ?? 0) > 0.2, JSON.stringify(five.audio));
  station(`${tag} and it is silent`, five.audio?.muted === true, JSON.stringify({ muted: five.audio?.muted }));
  station(`${tag} title gone by +5s`, !five.introVisible, `introVisible=${five.introVisible}`);
  station(`${tag} status().error empty`, !d5.error, JSON.stringify(d5.error ?? null));
  const uniq = new Set(shots.map((x) => x.sha)).size;
  station(`${tag} the picture changes across +2/5/8/12s`, uniq >= 3, JSON.stringify(shots));
  station(`${tag} zero console errors`, errs.length === 0, errs.slice(0, 4).join(' | '));
  await page.close();
  return { tag, errs };
}

const which = process.argv[2] ?? 'both';
writeFileSync(LOG, `start-fix BRAVE proof ${new Date().toISOString()} — ${URL_} — path ${which}\n`);
launchBrave();
const browser = await connect();
if (which === 'a' || which === 'both') await run(browser, 'a');
if (which === 'b' || which === 'both') await run(browser, 'b');
const verdict = stations.every((s) => s.ok);
console.log('\nVERDICT:', verdict ? 'PASS' : 'FAIL', `(${stations.filter((s) => !s.ok).length} failing)`);
appendFileSync(LOG, `\nVERDICT ${verdict ? 'PASS' : 'FAIL'}\n`);
try { execSync(`pkill -f "user-data-dir=${PROFILE}"`, { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(verdict ? 0 : 1);
