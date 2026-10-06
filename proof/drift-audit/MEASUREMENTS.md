# EYE-WITNESS drift-audit — IT FEEDS world @ HEAD 2906a8a

- 記=measured. Lane: naru-sonnet, room naru-sonnet-mst5543d17td5x.
- 誤庭法 respected: every git command run with explicit `cd /Users/pascaldisse/projects/GAIA-World-Engine` first; `git rev-parse --show-toplevel` returned this repo after each commit.

## Rig
- engine HEAD: `2906a8ab6d01dcf1b5adda3f3526b38a1b0580fe` (branch `rust-port`, commit date 2026-08-13 14:06:43 +0200)
- world server: `localhost:8422` (pid 78858, pre-existing — observation only, never restarted)
- vite client: `localhost:8423` (pid 79481, pre-existing — observation only, never restarted)
- own browser: dedicated Brave, `--user-data-dir=~/.cache/gaia-drift-audit-profile`, `--remote-debugging-port=9371` (verified free before launch), launched `open -n -g -j` (background/hidden, never stole focus from Pascal's own session), with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`. No `--headless`.
- opened `http://localhost:8423/?port=8422`
- rAF verified alive before trusting any eval (`requestAnimationFrame` scheduled + fired flag observed `true`)
- capture timestamp window: 2026-08-14 18:07–18:22 CEST (2026-08-14T16:07–16:22Z)

## ⚠ Finding: CDP synthetic click did not reliably acquire real pointer lock
The client's `overlay` div only hides on a genuine `pointerlockchange` event where `document.pointerLockElement === canvas` (`client/kernel/player.js`). `Input.dispatchMouseEvent` clicks on the overlay call `requestPointerLock()`, and it worked exactly once early in the session (unrecorded scratch shot) — after that, every retry (8 rapid attempts, then a page reload + single careful attempt, then a 3s-cooldown + 5 spaced attempts) left `document.pointerLockElement === null` and the overlay stuck on `display:flex`, even though `window.gaia`, `requestAnimationFrame`, the WebSocket op stream, and `gaia.store.entities` (37→54 live entities, Map) were all demonstrably alive and updating throughout. This reads as a **CDP/automation limitation of a hidden (`-g`) window**, not a world-render bug — the sim/render pipeline was never actually stalled, only the DOM gate. Worked around via the technique AGENTS.md explicitly sanctions for keyboard-less CDP play-testing: `gaia.player.locked = true` plus manually mirroring the overlay-hide a real `pointerlockchange` would have performed. Flagging so the next drift-audit lane doesn't misdiagnose a stuck gate as "world renders black" — sim underneath is alive; only the pointer-lock acquisition via synthetic CDP clicks is flaky under a backgrounded window.
No console exceptions were thrown by the app itself during a `Runtime.enable` + reload capture window (only vite HMR connect/disconnect debug logs). The one `TypeError: Converting circular structure to JSON` seen was self-inflicted — my own `JSON.stringify(gaia.environment)` diagnostic call hitting the WebGPU renderer's circular refs, not an app-thrown error.

## Plates

### 01-kimai-visible.png (SHA256 `1523994b208aa11849509a6f652af7205d60c3f2714f8ae40a1bf149ee14bf8c`)
Player POV, camera `{x:13.519, y:1.705, z:27.071}`, aimed at kimai (`yaw=atan2(-dx,-dz)`, `pitch=-0.05`), standoff ≈13.48 units (kimai radius 6.4383 + 7 margin — chosen live so the camera would NOT be inside kimai's own translucent body; earlier attempts at spawn (0,1.7,18) put the camera literally *inside* kimai because its path currently threads through that exact spot — see corpses below). Shows kimai's full teal/green slime-blob body (6-sphere composite mesh, `kimai_slime` material, opacities 0.34–0.66) in the left/foreground, the diner interior (booths, back wall, counter, 3 pendant lights) readable on the right, two small humanoid rigs standing near/on kimai (Gerald/Doreen-scale NPCs), and a bright moon/light billboard.
- kimai entity `transform.position` at shot time: `[6.8, 0, 15.38]`
- kimai `state.mass` at shot time: **2135** (campaign baseline noted ~1766 — mass has grown since, consistent with organic kimai growth per campaign design, not a discrepancy)
- kimai `state.radius`: 6.4383

### 02-movement-after.png (SHA256 `6ae24cbaafc6ff7656eadf5376b457a3c2e6fe5b2546779d2a8d5e201ff7345d`)
Movement proof via held `KeyW` (not a teleport): `gaia.player.keys.add('KeyW')` held 1.8s at `yaw=π`.
- position before: `{x:0, y:1.7, z:18}`
- position after: `{x:≈0, y:1.7, z:28.93}` → Δz = **+10.93** units over 1.8s ≈ 6.07 u/s forward speed, plausible run speed.
- plate shows the destination: a street-side tableau — one blocky NPC rig + a street lamp (pink diamond fixture on a post) against the dark-plum environment background. Background color `#4b1831` matches `diner_environment.environment.background`/`fog.color` exactly — confirmed authored, not a black-screen bug.

### 03-diner-wide.png (SHA256 `5387cc1dfdf073707412318a3e805cbe2b8376e3629261c4a4fcada5cfa5c185`)
Camera `{x:0, y:1.700, z:8}`, `yaw=0, pitch=-0.06` — chosen after discovering `yaw=π` faces **+z** (toward kimai, confirmed by the movement-proof Δz above), not −z; `yaw=0` faces −z, into the diner. Distance to kimai's live position from this camera: 10.04 units (> kimai radius 6.4383 → camera clear of its body, unlike the first two diner-facing attempts which landed the camera inside/on top of kimai because its idle position at `[6.8,0,15.38]` sits close to the room's east edge). Full diner interior readable: terracotta floor with cream inlay runner, back wall with teal accent stripe, counter, both booths (`booth_left`/`booth_right`), the center table with a metallic disc top on a maroon pedestal, and 3 working pendant lights providing real warm key-light falloff on the booths/floor.

## Dead branches (kept for the record)
- 死: `01`/`03` first attempts, camera at spawn `(0,1.7,18)` / `(0,4.2→1.72,9.5)`. 因: kimai's active path (`[[5.8,0,-7.1],[-1.6,0,19.9]]`, speed 8, non-looping) crosses directly through the player spawn point and the diner floor's east side; camera ended up *inside* kimai's large (r≈6.44) translucent body both times, producing a washed-teal, geometry-less frame (visible in the scratch shots, not committed). Fixed by reading kimai's live `transform.position`+`radius` from the store before framing each shot and keeping a standoff margin.
- 死: `yaw=Math.PI` assumed to face "into" the diner (−z) by analogy with the overlay text convention. 因: false — the movement-proof Δz confirmed `yaw=π` is +z. Corrected to `yaw=0` for the diner-wide plate.
- 死: dismissing the gate via repeated `Input.dispatchMouseEvent` clicks (12+ attempts across 3 separate strategies: rapid retry, single-attempt-after-reload, spaced-with-cooldown). 因: real `pointerlockchange` never fired again after the one early success; window is launched hidden/background per AGENTS.md policy, which appears to prevent CDP-synthetic clicks from carrying the "genuine user activation" Chrome's Pointer Lock API wants on a backgrounded window. Worked around with the AGENTS.md-sanctioned `gaia.player.locked=true` technique.

## Verdict
1. **Renders correctly, with one caveat**: at HEAD `2906a8a` the it-feeds world is alive end-to-end — entity sync (54 live entities via WS `ops` stream), kimai's fluid-body simulation and path animation, the diner geometry/lighting, and WASD-driven player movement (real held-key movement, not a teleport) all measured working. The scene is intentionally *dim/moody* (authored `background`/`fog` = `#4b1831`, `sky` = `#ffb15f`, `exposure` 1.15) — readable once you're not staring at pure sky/void, not the "everything black" failure the campaign log flagged from earlier sessions.
2. **Known debt still open**: the campaign's own priority atom ①(液照明/散乱項 — light scattering/volumetric pass for the fluid) is still unlanded — kimai's body reads as a flat gradient sphere-composite up close, no subsurface/scatter shading, matching the prior "falsification済:照明項皮無" note. Not re-tested here beyond visual confirmation it's still flat.
3. **New debt for the audit process, not the world**: CDP-driven pointer-lock acquisition is unreliable on a hidden/backgrounded automation window against this client's `pointerlockchange`-gated overlay. Future eye-witness lanes should default straight to `gaia.player.locked=true` + manual overlay-hide rather than spending cycles retrying synthetic clicks.
