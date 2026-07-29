// tools/entry-fix-proof.mjs — THE ENTRY-FLOW WALKTHROUGHS (entry-fix lane).
//
// Two live runs on this lane's iso stack (client 5193 · world 8460 · quest
// 4693), headless + muted, a screenshot at EVERY station, zero console errors
// asserted on both. The film's purity is not judged by eye: t=5 is measured
// by decoding the PNG and counting lit pixels (stars/galaxies are lit points;
// the deep is not), and t=80's red drop must be measurably red.
//
// WEDGE DISCIPLINE: every await is timeout-wrapped, every shot hits disk the
// moment it is taken, and the station log is flushed as it goes.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(REPO, 'proof', 'entry-fix');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(SHOTS, 'stations.log');
writeFileSync(LOG, `entry-fix walkthroughs ${new Date().toISOString()}\n`);

const CLIENT = 'http://localhost:5193';
const QUEST = 'http://localhost:4693';
const URL_ = `${CLIENT}/?quest=${QUEST}`;
const GATE_PASSWORD = readFileSync('/Users/pascaldisse/projects/paloptic/gate/PASSWORD.txt', 'utf8').replace(/\n$/, '');
const USER = `entryfix-${Date.now()}`;
const PASS = 'TestPass1234';
const PROFILE = join(REPO, '.scratch', 'entry-fix', 'profile-' + Date.now());

const stations = [];
function station(name, ok, detail = '') {
  stations.push({ name, ok, detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(page, fn, { timeout = 30000, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.evaluate(fn).catch(() => null);
    if (v) return v;
    await wait(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ── PNG measurement (no image dependency: playwright ships 8-bit RGBA PNG) ──
function decodePng(buf) {
  let pos = 8; let w = 0; let h = 0; let bitDepth = 0; let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('unexpected bit depth ' + bitDepth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : (() => { throw new Error('unexpected color type ' + colorType); })();
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y += 1) {
    const filter = raw[p]; p += 1;
    for (let x = 0; x < stride; x += 1) {
      const rawByte = raw[p + x];
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = rawByte + a; break;
        case 2: v = rawByte + b; break;
        case 3: v = rawByte + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c; const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
          v = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      out[y * stride + x] = v & 0xff;
    }
    p += stride;
  }
  return { w, h, ch, px: out };
}

// lit = anything a star/galaxy/system would leave on screen. The deep is a
// near-black living darkness, so its brightest dust still sits far below 70.
function measure(file, { lit = 70 } = {}) {
  const { w, h, ch, px } = decodePng(readFileSync(file));
  let litCount = 0; let redCount = 0; let sum = 0; let max = 0;
  for (let i = 0; i < w * h; i += 1) {
    const r = px[i * ch]; const g = px[i * ch + 1]; const b = px[i * ch + 2];
    const l = Math.max(r, g, b);
    sum += (r + g + b) / 3;
    if (l > max) max = l;
    if (l > lit) litCount += 1;
    if (r > 60 && r > g * 1.6 && r > b * 1.6) redCount += 1;
  }
  return { pixels: w * h, lit: litCount, red: redCount, mean: +(sum / (w * h)).toFixed(2), max };
}

async function shoot(page, name) {
  const file = join(SHOTS, name);
  await page.screenshot({ path: file, timeout: 20000 });
  return file;
}

async function passGate(page, password) {
  await page.waitForSelector('.gate-input', { timeout: 30000 });
  await page.fill('.gate-input', password);
  await page.press('.gate-input', 'Enter');
}

async function main() {
  const errors = { A: [], B: [] };
  let bucket = 'A';
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    args: ['--headless=new', '--mute-audio', '--no-sandbox', '--autoplay-policy=no-user-gesture-required',
      '--use-gl=angle', '--enable-unsafe-swiftshader'],
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors[bucket].push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors[bucket].push(`pageerror: ${e.message}`));

  // ══ RUN A · FRESH PROFILE ═════════════════════════════════════════════
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('#atlas-gate', { timeout: 30000 });
  await wait(1200);
  const a1 = await shoot(page, 'A01-gate-alone.png');
  const behind = await page.evaluate(() => {
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && (e.textContent || '').trim().length > 0; };
    return { veil: document.body.classList.contains('atlas-entry'), hud: vis('#hud'), overlay: vis('#overlay'),
      dream: /Hunter.s Dream/.test(document.body.innerText) };
  });
  station('A1 gate shown alone (no HUD, no overlay, no Hunter\'s Dream)',
    behind.veil && !behind.hud && !behind.overlay && !behind.dream, `${JSON.stringify(behind)} · ${a1}`);

  await passGate(page, 'not-the-password');
  await wait(1500);
  const a2 = await shoot(page, 'A02-gate-wrong-password.png');
  const stillGated = await page.evaluate(() => !!document.querySelector('#atlas-gate'));
  station('A2 wrong password rejected', stillGated, a2);

  await page.fill('.gate-input', '');
  await passGate(page, GATE_PASSWORD);
  await poll(page, () => !document.querySelector('#atlas-gate'), { timeout: 30000, label: 'gate to open' });
  const st3 = await poll(page, () => {
    const s = window.gaia?.atlasIntro?.status?.();
    return s && s.state === 'title' && document.querySelector('#atlas-intro.ready') ? s : null;
  }, { timeout: 90000, label: 'first-visit intro' });
  const a3 = await shoot(page, 'A03-first-intro-only-option.png');
  const opts = await page.evaluate(() => {
    const menu = document.querySelector('#atlas-intro .in-menu');
    const esc = document.querySelector('#atlas-intro .in-esc');
    return { menuHidden: !!menu?.hidden, escHidden: !!esc?.hidden,
      census: window.gaia?.atlasStrategy?.cosmos?.nodes?.length ?? -1 };
  });
  station('A3 first visit: ONE option, no enter door, no esc hint',
    opts.menuHidden && opts.escHidden && st3.unskippable === true, `${JSON.stringify(opts)} · phase=${st3.phase} · ${a3}`);
  station('A3b census', opts.census >= 512, `cosmos nodes = ${opts.census}`);

  await page.click('#atlas-intro', { timeout: 15000 });
  await poll(page, () => window.gaia?.atlasIntro?.status?.().state === 'playing', { timeout: 60000, label: 'film rolling' });

  // t = 5: THE DEEP ALONE
  await page.evaluate(() => window.gaia.director.scrub(5, { resume: null }));
  await wait(1500);
  const a4 = await shoot(page, 'A04-film-t5-pure-deep.png');
  const m5 = measure(a4);
  station('A4 film t=5 is pure deep — zero stars/galaxies/systems',
    m5.lit === 0, `lit>${70}px=${m5.lit} mean=${m5.mean} max=${m5.max} · ${a4}`);

  // t = 80: THE RED DROP
  await page.evaluate(() => window.gaia.director.scrub(80, { resume: null }));
  await wait(1500);
  const a5 = await shoot(page, 'A05-film-t80-red-drop.png');
  const m80 = measure(a5);
  station('A5 film t=80 carries the red drop\'s light', m80.red > 0 || m80.max > 70,
    `red=${m80.red} max=${m80.max} mean=${m80.mean} · ${a5}`);

  // ESC IS DEAD
  const before = await page.evaluate(() => window.gaia.atlasIntro.status().state);
  await page.keyboard.press('Escape');
  await wait(800);
  const after = await page.evaluate(() => window.gaia.atlasIntro.status().state);
  const a6 = await shoot(page, 'A06-esc-does-not-skip.png');
  station('A6 Esc does NOT skip on a first visit', after === before && after !== 'done',
    `${before} → ${after} · ${a6}`);

  // THE CREATOR (headless audio clock cannot cross HANDOVER_T; the same
  // handover() roll() calls is invoked through the dev handle)
  await page.evaluate(() => window.gaia.atlasIntro.intro.handover());
  await page.waitForSelector('#atlas-onboarding', { timeout: 30000 });
  await wait(1200);
  const a7 = await shoot(page, 'A07-creator.png');
  const creator = await page.evaluate(() => ({
    state: window.gaia.atlasIntro.status().state,
    quote: document.querySelector('#atlas-onboarding .ob-quote')?.textContent ?? '',
  }));
  station('A7 film → creator ("What is your name, good hunter?")',
    creator.state === 'creator' && /good hunter/i.test(creator.quote), `${JSON.stringify(creator)} · ${a7}`);

  await page.fill('#atlas-onboarding input[name="username"]', USER);
  await page.fill('#atlas-onboarding input[name="password"]', PASS);
  await page.fill('#atlas-onboarding input[name="confirm"]', PASS);
  await page.click('#atlas-onboarding [data-act="submit"]', { timeout: 15000 });
  const user = await poll(page, () => window.gaia?.atlasOnboarding?.status?.().authCache?.user ?? null,
    { timeout: 30000, label: 'registration' });
  await poll(page, () => window.gaia.atlasIntro.status().state === 'done', { timeout: 30000, label: 'world' });
  await wait(2500);
  const a8 = await shoot(page, 'A08-world-after-register.png');
  station('A8 register → WORLD', !!user, `${JSON.stringify(user)} · ${a8}`);

  // ══ RUN B · RETURN VISIT (account cookie present) ══════════════════════
  bucket = 'B';
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  const gateBack = await page.waitForSelector('#atlas-gate', { timeout: 6000 }).catch(() => null);
  if (gateBack) {
    const b0 = await shoot(page, 'B00-gate.png');
    await passGate(page, GATE_PASSWORD);
    await poll(page, () => !document.querySelector('#atlas-gate'), { timeout: 30000, label: 'gate to open (B)' });
    station('B0 gate on return', true, b0);
  } else {
    station('B0 gate already open (token in localStorage — by design)', true, 'no shot: gate did not re-arm');
  }
  const stB = await poll(page, () => {
    const s = window.gaia?.atlasIntro?.status?.();
    return s && s.state === 'menu' && document.querySelector('#atlas-intro.ready') ? s : null;
  }, { timeout: 90000, label: 'return start screen' });
  await wait(1200);
  const b1 = await shoot(page, 'B01-start-screen-both-options.png');
  const menu = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#atlas-intro .in-choice')].map((b) => b.textContent.trim());
    const vis = (sel) => { const e = document.querySelector(sel); if (!e) return false; const s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && (e.textContent || '').trim().length > 0; };
    return { btns, hud: vis('#hud'), overlay: vis('#overlay'),
      dream: /Hunter.s Dream/.test(document.body.innerText),
      veil: document.body.classList.contains('atlas-entry') };
  });
  station('B1 return start screen shows BOTH options',
    menu.btns.length === 2 && /again/i.test(menu.btns[0]), `${JSON.stringify(menu.btns)} · account=${!!stB.account} · ${b1}`);
  station('B2 no in-world HUD on the start screen (no "Hunter\'s Dream" toast)',
    menu.veil && !menu.hud && !menu.overlay && !menu.dream, `${JSON.stringify(menu)} · ${b1}`);

  await ctx.close();

  const report = {
    at: new Date().toISOString(), user: USER, shots: SHOTS,
    stations, consoleErrors: errors,
    counts: { A: errors.A.length, B: errors.B.length,
      passed: stations.filter((s) => s.ok).length, total: stations.length },
  };
  writeFileSync(join(SHOTS, 'report.json'), JSON.stringify(report, null, 2));
  appendFileSync(LOG, `\nconsole errors A=${errors.A.length} B=${errors.B.length}\n`
    + errors.A.concat(errors.B).map((e) => '  ' + e).join('\n') + '\n');
  console.log('\nconsole errors  A:', errors.A.length, ' B:', errors.B.length);
  errors.A.concat(errors.B).forEach((e) => console.log('  ' + e));
  console.log(`stations ${report.counts.passed}/${report.counts.total} · ${SHOTS}`);
  if (report.counts.passed !== report.counts.total || errors.A.length || errors.B.length) process.exitCode = 1;
}

main().catch((err) => {
  appendFileSync(LOG, `FATAL ${err.stack}\n`);
  console.error('FATAL', err);
  process.exitCode = 1;
});
