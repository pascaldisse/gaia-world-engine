# FILM LANE A · THE OPENING & THE TEARDROP — proof

Branch `film-a` · worktree `../GAIA-WE-filmA` · iso stack GAIA_PORT=8424, vite 5177, CDP 9225,
ops = paloptic `atlas-ops.json` + `quest-ops.json` (811 entities, 3061 records).

Files: `client/plugins/atlas-fx-opening.js` (new, lane A owns) ·
`client/plugins/atlas-director.js` — void/sea/deep/candle/alone cases + one import line ONLY.

## Plates
`tNN.png` = director.seek checkpoints (10, 30, 55, 74, 76, 78, 79.7, 81, 85, 95)
`rt-NN_N.png` = REAL-TIME capture, play({audio:false, speed:1, from:72}), one frame/s, 72 → 86.4
(seek cannot show the fall; rt-79_2 and rt-80_2 are the money frames).

## Verdicts (own eyes, off these plates)
1. THE DEEP CENTERED — t=10/30/55: the frame is INSIDE a breathing dust shell whose heart is
   the flame's live position; nothing else on screen. The shell was laid out around the world
   ORIGIN, 424 units from the flame at (162,-368,-125): that mismatch — not the camera — is why
   the flame read as off-centre. Staging moved (`centerDeep`, `DEEP_SPREAD 3.4` measured off the
   crane's 940→470 stand-off), camera keys untouched.
2. THE RED TEARDROP — rt-76…rt-79_2: one red emissive drop with a tapered comet trail, born ~196
   units above the ignition point, accelerating (u², not a lerp) for 4.81s, landing ON the flame's
   position at 79.70.
3. IGNITION AS EVENT — t=79.7 (flash peaks ON the word), rt-80_2 / t=81 (embers + shockwave ring),
   t=85 / t=95 (hearth settled, burning alone). Impact flash → body bloom (igniteCurve, forge
   emerge flicker under it) → settle. No 0→10 scale anywhere.
4. ALONE MEANS ALONE — measured, not eyeballed: at t=79.9/81/85/95/100 → drawn records = 1,
   forged bodies = 1, visible groups = 300 (all `dust:sky:*`), figures = 0. The veil is by INDEX
   (every record but the flame) and is handed back on the next `setFilmVeil` call, so lane C's
   fracture at 107.13 inherits a clean world.
5. FX CONTRACT — `spawnTeardrop / igniteFlash / hearthGlow / igniteCurve / openingFx`, §IRON
   tunables at the top, every geometry/material/texture in a disposal bag, `director.stop()`
   wrapped from the FX module (transport untouched) → dust positions restored, no leaked objects.

## Three engine facts this lane paid for (they will bite the other lanes)
- `THREE.Points` + `PointsMaterial(vertexColors)` renders NOTHING under three/webgpu r180 here.
  Particles must be additive sprite QUADS sharing one material (see `quadPool`).
- A node material does not fade by `.opacity`. Under AdditiveBlending, brightness IS alpha →
  fade by scaling the COLOUR (`fade()`), and keep base colours near 1 or they clip flat.
- `cosmos.applyVeils()` runs on build and on UI filter toggles only — NOT per frame. A film veil
  that is dropped from `stage.veil` leaves `cosmos.veiled[]` still flagged; and because
  `darkness()` veils by KIND, the First Flame (a tenant) stayed veiled and `forge.acquire()`
  refused it — the ignition had no body at all until it was un-veiled by index.

NOT MERGED — nyari merges.
