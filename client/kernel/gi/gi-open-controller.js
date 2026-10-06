// v2 open-world controller (docs/GI-PROBES.md §v2 open-world). Owned by GIController when configure({mode:'open'}).
// Per update(dt, cameraPos): 3D recenter (voxel window + every cascade) → rebuild≤N dirty bricks → ONE partial
// upload range per brick → mark entered probes fresh (depth sentinel) → ONE dispatch per kernel covering every
// cascade's round-robin batch. RTS path never touches this file.
import { buildCascades, totalProbes, scrollCascade, cascadeBaseCell, planCascadeBatches, CASCADE_DEFAULTS } from './cascade.js';
import { VoxelWindow, VOXEL_DEFAULTS, extractMeshTriangles } from './voxel-window.js';
import { OPEN_DEFAULTS } from './gi-reference.js';
import {
  createProbeAtlases, createVoxelStorage, setVoxelBase, flushVoxelUploads, createCascadeUniforms, setCascadeBases,
  createSkyUniforms, createAmbientUniforms, createBatchUniforms, setBatch, createOpenIrradianceKernel, createOpenDepthKernel, createOpenQueryNode,
} from './gi-open-nodes.js';
import { createRayParallelKernels } from './gi-open-raypar.js';
import { uniform, vec3, positionWorld, normalWorld } from 'three/tsl';

export const OPEN_PARAM_DEFAULTS = {
  cascades: CASCADE_DEFAULTS, // {count, spacings, dims, updateFractions, blendCells}
  voxel: VOXEL_DEFAULTS, // {cellSize, brickSize, bricks, maxBricksPerUpdate}
  sky: OPEN_DEFAULTS.sky, // fallback 3-colour gradient when no skySummary
  adaptive: OPEN_DEFAULTS.adaptive,
  ambient: 'add', // 'add' (default, unchanged: GI irradiance is ADDED to whatever the scene's hemi light contributes) | 'replace' (GI substitutes the hemi sky ambient where it has coverage: net irradiance = mix(hemi(n), gi, coverage); coverage fades to 0 over the coarsest cascade's outer blendCells -> hemi takes over outside the volume)
  skyScale: 1, // x on the sky radiance the probes see (miss rays + sky-lit bounce). 1 = as published by lighting.skySummary; set to hemiLum/giOpenSkyLum to CALIBRATE the GI open-sky level to the hemi light (docs/GI-AMBIENT.md)
  ambientLight: null, // 'replace': HemisphereLight-like {color, groundColor, intensity} synced every update(); null = first HemisphereLight found in the scene (cached; re-searched only if it leaves the scene)
  relocateMax: null, // world units; null = half the finest spacing
  maxMarchDist: 48, // = OPEN_MARCH_STEPS*cell/2 at 1 m cells
  queryEarlyOut: true, // per-pixel material query skips coarser cascades where the finer one fully covers (same result, fewer probe reads; false = evaluate all cascades, A/B)
rayParallel: true, // DDGI 2-pass (trace: 1 thread per probe-ray -> ray buffer, then per-texel blend; docs/GI-RAYPAR.md). false = legacy per-texel full-ray kernels (A/B)
};

export class GIOpen {
  constructor({ renderer, scene, params, attachment }) {
    this.renderer = renderer; this.scene = scene; this.attachment = attachment;
    const p = this.p = { ...params };
    const casc = { ...CASCADE_DEFAULTS, ...(p.cascades ?? {}) };
    this.cascades = buildCascades(casc);
    this.blendCells = casc.blendCells;
    this.win = new VoxelWindow({ ...VOXEL_DEFAULTS, ...(p.voxel ?? {}) });
    const total = totalProbes(this.cascades);
    this.atlases = createProbeAtlases({ probeCount: total, irradianceRes: p.irradianceRes, depthRes: p.depthRes });
    this._depthAttr = this.atlases.depth.value; // StorageInstancedBufferAttribute (CPU array = sentinel writer)
    this._depthAttr.array.fill(-1); // all probes start 'fresh' (sentinel) → first update takes new value, queries skip them
    this.vs = createVoxelStorage(this.win);
    this.baseCellU = createCascadeUniforms(this.cascades);
    this.batch = createBatchUniforms();
    this.skyScale = p.skyScale ?? 1; this._skyRaw = { ...(p.sky ?? OPEN_DEFAULTS.sky) };
    this.sky = createSkyUniforms(this._skyRaw); this._applySky();
    this.ambientMode = p.ambient === 'replace' ? 'replace' : 'add';
    this.ambientU = createAmbientUniforms(); this._ambientManual = false; this._hemi = p.ambientLight ?? null; this._hemiMiss = 0; this.ambientSyncs = 0;
    this.sun = { direction: uniform(vec3(...p.sun.direction)), color: uniform(vec3(...p.sun.color)), intensity: uniform(p.sun.intensity) };
    const relocateMax = p.relocateMax ?? this.cascades[0].spacing * 0.5;
    const maxDist = Math.min(p.voxelMaxDist ?? 48, p.maxMarchDist ?? 48);
    const common = { atlases: this.atlases, vs: this.vs, cascades: this.cascades, baseCellU: this.baseCellU, batch: this.batch, raysPerProbe: p.raysPerProbe, maxDist, hysteresis: p, relocateMax };
    const adaptive = p.adaptive ?? OPEN_DEFAULTS.adaptive;
    this.rayParallel = p.rayParallel !== false; this.trace = null; this.rayBuf = null;
    if (this.rayParallel) { const k = createRayParallelKernels({ ...common, sun: this.sun, sky: this.sky, adaptive, blendCells: this.blendCells }); this.trace = k.trace; this.rayBuf = k.rayBuf; this.irr = k.irr; this.dep = k.dep; }
    else { this.irr = createOpenIrradianceKernel({ ...common, sun: this.sun, sky: this.sky, adaptive, blendCells: this.blendCells }); this.dep = createOpenDepthKernel(common); }
    if (p.bounceScale != null) this.irr.bounceScale.value = p.bounceScale;
    this.queryNode = createOpenQueryNode({ atlases: this.atlases, cascades: this.cascades, baseCellU: this.baseCellU, worldPositionNode: positionWorld, normalNode: normalWorld, blendCells: this.blendCells, ambient: this.ambientMode, ambientU: this.ambientU, earlyOut: p.queryEarlyOut !== false });
    this.baseCells = null; this.cursors = this.cascades.map(() => 0);
    this.stats = { frames: 0, bricksRebuilt: 0, bricksUploaded: 0, freshProbes: 0, dispatchedProbes: 0 };
    this.attachment?.attachAll(this.scene, this.queryNode);
  }
  // ---- API for the game (BP)
  /** mesh = {triangles: Float32Array|number[] (world xyz*3/tri), color?, textureMean?, albedo?, aabb?} */
  addMesh(id, mesh) { this.win.addMesh(id, mesh); }
  removeMesh(id) { return this.win.removeMesh(id); }
  /** convenience: three Mesh (matrixWorld baked; material.color × material.userData.meanColor) */
  addThreeMesh(id, mesh) { this.win.addMesh(id, extractMeshTriangles(mesh)); }
  /** environment.lighting.skySummary {zenith,horizon,ground} → sky uniforms (live, no rebuild) */
  setSkySummary(s) { if (!s) return; for (const k of ['zenith', 'horizon', 'ground']) if (s[k]) this._skyRaw[k] = [s[k][0], s[k][1], s[k][2]]; this._applySky(); }
  _applySky() { const k = this.skyScale; for (const c of ['zenith', 'horizon', 'ground']) { const v = this._skyRaw[c]; this.sky[c].value.set(v[0] * k, v[1] * k, v[2] * k); } }
  /** x on the probe-side sky radiance (see OPEN_PARAM_DEFAULTS.skyScale). Live: re-applies the last summary */
  setSkyScale(v) { this.skyScale = v; this._applySky(); }
  /** 'replace' mode: set the hemi ambient by hand {sky, ground (rgb array|{r,g,b}), intensity=1}; stops the per-update light sync */
  setAmbient({ sky, ground, intensity = 1 } = {}) { this._ambientManual = true; this._writeAmbient(sky, ground, intensity); }
  _writeAmbient(sky, ground, intensity) { const rgb = (c) => (Array.isArray(c) ? c : c ? [c.r, c.g, c.b] : [0, 0, 0]); const s = rgb(sky), g = rgb(ground); this.ambientU.sky.value.set(s[0] * intensity, s[1] * intensity, s[2] * intensity); this.ambientU.ground.value.set(g[0] * intensity, g[1] * intensity, g[2] * intensity); this.ambientSyncs++; }
  /** 'replace' mode: copy the scene hemi light into the ambient uniforms (cheap; cached light, re-searched only when missing). Called by update(); callers that throttle update() may call it directly */
  syncAmbient() {
    if (this.ambientMode !== 'replace' || this._ambientManual) return false;
    let h = this._hemi;
    if (!h || (h.parent === null && !this.p.ambientLight)) { // gone from the scene -> re-search (throttled when none exists)
      h = null; if (this._hemiMiss-- <= 0) { this.scene?.traverse?.((o) => { if (!h && o.isHemisphereLight) h = o; }); this._hemiMiss = h ? 0 : 120; } this._hemi = h;
    }
    if (!h) return false;
    this._writeAmbient(h.color, h.groundColor, h.intensity ?? 1); return true;
  }
  setBounceScale(v) { this.irr.bounceScale.value = v; }
  setSun(sun) { if (sun.direction) this.sun.direction.value.set(...sun.direction); if (sun.color) this.sun.color.value.set(...sun.color); if (sun.intensity != null) this.sun.intensity.value = sun.intensity; }

  _markFresh(freshByCascade) {
    const tpp = this.atlases.depthRes * this.atlases.depthRes; const item = this._depthAttr.itemSize; let n = 0;
    this._depthAttr.clearUpdateRanges();
    freshByCascade.forEach((slots, k) => {
      for (const s of slots) {
        const start = (this.cascades[k].baseIndex + s) * tpp * item;
        this._depthAttr.array.fill(-1, start, start + tpp * item);
        this._depthAttr.addUpdateRange(start, tpp * item); n++;
      }
    });
    if (n) this._depthAttr.needsUpdate = true; // ranges present → partial write only (never whole-buffer: would clobber GPU state)
    return n;
  }
  update(dt, cameraPos = [0, 0, 0]) {
    this.syncAmbient();
    this.win.setCenter(cameraPos); setVoxelBase(this.vs, this.win);
    const r = this.win.update();
    const uploaded = flushVoxelUploads(this.vs, r.rebuilt);
    const fresh = this.cascades.map(() => []);
    const first = this.baseCells === null;
    const next = this.cascades.map((c, k) => {
      if (first) return cascadeBaseCell(c, cameraPos);
      const s = scrollCascade(c, this.baseCells[k], cameraPos); fresh[k] = s.freshSlots; return s.baseCell;
    });
    this.baseCells = next; setCascadeBases(this.baseCellU, next);
    const nFresh = this._markFresh(fresh);
    const plan = planCascadeBatches(this.cascades, this.cursors); this.cursors = plan.cursors;
    const total = setBatch(this.batch, plan.starts, plan.counts);
    const irrN = total * this.atlases.irradianceRes ** 2, depN = total * this.atlases.depthRes ** 2;
    this.irr.validCount.value = irrN; this.dep.validCount.value = depN;
    if (this.trace) { const traceN = total * this.p.raysPerProbe; this.trace.validCount.value = traceN; this.renderer?.compute(this.trace.kernel, traceN); } // pass 1 (ray-parallel): one thread per (probe, ray)
    this.renderer?.compute(this.irr.kernel, irrN); this.renderer?.compute(this.dep.kernel, depN); // irr BEFORE dep (irr reads the depth sentinel)
    const newlyAttached = this.attachment?.syncNewMeshes(this.scene, this.queryNode) ?? 0;
    const st = this.stats; st.frames++; st.bricksRebuilt += r.rebuilt.length; st.bricksUploaded += uploaded; st.freshProbes += nFresh; st.dispatchedProbes += total;
    return { dispatched: true, mode: 'open', bricksRebuilt: r.rebuilt.length, bricksPending: r.remaining, freshProbes: nFresh, probesDispatched: total, newlyAttached };
  }
  dispose() { this.attachment?.detachAll(); }
}
