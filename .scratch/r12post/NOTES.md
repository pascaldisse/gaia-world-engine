# r12-post NOTES
## S1 inventory (three chain, client/kernel/lighting/post.js buildChain)
scenePass(output[+normalView MRT][+velocity MRT if traa]) -> GTAONode `ao(depth, normal|null, camera)` (resolutionScale .5, radius 1.2, thickness 1, samples 16; distanceExponent/FallOff/scale = GTAONode defaults 1)
-> color*aoTerm, aoTerm = mix(1, mix(1, rawAo.r, intensity .85), 1 - smoothstep(fadeStart 80, fadeEnd 150, -viewZ)) [rig composite]
-> [TRAA(lit, depth, velocity) if cfg.traa.enabled (default OFF)] -> * AE expMul -> + bloom(resolved) -> renderer tonemap/exposure.
NO denoise/blur node in r180 GTAONode (DenoiseNode is separate, not used by the rig) -> nothing to port. Ladder: mrt normals -> depth normals -> none.
wgpu post bridge (post-bridge.js) BEFORE r12: mirrors toneMapping/exposure/bloom/AE only. GTAO, TRAA, rig composite DROPPED SILENTLY (not even stats.unsupported).
## S2 core GTAO
crates/gaia-render/src/gtao.wgsl = line-for-line port of GTAONode `ao` Fn + PostProcessingUtils getViewPosition/getScreenPosition/getNormalFromDepth (generating WGSL via three's node builder needs a live WebGPURenderer/device -> infeasible compile-free; math ported w/ cites in file header).
Normals: RECONSTRUCTED FROM DEPTH (getNormalFromDepth, three's own no-normal-node path) - core has no normal MRT target; the engine 'mrt' rung's normals are not mirrored (state: depth-normal GTAO).
Composite point = same as three chain: before AE mul / bloom highpass / tonemap (post.wgsl ao_term in fs_highpass + fs_resolve). Meter stays pre-AO (as three).
Deviation: fade weight computed in the AO pass at AO resolution (G channel, bilinear-filtered at resolve) vs three's full-res depth per pixel.
Tests: tests/gtao.rs flat plane min ratio .956 (sRGB), inner corner .692 at crease, top/near 1.000.
Commit: see git log.
