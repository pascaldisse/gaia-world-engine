# GI-PERF NOTES (solas/gi-perf, 2026-10-06) — DS Asylum, M1-Pro-class target
Rig: DS client (nari-world-companion lampas/ds-gi-shots, copy in untracked .ds/) + engine = this worktree; headless Brave, WebGPU, CDP DPR-2 emulation 1512x982 (=3024x1964). Tools: tools/gi-perf/bench.mjs (interleaved, GPU timestamps via ?gpuTs=1, CDP Performance) · prof.mjs (CPU sampling).
Caveat: machine load avg 15-36 and other lanes' browsers rendering -> runs are BIMODAL (~38 fps/task 26 ms vs ~16 fps/task 62-66 ms) independent of config (GI-off also lands in the slow mode). Compare only within a mode; GPU ms also inflated by contention. UNVERIFIED on real M1 Pro.
## Landed
- renderer.js: render-height param (PIXEL_IRON.targetHeight / ?renderHeight=<px> / pixels.setTargetHeight(h); default unchanged = adaptive DPR). 720 -> 1108x720 on 3024x1964.  ?gpuTs=1 = trackTimestamp (default off).
## Tried + reverted
- gi queryEarlyOut (skip coarser cascades via If where finer covers): rep1 27 vs 12 ms (worse), rep2 25 vs 35 (better) -> noise-dominated, no proven gain, screenshot mean diff 1.1/255 vs baseline (not bit-identical, may be anim noise). Reverted.
## Findings (profile prof.mjs, 720p GI on, 5 s)
- GI-specific CPU is tiny: GI update 0.55-0.68 ms/frame, voxelize ~0.004 ms (bricks done after warm-up), compute encode ~0.1 ms, GPU compute (probe trace/blend) 0.09-0.2 ms/frame.
- Frame CPU 26-66 ms is three.js render submission: getMaterialCacheKey 11%, _projectObject 7%, _renderObjectDirect 7%, getNodeChildren, updateMatrixWorld... = 1735 meshes x (main + 4 shadow cascades, 1674 shadow meshes) draw overhead. Shadows off (dsSun_shadows=0): 38 fps, GPU 9.4 ms, task 27 ms vs ~16 fps/65 ms in same-time runs.
- Resolution: GPU render ms scales ~with pixels: 1964 ~107-178, 1473 ~77, 982 ~35, 720 ~25 (slow mode) / 11-12 (fast mode).
## Next (not done)
- Shadow draw submission (cull/merge 1674 casters, cascade stagger/caching), static-scene render bundles / instancing — outside GI proper.
- Per-pixel GI query costs 3 cascades x 8 corners x 2 reads always; a proper A/B needs a quiet GPU.
## Suite
- node --test (73 non-bun files): 647 tests / 645 pass / 1 fail = test/motion.test.js, IDENTICAL to main 487bec3e. bun test (3 bun files): fail = atlas-analytics.test.js missing ../client/plugins/atlas-analytics.js on both; branch adds gi-voxel-index.test.js (passes).
## Table (raw rows: n values per cell separated by /)
| config | height | mode | n | fps | GPU render ms | GPU compute ms | main-thread task ms/frame | GI update CPU ms | voxelize ms |
|---|---|---|---|---|---|---|---|---|---|
| ao0 | 720 | stand | 1 | 16.51 | 25.87 | 0.178 | 64.58 | 0.613 | 0.003 |
| base | 720 | stand | 2 | 39.06/15.29 | 12.183/35.282 | 0.092/0.156 | 26.33/70 | 0.684/0.622 | 0.003/0.006 |
| base | 720 | walk | 2 | 38.69/15.27 | 10.691/33.781 | 0.09/0.154 | 26.63/70.27 | 0.65/0.621 | 0.003/0.003 |
| base | 1964 | stand | 2 | 12.71/9.65 | 107.426/178.309 | 0.136/0.204 | 27.75/78.09 | 0.679/0.678 | 0.004/0.007 |
| off | 720 | stand | 2 | 18.11/15.86 | 26.856/27.228 | None/None | 57.32/66.13 | 0/0 | 0/0 |
| off | 720 | walk | 2 | 17.99/16.06 | 22.901/32.942 | None/None | 57.64/64.28 | 0/0 | 0/0 |
| off | 1964 | stand | 2 | 18.01/16.04 | 82.888/93.193 | None/None | 58/64.85 | 0/0 | 0/0 |
| on | 720 | stand | 3 | 17/17.13/15.89 | 27.084/25.069/24.821 | 0.147/0.145/0.176 | 62.34/61.73/66.99 | 0.561/0.552/0.591 | 0.004/0.004/0 |
| on | 720 | walk | 2 | 17.05/15.98 | 26.985/31.07 | 0.155/0.152 | 62.69/66.98 | 0.555/0.595 | 0.001/0.004 |
| on | 982 | stand | 1 | 17.01 | 34.681 | 0.139 | 62.18 | 0.553 | 0.003 |
| on | 1473 | stand | 1 | 16.15 | 76.513 | 0.173 | 65.67 | 0.59 | 0.005 |
| on | 1964 | stand | 2 | 11.9/11.89 | 142.345/139.085 | 0.205/0.175 | 74.06/68.11 | 0.608/0.613 | 0.005/0.002 |
| sh0 | 720 | stand | 1 | 38.23 | 9.374 | 0.105 | 26.86 | 0.583 | 0.002 |
# DRAW-BATCH (lampas/draw-batch, 2026-10-06) — static batching + shadow caching
Code: client/kernel/static-batch.js (new, wired in main.js: `staticBatch.update()` before render, `gaia.staticBatch`), client/kernel/lighting/shadows.js (`staticCache`), tests test/static-batch.test.js (13).
## Options (all default OFF; tooling flags ?staticBatch=1 ?staticBatchCell=<m> ?shadowCache=1|<refreshFrames>; config GAIA_RENDER_CONFIG.staticBatch / lighting shadows cfg staticCache)
- staticBatch: meshes whose matrixWorld is unchanged for settleScans scans, non-skinned/instanced/morph/transparent/noBatch/dynamic, merge per (material, attr signature, cast/receive, renderOrder, 32 m cell) in WORLD space; originals stay in graph (GI voxelizer/collision/game refs) hidden via layers.mask=0 (`visible` untouched). Per-frame guard: member matrix/visible/castShadow/geometry/material change -> chunk released, originals restored + flagged noBatch.
- shadowProxy (with staticBatch): static opaque non-alpha casters merged ACROSS materials (position+index only, 48 m cells) into proxies on layer 5; sun shadow cameras incl. CSM cascade lights (clones in shadowNode.lights, castShadow unset!) get layer 5; originals castShadow=false. Alpha-tested / alphaMap / positionNode materials stay real casters. Bug found+fixed in lane: cascade cameras missed first -> proxies invisible to shadows (looked like a win: tris -14%; real tris after fix == baseline). three's shadow pass uses overrideMaterial but reads side/alphaTest/alphaMap from the caster's material.
- shadows.staticCache: cascade 0 every frame; far cascades only on sun move / stagger guard overshoot / every cacheRefresh(30) frames (offset per cascade). Dynamic casters in far cascades lag <= cacheRefresh frames. TRUE static/dynamic caster separation is not possible with three's one-pass-per-cascade shadow map (documented, not done).
## Scene facts (Asylum): 1734 meshes = 648 SKINNED (characters, 385k verts, ALL cast, never batchable) + 263 invisible dyncol + ~560 static visible with 507 unique materials (~1 mesh/material) -> same-material merge only finds 157 meshes/61 chunks; draw calls dominated by skinned meshes x (main + cascades).
## Measurements 720p GI on, DS Asylum start pose, in-page toggle A/B (draw calls = mean renderer.info.render.drawCalls/frame, rAF-sampled; machine load 12-70, other lanes' browsers running; bimodal CPU -> compare within run)
| config | drawCalls | tris | task ms/frame (bench, 2 reps) | GPU render ms (bench) | fps |
| base | 2545 | 2.245M | 63.7/62.3 | 28.7/30.9 | 16.9/17.2 |
| staticBatch (batch+proxy) | ~2195 (main-only 2375) | 2.26M | 55.4/55.6 | 26.5/25.6 | 19.3/19.1 |
| staticBatch + shadowCache | 1627 | 1.81M | 41.0/40.7 | 25.1/25.0 | 25.5/25.6 |
| shadowCache only (in-page, 3 reps, before layer fix) | 1996 | 1.81M | 44.7-48.7 | - | 20.6-22.5 |
Screenshots (same camera, rep1 vs older baseline run; mean |diff| 0-255): base-vs-base noise 0.11, staticBatch 0.26, +cache 0.32; x8-amplified p99.9 <=40/255, px>32: 0.00-0.14% (noise floor 0.02%). START POSE IS NEAR BLACK (mean lum 13.5/255): a lit-room shadow comparison is UNVERIFIED.
## Not done / next: skinned-mesh draw cost (648 meshes x passes = biggest remaining): distance/frustum cap for skinned shadow casting, merge skinned parts per character; per-MTD texture-array materials to make static merge effective; real-M1 GPU numbers.
## Tests: node --test: 4 fails = test/motion, tools/_cdp-record-test, tools/cdp-static-test, tools/test-zip (all main-known); bun test: 6 fail = same RTS-numeric-pin + 2 gi-nodes-parity source-wiring fails (verified FAIL on main ab4f5f6c too) + 'external uris' (humanoid-tex; flaky under load: passes alone on branch AND main) + atlas-analytics file.
