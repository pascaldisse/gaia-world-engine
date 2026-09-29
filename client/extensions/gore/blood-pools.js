// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §2 pool: flat decal on ground, radius 0->size over ~2s ease-out, persists,
// darkens slightly; oldest evicted at cap. §4: decal cap default 48, pools
// SHARE the decal cap and the same underlying instanced buffer -- both the
// small droplet-contact marks (blood-particles.js's onGroundContact) and an
// explicit gore.blood.pool() call live in one InstancedMesh, one eviction
// ring. stats() reports both: `decals` = every live instance in the ring,
// `pools` = the subset created by an explicit pool() call.
//
// One CircleGeometry(position/normal/uv=3) + instanceMatrix(1) + one packed
// vec4 colour+age instanced attribute(1) = 5 vertex buffers, within the §4
// budget of 6.
const GROW_TIME = 2.0; // seconds, ease-out radius growth
const DARKEN_OVER = 6.0; // seconds to reach full darkening
const COLOR_BASE = [0.35, 0.02, 0.04];
const COLOR_DARK = [0.14, 0.01, 0.015];

function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }

export class BloodPools {
  /**
   * @param {{three:any, tsl:any}} gpu
   * @param {import('three').Scene} scene
   * @param {{ capacity?: number }} opts
   */
  constructor(gpu, scene, opts = {}) {
    const { three, tsl } = gpu;
    this.three = three; this.scene = scene;
    this.capacity = Math.max(1, opts.capacity ?? 48);
    const n = this.capacity;

    this.targetSize = new Float32Array(n);
    this.age = new Float32Array(n);
    this.alive = new Uint8Array(n);
    this.isPool = new Uint8Array(n);
    this.posX = new Float32Array(n); this.posY = new Float32Array(n); this.posZ = new Float32Array(n);
    this.normalX = new Float32Array(n); this.normalY = new Float32Array(n); this.normalZ = new Float32Array(n);
    this.handleId = new Float64Array(n).fill(-1);

    // FIFO ring of slot indices in creation order, for oldest-eviction.
    this.order = new Int32Array(n); this.orderHead = 0; this.orderCount = 0;
    this.freeSlots = new Int32Array(n); for (let i = 0; i < n; i++) this.freeSlots[i] = n - 1 - i;
    this.freeTop = n;
    this._nextHandleId = 1;

    this.geometry = new three.CircleGeometry(1, 24);
    this.material = new three.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    this.colorAttr = new three.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.geometry.setAttribute('gInstanceColor', this.colorAttr);
    this.material.colorNode = tsl.instancedBufferAttribute(this.colorAttr, 'vec4');

    this.mesh = new three.InstancedMesh(this.geometry, this.material, n);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this._m4 = new three.Matrix4(); this._pos = new three.Vector3();
    this._quat = new three.Quaternion(); this._up = new three.Vector3(0, 0, 1); this._normal = new three.Vector3();
    this._scale = new three.Vector3();
    scene.add(this.mesh);
  }

  stats() {
    let pools = 0;
    for (let i = 0; i < this.orderCount; i++) { const s = this.order[(this.orderHead + i) % this.capacity]; if (this.isPool[s]) pools++; }
    return { decals: this.orderCount, pools };
  }

  _allocSlot() {
    if (this.freeTop > 0) return this.freeSlots[--this.freeTop];
    // at cap: evict oldest
    const oldest = this.order[this.orderHead];
    this.orderHead = (this.orderHead + 1) % this.capacity;
    this.orderCount--;
    this.alive[oldest] = 0;
    return oldest;
  }

  _spawn(pos, normal, size, isPool) {
    if (!(size > 0) || !Array.isArray(pos) || !Array.isArray(normal)) return null;
    const slot = this._allocSlot();
    this.targetSize[slot] = size; this.age[slot] = 0; this.alive[slot] = 1; this.isPool[slot] = isPool ? 1 : 0;
    this.posX[slot] = pos[0]; this.posY[slot] = pos[1]; this.posZ[slot] = pos[2];
    this.normalX[slot] = normal[0]; this.normalY[slot] = normal[1]; this.normalZ[slot] = normal[2];
    const id = this._nextHandleId++;
    this.handleId[slot] = id;
    this.order[(this.orderHead + this.orderCount) % this.capacity] = slot;
    this.orderCount++;
    return { id, slot };
  }

  /** @returns {{id:number, slot:number}|null} */
  pool(pos, normal, size) { return this._spawn(pos, normal, size, true); }

  /** internal: small mark from a blood droplet's ground contact */
  decal(pos, normal, size) { return this._spawn(pos, normal, size, false); }

  update(dt) {
    for (let i = 0; i < this.orderCount; i++) {
      const slot = this.order[(this.orderHead + i) % this.capacity];
      this.age[slot] += dt;
    }
    this._writeInstances();
  }

  _writeInstances() {
    for (let i = 0; i < this.orderCount; i++) {
      const slot = this.order[(this.orderHead + i) % this.capacity];
      const growT = Math.min(1, this.age[slot] / GROW_TIME);
      const radius = this.targetSize[slot] * easeOutCubic(growT);
      this._normal.set(this.normalX[slot], this.normalY[slot], this.normalZ[slot]).normalize();
      this._quat.setFromUnitVectors(this._up, this._normal);
      this._pos.set(this.posX[slot], this.posY[slot], this.posZ[slot]);
      this._scale.set(radius, radius, radius);
      this._m4.compose(this._pos, this._quat, this._scale);
      this.mesh.setMatrixAt(i, this._m4);
      const darkT = Math.min(1, this.age[slot] / DARKEN_OVER);
      const base = i * 4;
      this.colorAttr.array[base] = COLOR_BASE[0] + (COLOR_DARK[0] - COLOR_BASE[0]) * darkT;
      this.colorAttr.array[base + 1] = COLOR_BASE[1] + (COLOR_DARK[1] - COLOR_BASE[1]) * darkT;
      this.colorAttr.array[base + 2] = COLOR_BASE[2] + (COLOR_DARK[2] - COLOR_BASE[2]) * darkT;
      this.colorAttr.array[base + 3] = 1;
    }
    this.mesh.count = this.orderCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  reset() {
    this.orderHead = 0; this.orderCount = 0;
    this.freeTop = this.capacity;
    for (let i = 0; i < this.capacity; i++) this.freeSlots[i] = this.capacity - 1 - i;
    this.alive.fill(0);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
