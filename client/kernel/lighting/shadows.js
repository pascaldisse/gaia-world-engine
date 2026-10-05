// S1 — cascaded sun shadows (CSM). docs/LIGHTING-OPENWORLD.md §S1
// three/addons/csm/CSMShadowNode.js (WebGPURenderer-only) hung on the sun's
// DirectionalLight via light.shadow.shadowNode. Builder camera = the camera the
// scene is rendered with, so the cascades follow it; setCamera() retargets.
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';

export const SHADOW_DEFAULTS = {
  cascades: 4,        // PORT: task spec
  maxFar: 600,        // m — PORT: task spec; beyond it fog/unshadowed
  mapSize: 2048,      // per cascade — PORT: task spec
  stagger: true,      // PORT (standard CSM practice): cascade 0 renders every frame, cascades 1..N-1 round-robin one per frame (shadow.matrix is only rewritten when a map renders -> lookups stay consistent). Measured BP 10-05: 4 full passes/frame = CPU-bound
  bias: -0.0003,      // ASSUMED: tuned for 0.1–600 m splits, needs live check
  normalBias: 0.04,   // ASSUMED
  fade: true,         // PORT: CSMShadowNode.fade — blends neighbouring cascades
  lightMargin: 200,   // m — PORT: CSMShadowNode default; casters behind the frustum
  mode: 'practical',  // PORT: CSMShadowNode default split
};

// cast/receive on every Mesh under root; userData.noShadow opts a mesh out
// (sky domes, particles, decals, helpers). Returns the number of meshes marked.
export function markShadows(root, { cast = true, receive = true } = {}) {
  let n = 0;
  root?.traverse?.((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return;
    if (o.userData?.noShadow) { o.castShadow = false; o.receiveShadow = false; return; }
    o.castShadow = cast;
    o.receiveShadow = receive;
    n++;
  });
  return n;
}

// Owns the CSMShadowNode for one sun light. Nothing is touched until enable().
export class SunShadows {
  constructor(sun) {
    this.sun = sun;
    this.node = null;
    this.config = null;
    this._saved = null; // pre-CSM light state, restored on disable()
  }
  get enabled() { return this.node !== null; }

  enable(cfg = {}) {
    const c = { ...SHADOW_DEFAULTS, ...cfg };
    const light = this.sun;
    const prev = this.config;
    // cascades / mapSize / maxFar / mode / lightMargin are baked into the node
    // at build time -> a change rebuilds it; bias/normalBias/fade are live.
    const structural = !this.node || !prev || ['cascades', 'mapSize', 'maxFar', 'mode', 'lightMargin']
      .some((k) => prev[k] !== c[k]);
    if (!this._saved) {
      this._saved = {
        castShadow: light.castShadow,
        shadowNode: light.shadow.shadowNode ?? null,
        mapW: light.shadow.mapSize.x, mapH: light.shadow.mapSize.y,
        bias: light.shadow.bias, normalBias: light.shadow.normalBias,
      };
    }
    light.castShadow = true;
    light.shadow.mapSize.set(c.mapSize, c.mapSize);
    light.shadow.bias = c.bias;
    light.shadow.normalBias = c.normalBias;
    if (structural) {
      this._dropNode();
      this.node = new CSMShadowNode(light, {
        cascades: c.cascades, maxFar: c.maxFar, mode: c.mode, lightMargin: c.lightMargin,
      });
      light.shadow.shadowNode = this.node;
    } else if (this.node.lights?.length) {
      // built already: push live knobs into the per-cascade shadow clones
      this.node.lights.forEach((l, i) => {
        l.shadow.bias = c.bias * (i + 1);
        l.shadow.normalBias = c.normalBias;
      });
    }
    this.node.fade = !!c.fade;
    this.config = c;
    return this.node;
  }

  disable() {
    this._dropNode();
    const s = this._saved;
    if (s) {
      this.sun.castShadow = s.castShadow;
      this.sun.shadow.shadowNode = s.shadowNode;
      this.sun.shadow.mapSize.set(s.mapW, s.mapH);
      this.sun.shadow.bias = s.bias;
      this.sun.shadow.normalBias = s.normalBias;
    }
    this._saved = null;
    this.config = null;
  }

  _dropNode() {
    if (!this.node) return;
    // dispose() removes cascade lights from their parent; only valid once
    // _init ran (camera set) — before that there is nothing to remove.
    if (this.node.camera !== null) { try { this.node.dispose(); } catch { /* parent gone */ } }
    this.sun.shadow.shadowNode = null;
    this.node = null;
  }

  // retarget cascades to another camera / refresh after fov/aspect/far change
  // per frame: staggered refresh (cfg.stagger). Cascade lights exist only after the node's first compile (_init).
  tick() {
    const n = this.node, ls = n?.lights;
    if (!ls?.length) return;
    const on = this.config?.stagger !== false;
    if (!on) { if (this._staggered) { ls.forEach((l) => { l.shadow.autoUpdate = true; }); this._staggered = false; } return; }
    this._staggered = true;
    ls[0].shadow.autoUpdate = true;
    if (ls.length < 2) return;
    const every = Math.max(1, Math.round(Number(this.config?.stagger) || 1)); // stagger:true|1 = one far cascade per frame; k = one far cascade every k frames
    this._fc = (this._fc ?? 0) + 1;
    const go = this._fc % every === 0;
    if (go) this._rr = ((this._rr ?? 0) % (ls.length - 1)) + 1; // 1..N-1
    for (let i = 1; i < ls.length; i++) { ls[i].shadow.autoUpdate = false; if (go && i === this._rr) ls[i].shadow.needsUpdate = true; }
  }

  syncCamera(camera) {
    const n = this.node;
    if (!n || !camera) return;
    if (n.camera === null) return; // not built yet: builder camera is adopted at first compile
    const key = `${camera.fov}|${camera.aspect}|${camera.near}|${camera.far}`;
    if (n.camera !== camera || this._camKey !== key) {
      n.camera = camera;
      this._camKey = key;
      n.updateFrustums();
    }
  }
}
