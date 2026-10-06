// S1 — cascaded sun shadows (CSM). docs/LIGHTING-OPENWORLD.md §S1
// three/addons/csm/CSMShadowNode.js (WebGPURenderer-only) hung on the sun's
// DirectionalLight via light.shadow.shadowNode. Builder camera = the camera the
// scene is rendered with, so the cascades follow it; setCamera() retargets.
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { Fn, vec2, float, reference, texture, renderGroup } from 'three/tsl';
import { LinearFilter, BasicShadowMap, PCFShadowMap, PCFSoftShadowMap, VSMShadowMap } from 'three/webgpu';

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
filter: 'smooth',   // PORT: r180 WebGPU maps renderer.shadowMap.type -> filter fn (Basic 1 tap | PCF 17 nearest taps, radius=shadow.radius | PCFSoft 9-tap | VSM). Nearest compare = stair-stepped edges. 'smooth' = ENGINE filter: hardware-bilinear compare (depth tex LinearFilter) x Vogel-disk taps x tent weights, radius = filterRadius texels. docs/LIGHTING-OPENWORLD.md S1
filterRadius: 1.5,  // texels (pcf + smooth) -> LightShadow.radius per cascade (live). ASSUMED: tuned on BP pose B, docs/lanes/bw-shadow.md
filterTaps: 12,     // smooth only; each tap = one 2x2 bilinear compare (GPU only, 0 CPU). ASSUMED
staticCache: false, // ENGINE option (default off): far cascades 1..N-1 are CACHED — re-rendered only when the sun moved, the guard says the camera left the last-rendered map, or every `cacheRefresh` frames (dynamic casters in far cascades lag <= cacheRefresh frames). Cascade 0 renders every frame. Supersedes stagger rotation when on
cacheRefresh: 30,   // frames between forced refreshes of a cached far cascade (cascade i is offset by i so they never coincide)
guard: true,        // stagger safety net: a skipped far cascade whose frustum slice left its last-rendered map is rendered NOW (max 1 per frame; teleport/hitch pop). 0 cost unless coverage is actually lost
};
export const SHADOW_FILTERS = ['basic', 'pcf', 'pcfsoft', 'vsm', 'smooth'];
// filter name -> renderer.shadowMap.type (smooth keeps PCF as the type; its custom filterNode replaces the PCF fn)
export const FILTER_TYPE = { basic: BasicShadowMap, pcf: PCFShadowMap, pcfsoft: PCFSoftShadowMap, vsm: VSMShadowMap, smooth: PCFShadowMap };
// Vogel disk (golden-angle spiral): unit-disk tap offsets + tent weights (centre-heavy -> smooth penumbra), weights sum to 1
export function vogelTaps(n) {
  const N = Math.max(1, Math.round(n)), GA = Math.PI * (3 - Math.sqrt(5)), pts = [];
  let ws = 0;
  for (let k = 0; k < N; k++) { const r = Math.sqrt((k + 0.5) / N), t = k * GA, w = 1 - 0.5 * r; pts.push({ x: r * Math.cos(t), y: r * Math.sin(t), w }); ws += w; }
  for (const p of pts) p.w /= ws;
  return pts;
}
// ENGINE smooth filter for ShadowNode.filterNode: {depthTexture, shadowCoord, shadow, depthLayer} -> float visibility.
// Eager depthTexture.mag/minFilter = Linear -> WebGPU comparison sampler filters (hardware 2x2 PCF per tap).
export function makeSmoothFilter(taps = 12) {
  const pts = vogelTaps(taps);
  const inner = Fn(({ depthTexture, shadowCoord, shadow, depthLayer }) => {
    const mapSize = reference('mapSize', 'vec2', shadow).setGroup(renderGroup);
    const radius = reference('radius', 'float', shadow).setGroup(renderGroup);
    const texel = vec2(1).div(mapSize).mul(radius);
    let sum = null;
    for (const p of pts) {
      let d = texture(depthTexture, shadowCoord.xy.add(texel.mul(vec2(p.x, p.y))));
      if (depthTexture.isArrayTexture) d = d.depth(depthLayer);
      const v = d.compare(shadowCoord.z).mul(float(p.w));
      sum = sum === null ? v : sum.add(v);
    }
    return sum;
  });
  const fn = (inputs) => { inputs.depthTexture.magFilter = LinearFilter; inputs.depthTexture.minFilter = LinearFilter; return inner(inputs); };
  fn.taps = pts.length;
  return fn;
}
// Stagger guard math: max overshoot (in shadow-map uv, 0 = fully inside [0,1]^2) of a cascade's frustum slice (camera-space `frustum.vertices.near|far`, 4 each) when projected
// through camMatrixWorld then the cascade's LAST-RENDERED shadow.matrix (ortho: no w divide). Pure arithmetic, no allocation.
export function sliceOvershoot(frustum, camWorld, shadowMatrix) {
  const c = camWorld.elements ?? camWorld, m = shadowMatrix.elements ?? shadowMatrix;
  let worst = 0;
  for (const set of [frustum.vertices.near, frustum.vertices.far]) {
    for (let i = 0; i < set.length; i++) {
      const v = set[i];
      const wx = c[0] * v.x + c[4] * v.y + c[8] * v.z + c[12], wy = c[1] * v.x + c[5] * v.y + c[9] * v.z + c[13], wz = c[2] * v.x + c[6] * v.y + c[10] * v.z + c[14];
      const u = m[0] * wx + m[4] * wy + m[8] * wz + m[12], t = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
      const o = Math.max(-u, u - 1, -t, t - 1);
      if (o > worst) worst = o;
    }
  }
  return worst;
}

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

  enable(cfg = {}, renderer = null) {
    const c = { ...SHADOW_DEFAULTS, ...cfg };
    if (typeof location !== 'undefined') { const q = new URLSearchParams(location.search).get('shadowCache'); if (q !== null) { c.staticCache = q !== '0'; if (Number(q) > 1) c.cacheRefresh = Number(q); } } // perf tooling: ?shadowCache=1|<refreshFrames>|0
    const light = this.sun;
    const prev = this.config;
    // cascades / mapSize / maxFar / mode / lightMargin are baked into the node
    // at build time -> a change rebuilds it; bias/normalBias/fade are live.
    const structural = !this.node || !prev || ['cascades', 'mapSize', 'maxFar', 'mode', 'lightMargin', 'filter', 'filterTaps']
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
    const filter = SHADOW_FILTERS.includes(c.filter) ? c.filter : SHADOW_DEFAULTS.filter;
    // r180 WebGPU resolves the filter fn from renderer.shadowMap.type when each ShadowNode is BUILT (first compile) -> set it before the node exists; a later change needs a node rebuild + material recompile
    if (renderer?.shadowMap && structural) renderer.shadowMap.type = FILTER_TYPE[filter];
    if (structural) {
      this._dropNode();
      this.node = new CSMShadowNode(light, {
        cascades: c.cascades, maxFar: c.maxFar, mode: c.mode, lightMargin: c.lightMargin,
      });
      light.shadow.shadowNode = this.node;
      // LightShadow.copy() drops filterNode and the cascade clones are built inside _init -> hook _init, set filterNode on every clone (before ShadowNode.setup reads it)
      if (filter === 'smooth') {
        const fn = makeSmoothFilter(c.filterTaps), node = this.node, init = node._init.bind(node);
        node._init = (b) => { init(b); node.lights.forEach((l) => { l.shadow.filterNode = fn; l.shadow.radius = this.config?.filterRadius ?? c.filterRadius; }); };
      }
    } else if (this.node.lights?.length) {
      // built already: push live knobs into the per-cascade shadow clones
      this.node.lights.forEach((l, i) => {
        l.shadow.bias = c.bias * (i + 1);
        l.shadow.normalBias = c.normalBias;
        l.shadow.radius = c.filterRadius;
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
    if (this.config?.staticCache) return this._tickCached(ls);
    if (this._cached) { this._cached = false; ls.forEach((l) => { l.shadow.autoUpdate = true; }); }
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
    this._guard(ls);
  }
  // staticCache: cascade 0 every frame; far cascades only on sun change / guard / periodic refresh (cacheRefresh), offset per cascade
  _tickCached(ls) {
    this._cached = true; this._staggered = false;
    const sp = this.sun.position, key = `${sp.x.toFixed(2)},${sp.y.toFixed(2)},${sp.z.toFixed(2)}|${this.sun.target?.position.x.toFixed(1)},${this.sun.target?.position.z.toFixed(1)}`;
    const sunMoved = key !== this._sunKey; this._sunKey = key;
    this._fc = (this._fc ?? 0) + 1;
    const every = Math.max(1, Math.round(Number(this.config?.cacheRefresh) || 30));
    ls[0].shadow.autoUpdate = true;
    this.cacheRenders = 0;
    for (let i = 1; i < ls.length; i++) {
      const sh = ls[i].shadow; sh.autoUpdate = false;
      const never = this._lastRender?.[i] === undefined;
      if (never || sunMoved || (this._fc + i) % every === 0) { sh.needsUpdate = true; (this._lastRender ??= [])[i] = this._fc; this.cacheRenders++; }
    }
    this._guard(ls);
  }
  // stagger safety net (cfg.guard): a skipped far cascade whose frustum slice is no longer inside its LAST-RENDERED map would show a pop (unshadowed band) until its turn -> render the worst one now. Max 1 forced per frame (never above stagger-1 cost); 0 CPU render cost while coverage holds.
  _guard(ls) {
    const n = this.node, cam = n.camera;
    this.guardForced = 0;
    if (this.config?.guard === false || !cam || !n.frustums?.length) return;
    let worst = 0, wi = -1;
    for (let i = 1; i < ls.length; i++) {
      const sh = ls[i].shadow;
      if (sh.needsUpdate || !sh.matrix || !n.frustums[i]) continue; // already rendering this frame
      const o = sliceOvershoot(n.frustums[i], cam.matrixWorld, sh.matrix);
      if (o > worst) { worst = o; wi = i; }
    }
    if (wi > 0) { ls[wi].shadow.needsUpdate = true; this.guardForced = wi; this.guardCount = (this.guardCount ?? 0) + 1; }
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
