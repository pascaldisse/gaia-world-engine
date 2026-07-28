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

const c = await connectTimed();
const report = {};
try {
  // ── 1 · gate, tokenless fresh profile (localStorage wiped -> reload shows
  // the real first-time lock screen; same DOM/app state a truly fresh
  // profile would produce, since the gate is 100% localStorage-token-gated)
  await c.evaluate(`localStorage.clear(); sessionStorage.clear(); return 1;`, { ms: 10000 });
  await c.send('Page.navigate', { url: `${BASE}/` }, 15000);
  await c.waitFor(`return !!document.getElementById('atlas-gate');`, { timeoutMs: 30000 });
  await new Promise((r) => setTimeout(r, 1200)); // gate's own fade/eye-open transition
  report.gate = { file: `${OUT}/surf-01-gate.png`, bytes: await c.shot(`${OUT}/surf-01-gate.png`, 15000) };

  // ── 2 · start screen (skinned login) — seed both tokens, reload plain
  // (no ?intro=off, so the real overlay flow runs: gate passes silently,
  // atlas_seen_intro set -> showMenu() -> state 'menu' with .ob-menu-login)
  await c.evaluate(`
    localStorage.setItem('atlas_gate', '${GATE_TOKEN}');
    localStorage.setItem('atlas_seen_intro', '1');
    return 1;`, { ms: 10000 });
  await c.send('Page.navigate', { url: `${BASE}/` }, 15000);
  await c.waitFor(`return window.gaia?.atlasIntro?.status?.().state === 'menu';`, { timeoutMs: 40000 });
  await c.waitFor(`return !!document.querySelector('.ob-menu-login');`, { timeoutMs: 15000 });
  await new Promise((r) => setTimeout(r, 900));
  report.startScreen = { file: `${OUT}/surf-02-start-screen.png`, bytes: await c.shot(`${OUT}/surf-02-start-screen.png`, 15000) };

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

  // ── 5 · scrubber open
  await c.waitFor(`return !!(window.gaia?.atlasScrubber);`, { timeoutMs: 15000 });
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
