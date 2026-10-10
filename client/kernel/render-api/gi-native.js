// render-api/gi-native.js — NATIVE probe GI sink (lane nt-gi). The probe-GI compute (client/kernel/gi, GI-PROBES.md open mode) runs in gaia-render (gi_compute.rs/.wgsl,
// a literal translation of the TSL kernels); the page keeps ONLY the CPU bookkeeping (voxel window bricks, cascade scroll, batch plan, uniforms) and ships it here:
//   GIOpen.update -> sink.voxels(start, u32[])   one dirty brick range each (and the whole window once at init)
//                 -> sink.step(frame, fresh)     frame = packGiFrame(), fresh = global probe indices that entered a window (depth sentinel)
// Replaces gi-bridge.js (three compute on three's GPU device + ~19 MB atlas readback / 30 frames). NO three imports.
//
//   const giNative = createGiNative({ backend });  environment.gi.attachNative(giNative);
// Frame layout (f32, mirrors gaia-render gi_compute.rs GF_*; length checked by the core): see GI_FRAME.
export const GI_FRAME = Object.freeze({ LEN: 44, BASE_BRICK: 0, BOUNCE: 3, SUN_DIR: 4, SUN_INTENSITY: 7, SUN_COLOR: 8, AMBIENT_REPLACE: 11, ZENITH: 12, HORIZON: 16, GROUND: 20, STARTS: 24, COUNTS: 28, BASE_CELLS: 32, MAX_CASCADES: 4 });
const v3 = (v) => (Array.isArray(v) ? v : [v.x, v.y, v.z]);
/** pure: pack one frame's GI state. sun/sky entries are {x,y,z}|[x,y,z] (three Vector3 uniform values), baseCells = [[x,y,z]..] per cascade. */
export function packGiFrame({ baseBrick, bounceScale, sunDirection, sunColor, sunIntensity, ambientReplace, zenith, horizon, ground, starts, counts, baseCells }) {
  const f = new Float32Array(GI_FRAME.LEN);
  f.set(baseBrick, GI_FRAME.BASE_BRICK); f[GI_FRAME.BOUNCE] = bounceScale;
  f.set(v3(sunDirection), GI_FRAME.SUN_DIR); f[GI_FRAME.SUN_INTENSITY] = sunIntensity; f.set(v3(sunColor), GI_FRAME.SUN_COLOR); f[GI_FRAME.AMBIENT_REPLACE] = ambientReplace ? 1 : 0;
  f.set(v3(zenith), GI_FRAME.ZENITH); f.set(v3(horizon), GI_FRAME.HORIZON); f.set(v3(ground), GI_FRAME.GROUND);
  if (starts.length > GI_FRAME.MAX_CASCADES || counts.length > GI_FRAME.MAX_CASCADES || baseCells.length > GI_FRAME.MAX_CASCADES) throw new Error(`packGiFrame: more than ${GI_FRAME.MAX_CASCADES} cascades`);
  starts.forEach((s, k) => { f[GI_FRAME.STARTS + k] = s; });
  counts.forEach((c, k) => { f[GI_FRAME.COUNTS + k] = c; });
  baseCells.forEach((b, k) => f.set(b, GI_FRAME.BASE_CELLS + 3 * k));
  return f;
}
/** sink for GIOpen. backend = wgpu backend (wgpu-backend.js) exposing giComputeInit/Voxels/Step/Destroy/Stats/Error. */
export function createGiNative({ backend } = {}) {
  for (const m of ['giComputeInit', 'giComputeVoxels', 'giComputeStep', 'giComputeDestroy']) if (typeof backend?.[m] !== 'function') throw new Error(`createGiNative: backend has no ${m} (needs a gaia-render build with native GI compute)`);
  const st = { inits: 0, voxelWrites: 0, voxelWords: 0, steps: 0, freshProbes: 0, lastError: null, core: null };
  let live = false;
  return {
    stats: st,
    get live() { return live; },
    /** cfg = GIOpen.nativeConfig(); words = the whole CPU voxel window (uploaded once; later only dirty bricks) */
    init(cfg, words) { backend.giComputeInit(JSON.stringify(cfg)); live = true; st.inits++; if (words?.length) this.voxels(0, words); },
    voxels(start, words) { backend.giComputeVoxels(start, words); st.voxelWrites++; st.voxelWords += words.length; },
    step(frame, fresh) { backend.giComputeStep(frame, fresh); st.steps++; st.freshProbes += fresh.length; },
    /** drain the core's last failure + counters into stats (cheap; call from the presenter once per frame) */
    poll() { const e = backend.giComputeError?.(); if (e) st.lastError = String(e); st.core = backend.giComputeStats?.() ?? null; return st; },
    destroy() { if (live) { backend.giComputeDestroy(); live = false; } },
  };
}
