# LIGHTING-OPENWORLD — engine sun / sky / post rig (lane L-SUN)

Module `client/kernel/lighting/`. Default OFF → `lighting.enabled:false` = zero scene mutation, kernel bloom chain intact (test: `lighting-environment-wiring`).
Probe GI = separate lane (`kernel/gi/`), untouched; interface = `environment.lighting.skySummary`.

## API (environment component param)
```js
environment.apply({ lighting: {
  enabled: true,
  time: { timeOfDay: 16.5, latitude: 40, dayOfYear: 172, speed: 0 },   // OR time:{direction:[x,y,z]}
  shadows: { cascades: 4, maxFar: 600, mapSize: 2048, bias: -0.0003, normalBias: 0.04, fade: true, lightMargin: 200 },
  sky: { turbidity: 6, rayleigh: 2, mieCoefficient: 0.005, mieDirectionalG: 0.8, groundAlbedo: 0.25, visible: true },
  sun: { peak: 3.0, moon: 0.12 }, hemi: { day: 0.9, night: 0.12 }, fog: { near: 80, far: 900, follow: true },
  post: { tonemap: 'aces'|'agx'|'neutral'|'none', exposure: 1, ao: { enabled, intensity, radius, thickness, samples, resolutionScale, normals: 'mrt'|'depth', skyDepthEps: 1e-3, debug: null|'mask' }, traa: { enabled: false } },
} });
environment.lighting.setTimeOfDay(h);          // live clock; or time.speed = hours/real-sec
environment.lighting.markShadows(root);        // cast+receive on meshes; userData.noShadow opts out
environment.lighting.setCamera(cam);           // retarget cascades (default = renderer camera)
environment.lighting.skySummary                // {zenith,horizon,ground} each [r,g,b]; null while off
environment.lighting.onSkyChange((summary, sunState) => …)   // fires on sun/sky change
import { skyRadiance, skyRadianceTSL } from 'client/kernel/lighting/index.js'
```
### Per-concern ownership `lighting.owns` (lane ds-sky)
```js
lighting: { enabled: true, owns: { fog: true, background: true, hemi: true, sky: true } }   // each default true = historic behaviour, bit-identical (test: lighting-owns)
```
`false` = the game keeps that concern; sun, CSM shadows, AO, tonemap/exposure and the GI feed still run.
| key | false means |
|---|---|
| `fog` | `scene.fog` colour AND near/far untouched (the game's own fog) |
| `background` | `scene.background` untouched (not painted with the horizon colour) |
| `hemi` | hemisphere light colour/ground/intensity untouched |
| `sky` | no analytic Preetham dome is created (the game's authored sky meshes stay); `skySummary` becomes the external one below |
**External sky summary** (for `owns.sky:false`): `environment.lighting.setSkySummary({zenith,horizon,ground})` (each `[r,g,b]`) replaces the Preetham summary → hemi tint (if owned), fog-follow (if owned), and every `onSkyChange` listener (the GI feed: `onSkyChange(s => environment.gi.setSkySummary(s))`; `gi.setSkySummary` is the same call GI already had). `setSkySummary(null)` clears → Preetham again. Ignored while `owns.sky !== false`. A game with no external summary gets the Preetham one (fallback). Note: Environment crossfades are still suppressed while lighting is enabled (an un-owned concern is simply left as `apply()` wrote it).
While enabled: lighting owns sun colour/intensity/position, hemi, fog colour(+near/far), `scene.background` (kept a Color = horizon), exposure, tonemap. `Environment.update()` skips crossfade, uses `lighting.exposure`, never overwrites lights per frame; recompute only when sun/sky changes. `apply()` without lighting → disables, params win (no stale restore).
Camera: `Environment` ctor takes `camera` (main.js passes it). Other games: pass it or call `setCamera`.

## Technique + sources
| stage | technique | source |
|---|---|---|
| S1 | Cascaded shadow maps, practical split, cascade fade, per-cascade texel snapping | `three/addons/csm/CSMShadowNode.js` r180 (WebGPU-only); Dimitrov 2007 "Cascaded Shadow Maps" https://developer.download.nvidia.com/SDK/10.5/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf |
| S2 sun | declination `-23.44°·cos(2π(N+10)/365)`, hour angle `15°·(h−12)`, `sin el = sinφ sinδ + cosφ cosδ cos H` | low-precision solar position (Cooper 1969; NOAA solar calc https://gml.noaa.gov/grad/solcalc/calcdetails.html) |
| S2 sky | Preetham analytic daylight, ported line-for-line into JS `skyRadiance` + TSL `skyRadianceTSL` (shared constants) | `three/addons/objects/SkyMesh.js`; Preetham/Shirley/Smits 1999 https://www.researchgate.net/publication/220720443_A_Practical_Analytic_Model_for_Daylight |
| S2 sun colour | elevation ramp warm→white, smoothstep intensity, moon crossfade below −6° (civil twilight) | ASSUMED art ramp |
| S3 | GTAO (normal MRT), half-res; optional TRAA (velocity MRT); bloom after | `three/addons/tsl/display/GTAONode.js` (Jimenez et al. 2016 https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf), `TRAANode.js` |
| S3 tonemap | renderer.toneMapping ACES/AgX/Neutral; PostProcessing applies it at the end | three r180 |

## Knobs
PORT = taken from source; ASSUMED = my value, tune live.
- shadows: cascades 4 PORT(spec), maxFar 600 PORT(spec), mapSize 2048 PORT(spec), fade true PORT, lightMargin 200 PORT(CSM default), mode practical PORT, **bias −0.0003 ASSUMED, normalBias 0.04 ASSUMED**
- sky: turbidity 6 ASSUMED (SkyMesh 2 / example 10), rayleigh 2 ASSUMED, mie 0.005 PORT, mieG 0.8 PORT, groundAlbedo 0.25 ASSUMED, size 0.7×far ASSUMED
- sun: peak 3.0 ASSUMED, moon 0.12 ASSUMED, moonFloor −6° PORT(civil twilight), colour anchors ASSUMED, moon = sun antipode ASSUMED
- hemi: day 0.9 / night 0.12 ASSUMED; sky/ground tint from skySummary (ground ×0.5) ASSUMED
- fog: near 80 / far 900 ASSUMED; colour = mean of 8 azimuths at 4° elevation (disc excluded) ASSUMED
- post: AO intensity 0.85 ASSUMED, radius 1.2 m ASSUMED, thickness 1 / samples 16 PORT, resolutionScale 0.5 PORT(GTAO doc), tonemap aces (engine continuity), exposure 1 ASSUMED, TRAA off
- GTAO multiplies the WHOLE scene colour (no direct/indirect split) × `intensity` — ASSUMED approximation of "into indirect"; real split needs diffuse-indirect MRT (future, with GI lane).

## Deviations from the brief
- `skyRadiance` zenith is **not** brighter than the horizon at noon in the Preetham model (longer path scatters more): horizon R/G ≥ zenith, zenith **bluer** (B zenith > horizon). Test asserts that, not the brief wording.
- Sky radiance units = SkyMesh's display-referred ~0..3 (pre-tonemap, ×1.0 exposure). GI consuming it as irradiance = ASSUMED scale; tune with `hemi`/GI gain.
- Night: SkyMesh floor (`0.1·Fex`, then gamma) leaves zenith ≈0.1 — brighter than the 0.12 moon light implies. Consider darker `sky` params at night if live looks flat.
- Node: `node --test test/` fails on node 26 (dir arg) → suite run as `node --test 'test/*.test.js'`.

## UNVERIFIED (no GPU in lane)
1. CSM actually renders 4 cascades under WebGPU with `fade` + `lightMargin 200`; no shimmer, no acne/peter-panning at the bias values.
2. CSM node attached AFTER materials compiled: changing `cascades`/`mapSize`/`maxFar` rebuilds the node but already-compiled materials may keep the old shadow graph → configure BEFORE the first world load (or expect recompile).
3. CSM follows the camera passed to `pass()` (builder camera); `setCamera` + `updateFrustums()` on fov/aspect change — behaviour with BP's car camera unseen.
4. `skyRadianceTSL` ≡ JS `skyRadiance` GPU parity (only graph construction tested).
5. SkyMesh dome camera-centred, scale 0.7×far: no clipping/visible box edges, depth/far-plane behaviour, under fog (SkyMesh ignores scene fog).
6. GTAO normal-MRT chain compiles + renders on WebGPU; `normalView` MRT precision; half-res AO halos; AO strength look. Fallback ladder (mrt → depth → bloom-only) only exercised via forced construction errors; real async GPU errors (pipeline compile) are NOT caught by the render try/catch.
7. TRAA: jitter vs CSM shimmer, ghosting with BP's fast car; velocity of skinned/instanced meshes.
8. Bloom node of the lighting chain tracks `post.setBloom` (Environment/viewfx) — sync tested on stubs only.
9. AgX vs ACES look on the Preetham sky at sunset; exposure 1 with sun peak 3.0 may clip/over-expose — first live knob to turn: `post.exposure`.
10. Hemisphere/fog colours from sky horizon vs actual sky dome horizon colour match (both use same fn; dome includes fog-less atmosphere).
11. 292 streamed tiles: `markShadows` must run on each streamed-in tile (caster count / shadow cost at maxFar 600, draw-call multiplication ×4 cascades).
12. Env lightning `flash()` on top of lighting-owned lights (baseline tracked via `_syncCurrent`).

## Tests
`test/lighting-shadows|sun-sky|post|environment-wiring.test.js` — pure fns (sun at known times, ramp monotone, skyRadiance invariants), node-graph construction, fallback ladder, swap/restore, component wiring + default-OFF equivalence. Mutant per key test run (see lane report).

### AO sky mask `post.ao.skyDepthEps` (lane ds-ao2)
No opaque geometry ⇒ no occlusion. `aoTerm = select(depth >= 1-skyDepthEps, 1, mix(1, gtao.r, intensity))`, depth = `scenePass.getTextureNode('depth').sample(screenUV)` (explicit per-pixel sample, full-res). Pixels whose depth is still CLEAR (sky, beyond far plane, far translucent layers w/ `depthWrite:false`, e.g. DS cloud-sea) never get AO.
NDC depth ≈ 1−near/z → default 1e-3 ≈ AO off beyond ~100 m @ near 0.1 (eps ≈ near/maxAoDist). Live DS proof: far sky/cloud meshes lie INSIDE the far plane (1−depth ≈ 8e-5 @1.2 km), so depth is not exactly 1 — eps 1e-5 masked nothing (mask view all grey), 3e-4 most, 1e-3 all streaks.
`post.ao.debug:'mask'` = proof view: RED = masked (AO forced 1), grey = raw GTAO term; bypasses bloom.
