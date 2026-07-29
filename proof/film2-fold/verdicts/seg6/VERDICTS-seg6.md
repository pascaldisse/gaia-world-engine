# FILM2 · SEG-6 — THE WATCHERS AND THE BELL (176.32 → 228.40) · VERDICTS

Lane: worktree `../GAIA-WE-seg6` · branch `film2-seg6` off `rust-port@f20e48e6`
Ports (iron, this lane only): client **5186** · CDP **9236** · no world server.
World: `?static=1` — `client/assets/world-snapshot.json`, built from paloptic
`viz/data/atlas-ops.json` (434 entities) + `client/atlas-graph.json` (3061
records / 7748 relations). **No ops POSTed anywhere, no shared world touched** —
a serverless page cannot perturb another lane. Census is therefore the snapshot's
434 + 1 local presence, not a 512-entity live world; stated, not hidden.
Browser: chrome-headless-shell, `--mute-audio`, `?mute=1`, driver never arms audio.

## 1 · DELIVERABLES

| file | what |
|---|---|
| `client/plugins/film2/seg6.js` | the segment: `WINDOW`, `entryPose`, `exitPose`, `prewarm`, `enter`, `tick`, `exit`, `poseAt`, `snapCamera`, `status` |
| `tools/seg6-driver.mjs` | this lane's CDP driver: `boot` · `still` · `strip` (real-time) · `status` |
| `tools/seg6-stack.sh` | the only way this lane starts vite/chrome (headless, muted, own profile) |
| `proof/seg6/strip/` | the real-time strip |

Shared files edited: **none**. `atlas-eyes.js` / `atlas-director.js` read-only.
Draw calls added: **4** (ember · streak · shell · body) + the eye layer's own 2.

## 2 · THE STRIP (real time, speed 1.0)

`node tools/seg6-driver.mjs strip proof/seg6/strip 1 176.32 228.40`
→ 16 plates over **57.0 s wall for 52.1 s of film** — real time, not a seek
sweep. The requested 1 fps was not reachable: this machine ran eight
software-WebGPU chromiums at load ≈ 41, one 512×288 frame costs ~2–3 s, so the
strip samples at ~0.31 fps and every plate is LABELLED with the film clock it
was actually taken at. That is the honest number; a 1 fps claim here would be
a lie about the hardware.

Per-plate instrument census from the same run (`.scratch/run4.log`) — this is
the choreography, measured, not asserted:

```
177.22  ember 5    streak 5    shell 0   body 0    ← the deep only begins to thicken
180.66  ember 649  streak 289  shell 0   body 0    ← swarms falling, NO body yet
184.47  ember 419  streak 257  shell 5   body 3    ← 3 watchers born, 4th not yet
187.36  ember 91   streak 330  shell 5   body 4    ← all four; the granting begins
190.47  ember 2    streak 440  shell 15  body 4    ← lid-flash shells peak ON the words
193.81→205.15  ember 0  streak 440  shell 4  body 4 ← settled: rings only, no bloodline
209.02  ember 54   streak 441  shell 4   body 4    ← the thread is drawing
212.39→228.14  ember 72  streak 440  shell 4  body 4 ← thread + pulses
```

Read against the lyric: bodies 0 → 3 → 4 across 180.7 → 187.4 (the four birth
words), shell (flash) peaks at 190.5 inside the granting line, ember goes 0 → 54
at 209.0 — i.e. **after** `meet` (207.11) and not before, and nothing at all is
alive at 177.2 but the mist. No instrument fires before its word.

### CONVICTIONS FROM THE STRIP, AND THE FIXES

1. **The whole first strip was BLACK** (23 plates, byte-identical, max channel
   value 2, while the counters said 73 eyes / 440 streaks). Cause: the driver
   used the recorder's `drawImage(canvas)` readback, which is a **WebGL** law —
   a WebGPU canvas reads back black outside the task that drew it (beauty bible
   §2, re-earned here). Fix `e03322e6`→`fix 4`: plates come from the compositor
   (`Page.captureScreenshot`); the cheap path is opt-in via `SHOT_MODE=page`.
   Evidence kept: `proof/seg6/convicted/black-readback-t176_98.png`.
2. **66 eyes stood at t=177.22 — ten seconds before the word.** Cause: the eye
   field is a singleton on the cosmos group, and a re-booted take inherits the
   previous take's `hold`ed eyes (40 wreath + 26 seed = exactly 66). Fix
   (`da04f5a6`): the pre-granting branch now clears the ENTIRE field, and
   `enter()` drops every `seg6:*` key it inherits. THE FILM'S ONLY EYE MOMENT
   may not be pre-empted by its own rehearsal.
3. **10 `forge:*` eyes were already live at boot** (`status()` at 176.32),
   granted by `atlas-forge.js`'s own pagerank rule. `atlas-forge` is shared and
   may not be edited, so the segment enforces the law over the field instead
   (fix 1, `94562d21`→`fix 1`): before the granting word, any eye this segment
   did not author is dropped every frame.
4. **`prewarm`'s whole-scene `compileAsync` killed the renderer twice**
   mid-boot on the loaded machine (page came back with an empty URL, `boot`
   returned `undefined` — it looks exactly like a code failure and is not one).
   Fix (`e03322e6`): it is opt-in (`ctx.compile !== false`); our four looks are
   compiled by prewarm's own one-instance draw, which is what actually matters.
5. Harness: a `nohup ... &` child dies with the harness bash call (`disown`
   now, `8f35fbfe`), and the stack script rewrote the vite config it was about
   to probe, so vite restarted itself and the launch aborted before the browser
   ever started (fix 3).

### STILL OPEN (stated, not hidden)
- **The compositor returns one frozen frame.** All 16 non-black plates are
  byte-identical (`md5 48a45b84…`) although the counters advance across them:
  chrome-headless-shell with no visible surface is not committing new WebGPU
  frames to the compositor on this machine, so `captureScreenshot` re-serves the
  last commit. The pixel evidence for the choreography is therefore ONE frame
  plus the per-frame instrument census above — I am not going to call a strip of
  identical frames a proof of motion. The two remaining paths (a `Metal`-adapter
  browser instead of SwiftShader; `Page.startScreencast` frames) both need the
  machine to be less than eight-lanes busy, and the renderer process died three
  times during this budget while I tried.

## 3 · BIRTH-CRAFT AUDIT — every object, entrance and exit

Law (Pascal): no pop-ins, no on/off, no bare `scale(0→1)`, no opacity toggle, no
`visible = true`; every appearance and disappearance is a designed, eased,
multi-phase animation timed to its word. Audit of every object this window owns:

| # | object | ENTRANCE (phases, word) | EXIT |
|---|---|---|---|
| 1 | **mist veil** ×4 (`watchers()`) | ① each mote lights on its OWN start, spread over 3 s from `dark` (177.37) ② through a candle `flicker()` (3 detuned sines), never a linear fade ③ drifting inward as it brightens | absorbed: drawn into the swarm, radius falling while colour cools red→grey (ash), gone by body+0.9 s |
| 2 | **condensation swarm** ×4 (150 motes each) | ① per-mote ignition on its own lead (0.55·…·1.0 × 4.2 s before its word) with flicker ② flare as it accelerates: ω ∝ 1/r (angular momentum), so it WHIPS in ③ elongates into a streak — velocity is a shape | swallowed: the last 12 % of the fall is a flare then an exponential ash decay after the word |
| 3 | **watcher body** ×4 | ① FORMLESS — a dark globe boiling on three detuned sines at 34 % radius ② FLARE — implosion flash ON the word (hairline shell shockwave + core ember) ③ SETTLE — the wobble relaxes over 2.4 s into a 0.21 Hz breath, rim fresnel steadies | held (they are the exit state) · on `exit(ctx,{dissolve:true})` the globe disperses back into 90 embers that drift outward and cool to ash |
| 4 | **accretion ring** ×4 (110 streaks) | ① spin-up from +1.1 s: each streak starts as a point already orbiting ② elongates as it accelerates ③ doppler-brightens where it runs at the lens (Kepler shear: inner faster) | wind-down on dissolve: sheared long and thin into the body |
| 5 | **eyes** ×66 (`atlas-eyes.js`, instrument) | ① GLEAM at word −0.34 s: a wet spark flares where the eye will be ② PART ON its word — the instrument's own lid overshoot+settle, iris dilating up from 0.14 ③ WAKE: pupil snap on the beat + a limb flash shell that decays. Six waves on the six words `eye/for/every/seed/they/keep`, 0.052 s between neighbours | stay open — "eyes open across the field" IS the exit state · on dissolve, lids fall over 1.15 s with the iris shrinking first, each leaving a cooling gleam |
| 6 | **two sparks** (different galaxies) | ① flicker-ignition on `two` (205.98) / `sparks` (206.36) ② lens flare: hairline expanding ring + 6 diffraction spikes + hot core ③ decays into the thread's own end-bead | becomes the thread's end-bead — it turns into the thing it started |
| 7 | **bloodline thread** (9 hops) | ① a hot HEAD runs hop by hop from `meet` (207.11) to `avoid` (212.33) ② behind it the vein settles to a dim thread (two-phase, per bead) | vein persists (exit state) · on dissolve it un-draws from both ends toward the middle |
| 8 | **bell pulse** | ① strike flash at the near end ON `bell` (214.89): shockwave ring + core ② the bead WALKS the whole web over 5.2 s, lighting each vein it passes ③ flicker-modulated, brightest mid-span | spends itself at the far end into a thinning ring |
| 9 | **whisper pulses** ×2 | same craft, cooler palette, faster (2.6 s / 2.2 s), lower gain — on `whispers` (220.56) and `come −0.55` (227.23) | same spend-into-a-ring |
| 10 | **prewarm instances** (1 per look) | none — they are 1e-3 units, colour 0, sub-ten-thousandth of a pixel: a COMPILE, not an appearance | dropped in `enter()` having never been visible |

No object in this window is switched on or off. `grep -n "visible *=" client/plugins/film2/seg6.js` → one hit: the header comment that bans it.

## 4 · THE SHOT
One continuous C1 move, 7 keys, `entryPose` dist 350 on the threaded cluster
(seg-5's hand-off, resolved live as the bloodline's first spark) → `exitPose`
dist 800 over the whole layout, with `IRON.cam.lean` adding 0.085 rad of
nose-down across the last 4 s so seg-7 inherits a camera already falling.
No cut mechanism exists in the file.

## 5 · COMMITS
```
94562d21 stage 1: the segment + its own iso harness
8f35fbfe stage 2: lane stack survives harness SIGHUP (disown), driver deadlines
<fix 1>  law-3 enforcement over the shared eye field (10 forge eyes at 176.32)
e03322e6 fix 2: prewarm's whole-scene compileAsync is opt-in (it killed the renderer)
<fix 3>  stack script must not rewrite the vite config it is probing
<fix 4>  the strip was BLACK — WebGPU canvas readback; plates now from the compositor
da04f5a6 fix 5: 66 eyes stood ten seconds before the word (inherited singleton field)
```
