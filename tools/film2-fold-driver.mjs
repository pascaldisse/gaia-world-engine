// FILM2 FOLD · boot smoke + the real-time strip. One CDP session, one run.
//
//   node tools/film2-fold-driver.mjs smoke
//   node tools/film2-fold-driver.mjs strip
//
// Laws obeyed here: the browser is hidden + --mute-audio (tools/film2-fold-stack.sh),
// screenshots go through CDP Page.captureScreenshot (an in-page readback of a
// WebGPU canvas is black), the two gates (atlas_gate, atlas_seen_intro) are
// set before anything is measured, and the clock read is the film's own audio
// element — never a wall clock.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const CDP = Number(process.env.CDP_PORT ?? 9256);
const PORT = Number(process.env.GAIA_CLIENT_PORT ?? 5196);
const OUT = process.env.OUT ?? 'proof/film2-fold';
const cmd = process.argv[2] ?? 'smoke';

const list = await (await fetch(`http://localhost:${CDP}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.includes(`${PORT}`)) ?? list.find((t) => t.type === 'page');
if (!page) throw new Error('no page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
let id = 0;
const pend = new Map();
const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    logs.push({ kind: m.params.type, text: m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ') });
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push({ kind: 'exception', text: m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text });
  }
});
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const m = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (m.result?.exceptionDetails) return { error: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text };
  return m.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gates, then a reload so the page boots past them
// A RELOAD WOULD KILL A ROLLING FILM: `grab` runs in short processes while the
// take continues in the browser, so never navigate a page that is already up.
const booted = await ev('!!(window.gaia?.atlasStrategy?.cosmos?.ready)');
if (booted !== true) {
  await ev(`localStorage.setItem('atlas_gate','8fc666825e1a4b06'); localStorage.setItem('atlas_seen_intro','1'); 1`);
  await send('Page.navigate', { url: `http://localhost:${PORT}/?static=1&mute=1&intro=off` });
  for (let i = 0; i < 90; i += 1) {
    await sleep(1000);
    const ready = await ev('!!(window.gaia?.atlasStrategy?.cosmos?.ready)');
    if (ready === true) break;
  }
}
const census = await ev('window.gaia?.atlasStrategy?.cosmos?.nodes?.length ?? -1');

if (cmd === 'smoke') {
  const out = { census, steps: [] };
  // Witness click = a REAL user gesture (the audio graph needs activation)
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll('button, .atlas-gate-btn, #atlas-intro button, [data-action]')]
      .find((x) => /witness|begin|enter/i.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim() };
  })()`);
  out.witness = btn;
  if (btn) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    }
  } else {
    await ev(`window.gaia?.director?.play?.({ audio: true, mode: 'live' })`);
  }
  await sleep(6000);
  const a1 = await ev(`(() => { const d = window.gaia?.director?.director; const el = d?.audio?.el;
    return { t: d?.t ?? null, audioT: el?.currentTime ?? null, paused: el?.paused ?? null, muted: el?.muted ?? null, playing: d?.playing ?? null, waiting: d?.waitingForAudio ?? null }; })()`);
  await sleep(5000);
  const a2 = await ev(`(() => { const d = window.gaia?.director?.director; const el = d?.audio?.el;
    return { t: d?.t ?? null, audioT: el?.currentTime ?? null, paused: el?.paused ?? null }; })()`);
  out.clock = { at6s: a1, at11s: a2, advanced: (a2?.audioT ?? 0) > (a1?.audioT ?? 0) };
  out.film2 = await ev(`JSON.parse(JSON.stringify(window.gaia?.film2?.status?.() ?? null))`);
  const scrub = await ev(`window.gaia?.director?.scrub?.(160).then((r) => JSON.parse(JSON.stringify(r)))`);
  await sleep(2500);
  out.scrub = { result: scrub, after: await ev(`(() => ({ t: window.gaia?.director?.director?.t, seg: window.gaia?.film2?.status?.().current }))()`) };
  out.console = logs;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'boot-smoke.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  ws.close();
  process.exit(0);
}

// strip-fix: re-shoot ONLY the fixed windows, in REAL TIME (same rig, 1 fps).
// Each range is played from a lead-in before its first frame so the segments
// are entered by the clock, never by a bare seek at the frame itself.
// roll <t> : put the rolling film at t (real playback, audio clock authoritative)
if (cmd === 'roll') {
  const at = Number(process.argv[3] ?? 0);
  if (!(await ev('!!window.gaia?.film2'))) {
    const btn = await ev(`(() => {
      const b = [...document.querySelectorAll('button, .atlas-gate-btn, #atlas-intro button, [data-action]')]
        .find((x) => /witness|begin|enter/i.test(x.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (btn) for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    else await ev(`window.gaia?.director?.play?.({ audio: true, mode: 'live' })`);
    await sleep(9000);
  }
  // THE AUDIO ELEMENT ONLY EXISTS ONCE play() HAS BUILT IT — scrub() alone
  // leaves the film on a virtual clock, i.e. frozen. Spend the gesture, then
  // play FROM the lead-in: this is the real-time take.
  const hasAudio = await ev(`!!window.gaia?.director?.director?.audio?.el`);
  if (!hasAudio) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: 640, y: 690, button: 'left', clickCount: 1 });
    }
    await ev(`window.gaia.director.play({ from: ${at}, audio: true, gesture: true, mode: 'live' })`);
    await sleep(4000);
  }
  await ev(`window.gaia?.director?.scrub?.(${at}, { resume: true })`);
  await sleep(1500);
  // THE CLOCK IS THE AUDIO ELEMENT: if it is still paused the film is frozen,
  // whatever the transport thinks. Spend a real gesture, then press play.
  for (let i = 0; i < 3; i += 1) {
    const paused = await ev(`window.gaia?.director?.director?.audio?.el?.paused ?? true`);
    if (paused !== true) break;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: 640, y: 700, button: 'left', clickCount: 1 });
    }
    await ev(`(async () => { const d = window.gaia?.director?.director; try { await d.audio.ctx.resume(); } catch {} ; d.audio.el.currentTime = ${at}; await d.audio.el.play().catch(() => {}); await d.resume(${at}); return 1; })()`);
    await sleep(1500);
  }
  await sleep(1000);
  // DISMISS THE INTRO, LIKE A USER. #atlas-intro is display:flex with an OPAQUE
  // BLACK background at z-index 2147483000 over the whole viewport, and the
  // deny-all sweep deliberately ALLOWS it (its mist belongs to the film). So a
  // whitelist can never catch it: the film rolled correctly underneath while
  // every frame photographed 'THE BEGINNING / ENTER THE DREAM'.
  // It survived because roll() only clicks the gate when window.gaia.film2 is
  // absent — on an already-booted page it skipped the click, and nothing else
  // ever takes the intro down. Dismiss it the way the player does, then VERIFY.
  for (let i = 0; i < 4; i += 1) {
    const up = await ev(`(() => { const el = document.querySelector('#atlas-intro');
      return !!el && getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).opacity) > 0.02; })()`);
    if (up !== true) break;
    const hit = await ev(`(() => {
      const b = [...document.querySelectorAll('#atlas-intro button, #atlas-intro [data-action], #atlas-intro a')]
        .find((x) => /enter the dream|witness|begin|skip/i.test(x.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim() };
    })()`);
    if (hit) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
      }
    } else {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      }
    }
    await sleep(900);
  }
  // ASSERT THE DENY-ALL SWEEP. play() runs it; scrub()/resume() — the path this
  // command actually takes — does not, so the entry gate (#overlay) stayed on
  // screen over a film that was rolling perfectly well underneath it. Every
  // frame of the 2026-07-29 roll photographed the gate.
  const chrome = await ev(`(() => {
    const d = window.gaia?.director?.director;
    if (!d?.setFilmChrome) return { chrome: 'no director' };
    d.setFilmChrome(true);
    const sq = [...document.body.children].filter((el) => {
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02 && r.width > 2 && r.height > 2;
    }).map((el) => el.id || el.tagName.toLowerCase());
    const intro = document.querySelector('#atlas-intro');
    const introUp = !!intro && getComputedStyle(intro).display !== 'none' && Number(getComputedStyle(intro).opacity) > 0.02;
    return { chrome: 'swept', visibleTopLevel: sq, introUp };
  })()`);
  // A ROLL THAT CANNOT SEE THE FILM IS NOT A ROLL.
  if (chrome?.introUp) { console.error('[roll] ABORT: #atlas-intro still covers the frame'); ws.close(); process.exit(2); }
  console.log(JSON.stringify({ ...(await ev(`(() => ({ t: window.gaia?.director?.director?.t, audioT: window.gaia?.director?.director?.audio?.el?.currentTime, paused: window.gaia?.director?.director?.audio?.el?.paused, seg: window.gaia?.film2?.status?.().current }))()`)), ...chrome }));
  ws.close(); process.exit(0);
}

// grab <from> <to> : 1 fps captures OFF THE FILM'S OWN CLOCK while it rolls.
// Survives being split across several short processes — the film keeps rolling
// in the browser between them, so the strip is still one real-time take.
//
// TWO RIG DEFECTS THIS LOOP NOW REFUSES TO REPEAT (both cost a whole void roll
// on 2026-07-29, and both produced files that LOOKED like a strip):
//
//  A · THE SQUATTER. `roll` reaches playback through scrub/resume, which never
//      runs the director's own deny-all chrome sweep. 47 frames photographed
//      the entry gate ("THE BEGINNING / ENTER THE DREAM") with the film running
//      underneath — and since the gate is near-uniform, the exposure table read
//      identical statistics for every frame and looked like a clean result.
//      filmChrome() now asserts the sweep before a single frame is taken.
//
//  B · THE STALL. The audio element paused at 258.219 while the director's
//      virtual clock ran on to 293.394 (paused true, ended FALSE, readyState 4,
//      duration 293.44). Frames are named off the audio clock by law, so the
//      loop wrote the same second forever. A frozen clock is now DETECTED, its
//      cause RECORDED (the full media state, not a guess), and playback resumed;
//      if it will not resume the take ABORTS instead of filing a strip of one
//      repeated second.
const filmChrome = async () => ev(`(() => {
  const d = window.gaia?.director?.director;
  if (!d?.setFilmChrome) return { chrome: 'no director' };
  d.setFilmChrome(true);
  const sq = [...document.body.children].filter((el) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.02 && r.width > 2 && r.height > 2;
  }).map((el) => el.id || el.tagName.toLowerCase());
  const intro = document.querySelector('#atlas-intro');
  const introUp = !!intro && getComputedStyle(intro).display !== 'none' && Number(getComputedStyle(intro).opacity) > 0.02;
  return { chrome: 'swept', visibleTopLevel: sq, introUp };
})()`);

// The media state at the moment of a freeze — every field that could explain
// it, so the cause is read off the page instead of reasoned about.
const mediaState = async () => ev(`(() => {
  const d = window.gaia?.director?.director; const el = d?.audio?.el;
  return {
    audioT: el?.currentTime ?? -1, virtualT: d?.t ?? null, paused: el?.paused ?? null,
    ended: el?.ended ?? null, duration: el?.duration ?? null, readyState: el?.readyState ?? null,
    networkState: el?.networkState ?? null, muted: el?.muted ?? null, volume: el?.volume ?? null,
    playbackRate: el?.playbackRate ?? null, seeking: el?.seeking ?? null,
    ctxState: d?.audio?.ctx?.state ?? null, playing: d?.playing ?? null,
    visibility: document.visibilityState, hidden: document.hidden,
    seg: window.gaia?.film2?.status?.().current ?? null,
  };
})()`);

const resumeFilm = async (at) => ev(`(async () => {
  const d = window.gaia?.director?.director; const el = d?.audio?.el;
  if (!el) return { resumed: false, why: 'no audio element' };
  try { if (d.audio?.ctx?.state === 'suspended') await d.audio.ctx.resume(); } catch {}
  try { await el.play(); } catch (e) { return { resumed: false, why: String(e?.message ?? e) }; }
  try { await d.resume?.(${at}); } catch {}
  return { resumed: !el.paused, audioT: el.currentTime, ctxState: d.audio?.ctx?.state ?? null };
})()`);

if (cmd === 'grab') {
  const from = Number(process.argv[3]);
  const to = Number(process.argv[4]);
  const budget = Number(process.env.BUDGET_MS ?? 55000);
  const dir = path.join(OUT, process.env.STRIP_DIR ?? 'strip-fix');
  fs.mkdirSync(dir, { recursive: true });
  const chrome = await filmChrome();
  // The intro is opaque black at max z-index and the sweep ALLOWS it; if it is
  // still up, every frame would photograph the gate instead of the film (and
  // being near-uniform, it would even measure as a clean, consistent result).
  if (chrome?.introUp) { console.error('[grab] ABORT: #atlas-intro covers the frame — run `roll` first'); ws.close(); process.exit(2); }
  const stalls = [];
  const t0 = Date.now();
  let next = from;
  let lastAt = -1;
  let lastMoveAt = Date.now();
  let aborted = null;
  while (next <= to && Date.now() - t0 < budget) {
    const at = await ev(`window.gaia?.director?.director?.audio?.el?.currentTime ?? -1`);
    if (typeof at !== 'number' || at < 0) { console.log('no clock'); break; }
    if (at >= to + 1.2) break;

    // THE CLOCK MUST MOVE. Whether the element admits `paused` or simply stops
    // advancing, a clock that has not moved in STALL_MS is a stall, and a
    // stalled clock may not name a frame.
    if (at > lastAt + 1e-3) { lastAt = at; lastMoveAt = Date.now(); }
    else if (Date.now() - lastMoveAt > Number(process.env.STALL_MS ?? 2500)) {
      const before = await mediaState();
      const fix = await resumeFilm(at);
      await sleep(500);
      const after = await mediaState();
      stalls.push({ at, before, fix, after, wall: new Date().toISOString() });
      console.error(`[grab] STALL at audioT=${at} — ${JSON.stringify(before)} -> resume ${JSON.stringify(fix)}`);
      lastMoveAt = Date.now();
      if (!fix?.resumed && after.audioT <= at + 1e-3) {
        aborted = `film would not resume at ${at} (paused=${after.paused} ended=${after.ended} readyState=${after.readyState} ctx=${after.ctxState})`;
        break;
      }
      continue;
    }

    if (at >= next) {
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      const d = shot.result?.data;
      const n = Math.max(next, Math.floor(at));   // clock law: audio time names the frame
      if (d) fs.writeFileSync(path.join(dir, `f${String(n).padStart(3, '0')}.jpg`), Buffer.from(d, 'base64'));
      next = n + 1;
    } else await sleep(120);
  }
  const out = { nextWanted: next, clock: await ev(`window.gaia?.director?.director?.audio?.el?.currentTime ?? -1`), chrome, stalls, aborted };
  fs.writeFileSync(path.join(dir, 'grab-log.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out));
  ws.close(); process.exit(aborted ? 2 : 0);
}

// subs <from> <to> : per-frame {t, activeSubtitle} off the film's own clock,
// plus the cue table the director built from lyrics.json, so a line seen on
// screen can be checked against the WORD TIMES it came from.
if (cmd === 'subs') {
  const from = Number(process.argv[3]);
  const to = Number(process.argv[4]);
  const dir = path.join(OUT, process.env.STRIP_DIR ?? 'subtitle-check');
  fs.mkdirSync(dir, { recursive: true });
  const cues = await ev(`JSON.parse(JSON.stringify(window.gaia?.director?.director?.cues ?? []))`);
  const shots = process.env.SHOTS === '1';
  const rows = [];
  let next = from;
  const t0 = Date.now();
  while (next <= to && Date.now() - t0 < Number(process.env.BUDGET_MS ?? 120000)) {
    const st = await ev(`(() => { const d = window.gaia?.director?.director;
      return { t: d?.t ?? null, audioT: d?.audio?.el?.currentTime ?? -1, cueIndex: d?.cueIndex ?? null,
               subText: d?.subText ?? '', domSub: document.querySelector('#atlas-director-ui .dir-sub')?.textContent ?? '',
               subOn: document.querySelector('#atlas-director-ui .dir-sub')?.classList.contains('on') ?? false,
               seg: window.gaia?.film2?.status?.().current ?? null }; })()`);
    const at = st?.audioT ?? -1;
    if (!(at >= 0)) { console.log('no clock'); break; }
    if (at >= to + 1.2) break;
    if (at >= next) {
      const n = Math.max(next, Math.floor(at));
      if (shots) {
        const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
        if (shot.result?.data) fs.writeFileSync(path.join(dir, `f${String(n).padStart(3, '0')}.jpg`), Buffer.from(shot.result.data, 'base64'));
      }
      rows.push({ frame: n, ...st });
      next = n + 1;
    } else await sleep(100);
  }
  fs.writeFileSync(path.join(dir, `subs-${from}-${to}.json`), JSON.stringify({ cues, rows }, null, 2));
  console.log(JSON.stringify({ rows: rows.length, cues: cues.length, last: rows.at(-1) }));
  ws.close(); process.exit(0);
}

if (cmd === 'strip-fix') {
  const dir = path.join(OUT, 'strip-fix');
  fs.mkdirSync(dir, { recursive: true });
  const RANGES = JSON.parse(process.env.RANGES ?? '[[110,130,105],[225,293,220]]');   // [from, to, leadIn]
  // THE FILM MUST BE ROLLING BEFORE A SCRUB MEANS ANYTHING: window.gaia.film2
  // only exists once play() has run, and the audio clock only advances after a
  // real gesture. Same witness click as `smoke`.
  const btn = await ev(`(() => {
    const b = [...document.querySelectorAll('button, .atlas-gate-btn, #atlas-intro button, [data-action]')]
      .find((x) => /witness|begin|enter/i.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (btn) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    }
  } else {
    await ev(`window.gaia?.director?.play?.({ audio: true, mode: 'live' })`);
  }
  await sleep(8000);
  console.log('rolling:', JSON.stringify(await ev(`(() => ({ t: window.gaia?.director?.director?.t, audioT: window.gaia?.director?.director?.audio?.el?.currentTime, seg: window.gaia?.film2?.status?.().current }))()`)));
  for (const [from, to, lead] of RANGES) {
    await ev(`window.gaia?.director?.scrub?.(${lead})`);
    await sleep(3000);
    await ev(`(() => { const d = window.gaia?.director?.director; d.resume(${lead}); return 1; })()`);
    // A FRAME IS NAMED BY THE FILM'S CLOCK, NEVER BY THE WALL CLOCK.
    // (07-29) The old wall-clock loop below is what put the 220.56s line
    // "Whispers to the sleeping one" into a frame called f279: whenever the
    // audio clock lagged the wall (a seek settle, a shader compile), every
    // later frame carried a name the picture did not belong to. The subtitle
    // "drift" was this, and only this — see proof/film2-fold/subtitle-check.
    for (let n = lead; n <= to; n += 1) {
      for (;;) {
        const at = await ev(`window.gaia?.director?.director?.audio?.el?.currentTime ?? -1`);
        if (typeof at !== 'number' || at < 0) break;
        if (at >= n) break;
        await sleep(80);
      }
      if (n < from) continue;
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      const data = shot.result?.data;
      const at = await ev(`window.gaia?.director?.director?.audio?.el?.currentTime ?? -1`);
      const name = typeof at === 'number' && at >= 0 ? Math.floor(at) : n;
      if (data) fs.writeFileSync(path.join(dir, `f${String(name).padStart(3, '0')}.jpg`), Buffer.from(data, 'base64'));
      if (n % 10 === 0) {
        const st = await ev(`(() => ({ t: window.gaia?.director?.director?.t, seg: window.gaia?.film2?.status?.().current }))()`);
        console.log(n, JSON.stringify(st));
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'strip-fix-console.json'), JSON.stringify(logs, null, 2));
  console.log('strip-fix done', dir);
  ws.close();
  process.exit(0);
}

if (cmd === 'strip') {
  const dir = path.join(OUT, 'strip');
  fs.mkdirSync(dir, { recursive: true });
  await ev(`window.gaia?.director?.scrub?.(0)`);
  await sleep(3000);
  await ev(`(() => { const d = window.gaia?.director?.director; d.resume(0); return 1; })()`);
  const t0 = Date.now();
  for (let n = 0; n < 293; n += 1) {
    const want = t0 + n * 1000;
    const wait = want - Date.now();
    if (wait > 0) await sleep(wait);
    const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
    const data = shot.result?.data;
    if (data) fs.writeFileSync(path.join(dir, `f${String(n).padStart(3, '0')}.jpg`), Buffer.from(data, 'base64'));
    if (n % 30 === 0) {
      const st = await ev(`(() => ({ t: window.gaia?.director?.director?.t, seg: window.gaia?.film2?.status?.().current }))()`);
      console.log(n, JSON.stringify(st));
    }
  }
  fs.writeFileSync(path.join(OUT, 'strip-console.json'), JSON.stringify(logs, null, 2));
  console.log('strip done', dir);
  ws.close();
  process.exit(0);
}
