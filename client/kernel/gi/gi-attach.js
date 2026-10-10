// Scene-level material wiring (§GI-PROBES.md Material sampling, parent
// review E): when GI is enabled, attach the SAME shared query node (built
// once from three's own per-fragment `positionWorld`/`normalWorld`
// builtins — not material-specific, so one query node graph is correct for
// every eligible material) to every lit mesh material in the scene.
// Eligibility = a NodeMaterial whose lighting model actually reads
// `context.irradiance` in its indirectDiffuse term (verified against three
// r180 source: PhysicalLightingModel does, BasicLightingModel does NOT —
// MeshBasicNodeMaterial zeroes indirectDiffuse before ever looking at our
// contribution, so attaching to it would be a real no-op, not just
// wasteful). Sprites are excluded structurally: `scene.traverse` only
// touches `node.isMesh` nodes, and `THREE.Sprite.isMesh` is not set.

import { attachGI, detachGI } from './gi-material.js';
import { leakGuards } from '../render-api/native/page-memory.js'; // nt-frameleak

// MeshLambertNodeMaterial / MeshStandardNodeMaterial / MeshPhysicalNodeMaterial
// all set `this.lights = true` AND use a lighting model whose
// indirectDiffuse() adds `irradiance.mul(BRDF_Lambert(...))` — the exact
// context.irradiance our IrradianceNode writes into (three r180 source:
// PhysicalLightingModel.js:665, shared by Lambert/Standard/Physical).
// MeshBasicNodeMaterial ALSO sets lights=true but uses BasicLightingModel,
// which assigns indirectDiffuse to vec4(0) unconditionally first
// (BasicLightingModel.js:37) — `lights===true` alone is NOT a safe litmus
// test (confirmed empirically), so eligibility is by explicit class flag.
const ELIGIBLE_FLAGS = ['isMeshStandardNodeMaterial', 'isMeshPhysicalNodeMaterial', 'isMeshLambertNodeMaterial'];

export function isGIEligibleMaterial(material) {
  if (!material || typeof material.setupLights !== 'function') return false;
  return ELIGIBLE_FLAGS.some((flag) => material[flag] === true);
}

function forEachMeshMaterial(scene, cb) {
  scene.traverse((node) => {
    if (!node.isMesh || !node.material) return; // THREE.Sprite.isMesh is not set -> excluded structurally
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const mat of mats) cb(mat);
  });
}

function countMeshes(scene) {
  let n = 0;
  scene.traverse((node) => { if (node.isMesh) n++; });
  return n;
}

/**
 * Owns the set of materials GI has attached itself to, so disabling can
 * restore every one of them exactly (not just "stop enabling new ones").
 */
export class GISceneAttachment {
  constructor() {
    this._originals = new Map(); // material -> its setupLights before attachGI wrapped it
    // nt-frameleak (native: leakGuards.weakRegistries, ?nativeWeakRegs=0 = old): the strong Map above pinned EVERY eligible material ever attached (+ its textures) until detachAll, even after the
    // mesh left the scene. Weak mode: `_wm` (WeakMap material -> original) answers "attached?", `_refs` (Set<WeakRef>) keeps detachAll able to restore the survivors.
    this._wm = new WeakMap(); this._refs = new Set();
    this._lastMeshCount = -1;
  }
  _weak() { return leakGuards.weakRegistries && typeof WeakRef !== 'undefined'; }

  /** Attach to every eligible, not-yet-attached material. Idempotent. @returns count newly attached */
  attachAll(scene, giQueryNode) {
    if (!scene) return 0;
    let attached = 0;
    const weak = this._weak();
    if (weak && this._refs.size > 2048) for (const r of this._refs) if (!r.deref()) this._refs.delete(r);
    forEachMeshMaterial(scene, (mat) => {
      if (!isGIEligibleMaterial(mat)) return;
      if (weak ? this._wm.has(mat) : this._originals.has(mat)) return; // already attached, skip (idempotent)
      const original = mat.setupLights;
      attachGI(mat, giQueryNode);
      if (weak) { this._wm.set(mat, original); this._refs.add(new WeakRef(mat)); } else this._originals.set(mat, original);
      mat.needsUpdate = true;
      attached++;
    });
    this._lastMeshCount = countMeshes(scene);
    return attached;
  }

  /** Cheap per-frame check: only re-scans the scene if the mesh count changed. @returns count newly attached */
  syncNewMeshes(scene, giQueryNode) {
    if (!scene) return 0;
    if (countMeshes(scene) === this._lastMeshCount) return 0;
    return this.attachAll(scene, giQueryNode);
  }

  /** Restore every attached material's original setupLights + flag a recompile. */
  detachAll() {
    for (const [mat, original] of this._originals) {
      detachGI(mat, original);
      mat.needsUpdate = true;
    }
    this._originals.clear();
    for (const r of this._refs) { const mat = r.deref(); if (mat) { detachGI(mat, this._wm.get(mat)); mat.needsUpdate = true; this._wm.delete(mat); } }
    this._refs.clear();
    this._lastMeshCount = -1;
  }

  get attachedCount() {
    let n = this._originals.size;
    for (const r of this._refs) { if (r.deref()) n++; else this._refs.delete(r); } // dead refs are pruned here (census/probe cadence)
    return n;
  }
}
