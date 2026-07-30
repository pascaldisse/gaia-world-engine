# HANDOFF — Paleblood Atlas · intro museum + live DB · 2026-07-29 ~12:15

Fresh-ctx continuation doc. Style: telegraphic. Repo = `~/projects/GAIA-World-Engine` (MAIN ONLY — worktrees banned by Pascal 07-29; summons banned 08:38 — nyari's hands only).

## Mission state
- Product: Bloodborne-skinned 3D graph-DB demo for Charles (Handwerker-AI). DB = the point; films exist to SHOW it.
- LIVE DB (verified 12:05 via `tools/db-census.mjs`): **3,061 nodes / 7,748 bonds** — 1 tenant · 3 store · 24 consultant · 475 product · 1,400 customer · 760 order · 394 finding · 4 rule; 8 fields/record; anonymization=mechanic (BB names). cosmosReady ✓.
- Intro = THE MUSEUM: start screen (every visitor, every auth state) → `choose`: Witness I / II / III / Enter the Dream.

## Live stack (untouchable ports; nyari may resurrect after crash — recipe below)
- world `:8421` + vite `:5174` (pids cwd = GAIA-World-Engine) · quest `:4610` (script `dev`, `bun run build-riddles` first) · hero 8420/5173 unrelated.
- resurrect: `nohup bash ~/.gaia/logs/atlas-start.sh` then re-POST `~/projects/paloptic/viz/data/{atlas,quest}-ops.json` → `:8421/op` as `{ops:[...]}` UA `curl/8.4.0`.
- Gate: password `paloptic/gate/PASSWORD.txt`; token v2 `{v:2,sha16:8fc666825e1a4b06}` under localStorage `atlas_gate`; token write lands ~3.5s AFTER correct password (probes wait ≥6s).
- BUILD BEACON (law rewritten 07-30, opus5 correction): token in `client/assets/build.txt`, shown bottom-right of entry screens. Ritual: `git rev-parse --short HEAD > client/assets/build.txt` **BEFORE** commit (token = parent hash; unique per commit, NO --amend — amend ritual was structurally broken: file can't contain its own commit's hash, drifted one behind forever, voided ALL observations incl. true ones). Check = **tab-fetched build.txt == on-disk build.txt** — git HEAD is NOT the comparand. Mismatch ⇒ stale tab ⇒ observations void. Parent-hash token = amend-safe (amend preserves parent). ⚠ token is the PARENT's hash — never `git show $(cat build.txt)` expecting this build; it shows the one before. Vite HMR-wedged tabs survive plain reloads — fresh tab required.

## HEAD chain today (morning→now, main)
gesture-fix f65ab49a → b22bbca3 (never naked world; setVisible choke) → 9c4a3854 (schema purge; WITNESS IS ABSOLUTE) → 592c34ef (WORLD→FILM legal) → beacon → e37b305c+7b08c74b (whitelist darkness — died with old director, LESSON stands) → 47fd0f1e (prewarm sleep) → a7501dd8 (welcomeOnce out of setVisible) → 4978c33b (film2+director DELETED, sprite film) → e2897f0a (**GEHRMAN AUDIO DELETED**: oggs `git rm`'d, welcomeOnce stub, onGesture greeting killed, npc whitelist pruned — NEVER resurrect) → b4cf062d (intro deleted; left dangling-else, fixed later) → 90a1a1d0 (museum v0) → 65f5e44a (boot poll must NOT require resident director) → c5cfec32 (no re-arm mid-roll) → scrubber revival chain → a970388b (3 real movies v1) → e3232851 (ONE start screen for everyone) → **b4460abf ≡ 7464a1cd (TRUE MUSEUM, era-complete sets — current; two names for ONE build, amend-drift artifact)**. ⚠ all pre-07-30 hashes in this chain amend-suspect — trust message, not hash.

## Museum architecture (current, b4460abf)
- `client/plugins/atlas-intro.js` = entry machine (gate→title/menu→FILM→HANDOVER→WORLD). `loadFilm(version)` dynamic-imports one era set, registry `this._films` re-registers `window.gaia.director` on switch (module cache never re-evals). `beginIntro(version)` refuses re-arm while FILM rolling. Menu markup ~line 293; handler `data-act` v1/v2/v3/enter. showTitle = SAME menu (no gesture catch-all — that was "wrong video").
- Era sets (extracted via `git show <commit>:path >`, imports rewired to sibling copies):
  - **I First Cut** `500d2c06` → `intro-v1.js` + `intro-v1-rites.js` + `intro-v1-opening.js`
  - **II Teardrop** `d6103233` (= 12d3c31c~1, LAST full film1: teardrop b0ca73b3 ⊂, Hermite cam, fall+Ebrietas f185347a ⊂, **orderings finale = DB on screen**) → `intro-v2.js` + `-rites/-opening/-eyes`
  - **III Eight Seals** `a7501dd8` director → `intro-v3.js` + `client/plugins/film2/` (restored dir, its own era ✓)
- fx modules self-contained (THREE/tsl + shared/noise only) — era-true cheap. Forge/cosmos = TODAY's (shared with live world; era-forge NOT extractable).
- One-file grafts = ABOLISHED (played today's flesh → "two identical movies", "missing 90%"). Era = the SET, not the director file.
- Timeline/scrubber: `T` (also Backquote/F9) during any film; never summons a film; v-compat via `get d()` fallback. (v3-compat getters died with sprite film; era directors expose `.director` themselves.)
- Cosmos guard: `setVisible(true)` allowed in states `done` AND `handover` (old films reveal at handover), refused earlier. `welcomeOnce()` = stub. `onGesture()` = no-op.

## Laws (Pascal-enforced, non-negotiable)
1. **DONE = nyari clicked it on live `:5174` herself** + real-time proof. Seek-plates banned; strips 1fps named by `audio.el.currentTime` (wall-clock naming lies).
2. WITNESS IS ABSOLUTE: any state → teardown (cos.suspend, setVisible(false), silenceDrone, cinematic(true)) BEFORE arming; door black until first painted frame.
3. NEVER the naked world; slow kernel holds black door.
4. Camera: keyframes BLEND (Hermite through keys, no stop-start, no drift outside keys); "not moving between keyframes" = his 07-28 words for stop-start crime.
5. Birth-craft: no pop-ins/toggles; 2+ phase entrances+exits.
6. Lyrics = render spec (drop 73.64 · spark 79.7 · split 103.32 · accrete 123.60 · ring 144.08 · watchers 176.32 · eyes 187.8 · bell 214.9 · fall 228.40 · her 256.80 · welcome 277 · end 293.44).
7. §IRON no hardcode; NEVER /tmp; main only; no summons; Gehrman audio stays dead; bun-only in gaia-daemon (n/a here).
8. Two start screens ⇒ test the surface PASCAL stands on (logged-out title was invisible to all probes for hours).

## Verification rigs (`tools/`, all Brave: `CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`, `--headless=new --mute-audio`; playwright headless-shell MISSING, chromium-1148 lacks AAC+WebGPU)
- `live-account-probe.mjs` — register→reload→click `BTN` env (regex) → P2/P3 status snapshots + screenshots `proof/live-click/`.
- `film-strip.mjs` — menu path via BTN, 1fps clock-named frames → `proof/intro-film/f*.jpg` (run ≈ 300s).
- `live-click2-probe.mjs` (fresh-visitor path), `museum-check.mjs`, `startscreen-dump.mjs` (logged-out surface), `timeline-check.mjs`, `gate-dump.mjs`, `db-census.mjs`, `live-ring-probe.mjs` (scene traversal hunter).
- Contact sheets: PIL script in room history (6-col, t-labels, 4 sheets).

## Open threads (priority order)
1. ~~II Teardrop t44 navigation~~ **STRUCK 07-30 (opus5)**: NOT a product bug — one-off renderer death; Playwright mis-reports context-destroy as "navigation". Instrumented full walk t=0→293: ZERO navigations; client structurally cannot navigate (no `location.*` in client/). Pascal's watch was never at risk.
   **REAL DEFECT → EYES BEAT t≈188**: p99=8 vs neighbors 53–92; nyari eyeballed r188 — NO eyes in frame at the lyric "eyes" (atlas-eyes should open on word-beats). Missing body, not intended dark. Frames: `proof/teardrop-nav/realtime/`. Remaining beats unwalked realtime: drop@74-80, split@110, fall/Ebrietas@245-270, ORDERINGS FINALE@277-293. Missing bodies ⇒ diagnose era-API drift, not "prettify".
   § PHOTOMETRY LAW (opus5 07-30): headless = SwiftShader = blind — photograph on headful Brave Metal-3 ONLY · seek ≠ playback for INTEGRATED-FX films (intro-v2: seek understates p99 up to 6.6×) — seek-photometry valid only for analytic-FX eras (film2/lane-C) · "seek don't watch" still stands for WEDGING; darkness measurement needs realtime.
2. I First Cut frame-walk (same standard).
3. III Eight Seals: known-good from fold era but re-verify post-museum (its darkness/veil lives in ITS director copy).
4. Handover from each era film → world must land (poll adapter in beginIntro: veil-drop on t>0.2, handover on t≥292.9/state done).
5. Pascal cookie died in schema purge ⇒ he lands logged-out; login/re-register path via onboarding worth a pass.
6. Stack killer unidentified (4 crashes yesterday); scene-file persistence TODO.
7. Charles meeting: Atlas demo; pleroma-engine thesis parked (`~/Downloads/bruce-nhs13.pdf`, notes in memory `paloptic-atlas.md`).

## Trap bank (cost blood)
- `new Audio()` never in DOM — read `director.audio.el`, not querySelectorAll.
- Synthetic `element.click()` ≠ pointerdown (menu handlers are pointerdown-capture) — use `page.mouse.click(x,y)`.
- `process.env` inside `page.evaluate` = browser crash; pass as arg.
- Boot poll requiring `window.gaia.director` deadlocked gate when films became lazy (65f5e44a).
- Old menu-handler edits: leftover `else` after removing `if` — ALWAYS re-read the block after sed.
- Prewarm may not SHOW (seg5 ring haunted f010+ for a day). Veils: whitelist-of-existence beats hide-known-families.
- sessionStorage `atlas:cosmos:welcomed` gated the old greeting; `atlas_seen_intro` localStorage = title-vs-menu; `atlas:schema`=2 purge eats unknown keys (killed Pascal's cookie session once).
- Strip contact sheets: judge p99 AND contrast; black-on-black and white-on-white both banned.

## Pascal-verdict log today (calibration)
sprite film = "children's drawings" (deleted permanently) · one-file era grafts = "video 2 twice, missing 90%" · praised-ever: teardrop drop + ORDERINGS FINALE ("the one thing which was good... YOU FUCKING REMOVED") · core question: "has anything to do with the database?" ⇒ answer in product terms: film must show the 3,061-record graph, finale = re-orderings of REAL data.
