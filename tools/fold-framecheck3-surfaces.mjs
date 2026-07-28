// FOLD FRAME-CHECK #3 · BATCH 2 — the surfaces.
//
// Adapted from film-c-browser.sh's launcher discipline (mute, isolated
// profile) + eyes-verdict.mjs's driver pattern (one connect, ordered checks,
// explicit state reads, plates via CDP captureScreenshot only). All app
// entry points used below are the app's OWN exposed test/dev APIs — no DOM
// clicking, no hand-rolled input simulation:
//   gate reset         localStorage.clear() + reload (atlas-gate.js: purely
//                       localStorage-token-gated, gaia.atlasGate.reset() is
//                       the same operation from inside the page)
//   start screen        atlas_seen_intro seeded, gate token seeded, normal
//                       navigate (no ?intro=off) -> state 'menu' (return-
//                       visit screen, login form injected by onboarding)
//   creator              gaia.atlasOnboarding.reset() ("testing: force the
//                       creator screen back up regardless of auth state")
//   doll panel            gaia.atlasNpc.open('doll')
//   scrubber              gaia.atlasScrubber.show()
// Every CDP/network await goes through the timeout-wrapped helper (10s
// default, see fold-framecheck3-lib.mjs) per this lane's law.
import fs from 'node:fs';
import { connectTimed } from './fold-framecheck3-lib.mjs';

const OUT = process.env.OUT ?? 'proof/fold-framecheck';
const CLIENT_PORT = process.env.GAIA_CLIENT_PORT ?? '5221';
const GATE_TOKEN = process.env.GATE_TOKEN ?? '8fc666825e1a4b06';
const BASE = `http://localhost:${CLIENT_PORT}`;
fs.mkdirSync(OUT, { recursive: true });

// ── THE KERNEL-HANDLE WIPE (diagnosed this lane, driver-side workaround) ───
// main.js's late `window.gaia = { ... }` (a FRESH object, not a merge — see
// its own comment above that line) lands AFTER atlas-gate.js/atlas-director.js
// import early via atlas-intro.js's boot chain and self-register onto the
// PRE-overwrite window.gaia. The overwrite silently drops window.gaia.atlasGate
// and window.gaia.director forever (nothing re-sets them — ES modules only
// run their top-level code once per URL). atlas-onboarding.js ships its own
// defensive 60s poll for window.gaia.director to re-publish itself, but by
// the time a driver script acts that poll has usually already expired too.
// Net effect: gaia.atlasIntro.status() sticks at state:'waiting'/'done' with
// director:null and never reaches 'menu'/'title'.
// FIX (app code untouched): re-import each plugin with a cache-busting query
// so its top-level self-registration IIFE runs again — this is each file's
// own documented contract (atlas-gate.js's header: "dynamic-importable from
// a cold page"). Re-registration is merge-style (`window.gaia.X = ...` onto
// the ALREADY-fresh object), so it's non-destructive of anything else.
async function ensureKernelHandles(c) {
  await c.waitFor(`return !!(window.gaia?.atlasStrategy?.active);`, { timeoutMs: 60000 });
  await c.evaluate(`(async () => {
    await import('/plugins/atlas-gate.js?fc=' + Date.now());
    const d = await import('/plugins/atlas-director.js?fc=' + Date.now());
    window.gaia.director = d.default;
    await import('/plugins/atlas-onboarding.js?fc=' + Date.now());
    // APP-CODE BUG (logged in VERDICTS.md, not fixed here): showMenu()'s
    // return-visit login form comes from mountMenuLogin(), which never
    // calls injectStyle() itself — only mountCreator() (first-visit path)
    // does. Seed it off-screen (mount + immediate unmount, never rendered)
    // BEFORE atlas-intro.js is re-imported below — that re-import's own
    // bottom IIFE fires boot() unawaited, and a seed done AFTER this point
    // loses the race against showMenu()/mountMenuLogin() rendering first.
    window.gaia.atlasOnboarding.onboarding.mountCreator();
    window.gaia.atlasOnboarding.onboarding.el?.remove();
    window.gaia.atlasOnboarding.onboarding.el = null;
    // atlas-intro.js is ITSELF a victim of the same wipe (its own boot()
    // calls publish() twice as a defense, but both calls can still land
    // before/after the wrong side of main.js's overwrite depending on
    // timing) — a fresh cache-busted import re-runs its top-level publish()
    // synchronously (window.gaia.atlasIntro is set before this import()
    // promise even resolves) and fires its own bottom IIFE's boot() call
    // automatically; no separate manual boot() invocation needed.
    await import('/plugins/atlas-intro.js?fc=' + Date.now());
    window.__fcKernelRestored = true;
  })()`, { ms: 20000 });
}

const c = await connectTimed();
const report = {};
try {
  // ── 1 · gate, tokenless fresh profile (localStorage wiped -> reload shows
  // the real first-time lock screen; same DOM/app state a truly fresh
  // profile would produce, since the gate is 100% localStorage-token-gated)
  await c.evaluate(`localStorage.clear(); sessionStorage.clear(); return 1;`, { ms: 10000 });
  await c.send('Page.navigate', { url: `${BASE}/` }, 15000);
  await c.waitFor(`return !!document.getElementById('atlas-gate');`, { timeoutMs: 30000 });
  // the gate's own opacity transition is 3s (CSS `#atlas-gate{opacity:0;
  // transition:opacity 3s ease}` -> `.on` class after 2 rAFs) — a shorter
  // wait catches it mid-fade, letting the game HUD/hint text underneath
  // bleed through the still-translucent black
  await new Promise((r) => setTimeout(r, 3400));
  report.gate = { file: `${OUT}/surf-01-gate.png`, bytes: await c.shot(`${OUT}/surf-01-gate.png`, 15000) };

  // ── 2 · start screen (skinned login) — seed both tokens, reload plain
  // (no ?intro=off, so the real overlay flow runs: gate passes silently,
  // atlas_seen_intro set -> showMenu() -> state 'menu' with .ob-menu-login)
  await c.evaluate(`
    localStorage.setItem('atlas_gate', '${GATE_TOKEN}');
    localStorage.setItem('atlas_seen_intro', '1');
    return 1;`, { ms: 10000 });
  await c.send('Page.navigate', { url: `${BASE}/` }, 15000);
  await ensureKernelHandles(c);
  // the re-imported atlas-intro.js already kicked off its own boot() (seen
  // flag is set, so it's the return-visit path) — just wait for it to land.
  await c.waitFor(`return window.gaia?.atlasIntro?.status?.().state === 'menu';`, { timeoutMs: 15000 });
  await c.waitFor(`return !!document.querySelector('.ob-menu-login');`, { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 900));
  report.startScreen = { file: `${OUT}/surf-02-start-screen.png`, bytes: await c.shot(`${OUT}/surf-02-start-screen.png`, 15000) };
  // DISMISS #atlas-intro before the remaining surfaces — it never closes on
  // its own (no player clicked a choice), and it shares its z-index
  // (2147483000) with #atlas-onboarding, so left mounted it randomly wins
  // the paint order over the creator/Doll/scrubber surfaces below and
  // corrupts their screenshots. enter() is the app's own "return screen's
  // second door: no film, just the world" API (atlas-intro.js enterDream()).
  await c.evaluate(`window.gaia.atlasIntro.enter(); return 1;`, { ms: 10000 });
  await c.waitFor(`return !document.getElementById('atlas-intro');`, { timeoutMs: 15000 });

  // ── 3 · creator (force-mount, the app's own testing API)
  await c.evaluate(`window.gaia.atlasOnboarding.reset(); return 1;`, { ms: 10000 });
  await c.waitFor(`return !!document.getElementById('atlas-onboarding');`, { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 900)); // creator's own fade-in
  report.creator = { file: `${OUT}/surf-03-creator.png`, bytes: await c.shot(`${OUT}/surf-03-creator.png`, 15000) };
  // clean the overlay off before the next two surfaces (DOM removal only,
  // no app-state mutation beyond what reset() already did)
  await c.evaluate(`document.getElementById('atlas-onboarding')?.remove(); return 1;`, { ms: 10000 });

  // ── 4 · Doll panel w/ riddles board — wait for the cosmos/atlasNpc plugin
  // to be live (auto-loaded off index.html, independent of the intro state
  // machine), then open the same way a player's click into the Doll does
  await c.waitFor(`return !!(window.gaia?.atlasNpc);`, { timeoutMs: 30000 });
  await c.evaluate(`window.gaia.atlasNpc.open('doll'); return 1;`, { ms: 10000 });
  await c.waitFor(`return document.getElementById('atlas-npc') && getComputedStyle(document.getElementById('atlas-npc')).display !== 'none';`, { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 900));
  report.dollPanel = { file: `${OUT}/surf-04-doll-panel.png`, bytes: await c.shot(`${OUT}/surf-04-doll-panel.png`, 15000) };
  // close the Doll dialogue before the next surface — it does not close
  // itself, and left open it double-exposes under the scrubber transport.
  await c.evaluate(`window.gaia.atlasNpc.close({ farewell: false }); return 1;`, { ms: 10000 });
  await c.waitFor(`return getComputedStyle(document.getElementById('atlas-npc')).display === 'none';`, { timeoutMs: 15000 });

  // ── 5 · scrubber open
  // atlasScrubber.show() no-ops ({open:false, why:'no film'}) unless
  // scrubbable() is true (d.playing || d.stage || d.t > 0.01) — the intro's
  // enter() above tore the stage down via director.stop({restore:true}).
  // seek() is the app's OWN documented re-prep path (atlas-scrubber.js's
  // header: "seek() re-prepares" a stage) — land on a real mid-film moment
  // so the transport has a world behind it to cut through.
  await c.waitFor(`return !!(window.gaia?.atlasScrubber);`, { timeoutMs: 15000 });
  await c.evaluate(`return window.gaia.director.seek(5).then(() => 1);`, { ms: 15000 });
  await c.evaluate(`window.gaia.atlasScrubber.show(); return 1;`, { ms: 10000 });
  await c.waitFor(`return !!document.getElementById('atlas-scrubber');`, { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 700));
  report.scrubber = { file: `${OUT}/surf-05-scrubber.png`, bytes: await c.shot(`${OUT}/surf-05-scrubber.png`, 15000) };

  fs.writeFileSync(`${OUT}/surfaces-index.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  c.close();
}
process.exit(0);
