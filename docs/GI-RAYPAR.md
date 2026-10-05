# GI open-mode ray-parallel kernels (lane L-GIK)

§ problem: `createOpenIrradianceKernel`/`createOpenDepthKernel` (gi-open-nodes.js) = 1 thread per TEXEL × loop ALL rays × 96 march steps → every texel of a probe re-traces the same rays (irr 64 texels + depth 256 texels = 320× redundant per probe). BP 896 probes ≈ 9M marches/frame → 11-22 fps vs 62 off.

§ fix: DDGI 2-pass, `gi-open-raypar.js`, flag `rayParallel` (default **true**; `false` = legacy A/B path, untouched)
- pass 1 TRACE: thread = (probe, ray); `probeLocal = t / rays`, `rayI = t % rays` → march + shade (sun, shadow march, bounce query, sky) → `rayBuf[probeLocal*rays + rayI] = vec4(radiance, hitT)`; `rayBuf` = batch-ordinal×rays vec4 (`probeCount*rays`)
- pass 2a IRR BLEND: thread = texel; Σ rayBuf radiance × max(0, texelDir·fibDir_i) × 4π/N; same adaptive hysteresis / fresh-sentinel / disabled → 0 as legacy
- pass 2b DEPTH BLEND: thread = texel; Σ cosine-weighted (dist, dist²), miss → maxDist; `old.x<0` → take fresh; disabled → (-1,-1)
- order per frame: trace → irr blend → dep blend (irr reads depth sentinel before dep rewrites it); ONE march now serves BOTH atlases
- disabled probe: trace writes `hitT = -2` (`DISABLED_HIT`) to all its rays, blend reads ray 0 `.w` (no re-resolve per texel); miss stays -1
- bounce: trace pass reads irradiance/depth atlases, blend passes write them → trace never races blend (legacy raced intra-dispatch under bounce)
- storage buffers: trace 4 (rayBuf, irr, depth, voxels) · irr blend 3-4 · depth blend 2 (≤ 8)
- controller: `GIOpen.trace`/`.rayBuf` (null when legacy); `irr`/`dep` keep `.alpha/.validCount`; `irr.bounceScale` === `trace.bounceScale` (shared uniform)
- files: `client/kernel/gi/gi-open-raypar.js` (+ `export` on 5 helpers in gi-open-nodes.js: decodeOctTSL fibonacciDirTSL probeWorldPos batchProbeIndex luma), `gi-open-controller.js` wiring

§ proof — live WebGPU (Brave 154 / Apple GPU), `tools/gi-raypar-bench.html` (served from worktree root :15490, CDP :19490); scene = 3 cascades × 8×4×8 = 768 probes (BP 896), 32 rays, 96 steps, irr 8² / depth 16², all probes every frame

| config | gpu ms/update | updates/s (wall) | parity vs legacy (max abs) |
|---|---|---|---|
| legacy `rayParallel:false` — timestamp-query median | 29.03 | — | — |
| ray-parallel — timestamp-query median | 0.92 | — | irr 2.4e-7 · depth 0 |
| legacy — wall, queue-synced/update, 5 s × 3 | 31.8 mean (31.7-31.9) | 31.4 | — |
| ray-parallel — wall, queue-synced/update, 5 s × 3 | 2.00 mean (1.96-2.04), median 1.4 | ~500 | irr 2.4e-7 · depth 0 |
| legacy — wall, 30 updates/sync (median of 5) | 31.9 | — | — |
| ray-parallel — wall, 30 updates/sync | 1.35 | — | — |

- speedup: timestamp-query **31.6×** (median; mean 22.0×) · wall synced **15.9×** mean (22.7× median) · wall batched **23.7×** → target ≥5× met
- parity (bounceScale 0 → race-free; atlas readback of ALL 768 probes; 0 GPU errors via withGpuValidation):
  - 32 rays, α=0.9, 20 frames: irr 2.38e-7, depth 0 (147k/196k irr texels non-zero)
  - 32 rays, α=0 (pure single-dispatch): irr 0, depth 0 (bit-exact)
  - 64 rays, α=0.9, 5 frames: irr 2.38e-7, depth 0
  - bounceScale 1, 20 frames (informational — legacy has intra-dispatch races): irr 1.4e-4, depth 0
  - gate ≤ 1e-3: PASS · gpuErrors: []
- raw: `/tmp/l-gik-bench-full.json` (run 2026-10-05 14:12)
- rerun: `cd <worktree> && python3 -m http.server 15490`; open `http://localhost:15490/tools/gi-raypar-bench.html?secs=5&reps=3` → `window.__giRaypar`

§ unit tests: `test/gi-open-raypar.test.js` (layout slot math, blend == reference `integrateProbeIrradiance` / depth moments, fibDirJS == `fibonacciSphereDirs`, disabled flag, hazard scans + mutants, storage budget, headless graph build); `test/gi-open-controller.test.js` (legacy 2-dispatch vs default 3-dispatch order/sizes)

§ open
- BP not rebuilt/measured end-to-end (harness only) — expect fps recovery to near GI-off but UNVERIFIED in game
- trace thread = (probe, ray) with wg 64 → 2 probes/wg; divergence across rays of a probe unmeasured vs wg 32/other layouts
- fresh-start `dispatchedProbes` beyond ray buffer capacity impossible (buffer = probeCount×rays) — batch ≤ probeCount by construction
- further wins (not done): skip trace for probes with unchanged geometry/sun; half-rate far cascades via updateFractions
- default flipped to `rayParallel:true`: BP callers opting out pass `rayParallel:false`
