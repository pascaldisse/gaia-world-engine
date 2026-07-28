// scrubber-proof.mjs — headless proof for the director's scrubber (film lane D).
//
// Two passes:
//   dry   ?intro=off, director.play({ audio:false }) — the automation clock.
//         Toggle the scrubber with the real secret key, seek to five chapters
//         with real mouse events, assert the WORLD (entered scenes, chapter,
//         camera, subtitle cue) at each one, then the keyboard transport.
//   live  the real front door: gate token pre-seeded, first-visit title screen,
//         one real click (the audio gesture), audio:true. Asserts the A/V lock
//         (audio.el.currentTime IS the director's clock after a scrub), the
//         handover, the scrub BACK through a completed handover, and that Esc
//         closes the scrubber WITHOUT skipping the intro (and skips once the
//         scrubber is closed).
//
// usage:  CDP_PORT=9228 GAIA_CLIENT_PORT=5180 node tools/scrubber-proof.mjs [dry|live|both]
import fs from 'node:fs';
import { connectCdp } from './cdp-lib.mjs';

const OUT = 'proof/film-d';
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2] ?? 'both';
const CLIENT = process.env.GAIA_CLIENT_PORT ?? '5180';
const { ws, send } = await connectCdp();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function ev(expr) {
  const msg = await send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true, awaitPromise: true });
  if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description ?? 'eval threw');
  return msg.result?.result?.value;
}
async function shot(name) {
  const msg = await send('Page.captureScreenshot', { format: 'png' });
  const file = `${OUT}/${name}.png`;
  fs.writeFileSync(file, Buffer.from(msg.result.data, 'base64'));
  console.log(`      · ${file} (${fs.statSync(file).size} B)`);
  return file;
}

const KEYS = {
  Backquote: { key: '`', code: 'Backquote', keyCode: 192, text: '`' },
  F9: { key: 'F9', code: 'F9', keyCode: 120 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};
async function key(name, { shift = false } = {}) {
  const k = KEYS[name];
  const mods = shift ? 8 : 0;
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', ...k, modifiers: mods, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
  });
  await sleep(40);
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code, modifiers: mods, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
  });
  await sleep(60);
}
async function mouse(type, x, y, buttons = 0, button = 'none') {
  await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: button === 'left' ? 1 : 0, pointerType: 'mouse' });
}
async function trackRect() {
  return ev("const r=document.querySelector('#atlas-scrubber .scr-track')?.getBoundingClientRect(); return r?{x:r.left,y:r.top,w:r.width,h:r.height}:null;");
}
// a real click on the timeline at time t (the hand's path, not an api call)
async function clickAt(t, duration) {
  const r = await trackRect();
  if (!r) throw new Error('no scrubber track on screen');
  const x = r.x + (t / duration) * r.w;
  const y = r.y + r.h / 2;
  await mouse('mouseMoved', x, y);
  await sleep(40);
  await mouse('mousePressed', x, y, 1, 'left');
  await sleep(60);
  await mouse('mouseReleased', x, y, 0, 'left');
  await settle();
}
async function settle(timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await ev('return gaia.atlasScrubber?.status?.()?.seeking ?? false');
    if (!s) { await sleep(120); return true; }
    await sleep(80);
  }
  return false;
}

// ───────────────────────────────────────────────────────────────── DRY PASS ──
async function dryPass() {
  console.log('\n── DRY PASS · ?intro=off · audio:false ──');
  await send('Page.navigate', { url: `http://localhost:${CLIENT}/?intro=off` });
  let ready = false;
  for (let i = 0; i < 200 && !ready; i += 1) {
    await sleep(500);
    try { ready = await ev('return !!(gaia?.atlasStrategy?.cosmos?.ready && gaia?.director && gaia?.atlasScrubber)'); } catch { /* loading */ }
  }
  check('dry: page + atlas + director + scrubber loaded', ready);
  if (!ready) return;

  const D = await ev('return gaia.director.duration');
  check('dry: director exposes duration + handoverAt', D > 290, `duration=${D} handoverAt=${await ev('return gaia.director.handoverAt')}`);

  // no hint on screen before the secret key
  const before = await ev("return { dom: !!document.getElementById('atlas-scrubber'), status: gaia.atlasScrubber.status() };");
  check('dry: nothing on screen and no DOM before the key', !before.dom && !before.status.open);
  check('dry: the key refuses when there is no film to cut', await ev(`
    return (()=>{ const r = gaia.atlasScrubber.status(); return !r.open && !r.scrubbable; })();`));

  // roll the film on the automation clock
  await ev("window.__handover=null; gaia.director.play({mode:'live',audio:false,subtitles:true,onHandover:(t)=>{window.__handover=t;}}); return 1;");
  await sleep(1200);
  check('dry: film rolling', await ev('return gaia.director.status().playing'));

  // THE SECRET KEY
  await key('Backquote');
  let st = await ev('return gaia.atlasScrubber.status()');
  check('dry: ` opens the scrubber', st.open, `t=${st.t} chapter=${st.chapter}`);
  check('dry: the engine debug panel did NOT toggle with it',
    await ev("const d=document.getElementById('debug'); return getComputedStyle(d).display !== 'flex';"));
  const ticks = await ev("return document.querySelectorAll('#atlas-scrubber .scr-tick:not(.handover)').length");
  const chapters = await ev('return gaia.director.scenes.length');
  check('dry: one chapter tick per SCENES row', ticks === chapters, `${ticks} ticks / ${chapters} scenes`);
  const labels = await ev("return [...document.querySelectorAll('#atlas-scrubber .scr-tick:not(.handover)')].every(n=>n.title.length>8 && n.dataset.scene)");
  check('dry: every tick carries its chapter name', labels);
  // ── TIMESTAMPS EVERYWHERE (Pascal's binding add) ────────────────────────
  const tickStamps = await ev(`
    const ticks = [...document.querySelectorAll('#atlas-scrubber .scr-tick:not(.handover)')];
    const scenes = gaia.director.scenes;
    return ticks.every((n,i) => n.title.includes('t0=' + scenes[i].t0.toFixed(2)) && n.dataset.t0 === scenes[i].t0.toFixed(2));`);
  check('stamps: every chapter tick is labelled with its t0 (raw seconds)', tickStamps);
  const readout = await ev(`
    const txt = document.querySelector('#atlas-scrubber .scr-t').textContent;
    const badge = document.querySelector('#atlas-scrubber .scr-now').textContent;
    const st = gaia.director.status();
    return { txt, badge, st: st.t, ok: txt.includes('t=' + st.t.toFixed(2)) && badge.includes('t=' + st.t.toFixed(2)) };`);
  check('stamps: head readout AND cursor badge print t= copy-exact to director.status().t',
    readout.ok, `readout="${readout.txt}" badge="${readout.badge}" status.t=${readout.st}`);
  check('stamps: the readout is mm:ss.s PLUS raw seconds',
    /\d:\d\d\.\d · t=\d+\.\d\d/.test(readout.txt), readout.txt);
  // hover anywhere on the bar → timestamp at that position
  {
    const r = await trackRect();
    await mouse('mouseMoved', r.x + r.w * 0.4, r.y + r.h / 2);
    await sleep(200);
    const tip = await ev(`
      const el = document.querySelector('#atlas-scrubber .scr-tip');
      return { text: el.textContent, shown: getComputedStyle(el).opacity, left: el.style.left };`);
    const want = (await ev('return gaia.director.duration')) * 0.4;
    const seen = Number((tip.text.match(/t=([\d.]+)/) ?? [])[1] ?? NaN);
    check('stamps: hovering the bar prints the timestamp under the pointer',
      Math.abs(seen - want) < 4 && Number(tip.shown) > 0.5 && /t0=/.test(tip.text),
      `tip="${tip.text.replace(/\s+/g, ' ').slice(0, 90)}" (pointer at ${want.toFixed(2)})`);
  }
  await shot('01-scrubber-open');

  // FIVE CHAPTERS, seeked with a real mouse
  const scenes = await ev('return gaia.director.scenes.map(s=>({id:s.id,t0:s.t0,t1:s.t1}))');
  const picks = ['candle', 'split', 'covenants', 'descent', 'altar']
    .map((id) => scenes.find((s) => s.id === id)).filter(Boolean);
  for (const sc of picks) {
    const target = sc.t0 + Math.min(3, (sc.t1 - sc.t0) * 0.25);
    await clickAt(target, D);
    const s = await ev(`
      const d = gaia.director.director;
      const sc = gaia.director.scenes;
      const t = d.t;
      const cur = sc.filter(x=>t>=x.t0).pop();
      const missing = sc.filter(x=>t>=x.t0).map(x=>x.id).filter(id=>!d.entered.has(id));
      const cue = (d.cues??[]).find(c=>t>=c.t0-0.05 && t<=c.t1);
      return { t:+t.toFixed(2), chapter:cur?.id ?? null, missing, cue: cue?cue.text:'',
               uiChapter: document.querySelector('#atlas-scrubber .scr-chapter')?.textContent,
               uiCue: document.querySelector('#atlas-scrubber .scr-cue')?.textContent,
               goal: [d.s.goal.x, d.s.goal.y, d.s.goal.z].map(v=>+v.toFixed(1)),
               released: d.released, reveal: d.status().reveal, forged: d.status().forged, rite: d.status().rite };`);
    const near = Math.abs(s.t - target) < 2.5;
    check(`dry: seek → ${sc.id} @ ${target.toFixed(1)}s lands on the chapter`,
      near && s.chapter === sc.id && s.uiChapter === sc.id, `t=${s.t} chapter=${s.chapter} ui=${s.uiChapter}`);
    check(`dry: ${sc.id} · every earlier scene was entered (world state is exact)`,
      s.missing.length === 0, `missing=${JSON.stringify(s.missing)} reveal=${s.reveal} forged=${s.forged} rite=${s.rite}`);
    check(`dry: ${sc.id} · subtitle cue at that second`, s.uiCue === s.cue, `cue="${s.cue}"`);
    check(`dry: ${sc.id} · the scripted camera is writing (not released)`, s.released === false, `goal=${JSON.stringify(s.goal)}`);
    // the readout is the LANDED t, not the requested one
    const land = await ev(`
      const st = gaia.director.status();
      const txt = document.querySelector('#atlas-scrubber .scr-t').textContent;
      const badge = document.querySelector('#atlas-scrubber .scr-now').textContent;
      const scr = gaia.atlasScrubber.status();
      return { st: st.t, txt, badge, readout: scr.readout, target: scr.target, audioT: st.audioT };`);
    check(`stamps: ${sc.id} · readout = the EXACT landed t (post-seek), target chip cleared`,
      land.txt.includes(`t=${land.st.toFixed(2)}`) && land.badge.includes(`t=${land.st.toFixed(2)}`)
      && land.readout.includes(`t=${land.st.toFixed(2)}`) && land.target === null,
      `status.t=${land.st} readout="${land.txt}" target=${land.target}`);
    await shot(`02-chapter-${sc.id}`);
  }

  // KEYBOARD TRANSPORT
  let t0 = await ev('return gaia.director.director.t');
  await key('ArrowRight'); await settle();
  let t1 = await ev('return gaia.director.director.t');
  check('dry: → is +5s', Math.abs(t1 - (t0 + 5)) < 1.2, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);
  await key('ArrowLeft'); await settle();
  const t2 = await ev('return gaia.director.director.t');
  check('dry: ← is −5s', Math.abs(t2 - (t1 - 5)) < 1.2, `${t1.toFixed(2)} → ${t2.toFixed(2)}`);
  const next = scenes.find((s) => s.t0 > t2 + 0.25);
  await key('ArrowRight', { shift: true }); await settle();
  const t3 = await ev('return gaia.director.director.t');
  check('dry: ⇧→ jumps to the next chapter t0', Math.abs(t3 - next.t0) < 0.6, `${t2.toFixed(2)} → ${t3.toFixed(2)} (${next.id} @ ${next.t0})`);
  const prev = [...scenes].reverse().find((s) => s.t0 < t3 - 0.75);
  await key('ArrowLeft', { shift: true }); await settle();
  const t4 = await ev('return gaia.director.director.t');
  check('dry: ⇧← jumps to the previous chapter t0', Math.abs(t4 - prev.t0) < 0.6, `${t3.toFixed(2)} → ${t4.toFixed(2)} (${prev.id} @ ${prev.t0})`);

  await key('Space');
  const paused = await ev('return { playing: gaia.director.status().playing, t: gaia.director.director.t }');
  await sleep(700);
  const stillT = await ev('return gaia.director.director.t');
  check('dry: space pauses and the clock STOPS', !paused.playing && Math.abs(stillT - paused.t) < 0.05, `t held at ${stillT.toFixed(2)}`);
  await shot('03-paused');
  // pause-scrub-resume
  await clickAt(160, D);
  const scrubbedWhilePaused = await ev('return { playing: gaia.director.status().playing, t:+gaia.director.director.t.toFixed(2) }');
  check('dry: pause-scrub keeps it paused at the new time',
    !scrubbedWhilePaused.playing && Math.abs(scrubbedWhilePaused.t - 160) < 2.5, JSON.stringify(scrubbedWhilePaused));
  await key('Space');
  await sleep(900);
  const resumed = await ev('return { playing: gaia.director.status().playing, t:+gaia.director.director.t.toFixed(2) }');
  check('dry: space resumes FROM the scrubbed point', resumed.playing && resumed.t > 160.2 && resumed.t < 166, JSON.stringify(resumed));

  // DRAG
  const r = await trackRect();
  const from = r.x + (0.25 * r.w);
  const to = r.x + (0.62 * r.w);
  const y = r.y + r.h / 2;
  await mouse('mouseMoved', from, y);
  await mouse('mousePressed', from, y, 1, 'left');
  for (let i = 1; i <= 8; i += 1) { await mouse('mouseMoved', from + ((to - from) * i) / 8, y, 1, 'left'); await sleep(70); }
  await shot('04-dragging');
  await mouse('mouseReleased', to, y, 0, 'left');
  await settle();
  const dragged = await ev('return +gaia.director.director.t.toFixed(2)');
  check('dry: drag lands where the hand let go', Math.abs(dragged - 0.62 * D) < 4, `t=${dragged} target=${(0.62 * D).toFixed(2)}`);
  check('dry: a drag resumes what it interrupted', await ev('return gaia.director.status().playing'));

  // HANDOVER, then scrub BACK through it
  await ev('return gaia.director.scrub(287.6, { resume: true })');
  for (let i = 0; i < 40; i += 1) { if (await ev('return !!window.__handover')) break; await sleep(300); }
  const ho = await ev('return { at: window.__handover, released: gaia.director.status().released, handedOver: gaia.director.status().handedOver }');
  check('dry: the handover still fires on the music after a scrub', ho.at !== null && ho.released, JSON.stringify(ho));
  await shot('05-after-handover');
  await ev('return gaia.director.scrub(150, { resume: false })');
  await settle();
  const back = await ev(`
    const d = gaia.director.director;
    return { t:+d.t.toFixed(2), released:d.released, handedOver:d.handedOver, stage:!!d.stage,
             chapter: gaia.atlasScrubber.status().chapter, entered:[...d.entered].length };`);
  check('dry: scrubbing back re-enters film state (camera re-taken)',
    back.released === false && back.handedOver === false && back.stage && Math.abs(back.t - 150) < 1,
    JSON.stringify(back));
  await shot('06-scrubbed-back');

  // ESC closes the scrubber (with intro=off there is no intro to skip)
  await key('Escape');
  const closed = await ev("return { open: gaia.atlasScrubber.status().open, dom: !!document.querySelector('#atlas-scrubber.on') };");
  check('dry: esc closes the scrubber', !closed.open && !closed.dom);
  await key('F9');
  check('dry: F9 is the same secret key', await ev('return gaia.atlasScrubber.status().open'));
  await key('Escape');
  await ev("return gaia.director.stop({restore:true});");
}

// ──────────────────────────────────────────────────────────────── LIVE PASS ──
async function livePass() {
  console.log('\n── LIVE PASS · the real front door · audio:true ──');
  // gate token + a first visit, then the real title screen
  await send('Page.navigate', { url: `http://localhost:${CLIENT}/?intro=off` });
  await sleep(2500);
  const cfg = JSON.parse(fs.readFileSync('client/assets/gate-config.json', 'utf8'));
  await ev(`localStorage.setItem('atlas_gate', ${JSON.stringify(cfg.sha256.slice(0, 16))});
            localStorage.removeItem('atlas_seen_intro'); localStorage.setItem('gaia-muted','0'); return 1;`);
  await send('Page.navigate', { url: `http://localhost:${CLIENT}/` });
  let titled = false;
  for (let i = 0; i < 200 && !titled; i += 1) {
    await sleep(500);
    try { titled = await ev("return document.querySelector('#atlas-intro.ready') ? true : false"); } catch { /* loading */ }
  }
  check('live: first-visit title screen is up and ready', titled);
  if (!titled) return;
  await shot('10-title');

  // the click IS the audio gesture
  const box = await ev("const r=document.getElementById('atlas-intro').getBoundingClientRect(); return {x:r.width/2,y:r.height/2};");
  await mouse('mouseMoved', box.x, box.y);
  await mouse('mousePressed', box.x, box.y, 1, 'left');
  await sleep(60);
  await mouse('mouseReleased', box.x, box.y, 0, 'left');
  await sleep(3000);
  const rolling = await ev('return gaia.director.status()');
  check('live: the film rolls with real audio', rolling.playing && rolling.ctx === 'running' && rolling.audioT > 0.2,
    `ctx=${rolling.ctx} audioT=${rolling.audioT} t=${rolling.t}`);
  const audioClock = rolling.ctx === 'running';

  await key('Backquote');
  check('live: the secret key works mid-film', await ev('return gaia.atlasScrubber.status().open'));
  await shot('11-scrubber-live');

  // A/V LOCK: seek five chapters and prove the element IS the clock
  const D = await ev('return gaia.director.duration');
  for (const t of [64.5, 110, 165, 230, 250]) {
    await clickAt(t, D);
    await sleep(500);
    const s = await ev(`
      const d = gaia.director.director;
      return { t:+d.t.toFixed(2), audioT:+d.audio.el.currentTime.toFixed(2), paused:d.audio.el.paused,
               playing:d.playing, chapter:gaia.atlasScrubber.status().chapter, gain:+d.audio.music.gain.value.toFixed(2) };`);
    check(`live: A/V lock after a seek to ${t}s`,
      Math.abs(s.audioT - s.t) < 0.35 && Math.abs(s.t - t) < 3.5 && (!audioClock || !s.paused),
      `t=${s.t} el.currentTime=${s.audioT} playing=${s.playing} chapter=${s.chapter} musicGain=${s.gain}`);
    await shot(`12-av-${Math.round(t)}`);
  }
  // and it KEEPS following the element (not a stale virtual t)
  const a0 = await ev('const d=gaia.director.director; return {t:d.t, a:d.audio.el.currentTime};');
  await sleep(1500);
  const a1 = await ev('const d=gaia.director.director; return {t:d.t, a:d.audio.el.currentTime};');
  check('live: the director keeps reading el.currentTime, not a virtual clock',
    a1.t > a0.t + 0.5 && Math.abs(a1.t - a1.a) < 0.2, `t ${a0.t.toFixed(2)}→${a1.t.toFixed(2)} el ${a0.a.toFixed(2)}→${a1.a.toFixed(2)}`);

  // ESC: closes the cutting room, does NOT skip the intro
  const stateBefore = await ev('return gaia.atlasIntro.status().state');
  await key('Escape');
  const afterEsc = await ev("return { open: gaia.atlasScrubber.status().open, intro: gaia.atlasIntro.status().state, playing: gaia.director.status().playing };");
  check('live: esc closes the scrubber and does NOT shadow the intro',
    !afterEsc.open && afterEsc.intro === stateBefore && afterEsc.playing,
    `intro ${stateBefore} → ${afterEsc.intro}`);
  // …and with the scrubber closed, Esc is the visitor's skip again
  await key('Escape');
  await sleep(600);
  const skipped = await ev('return gaia.atlasIntro.status().state');
  check('live: with the scrubber closed, esc is the intro skip again', skipped === 'done', `intro=${skipped}`);

  // ── the handover, and a scrub back through a COMPLETED one ────────────────
  await ev("localStorage.removeItem('atlas_seen_intro'); return 1;");
  await send('Page.navigate', { url: `http://localhost:${CLIENT}/` });
  let again = false;
  for (let i = 0; i < 200 && !again; i += 1) {
    await sleep(500);
    try { again = await ev("return !!document.querySelector('#atlas-intro.ready')"); } catch { /* loading */ }
  }
  const b2 = await ev("const r=document.getElementById('atlas-intro').getBoundingClientRect(); return {x:r.width/2,y:r.height/2};");
  await mouse('mouseMoved', b2.x, b2.y);
  await mouse('mousePressed', b2.x, b2.y, 1, 'left');
  await sleep(60);
  await mouse('mouseReleased', b2.x, b2.y, 0, 'left');
  await sleep(2500);
  await key('Backquote');
  await ev('return gaia.director.scrub(287.4, { resume: true })');
  for (let i = 0; i < 40; i += 1) {
    if (await ev("return gaia.atlasIntro.status().state === 'handover'")) break;
    await sleep(300);
  }
  check('live: the handover fires from a scrubbed clock', await ev("return ['handover','done'].includes(gaia.atlasIntro.status().state)"),
    `intro=${await ev('return gaia.atlasIntro.status().state')} released=${await ev('return gaia.director.status().released')}`);
  await shot('13-handover');
  // let the intro finish the whole release: stop({restore:true}) at +4.4s
  await sleep(6000);
  const restored = await ev(`
    const d = gaia.director.director;
    return { stage: !!d.stage, released: d.released, intro: gaia.atlasIntro.status().state,
             cinematic: document.body.classList.contains('atlas-cinematic'), open: gaia.atlasScrubber.status().open };`);
  check('live: the intro completed its restore (stage torn down, camera the visitor’s)',
    restored.stage === false && restored.released === true && restored.intro === 'done', JSON.stringify(restored));
  await shot('14-restored');

  // NOW scrub back: the scrubber must re-enter film state gracefully
  await ev('return gaia.director.scrub(150, { resume: true })');
  await settle();
  await sleep(1200);
  const revived = await ev(`
    const d = gaia.director.director;
    return { t:+d.t.toFixed(2), audioT:+d.audio.el.currentTime.toFixed(2), stage:!!d.stage, released:d.released,
             playing:d.playing, gain:+d.audio.music.gain.value.toFixed(2),
             cinematic: document.body.classList.contains('atlas-cinematic'),
             chapter: gaia.atlasScrubber.status().chapter, entered: [...d.entered].length };`);
  check('live: scrubbing back after a completed handover re-enters film state',
    revived.stage && revived.released === false && revived.playing && Math.abs(revived.audioT - revived.t) < 0.4,
    JSON.stringify(revived));
  check('live: resume re-arms the mix the handover had faded out', revived.gain > 0.5, `musicGain=${revived.gain}`);
  await shot('15-back-after-handover');
  // and closing the scrubber puts back what it changed
  const cinBefore = await ev('return document.body.classList.contains("atlas-cinematic")');
  await key('Escape');
  await sleep(400);
  const cinAfter = await ev('return { cin: document.body.classList.contains("atlas-cinematic"), open: gaia.atlasScrubber.status().open }');
  check('live: closing the scrubber restores the chrome it re-asserted',
    !cinAfter.open && (!cinBefore || !cinAfter.cin), `cinematic ${cinBefore} → ${cinAfter.cin}`);
  await shot('16-closed');
  await ev("try{gaia.director.stop({restore:true})}catch(e){}; return 1;");
}

try {
  if (which === 'dry' || which === 'both') await dryPass();
  if (which === 'live' || which === 'both') await livePass();
} catch (err) {
  check('proof harness completed', false, err?.message ?? String(err));
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${results.length} checks passed`);
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ when: new Date().toISOString(), pass, total: results.length, results }, null, 2));
ws.close();
process.exit(pass === results.length ? 0 : 1);
