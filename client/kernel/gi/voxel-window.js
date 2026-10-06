// v2 open-world incremental voxelization (docs/GI-PROBES.md §v2 open-world). Pure JS.
// Mesh registry (addMesh/removeMesh) + camera-following TOROIDAL voxel window
// stored BRICK-MAJOR (brick = 8^3 voxels, one contiguous 512-uint run per brick) so a
// dirty brick is ONE partial buffer write. Per voxel ONE packed uint:
//   0 = empty;  (1<<24)|(r8<<16)|(g8<<8)|b8 = solid + albedo (avg of covering triangles' mesh albedo)
// => occupancy + albedo in a single storage buffer (storage-buffer budget ≤8).
// RTS-mode voxelize.js is untouched.

export const VOXEL_DEFAULTS = {
  cellSize: 1, // PLACEHOLDER m
  brickSize: 8,
  bricks: { x: 16, y: 8, z: 16 }, // window = 128x64x128 voxels at 1 m (PLACEHOLDER; rays leaving it read sky)
  maxBricksPerUpdate: 16, // PLACEHOLDER voxelize budget / update() call
  index: false, // CC-GIVOX: brick-keyed spatial index of the mesh registry (O(candidates) per _buildBrick instead of O(all meshes)); bit-identical output (candidates visited in insertion order). Opt-in; BP passes true.
  indexMaxBricks: 512, // meshes whose AABB spans more bricks than this go to the always-scanned `big` list
};
export const SOLID_BIT = 1 << 24;
export const posMod = (a, n) => ((a % n) + n) % n;
export const CELL_BIAS = 65536; // GPU mirror: positive bias (multiple of every pow2 dim) so WGSL % never sees negatives

const b8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
export const packVoxel = (rgb) => ((SOLID_BIT | (b8(rgb[0]) << 16) | (b8(rgb[1]) << 8) | b8(rgb[2])) >>> 0);
export const isSolid = (v) => (v & SOLID_BIT) !== 0;
export const unpackAlbedo = (v) => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];

/** albedo = material colour x texture mean (if known), both linear 0..1 */
export function meshAlbedo({ color = [0.5, 0.5, 0.5], textureMean = null, albedo = null } = {}) {
  if (albedo) return albedo;
  const t = textureMean ?? [1, 1, 1];
  return [color[0] * t[0], color[1] * t[1], color[2] * t[2]];
}

/** world-space triangles + albedo from a three Mesh (matrixWorld baked). Cheap; material.color × userData.meanColor */
export function extractMeshTriangles(mesh) {
  const g = mesh.geometry; const pos = g.attributes.position; const idx = g.index;
  mesh.updateWorldMatrix?.(true, false);
  const e = mesh.matrixWorld.elements; const n = idx ? idx.count : pos.count;
  const tri = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = idx ? idx.getX(i) : i; const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    tri[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    tri[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    tri[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const c = m?.color ? [m.color.r, m.color.g, m.color.b] : [0.5, 0.5, 0.5];
  return { triangles: tri, color: c, textureMean: m?.userData?.meanColor ?? null };
}

function aabbOf(tri) {
  const a = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) { a[k] = Math.min(a[k], tri[i + k]); a[k + 3] = Math.max(a[k + 3], tri[i + k]); }
  return a;
}

export class VoxelWindow {
  constructor(cfg = {}) {
    const c = { ...VOXEL_DEFAULTS, ...cfg };
    this.cellSize = c.cellSize; this.bs = c.brickSize; this.bricks = { ...c.bricks };
    this.maxBricksPerUpdate = c.maxBricksPerUpdate;
    this.voxelsPerBrick = this.bs ** 3;
    this.dims = { x: this.bricks.x * this.bs, y: this.bricks.y * this.bs, z: this.bricks.z * this.bs };
    this.data = new Uint32Array(this.bricks.x * this.bricks.y * this.bricks.z * this.voxelsPerBrick);
    this.baseBrick = [0, 0, 0];
    this.meshes = new Map(); // id -> {tri, aabb, albedo}
    this.dirty = new Map(); // key -> [bx,by,bz]
    this._centered = false;
    this.indexOn = !!c.index; this.indexMaxBricks = c.indexMaxBricks; this.cells = new Map(); this.big = new Map(); this._seq = 0; this._sum = new Float32Array(this.voxelsPerBrick * 4);
    this.scan = { bricks: 0, meshesScanned: 0, trisScanned: 0 }; // CC-GIVOX counters (deterministic): _buildBrick calls, meshes AABB-tested, tris examined
  }
  _cellKey(x, y, z) { return `${x},${y},${z}`; }
  _indexAdd(id, m) {
    const w = this.brickWorld, a = m.aabb; const lo = [0, 1, 2].map((k) => Math.floor(a[k] / w)), hi = [0, 1, 2].map((k) => Math.floor(a[k + 3] / w));
    const n = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    if (!(n <= this.indexMaxBricks)) { m.big = true; this.big.set(id, m); return; } // also catches NaN/Infinity AABBs
    m.big = false; m.lo = lo; m.hi = hi;
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) { const k = this._cellKey(x, y, z); let c = this.cells.get(k); if (!c) this.cells.set(k, c = new Map()); c.set(id, m); }
  }
  _indexRemove(id, m) {
    if (m.big) { this.big.delete(id); return; }
    for (let z = m.lo[2]; z <= m.hi[2]; z++) for (let y = m.lo[1]; y <= m.hi[1]; y++) for (let x = m.lo[0]; x <= m.hi[0]; x++) { const k = this._cellKey(x, y, z); const c = this.cells.get(k); if (c) { c.delete(id); if (!c.size) this.cells.delete(k); } }
  }
  /** meshes whose AABB can touch brick (bx,by,bz), in registry insertion order */
  _candidates(bx, by, bz) {
    const c = this.cells.get(this._cellKey(bx, by, bz));
    if (!this.big.size) return c ? [...c.values()] : [];
    const out = c ? [...c.values()] : []; for (const m of this.big.values()) out.push(m); out.sort((p, q) => p.seq - q.seq); return out;
  }
  get brickWorld() { return this.bs * this.cellSize; }
  /** world min corner of the window */
  get origin() { return this.baseBrick.map((b) => b * this.brickWorld); }
  brickSlot(bx, by, bz) { return posMod(bx, this.bricks.x) + this.bricks.x * (posMod(by, this.bricks.y) + this.bricks.y * posMod(bz, this.bricks.z)); }
  inWindow(bx, by, bz) {
    const b = this.baseBrick;
    return bx >= b[0] && bx < b[0] + this.bricks.x && by >= b[1] && by < b[1] + this.bricks.y && bz >= b[2] && bz < b[2] + this.bricks.z;
  }
  _mark(bx, by, bz) { if (this.inWindow(bx, by, bz)) this.dirty.set(`${bx},${by},${bz}`, [bx, by, bz]); }
  _markAabb(a) {
    const w = this.brickWorld; const lo = [0, 1, 2].map((k) => Math.floor(a[k] / w)); const hi = [0, 1, 2].map((k) => Math.floor(a[k + 3] / w));
    const b = this.baseBrick;
    const x0 = Math.max(lo[0], b[0]), x1 = Math.min(hi[0], b[0] + this.bricks.x - 1);
    const y0 = Math.max(lo[1], b[1]), y1 = Math.min(hi[1], b[1] + this.bricks.y - 1);
    const z0 = Math.max(lo[2], b[2]), z1 = Math.min(hi[2], b[2] + this.bricks.z - 1);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this._mark(x, y, z);
  }
  /** mesh = {triangles: flat xyz*3 per tri (world space), color?, textureMean?, albedo?, aabb?} */
  addMesh(id, mesh) {
    if (this.meshes.has(id)) this.removeMesh(id);
    const tri = mesh.triangles instanceof Float32Array ? mesh.triangles : Float32Array.from(mesh.triangles.flat ? mesh.triangles.flat() : mesh.triangles);
    const aabb = mesh.aabb ?? aabbOf(tri);
    this.meshes.set(id, { tri, aabb, albedo: meshAlbedo(mesh) });
    this._markAabb(aabb);
    const rec = this.meshes.get(id); rec.seq = this._seq++; if (this.indexOn) this._indexAdd(id, rec);
  }
  removeMesh(id) {
    const m = this.meshes.get(id); if (!m) return false;
    if (this.indexOn) this._indexRemove(id, m);
    this.meshes.delete(id); this._markAabb(m.aabb); return true;
  }
  /** snap window to camera (brick granularity, 3D). Entering bricks become dirty. @returns number of bricks entered */
  setCenter(cameraPos) {
    const w = this.brickWorld;
    const nb = [0, 1, 2].map((k) => Math.floor(cameraPos[k] / w) - Math.floor([this.bricks.x, this.bricks.y, this.bricks.z][k] / 2));
    const prev = this.baseBrick; const first = !this._centered;
    if (!first && nb[0] === prev[0] && nb[1] === prev[1] && nb[2] === prev[2]) return 0;
    this.baseBrick = nb; this._centered = true;
    // drop dirty entries that left the window
    for (const [k, b] of this.dirty) if (!this.inWindow(...b)) this.dirty.delete(k);
    let entered = 0;
    const inPrev = (x, y, z) => !first && x >= prev[0] && x < prev[0] + this.bricks.x && y >= prev[1] && y < prev[1] + this.bricks.y && z >= prev[2] && z < prev[2] + this.bricks.z;
    for (let z = 0; z < this.bricks.z; z++) for (let y = 0; y < this.bricks.y; y++) for (let x = 0; x < this.bricks.x; x++) {
      const bx = nb[0] + x, by = nb[1] + y, bz = nb[2] + z;
      if (!inPrev(bx, by, bz)) { this._mark(bx, by, bz); entered++; }
    }
    return entered;
  }
  /** packed voxel at ABSOLUTE cell, 0 outside window */
  getVoxel(cx, cy, cz) {
    const bs = this.bs; const bx = Math.floor(cx / bs), by = Math.floor(cy / bs), bz = Math.floor(cz / bs);
    if (!this.inWindow(bx, by, bz)) return 0;
    return this.data[this.brickSlot(bx, by, bz) * this.voxelsPerBrick + posMod(cx, bs) + bs * (posMod(cy, bs) + bs * posMod(cz, bs))];
  }
  getVoxelAtWorld(p) { const s = this.cellSize; return this.getVoxel(Math.floor(p[0] / s), Math.floor(p[1] / s), Math.floor(p[2] / s)); }

  _buildBrick(bx, by, bz) {
    const bs = this.bs, cs = this.cellSize, w = this.brickWorld, h = cs / 2;
    const o = [bx * w, by * w, bz * w];
    const sum = this._sum; sum.fill(0); const sc = this.scan; sc.bricks++;
    for (const m of (this.indexOn ? this._candidates(bx, by, bz) : this.meshes.values())) {
      const a = m.aabb; sc.meshesScanned++;
      if (a[3] < o[0] || a[0] > o[0] + w || a[4] < o[1] || a[1] > o[1] + w || a[5] < o[2] || a[2] > o[2] + w) continue;
      const t = m.tri;
      for (let i = 0; i < t.length; i += 9) {
        sc.trisScanned++;
        const lo = _lo, hi = _hi; for (let k = 0; k < 3; k++) { lo[k] = Math.min(t[i + k], t[i + 3 + k], t[i + 6 + k]); hi[k] = Math.max(t[i + k], t[i + 3 + k], t[i + 6 + k]); }
        if (hi[0] < o[0] || lo[0] > o[0] + w || hi[1] < o[1] || lo[1] > o[1] + w || hi[2] < o[2] || lo[2] > o[2] + w) continue;
        for (let k = 0; k < 3; k++) { _r0[k] = Math.max(0, Math.floor((lo[k] - o[k]) / cs)); _r1[k] = Math.min(bs - 1, Math.floor((hi[k] - o[k]) / cs)); }
        const r0 = _r0, r1 = _r1;
        // plane-box test kills the diagonal over-marking of a pure AABB mark (one SAT axis of Akenine-Möller)
        const e1 = [t[i + 3] - t[i], t[i + 4] - t[i + 1], t[i + 5] - t[i + 2]];
        const e2 = [t[i + 6] - t[i], t[i + 7] - t[i + 1], t[i + 8] - t[i + 2]];
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nl = Math.hypot(n[0], n[1], n[2]); const planar = nl > 1e-12; if (planar) n = [n[0] / nl, n[1] / nl, n[2] / nl];
        const reach = planar ? h * (Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2])) : 0;
        for (let z = r0[2]; z <= r1[2]; z++) for (let y = r0[1]; y <= r1[1]; y++) for (let x = r0[0]; x <= r1[0]; x++) {
          if (planar) {
            const dx = o[0] + (x + 0.5) * cs - t[i], dy = o[1] + (y + 0.5) * cs - t[i + 1], dz = o[2] + (z + 0.5) * cs - t[i + 2];
            if (Math.abs(n[0] * dx + n[1] * dy + n[2] * dz) > reach + 1e-9) continue;
          }
          const v = (x + bs * (y + bs * z)) * 4;
          sum[v] += m.albedo[0]; sum[v + 1] += m.albedo[1]; sum[v + 2] += m.albedo[2]; sum[v + 3] += 1;
        }
      }
    }
    const base = this.brickSlot(bx, by, bz) * this.voxelsPerBrick;
    for (let v = 0; v < this.voxelsPerBrick; v++) {
      const c = sum[v * 4 + 3];
      this.data[base + v] = c > 0 ? packVoxel([sum[v * 4] / c, sum[v * 4 + 1] / c, sum[v * 4 + 2] / c]) : 0;
    }
    return { slot: this.brickSlot(bx, by, bz), start: base, count: this.voxelsPerBrick };
  }
  /** rebuild up to `max` dirty bricks (nearest window centre first). @returns {rebuilt:[{slot,start,count}], remaining} — each range = ONE partial upload */
  update(max = this.maxBricksPerUpdate) {
    const c = [this.baseBrick[0] + this.bricks.x / 2, this.baseBrick[1] + this.bricks.y / 2, this.baseBrick[2] + this.bricks.z / 2];
    const list = [...this.dirty.entries()].sort((p, q) => d2(p[1], c) - d2(q[1], c)).slice(0, max);
    const rebuilt = [];
    for (const [k, b] of list) { this.dirty.delete(k); rebuilt.push(this._buildBrick(...b)); }
    return { rebuilt, remaining: this.dirty.size };
  }
}
const _lo = [0, 0, 0], _hi = [0, 0, 0], _r0 = [0, 0, 0], _r1 = [0, 0, 0]; // scratch (single-threaded _buildBrick)
const d2 = (a, c) => (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2;
