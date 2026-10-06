// static-batch.js — engine-generic static draw batching (lane lampas/draw-batch).
// Meshes that provably do not move (world matrix unchanged for `settleScans` scans), are not skinned/instanced/morphed/transparent and share a
// material are merged (world space) into one geometry per spatial cell. Originals stay in the graph (collision, GI voxelizer, game refs) but are
// hidden from rendering via layers.mask=0 (their `visible` is untouched). A per-frame guard (matrix / visible-chain compare) un-batches a chunk the
// moment any member moves or hides, and flags those meshes userData.noBatch. Opt out per mesh: userData.noBatch / userData.dynamic.
// Opt in: ?staticBatch=1 (or globalThis.GAIA_RENDER_CONFIG.staticBatch = true | {…}) or createStaticBatcher(scene,{enabled:true}) — default OFF.
import { Mesh, BufferGeometry, BufferAttribute, Matrix4, MeshBasicMaterial, DoubleSide } from 'three';

export const STATIC_BATCH_DEFAULTS = {
  enabled: false,      // ENGINE default: off; a game opts in via config / ?staticBatch=1
  cellSize: 32,        // m — spatial chunk edge; per-chunk frustum/shadow culling granularity. ASSUMED
  maxVertices: 120000, // per merged chunk (keeps culling useful)
  minGroup: 2,         // a (material,cell) group with fewer meshes is left alone
  scanEvery: 20,       // frames between scans for new/settled candidates
  settleScans: 2,      // scans a mesh's world matrix must be unchanged before it is eligible
  guard: true,         // per-frame un-batch on member matrix/visible change
  transparent: false,  // batch transparent materials (sort order changes) — off
  shadowProxy: true,   // (with enabled) static opaque casters merged ACROSS materials into depth-only proxies on `shadowLayer` (seen by sun shadow cameras only, not the main camera); originals stop casting. Alpha-tested / alpha-mapped / custom-position materials stay real casters
  shadowLayer: 5,      // three layer index for proxies (game must not use it)
  shadowCellSize: 48,  // m — proxy chunk edge; the cascade culling granularity
};

const _defaultOBR = new Mesh().onBeforeRender;
const _m = new Matrix4();
const sigOf = (g) => Object.keys(g.attributes).sort().map((k) => { const a = g.attributes[k]; return `${k}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}:${a.isInterleavedBufferAttribute ? 'i' : 'b'}`; }).join('|') + (g.index ? '+idx' : '');

export class StaticBatcher {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opt = { ...STATIC_BATCH_DEFAULTS, ...opts };
    this.frame = 0;
    this.track = new Map();   // mesh -> { m: Float32Array(16), stable }
    this.chunks = [];         // { kind:'main'|'shadow', mesh, members, masks, material, geoms, matrices, chain }
    this.owner = new Map();   // mesh -> Set(chunk)
    this.stats = { batchedMeshes: 0, chunks: 0, proxyMeshes: 0, proxyChunks: 0, unbatched: 0, scans: 0, lastScanMs: 0 };
  }

  setOptions(o) { Object.assign(this.opt, o); }
  get enabled() { return !!this.opt.enabled; }

  _eligible(o) {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || o.isBatchedMesh || o.userData?.noBatch || o.userData?.dynamic) return false;
    if (!o.visible || o.layers.mask === 0 || !o.frustumCulled || o.onBeforeRender !== _defaultOBR) return false;
    const mat = o.material, g = o.geometry;
    if (!mat || Array.isArray(mat) || !g?.attributes?.position || g.attributes.position.isInterleavedBufferAttribute) return false;
    if (g.morphAttributes && Object.keys(g.morphAttributes).length) return false;
    if (mat.transparent && !this.opt.transparent) return false;
    if (mat.visible === false) return false;
    for (let n = o.parent; n; n = n.parent) if (n.visible === false || n.userData?.dynamic) return false;
    return true;
  }

  _proxyOk(o) {
    const m = o.material;
    return !!(this.opt.shadowProxy && o.castShadow && !m.transparent && !(m.alphaTest > 0) && !m.alphaMap && !(m.transmission > 0) && !m.positionNode && !m.castShadowNode && !m.depthNode && !m.castShadowPositionNode);
  }

  // sun-shadow cameras (incl. CSM cascade lights) must see the proxy layer; a layer bit beyond 0 also keeps three from re-adopting the main camera mask
  _enableShadowLayer() {
    this.scene.traverse((l) => { if (l.isDirectionalLight && l.castShadow && l.shadow?.camera && !l.shadow.camera.layers.isEnabled(this.opt.shadowLayer)) { l.shadow.camera.layers.mask |= 1; l.shadow.camera.layers.enable(this.opt.shadowLayer); } });
  }

  // call once per frame BEFORE render
  update() {
    if (!this.opt.enabled) { if (this.chunks.length) this.disable(); return; }
    this.frame++;
    if (this.opt.guard) this._guard();
    if (this.frame % this.opt.scanEvery === 0) this._scan();
  }

  _guard() {
    for (let ci = this.chunks.length - 1; ci >= 0; ci--) {
      const c = this.chunks[ci];
      if (!c) continue;
      let bad = false;
      for (let i = 0; i < c.members.length && !bad; i++) {
        const o = c.members[i], e = o.matrixWorld.elements, s = c.matrices[i];
        for (let k = 0; k < 16; k++) if (e[k] !== s[k]) { bad = true; break; }
        if (o.visible === false || (c.kind === 'main' ? o.layers.mask !== 0 : o.castShadow !== false) || o.geometry !== c.geoms[i] || o.material !== c.mats[i]) bad = true;
      }
      if (!bad) for (const n of c.chain) if (n.visible === false) { bad = true; break; }
      if (bad) this._release(c, ci);
    }
  }

  _release(c, ci = this.chunks.indexOf(c)) {
    if (ci < 0) return;
    c.mesh.parent?.remove(c.mesh);
    c.mesh.geometry.dispose();
    this.chunks.splice(ci, 1);
    c.members.forEach((o) => { if (c.kind === 'main' && o.layers.mask === 0) o.layers.mask = c.masks.get(o); if (c.kind === 'shadow') o.castShadow = true; o.userData.noBatch = true; this.owner.get(o)?.delete(c); });
    if (c.kind === 'main') { this.stats.unbatched += c.members.length; this.stats.batchedMeshes -= c.members.length; } else this.stats.proxyMeshes -= c.members.length;
    // a mesh whose cast duty lived in a sibling chunk: release the siblings too (no shadow hole)
    for (const o of c.members) for (const s of [...(this.owner.get(o) ?? [])]) this._release(s);
    this.stats.chunks = this.chunks.filter((x) => x.kind === 'main').length; this.stats.proxyChunks = this.chunks.length - this.stats.chunks;
  }

  disable() {
    for (let ci = this.chunks.length - 1; ci >= 0; ci--) {
      const c = this.chunks[ci];
      c.mesh.parent?.remove(c.mesh); c.mesh.geometry.dispose();
      c.members.forEach((o) => { if (c.kind === 'main') o.layers.mask = c.masks.get(o); else o.castShadow = true; });
    }
    this.chunks.length = 0; this.owner.clear(); this.stats.batchedMeshes = 0; this.stats.chunks = 0; this.stats.proxyMeshes = 0; this.stats.proxyChunks = 0; this.track.clear();
  }

  _scan() {
    const t0 = performance.now(), seen = new Set(), ready = [];
    this.scene.traverse((o) => {
      if (!o.isMesh || !this._eligible(o)) return;
      seen.add(o);
      const e = o.matrixWorld.elements;
      const t = this.track.get(o);
      if (!t) { this.track.set(o, { m: Float32Array.from(e), stable: 0 }); return; }
      let same = true;
      for (let k = 0; k < 16; k++) if (t.m[k] !== e[k]) { same = false; t.m[k] = e[k]; }
      t.stable = same ? t.stable + 1 : 0;
      if (t.stable >= this.opt.settleScans) ready.push(o);
    });
    for (const k of this.track.keys()) if (!seen.has(k)) this.track.delete(k);
    if (this.opt.shadowProxy && (ready.length || this.stats.proxyChunks)) this._enableShadowLayer();
    if (ready.length) { if (this.opt.shadowProxy) this._buildProxies(ready); this._build(ready); }
    this.stats.scans++; this.stats.lastScanMs = performance.now() - t0;
  }

  _buildProxies(meshes) {
    const { shadowCellSize: cs, maxVertices, minGroup } = this.opt, groups = new Map();
    for (const o of meshes) {
      if (!this._proxyOk(o) || (this.owner.get(o) && [...this.owner.get(o)].some((c) => c.kind === 'shadow'))) continue;
      const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(o.matrixWorld), det = o.matrixWorld.determinant() < 0 ? 1 : 0;
      const side = o.material.shadowSide ?? o.material.side;
      const key = [side, det, !!g.index, Math.floor(c.x / cs), Math.floor(c.y / cs), Math.floor(c.z / cs)].join('/');
      let a = groups.get(key); if (!a) groups.set(key, a = []);
      a.push({ o, det, side });
    }
    for (const arr of groups.values()) {
      let cur = [], verts = 0;
      const flush = () => { if (cur.length >= minGroup) this._mergeProxy(cur); cur = []; verts = 0; };
      for (const it of arr) { const n = it.o.geometry.attributes.position.count; if (verts + n > maxVertices && cur.length) flush(); cur.push(it); verts += n; }
      flush();
    }
  }

  _mergeProxy(items) {
    const indexed = !!items[0].o.geometry.index, side = items[0].side;
    let vTotal = 0, iTotal = 0;
    for (const { o } of items) { vTotal += o.geometry.attributes.position.count; iTotal += indexed ? o.geometry.index.count : 0; }
    const pos = new Float32Array(vTotal * 3), idx = indexed ? new (vTotal > 65535 ? Uint32Array : Uint16Array)(iTotal) : null;
    let vo = 0, io = 0;
    for (const { o, det } of items) {
      const g = o.geometry, a = g.attributes.position, n = a.count, e = o.matrixWorld.elements;
      for (let i = 0; i < n; i++) { const x = a.getX(i), y = a.getY(i), z = a.getZ(i), w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]); const j = (vo + i) * 3; pos[j] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w; pos[j + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w; pos[j + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w; }
      if (indexed) {
        const ix = g.index.array, c = g.index.count;
        if (det) for (let i = 0; i < c; i += 3) { idx[io + i] = ix[i] + vo; idx[io + i + 1] = ix[i + 2] + vo; idx[io + i + 2] = ix[i + 1] + vo; }
        else for (let i = 0; i < c; i++) idx[io + i] = ix[i] + vo;
        io += c;
      }
      vo += n;
    }
    const out = new BufferGeometry(); out.setAttribute('position', new BufferAttribute(pos, 3)); if (idx) out.setIndex(new BufferAttribute(idx, 1));
    out.computeBoundingSphere(); out.computeBoundingBox();
    this._proxyMats ??= new Map();
    let mat = this._proxyMats.get(side); if (!mat) this._proxyMats.set(side, mat = new MeshBasicMaterial({ side, colorWrite: false })); // only its side is read by the shadow override
    const mesh = new Mesh(out, mat);
    mesh.name = `shadow-proxy:${this.chunks.length}`; mesh.castShadow = true; mesh.receiveShadow = false; mesh.layers.set(this.opt.shadowLayer);
    mesh.matrixAutoUpdate = false; mesh.userData.noBatch = true; mesh.userData.noGi = true; mesh.userData.shadowProxy = true;
    this.scene.add(mesh); mesh.updateMatrix(); mesh.updateMatrixWorld(true);
    const members = items.map((i) => i.o), chain = new Set();
    for (const o of members) for (let n = o.parent; n; n = n.parent) chain.add(n);
    const chunk = { kind: 'shadow', mesh, members, masks: null, material: mat, mats: members.map((o) => o.material), geoms: members.map((o) => o.geometry), matrices: members.map((o) => Float32Array.from(o.matrixWorld.elements)), chain: [...chain] };
    for (const o of members) { o.castShadow = false; (this.owner.get(o) ?? this.owner.set(o, new Set()).get(o)).add(chunk); }
    this.chunks.push(chunk); this.stats.proxyMeshes += members.length; this.stats.proxyChunks = this.chunks.filter((x) => x.kind === 'shadow').length;
  }

  _proxied(o) { return !!this.owner.get(o) && [...this.owner.get(o)].some((c) => c.kind === 'shadow'); }

  _build(meshes) {
    const { cellSize, maxVertices, minGroup } = this.opt;
    const groups = new Map();
    for (const o of meshes) {
      const g = o.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const c = g.boundingSphere.center.clone().applyMatrix4(o.matrixWorld);
      const det = o.matrixWorld.determinant() < 0 ? 1 : 0;
      const key = [o.material.uuid, sigOf(g), (o.castShadow || this._proxied(o)) ? 1 : 0, o.receiveShadow ? 1 : 0, o.renderOrder, o.layers.mask, det,
        Math.floor(c.x / cellSize), Math.floor(c.y / cellSize), Math.floor(c.z / cellSize)].join('/');
      let a = groups.get(key); if (!a) groups.set(key, a = []);
      a.push({ o, det });
    }
    for (const arr of groups.values()) {
      let cur = [], verts = 0;
      const flush = () => { if (cur.length >= minGroup) this._merge(cur); cur = []; verts = 0; };
      for (const it of arr) { const n = it.o.geometry.attributes.position.count; if (verts + n > maxVertices && cur.length) flush(); cur.push(it); verts += n; }
      flush();
    }
    this.stats.chunks = this.chunks.filter((x) => x.kind === 'main').length;
  }

  _merge(items) {
    const first = items[0].o, names = Object.keys(first.geometry.attributes), indexed = !!first.geometry.index;
    let vTotal = 0, iTotal = 0;
    for (const { o } of items) { vTotal += o.geometry.attributes.position.count; iTotal += indexed ? o.geometry.index.count : 0; }
    const attrs = {};
    for (const n of names) { const a = first.geometry.attributes[n]; attrs[n] = new a.array.constructor(vTotal * a.itemSize); }
    const idx = indexed ? new (vTotal > 65535 ? Uint32Array : Uint16Array)(iTotal) : null;
    let vo = 0, io = 0;
    for (const { o, det } of items) {
      const g = o.geometry, n = g.attributes.position.count;
      _m.copy(o.matrixWorld);
      const e = _m.elements, ne = new Matrix4().copy(_m).invert().transpose().elements; // inverse-transpose for normals
      for (const name of names) {
        const a = g.attributes[name], dst = attrs[name], is = a.itemSize;
        if (name === 'position') {
          for (let i = 0; i < n; i++) { const x = a.getX(i), y = a.getY(i), z = a.getZ(i), w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]); const j = (vo + i) * 3; dst[j] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w; dst[j + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w; dst[j + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w; }
        } else if (name === 'normal') {
          for (let i = 0; i < n; i++) { const x = a.getX(i), y = a.getY(i), z = a.getZ(i); const nx = ne[0] * x + ne[4] * y + ne[8] * z, ny = ne[1] * x + ne[5] * y + ne[9] * z, nz = ne[2] * x + ne[6] * y + ne[10] * z; const l = Math.hypot(nx, ny, nz) || 1; const j = (vo + i) * 3; dst[j] = nx / l; dst[j + 1] = ny / l; dst[j + 2] = nz / l; }
        } else if (name === 'tangent') {
          for (let i = 0; i < n; i++) { const x = a.getX(i), y = a.getY(i), z = a.getZ(i), w4 = a.getW(i); const j = (vo + i) * 4; const tx = e[0] * x + e[4] * y + e[8] * z, ty = e[1] * x + e[5] * y + e[9] * z, tz = e[2] * x + e[6] * y + e[10] * z; const l = Math.hypot(tx, ty, tz) || 1; dst[j] = tx / l; dst[j + 1] = ty / l; dst[j + 2] = tz / l; dst[j + 3] = w4; }
        } else if (!a.normalized && a.array.constructor === dst.constructor) {
          dst.set(a.array.length === n * is ? a.array : a.array.subarray(0, n * is), vo * is);
        } else {
          const get = ['getX', 'getY', 'getZ', 'getW'];
          for (let i = 0; i < n; i++) for (let k = 0; k < is; k++) dst[(vo + i) * is + k] = a[get[k]](i);
        }
      }
      if (indexed) {
        const ix = g.index.array, c = g.index.count;
        if (det) for (let i = 0; i < c; i += 3) { idx[io + i] = ix[i] + vo; idx[io + i + 1] = ix[i + 2] + vo; idx[io + i + 2] = ix[i + 1] + vo; }
        else for (let i = 0; i < c; i++) idx[io + i] = ix[i] + vo;
        io += c;
      }
      vo += n;
    }
    const out = new BufferGeometry();
    for (const n of names) { const a = first.geometry.attributes[n]; out.setAttribute(n, new BufferAttribute(attrs[n], a.itemSize, a.normalized)); }
    if (idx) out.setIndex(new BufferAttribute(idx, 1));
    out.computeBoundingSphere(); out.computeBoundingBox();
    const mesh = new Mesh(out, first.material);
    mesh.name = `static-batch:${this.chunks.length}`;
    mesh.castShadow = first.castShadow; /* proxied members already cast via their shadow proxy -> merged main mesh does not */ mesh.receiveShadow = first.receiveShadow; mesh.renderOrder = first.renderOrder;
    mesh.layers.mask = first.layers.mask; mesh.matrixAutoUpdate = false; mesh.userData.noBatch = true; mesh.userData.staticBatch = true;
    this.scene.add(mesh); mesh.updateMatrix(); mesh.updateMatrixWorld(true);
    const members = items.map((i) => i.o), masks = new Map(), chain = new Set();
    for (const o of members) { masks.set(o, o.layers.mask); for (let n = o.parent; n; n = n.parent) chain.add(n); }
    const chunk = { kind: 'main', mesh, members, masks, material: first.material, mats: members.map((o) => o.material), geoms: members.map((o) => o.geometry), matrices: members.map((o) => Float32Array.from(o.matrixWorld.elements)), chain: [...chain] };
    for (const o of members) { o.layers.mask = 0; this.track.delete(o); (this.owner.get(o) ?? this.owner.set(o, new Set()).get(o)).add(chunk); }
    this.chunks.push(chunk);
    this.stats.batchedMeshes += members.length;
  }

  report() { return { ...this.opt, ...this.stats, tracked: this.track.size }; }
}

export function staticBatchConfigFromEnv() {
  if (typeof location === 'undefined') return {};
  const p = new URLSearchParams(location.search), cfg = globalThis.GAIA_RENDER_CONFIG?.staticBatch;
  const o = typeof cfg === 'object' && cfg ? { ...cfg } : (cfg === true ? { enabled: true } : {});
  if (p.has('staticBatch')) o.enabled = p.get('staticBatch') !== '0';
  if (p.has('staticBatchCell')) o.cellSize = Number(p.get('staticBatchCell'));
  return o;
}

export function createStaticBatcher(scene, opts) { return new StaticBatcher(scene, { ...staticBatchConfigFromEnv(), ...opts }); }
