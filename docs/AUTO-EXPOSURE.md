# AUTO-EXPOSURE (eye adaptation)
opt-in `lighting.post.autoExposure` → `client/kernel/lighting/autoexposure.js`; default `enabled:false` ⇒ nothing built, 0 cost.

## Design
- Meter = HDR scene colour (scene-pass `output` texture, pre-AO/bloom/tonemap/static exposure). Plain texture node, NOT the PassTextureNode (would re-run scene pass in the nested quad render).
- GPU reduce chain (RTT quads, HalfFloat, run by hand after `post.render()`): 128² (4×4 bilinear taps, mean log2 luma) → 32² → 8² (+ cell weight in G) → 1×1 FLOAT: weighted **percentile-trimmed mean** of the 64 cells (exact rank, 4096 iters, 1 pixel): ignores darkest `lowPct` / brightest `highPct` of weighted mass (sun/sky/black voids), centre-weighted `mix(1,exp(-4r²),centerWeight)`.
- Lag: **async readback** (`readRenderTargetPixelsAsync` 1×1, ≤1 in flight, never awaited ⇒ no stall) → 1–3 frame metering lag (`state.lag`). Adaptation itself is CPU, per frame.
- Exposure lives on GPU as a uniform node `expMul = 2^ev` multiplied into the chain **before bloom** (`resolved.rgb * expMul`). Static `post.exposure`, `renderer.toneMappingExposure` and env dips multiply on top at tonemap ⇒ total = static × dip × AE (meter ignores both ⇒ dips don't fight AE).
- target `ev = clamp(compensation + strength·(log2(key) − meterLog2), minEV, maxEV)`; adapt `ev += (target−ev)·(1−exp(−dt·speed))`, framerate-independent; first reading snaps.
- `speedUp` = scene got brighter (ev falls, UE "dark→bright"), `speedDown` = scene got darker (ev rises). 90% time = ln10/speed.
- Debug: `lighting.autoExposureState` → `{ev,target,lum,meter,mul,reads,inflight,errors,lag,frames,cfg}`. `strength:0` = meter only (read `lum` to calibrate `key`).

## Knobs (all ASSUMED)
| knob | default | note |
|---|---|---|
| enabled | false | |
| minEV/maxEV | −3/+3 | clamp of applied EV |
| compensation | 0 | stops bias |
| key | 0.18 | scene mean lum ⇒ ev 0 (set = your "normal" scene lum to leave it unchanged) |
| strength | 1 | 0 meter only … 1 full normalise |
| speedUp/speedDown | 3/1 | 1/s; 90% in 0.77 s / 2.3 s |
| centerWeight | 0.6 | |
| lowPct/highPct | 0.1/0.9 | |

## Tests
`test/lighting-autoexposure.test.js` (CPU mirrors: trimmedMean, targetEV clamp, framerate independence, asymmetry, no oscillation, chain wiring). GPU path: live-proven in BP lane bq-ae (`docs/lanes/bq-ae.md`).
## Open
Histogram is 64-cell rank-trim, not a fine histogram. Half-res fireflies handled only by log + percentile. No dithering of readback quantisation.
