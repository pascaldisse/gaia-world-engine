// v2 open-world controller (docs/GI-PROBES.md §v2 open-world). Owned by GIController when configure({mode:'open'}).
// Per update(dt, cameraPos): 3D recenter (voxel window + every cascade) → rebuild≤N dirty bricks → ONE partial
// upload range per brick → mark entered probes fresh (depth sentinel) → ONE dispatch per kernel covering every
// cascade's round-robin batch. RTS path never touches this file.
import { buildCascades, totalProbes, scrollCascade, cascadeBaseCell, planCascadeBatches, CASCADE_DEFAULTS } from './cascade.js';
import { VoxelWindow, VOXEL_DEFAULTS, extractMeshTriangles } from './voxel-window.js';
import { OPEN_DEFAULTS } from './gi-reference.js';
import {
  createProbeAtlases, createVoxelStorage, setVoxelBase, flushVoxelUploads, createCascadeUniforms, setCascadeBases,
  createSkyUniforms, createBatchUniforms, setBatch, createOpenIrradianceKernel, createOpenDepthKernel, createOpenQueryNode,
} from './gi-open-nodes.js';
import { uniform, vec3, positionWorld, normalWorld } from 'three/tsl';

export const OPEN_PARAM_DEFAULTS = {
  cascades: CASCADE_DEFAULTS, // {count, spacings, dims, updateFractions, blendCells}
  voxel: VOXEL_DEFAULTS, // {cellSize, brickSize, bricks, maxBricksPerUpdate}
  sky: OPEN_DEFAULTS.sky, // fallback 3-colour gradient when no skySummary
  adaptive: OPEN_DEFAULTS.adaptive,
  relocateMax: null, // world units; null = half the finest spacing
  maxMarchDist: 48, // = OPEN_MARCH_STEPS*cell/2 at 1 m cells
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
    this.sky = createSkyUniforms(p.sky ?? OPEN_DEFAULTS.sky);
    this.sun = { direction: uniform(vec3(...p.sun.direction)), color: uniform(vec3(...p.sun.color)), intensity: uniform(p.sun.intensity) };
    const relocateMax = p.relocateMax ?? this.cascades[0].spacing * 0.5;
    const maxDist = Math.min(p.voxelMaxDist ?? 48, p.maxMarchDist ?? 48);
    const common = { atlases: this.atlases, vs: this.vs, cascades: this.cascades, baseCellU: this.baseCellU, batch: this.batch, raysPerProbe: p.raysPerProbe, maxDist, hysteresis: p, relocateMax };
    this.irr = createOpenIrradianceKernel({ ...common, sun: this.sun, sky: this.sky, adaptive: p.adaptive ?? OPEN_DEFAULTS.adaptive, blendCells: this.blendCells });
    this.dep = createOpenDepthKernel(common);
    if (p.bounceScale != null) this.irr.bounceScale.value = p.bounceScale;
    this.queryNode = createOpenQueryNode({ atlases: this.atlases, cascades: this.cascades, baseCellU: this.baseCellU, worldPositionNode: positionWorld, normalNode: normalWorld, blendCells: this.blendCells });
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
  setSkySummary(s) { if (!s) return; for (const k of ['zenith', 'horizon', 'ground']) if (s[k]) this.sky[k].value.set(s[k][0], s[k][1], s[k][2]); }
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
    this.renderer?.compute(this.irr.kernel, irrN); this.renderer?.compute(this.dep.kernel, depN);
    const newlyAttached = this.attachment?.syncNewMeshes(this.scene, this.queryNode) ?? 0;
    const st = this.stats; st.frames++; st.bricksRebuilt += r.rebuilt.length; st.bricksUploaded += uploaded; st.freshProbes += nFresh; st.dispatchedProbes += total;
    return { dispatched: true, mode: 'open', bricksRebuilt: r.rebuilt.length, bricksPending: r.remaining, freshProbes: nFresh, probesDispatched: total, newlyAttached };
  }
  dispose() { this.attachment?.detachAll(); }
}
