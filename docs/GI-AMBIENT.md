# GI-AMBIENT — GI replaces hemi sky ambient (lane l-amb)

Problem: three r180 HemisphereLightNode:79-81 + GI IrradianceNode both `+=` into `context.irradiance` → GI on = sky ambient twice (probe miss rays already return skyRadianceTSL). `queryCascadesTSL` = vec3(0) outside coarsest cascade, no outer fade → zeroing hemi blackens everything beyond the volume.

## API (client/kernel/gi)
- `gi.configure({mode:'open', ambient:'add'|'replace'})` — default `'add'` = old behaviour byte-for-byte (query node = raw GI).
- `'replace'`: material node = `c·(gi − hemi(n))`; hemi light still adds `hemi(n)` → **net = mix(hemi, gi, c)**.
  - `c` = `queryCascadesCoverageTSL().coverage` ∈[0,1]: max over cascades of `usable(k)·smooth(weightSum/COVERAGE_WEIGHT_FADE)·(coarsest ? smooth(borderCells/blendCells) : 1)`; usable = inside ∧ weightSum>1e-6; FADE=1e-3. 1 inside, 0 outside / no weight, smooth over coarsest's outer blendCells (1.5 cells ⇒ 27 m at 18 m spacing).
  - `hemi(n)` = `mix(ground, sky, 0.5·n.y+0.5)` (premultiplied colour×intensity, mirror of HemisphereLightNode, light dir +Y) from uniforms `open.ambientU.{sky,ground}`.
- Hemi source: `ambientLight:{color,groundColor,intensity}` param, else first `isHemisphereLight` in scene (cached; re-search only when it leaves the scene, throttled 120 updates when none). Synced in `open.update()` AND callable `open.syncAmbient()` (callers throttling update()).
- `gi.setAmbient({sky,ground,intensity})` manual (stops sync). `gi.setSkyScale(v)` / param `skyScale` (default 1) = ×(sky radiance the probes see: miss rays + sky-lit bounce; sun term untouched).
- `queryCascadesTSL` unchanged signature (returns `.value` of the new `queryCascadesCoverageTSL`); bounce reads in kernels untouched.

## CPU mirrors (gi-reference.js)
`referenceCoverage`, `hemiIrradiance`, `ambientReplace`, `skyIrradiance` (unoccluded probe E(n)=∫skyRadiance·max(0,n·ω)). Constants `COVERAGE_WEIGHT_*` live there, re-exported by gi-open-nodes.

## CALIBRATION (BP conditions: lat 37.8, doy 172, 15 h → sun el 49°, daylight 1, hemi day 0.9 ASSUMED)
skySummary zenith [0.685,1.103,1.663] horizon [1.727,2.135,2.274] ground [0.432,0.534,0.569]. Rig hemi: colour=zenith/max (→ [0.41,0.66,1]), ground=ground/max·0.5, intensity 0.9.

| normal | GI E (unoccluded) lum | hemi lum | ratio |
|---|---|---|---|
| up | 4.260 | 0.571 | **7.46** (rgb 8.5/7.4/6.5) |
| horizon | 4.826 | 0.489 | 9.87 |
| down | 3.071 | 0.407 | 7.54 |

GI open-sky ≠ hemi by 7.5× (>15%) ⇒ `skyScale` knob. Engine default stays 1 (BP sets 1/7.463 = **0.134**, CALIBRATED-TO-HEMI up-lum; hemi level itself ASSUMED). Residual after scalar: horizon normal 1.32×, down 1.01× (hemi has no horizon brightening); tint differs (hemi normalises zenith to max-channel 1 = bluer than the GI sky) — one scalar can't fix; deliberate.
Reproduce: `skyIrradiance([0,1,0], skySummary(sunPosition(...).dir))` vs `hemiIrradiance`, see test/gi-ambient.test.js.

## Tests
`test/gi-ambient.test.js` (14): coverage fade (edge 0, mid 0.5, ≥blendCells 1, outside 0, weight ramp no step), replace identity c=0→hemi / c=1→gi / mix, skyIrradiance=πL, real r180 node construction, structural mirror scan, controller wiring (sync, manual, no-hemi throttle, skyScale).
NO GPU in node ⇒ numeric TSL==CPU is UNVERIFIED headless; live GPU proof = BP docs/lanes/bo-amb.md.
