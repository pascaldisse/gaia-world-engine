// Wiring (§GI-PROBES.md Fallbacks/default). `environment` component gains
// `gi: {...}`, default `enabled:false`. GIController is the single place
// that decides whether ANY probe/storage/compute/IrradianceNode resource
// ever gets created — the off path (default) must touch nothing, proven by
// test/gi-controller.test.js. This file also owns the two things the
// parent's review flagged as unconfirmed: voxelizing the scene (on enable
// AND on a scene-change signal) and actually dispatching the compute
// kernels per frame with a rotating probeOffset.

import { buildProbeGrid, recenterGrid } from './probe-grid.js';
import { voxelizeTriangles } from './voxelize.js';
import {
  createOccupancyStorage, createProbeAtlases, createPointLightPool,
  createGIUpdateKernel, createGIDepthUpdateKernel, createGIQueryNode, createTouchedBuffer,
} from './gi-nodes.js';
import { GISceneAttachment } from './gi-attach.js';
import { uniform, vec3, positionWorld, normalWorld } from 'three/tsl';

export const GI_DEFAULTS = {
  enabled: false,
  spacing: 8,
  halfExtentXZ: 40,
  layersY: 3,
  heightRange: [0, 12],
  raysPerProbe: 64, // PLACEHOLDER — see docs/GI-PROBES.md Ray budget
  updateFraction: 1 / 8, // PLACEHOLDER — fraction of probes refreshed per update() call
  irradianceRes: 8,
  depthRes: 16,
  irradianceAlpha: 0.97, // PLACEHOLDER
  depthAlpha: 0.9, // PLACEHOLDER
  voxelCellSize: 1, // PLACEHOLDER occupancy grid resolution
  voxelMaxDist: 64, // PLACEHOLDER max ray-march distance
  albedo: 0.5, // PLACEHOLDER flat GPU-side albedo (no per-voxel color storage in v0, see docs)
  skyColor: [0.4, 0.5, 0.7], // PLACEHOLDER miss/ambient color
  maxPointLights: 16, // PLACEHOLDER pooled point-light cap
  sun: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1 }, // PLACEHOLDER default sun (straight down, white)
};

export class GIController {
  constructor({ renderer, scene } = {}) {
    this.renderer = renderer;
    this.scene = scene ?? null;
    this.enabled = false;
    this.resources = null;
    this.params = { ...GI_DEFAULTS };
    this._sceneTriangles = [];
    this._sceneDirty = true;
    this._probeCursor = 0;
    this._originArr = [0, 0, 0];
    this._voxelConfig = null; // {dims, voxelOriginArr, cellSize} — plain JS, CPU-side
    this._attachment = null; // GISceneAttachment, alive across an enabled span so disable can restore it
  }

  // -------------------------------------------------------------- config
  /** @returns {boolean} whether any GPU resource now exists (false = off path, nothing allocated) */
  configure(params = {}) {
    const p = { ...GI_DEFAULTS, ...params };
    this.params = p;
    if (!p.enabled) {
      // LAW: default/disabled path allocates zero storage buffers, zero
      // compute kernels, zero probe grid — not "disabled but built". Restore
      // every material GI ever attached to first (parent review E).
      this._attachment?.detachAll();
      this._attachment = null;
      this.enabled = false;
      this.resources = null;
      return false;
    }
    this.enabled = true;

    const grid = buildProbeGrid(p);
    const atlases = createProbeAtlases({
      probeCount: grid.count,
      irradianceRes: p.irradianceRes,
      depthRes: p.depthRes,
    });
    const lights = createPointLightPool(p.maxPointLights);
    const sun = {
      direction: uniform(vec3(...p.sun.direction)),
      color: uniform(vec3(...p.sun.color)),
      intensity: uniform(p.sun.intensity),
    };
    this._originArr = [0, grid.baseY, 0];
    const probeGrid = { origin: uniform(vec3(...this._originArr)), spacing: p.spacing, dims: grid.dims };

    this._voxelConfig = this._makeVoxelConfig(p);
    const occArr = this._runVoxelize();
    const occ = createOccupancyStorage(occArr, this._voxelConfig.dims, this._voxelConfig.voxelOriginArr, p.voxelCellSize);

    // parity-harness diagnostic (parent review 09-29): a per-probe "was
    // this slot actually written by a real dispatch" flag, so a readback
    // of 0 can be told apart from "never ran" vs "legitimately converged
    // to 0" (see docs/GI-PROBES.md and test/gi-kernel-index-mirror.test.js)
    const touched = createTouchedBuffer(grid.count);

    const irr = createGIUpdateKernel({
      atlases, occ, probeGrid, raysPerProbe: p.raysPerProbe, sun, lights,
      hysteresis: p, albedo: p.albedo, skyColor: p.skyColor, maxDist: p.voxelMaxDist, touched,
    });
    const dep = createGIDepthUpdateKernel({
      atlases, occ, probeGrid, raysPerProbe: p.raysPerProbe, sun, lights,
      hysteresis: p, albedo: p.albedo, skyColor: p.skyColor, maxDist: p.voxelMaxDist,
    });

    // shared query node: positionWorld/normalWorld are three's own
    // per-fragment builtins, so ONE query graph is correct for every
    // material it gets attached to below (not rebuilt per-material)
    const queryNode = createGIQueryNode({ atlases, worldPositionNode: positionWorld, normalNode: normalWorld, probeGrid });

    this.resources = { grid, atlases, lights, sun, probeGrid, occ, irr, dep, queryNode, touched, params: p };
    this._probeCursor = 0;

    // wire E: attach to every eligible material already in the scene
    this._attachment = new GISceneAttachment();
    this._attachment.attachAll(this.scene, queryNode);

    return true;
  }

  _makeVoxelConfig(p) {
    const cell = p.voxelCellSize;
    const dims = {
      x: Math.max(1, Math.round((2 * p.halfExtentXZ) / cell)),
      y: Math.max(1, Math.round((p.heightRange[1] - p.heightRange[0]) / cell)),
      z: Math.max(1, Math.round((2 * p.halfExtentXZ) / cell)),
    };
    const voxelOriginArr = [-p.halfExtentXZ, p.heightRange[0], -p.halfExtentXZ];
    return { dims, voxelOriginArr, cellSize: cell };
  }

  _runVoxelize() {
    const { dims, voxelOriginArr, cellSize } = this._voxelConfig;
    this._sceneDirty = false;
    return voxelizeTriangles(this._sceneTriangles, voxelOriginArr, cellSize, dims);
  }

  // ------------------------------------------------------- scene changes
  /**
   * Scene-change signal (§GI-PROBES.md Representation): static geometry
   * edited/streamed in — re-voxelize. Cheap when disabled (just remembers
   * the triangles for the next enable); when already enabled, mutates the
   * EXISTING occupancy storage buffer's data in place (same kernel graph,
   * no rebuild — GPU compute graphs are built once, buffers are re-uploaded).
   */
  setSceneTriangles(triangles) {
    this._sceneTriangles = triangles;
    this._sceneDirty = true;
    if (this.enabled && this.resources) this._revoxelize();
  }

  _revoxelize() {
    const occArr = this._runVoxelize();
    const attr = this.resources.occ.occupancy.value; // StorageInstancedBufferAttribute
    for (let i = 0; i < occArr.length; i++) attr.array[i] = occArr[i] ? 1 : 0;
    attr.needsUpdate = true;
  }

  // -------------------------------------------------------- per-frame
  /**
   * Per-frame dispatch (§GI-PROBES.md Probe layout + Ray budget): camera-
   * relative X/Z recenter, round-robin probeOffset rotation over
   * `updateFraction` of the grid, then actually issues the two compute
   * dispatches. No-op (and NEVER touches `renderer.compute`) when disabled.
   */
  update(dt, cameraPos = [0, 0, 0]) {
    if (!this.enabled || !this.resources) return { dispatched: false };
    const { grid, probeGrid, irr, dep, queryNode, params: p } = this.resources;

    const rec = recenterGrid(this._originArr, [cameraPos[0], 0, cameraPos[2]], p.spacing, p.halfExtentXZ, this._originArr[1]);
    this._originArr = rec.origin;
    probeGrid.origin.value.set(rec.origin[0], rec.origin[1], rec.origin[2]);

    const probesPerBatch = Math.max(1, Math.round(grid.count * p.updateFraction));
    irr.probeOffset.value = this._probeCursor;
    dep.probeOffset.value = this._probeCursor;
    const dispatchedOffset = this._probeCursor;
    this._probeCursor = (this._probeCursor + probesPerBatch) % grid.count;

    // BUGFIX (parent live-GPU report 09-29): the round-robin design exists
    // to amortize GPU cost across frames by only shading `probesPerBatch`
    // of the grid per update() call — but the kernel's BAKED-IN dispatch
    // count (totalTexels, from createGIUpdateKernel) always covers the
    // FULL atlas, so every single update() call was dispatching the WHOLE
    // grid's worth of threads regardless of updateFraction, defeating the
    // amortization (and making updateFraction<1 dispatch MORE threads than
    // probesPerBatch*texelsPerProbe needs, most of them redundant re-shades
    // of probes this call was never supposed to touch). renderer.compute()
    // accepts an explicit dispatch count override as its 2nd argument —
    // pass the ACTUAL batch size instead of relying on the kernel's static
    // full-atlas default.
    const irrTexelsPerProbe = this.resources.atlases.irradianceRes * this.resources.atlases.irradianceRes;
    const depTexelsPerProbe = this.resources.atlases.depthRes * this.resources.atlases.depthRes;
    this.renderer?.compute(irr.kernel, probesPerBatch * irrTexelsPerProbe);
    this.renderer?.compute(dep.kernel, probesPerBatch * depTexelsPerProbe);

    // wire E: a cheap mesh-count check catches meshes added after enable
    // and attaches them without re-scanning already-attached materials
    const newlyAttached = this._attachment?.syncNewMeshes(this.scene, queryNode) ?? 0;

    return { dispatched: true, probeOffset: dispatchedOffset, recentered: rec.shifted, newlyAttached };
  }

  dispose() {
    this._attachment?.detachAll();
    this._attachment = null;
    this.enabled = false;
    this.resources = null;
  }
}
