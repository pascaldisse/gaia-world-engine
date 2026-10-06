// render-api/gi-bridge.js — probe GI for the wgpu backend. three keeps running the GI compute (client/kernel/gi, open mode); this bridge periodically
// reads the probe irradiance + depth atlases back (async, non-blocking: renderer.getArrayBufferAsync, at most ONE read in flight) and hands them to
// backend.setGiProbes, where forward.wgsl samples them with the same math as gi-open-nodes.js queryCascadesCoverageTSL (+ hemi substitution).
// NO three imports (duck-typed controller): works with the engine-injected namespace.
//
//   const bridge = createGiBridge({ backend, renderer, getController: () => environment.gi, everyFrames: 30 });
//   bridge.tick();   // once per frame (cheap: counter + one in-flight flag)
//
// Atlas memory layout (gi-nodes.js createProbeAtlases): irradiance = instancedArray(n,'vec3') → WGSL stride 16 B (4 f32/texel, w pad),
// depth = instancedArray(n,'vec2') → 2 f32/texel (mean, mean²). Params snapshot = cascades + window base cells AT READBACK TIME (toroidal slot→cell map).
export const GI_PARAM_HEADER = 8, GI_PARAM_CASCADE = 8;

/** pure: pack GIOpen state into the setGiProbes `params` array. open = GIController.resources.open (GIOpen). */
export function packGiParams(open) {
  const cs = open.cascades, bases = open.baseCells;
  if (!cs?.length || !bases) return null;
  const p = [cs.length, open.blendCells ?? 1.5, open.atlases.irradianceRes, open.atlases.depthRes, open.ambientMode === 'replace' ? 1 : 0, 0, 0, 0];
  cs.forEach((c, k) => p.push(bases[k][0], bases[k][1], bases[k][2], c.spacing, c.dims.x, c.dims.y, c.dims.z, c.baseIndex));
  return Float32Array.from(p);
}

export function createGiBridge({ backend, renderer, getController, everyFrames = 30 } = {}) {
  const st = { frames: 0, reads: 0, skipped: 0, errors: 0, inFlight: false, active: false, lastMs: 0, lastBytes: 0, lastError: null };
  let wasActive = false;
  const openOf = () => { const c = getController?.(); return c?.resources?.open ?? c?._open ?? null; };
  async function read(open, params) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const [ib, db] = await Promise.all([renderer.getArrayBufferAsync(open.atlases.irradiance.value), renderer.getArrayBufferAsync(open.atlases.depth.value)]);
      backend.setGiProbes(new Float32Array(ib), new Float32Array(db), params);
      st.reads++; st.lastBytes = ib.byteLength + db.byteLength; st.active = true; wasActive = true;
    } catch (e) { st.errors++; st.lastError = String(e?.message ?? e); }
    finally { st.inFlight = false; st.lastMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0; }
  }
  return {
    stats: st,
    /** call once per frame; kicks an async readback every `everyFrames` frames when GI open mode is live. Returns the promise when one started (tests). */
    tick() {
      st.frames++;
      if (!backend.setGiProbes || !renderer?.getArrayBufferAsync) return null;
      if (st.inFlight || (st.frames % everyFrames) !== 1 % everyFrames) { if (st.inFlight) st.skipped++; return null; }
      const open = openOf();
      const params = open ? packGiParams(open) : null;
      if (!params) { if (wasActive && backend.clearGiProbes) { backend.clearGiProbes(); wasActive = false; st.active = false; } return null; }
      st.inFlight = true;
      return read(open, params);
    },
  };
}
