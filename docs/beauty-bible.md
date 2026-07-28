# THE BEAUTY BIBLE — art direction for the beauty pass (branch `beauty-art`)

Bar (Pascal, verbatim): *"it should look fucking beautiful, like a real galaxy, a
procedural universe — and still run at 60 FPS on a MacBook Air."*
Form calls = opus5 (artist). Meaning calls = Pascal (director).

## 0. LAWS (sealed — violations burned this project tonight)
- **NO WINDOW EVER.** Browser = full Chromium binary `--headless=new`, or
  `chrome-headless-shell`. Never `open`, never a visible profile.
- **`--mute-audio` always** + `?mute=1` + `play({audio:false})`. Three places, any
  one forgotten = sound on his speakers.
- **Guillotine**: commit every stage. A 30-min timeout eats only uncommitted work.
- **§IRON**: every tuned value = named option, default in one `IRON`-style table,
  measurement comment saying what was SEEN at the wrong value. No magic numbers.
- **Never touch ports 8420 / 8421 / 5173 / 5174** (serving trees). Also live: 5178,
  5179, 8425, 8426, 9222.
- **NO merge to film-merge.** nyari folds. Lanes commit to their own branch only.
- **Analytic FX law**: every animated value = pure `f(film_t, seed)`, zero
  integration → `director.seek(t)` reproduces a playback frame exactly.

## 1. IRON LANE PORTS (one row per lane, never share)
| lane | worktree | branch | client | server | CDP |
|---|---|---|---|---|---|
| rig | ../GAIA-WE-beauty-rig | beauty-rig | 5191 | 8431 | 9241 |
| eyes | ../GAIA-WE-beauty-eyes | beauty-eyes | 5192 | 8432 | 9242 |
| universe | ../GAIA-WE-beauty-universe | beauty-universe | 5193 | 8433 | 9243 |
| ebrietas | ../GAIA-WE-beauty-ebri | beauty-ebrietas | 5194 | 8434 | 9244 |

Iso stack recipe (per lane, from `~/projects/GAIA-World-Engine`):
`ln -s` → `node_modules`, `client/atlas-graph.json`, `client/assets/audio/beginning`
(all gitignored in the main tree; the audio one is ignored as a DIR so a symlink of
that name IS trackable → `git rm --cached` + add to
`$(git rev-parse --git-dir)/info/exclude`, and that dir needs `mkdir info` first).
Own vite `cacheDir` (a `/tmp/<lane>/vite.config.mjs` re-exporting the repo config
with absolute `root` + private `cacheDir`) — the shared `node_modules/.vite`
re-optimises and breaks other lanes' running servers.
`?static=1` loads `client/assets/world-snapshot.json` (436 entities) with NO world
server — preferred for plates. Gates: `localStorage.atlas_gate`,
`atlas_seen_intro`, and `?intro=off`, else every plate is the gate card.

## 2. CAPTURE + MEASURE
- **In-page canvas readback is BLACK** (WebGPU canvas reads back only in the task
  that drew it) → plates come from CDP `Page.captureScreenshot` only.
- `chrome-headless-shell` here has no Metal adapter → SwiftShader, ~0.1 fps at
  640×360. Fine for static seeks, USELESS for fps. fps numbers must come from a
  rig that reports a **Metal-3 adapter**; state the adapter next to every number.
- fps = rAF deltas over ≥120 frames at a held film-t. Also record
  `renderer.info.render.{drawCalls,triangles}` — the hard budget below.
- Heaviest moments to measure: **covenants full field**, **rites fx peak t≈236**,
  **altar t≈258**, plus **t=270** (Ebrietas hero close).

## 3. PERF BUDGET (hard gate — beauty that drops frames is not beauty)
- 60 fps target, MacBook-Air-class iGPU.
- Standard already proved by the fx layer: **3 draw calls for 845 instances.**
- Per-feature ceilings: particle field ≤1 draw call · galaxy nebula sheet ≤2 draw
  calls/galaxy · all primary tendrils = ONE merged mesh (drift in the vertex
  shader, per-vertex `tParam`/`armIdx` attributes) · all eyes = ONE InstancedMesh
  pair (globe + cornea).
- Geometry budgets: Ebrietas ≤80k tris total · one eye ≤2.5k tris.
- **AUTHORSHIP LAW (Pascal, overriding): NO BLENDER, no imported assets, zero GLB.**
  Every vertex is computed in the client/plugin layer — `BufferGeometry` built from
  code (swept taper-curve tubes, displaced/lathed shells, subdivided forms),
  `CanvasTexture`/TSL for procedural surface, instancing for repetition. The
  sculpture IS code; that is the thesis of this engine. A hand-placed vertex table
  is not sculpting either — write the generator.
- §IRON option `adaptivePixelRatio` (default on): drop devicePixelRatio toward 1.0
  when a rolling 30-frame mean sits under the target; never oscillate (hysteresis).

## 4. EBRIETAS — grief made cosmic (hero form, computed in `atlas-eidos.js`)
Director's meaning: *left behind at the Altar, still reaching.* Head bowed over the
altar. **If one thing is perfect, make it the reaching.**
- **MANTLE/DOME**: hunched FORWARD (weight of waiting) — build it: `LatheGeometry`
  or a parametric dome grid, ellipsoid squashed in Y, pitched 18–22°, dorsal ridge
  of 5–7 knobs, 2-octave value-noise vertex displacement at ridge scale, thickened
  front hem overhanging the head. Recompute normals after displacement or every
  form reads as faceted plastic.
- **HEAD**: bowed LOW and forward, tucked under the mantle's front lip — visible
  as a pale gleam, not a face. 3+ eyes on her, half-lidded (eyeball asset,
  instanced).
- **TENDRILS = the thesis.** Two contrasting families:
  - 7–9 **primary reaching** arms: real swept tubes — `CatmullRomCurve3`/bezier
    path + per-ring radius taper (write the sweep; `TubeGeometry` has a constant
    radius, so either post-scale its rings by `tParam` or emit rings yourself),
    taper r 4.2→0.35,
    path = S-reach (down from the mantle base → out → UP and FORWARD at the tip,
    tip slightly open/splayed = a hand that stopped expecting an answer but never
    stopped asking). Slow drift (0.3–0.5 Hz, per-arm phase).
  - 12–18 **secondary hanging** tendrils: thinner, longer, limp, straight down =
    grief drape. The REACH reads only against the HANG.
  - No straight cones anywhere. Ever.
- **WING-VEILS**: 2 pairs of membranes FOLDED CLOSE along back/flank (she is not
  ascending, she stayed). Thin displaced sheets, scalloped edges, translucent.
- **PALETTE** (director's): interior pale violet-white `#e8dcff` → cold magenta rim
  `#ff5ce0`/`#c05cff` → obsidian shadow `#0a0710`.
- **DEPTH**: fresnel rim (magenta) + interior glow gradient — faked translucency:
  back-facing additive interior shell, NOT real transmission (perf).
- Scale: she is a landmark ~1000 units under the galaxies, body ≈70 units across
  (current: core r22 at y14, lobe y38, arms 34–60 long) — must read as a SHAPE
  from universe framing and as a BEING at t=270.
- Her **24 orphan embers keep orbiting**. Do not break `setFlockCount`.

## 5. EYES — organs of revelation (procedural, in-engine)
Film thesis: *grant us eyes* = insight = seeing the data truly. Flat sprites are
**banned** everywhere (world, film, forge).
- Feel: **too wet, too aware, catching light before the head turns.**
- Form: sphere globe + procedural iris (radial fibers, dark pupil, dark limbal
  ring) drawn to a `CanvasTexture` (or TSL, if the fibers stay cheap) + a separate
  cornea cap mesh for the wet specular highlight. ≤2.5k tris per eye, ONE texture
  shared by every instance.
- Instanced everywhere eyes exist: opening-fx sprite eyes, forge pagerank eye,
  Ebrietas' eyes. Per-instance: look direction, blink phase, dilate, seed.
- Motion, all analytic `f(t)`: slow saccades (micro-jumps, then hold), rare blink,
  iris dilate.
- **Watchers scene 180–205: the Great Ones' eyes OPEN on a word-beat.** An eye that
  opens on the beat is worth more than any static detail.

## 6. THE PROCEDURAL UNIVERSE — Hubble deep field × the Mensis sky
No flat blobs at any camera distance. Structure at EVERY scale.
- Current state = the defect: `starfield:N` = 1154 spheres, ONE colour `#bfe0ff`,
  size 0.05. `nebula:N` = 2400 spheres, ONE colour, opacity 0.19, size 0.34 →
  uniform puffs. Both are `particles` components → `client/kernel/particles.js`.
- **Star colour temperature** (per-instance colour, still 1 draw call): ≈12%
  blue-white `#cfe4ff` · 24% white · 40% gold `#ffe9c0` · 18% amber `#ffbe7a` · 6%
  red `#ff8a6a`, jittered; brightness falls with temperature (blue bright, red
  dim); size jitter with a long tail (a few near-stars carry the depth read).
- **Nebula structure**: sculpt the 2400 positions with 3-octave fbm (filaments,
  not a disc) and **carve DUST LANES** — dark occluding strands across bright
  cloud is what sells Hubble — via a ridged second fbm driving density→0 bands.
  Colour by density: warm bright core → cold violet outskirts. 1–2 colour-
  temperature ACCENTS per galaxy, never a uniform hue.
- **Depth-graded glow**: alpha/emissive fall with distance from the galaxy core so
  the cloud has front and back.
- **The Mensis half**: everything slightly wrong-angled, asymmetric — non-uniform
  axis scale, off-axis rotations, asymmetric domain warp. Beauty with unease.
- Cheap volumetric read: ≤2 large camera-facing TSL quads per galaxy, layered
  domain-warped fbm + dust-lane mask + depth-graded alpha. Not thousands of puffs.
- Defaults must not regress rain/fireflies: every new behaviour = opt-in spec key.
