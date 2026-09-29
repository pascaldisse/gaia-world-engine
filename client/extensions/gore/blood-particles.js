// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §2 splash: dark-red droplets burst from pos along the hemisphere around
// normal, count ∝ strength (≈20·strength), speed 1-4 m/s, gravity, life
// 0.4-1.2s, shrink+fade; some droplets spawn a small ground decal on contact.
//
// One InstancedMesh, CPU-driven (no per-frame allocation: every scratch array
// is preallocated at construction to `capacity`). Vertex-buffer budget (§4,
// ≤6): BoxGeometry gives position/normal/uv (3) + instanceMatrix (1) +
// one packed vec4 colour+alpha instanced attribute (1) = 5.
import { rngRange, rngHemisphere } from './rng.js';

const GRAVITY = 9.8;
const SPEED_MIN = 1, SPEED_MAX = 4;
const LIFE_MIN = 0.4, LIFE_MAX = 1.2;
const COUNT_PER_STRENGTH = 20;
const GROUND_Y = 0;
const GROUND_DECAL_CHANCE = 0.12;
const GROUND_DECAL_SIZE = 0.05;
// dark-red family: base + per-droplet jitter (own tunable, §6 unspecified)
const COLOR_BASE = [0.42, 0.03, 0.05];
const COLOR_JITTER = 0.08;

export class BloodParticles {
  /**
   * @param {{three:any, tsl:any}} gpu
   * @param {import('three').Scene} scene
   * @param {() => number} rng seeded [0,1) generator (§4: own PRNG, no Math.random)
   * @param {{ capacity?: number, onGroundContact?: (pos:number[], normal:number[]) => void }} opts
   */
  constructor(gpu, scene, rng, opts = {}) {
    const { three, tsl } = gpu;
    this.three = three; this.tsl = tsl; this.scene = scene; this.rng = rng;
    this.onGroundContact = opts.onGroundContact ?? null;
    this.capacity = Math.max(1, opts.capacity ?? 2048);

    const n = this.capacity;
    this.posX = new Float32Array(n); this.posY = new Float32Array(n); this.posZ = new Float32Array(n);
    this.velX = new Float32Array(n); this.velY = new Float32Array(n); this.velZ = new Float32Array(n);
    this.life = new Float32Array(n); this.maxLife = new Float32Array(n); this.size0 = new Float32Array(n);
    this.contacted = new Uint8Array(n);
    this.colorR = new Float32Array(n); this.colorG = new Float32Array(n); this.colorB = new Float32Array(n);

    this.freeSlots = new Int32Array(n); for (let i = 0; i < n; i++) this.freeSlots[i] = n - 1 - i;
    this.freeTop = n; // freeSlots[0..freeTop) are usable, pop from freeTop-1
    this.activeList = new Int32Array(n); this.activeCount = 0;
    this.slotActiveIdx = new Int32Array(n).fill(-1);

    this.geometry = new three.BoxGeometry(0.03, 0.03, 0.03);
    this.material = new three.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    this.colorAttr = new three.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.geometry.setAttribute('gInstanceColor', this.colorAttr);
    this.material.colorNode = tsl.instancedBufferAttribute(this.colorAttr, 'vec4');

    this.mesh = new three.InstancedMesh(this.geometry, this.material, n);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0; // nothing alive at start
    this._m4 = new three.Matrix4(); this._pos = new three.Vector3();
    this._quat = new three.Quaternion(); this._scale = new three.Vector3();
    scene.add(this.mesh);
  }

  stats() { return this.activeCount; }

  /** @returns {number} particles actually emitted (0 if capped/invalid) */
  splash(pos, normal, strength) {
    if (!(strength > 0) || !Array.isArray(pos) || !Array.isArray(normal)) return 0;
    const requested = Math.round(COUNT_PER_STRENGTH * strength);
    let emitted = 0;
    for (let i = 0; i < requested && this.freeTop > 0; i++) {
      const slot = this.freeSlots[--this.freeTop];
      const dir = rngHemisphere(this.rng, normal);
      const speed = rngRange(this.rng, SPEED_MIN, SPEED_MAX);
      this.posX[slot] = pos[0]; this.posY[slot] = pos[1]; this.posZ[slot] = pos[2];
      this.velX[slot] = dir[0] * speed; this.velY[slot] = dir[1] * speed; this.velZ[slot] = dir[2] * speed;
      const life = rngRange(this.rng, LIFE_MIN, LIFE_MAX);
      this.life[slot] = life; this.maxLife[slot] = life;
      this.size0[slot] = rngRange(this.rng, 0.8, 1.3);
      this.contacted[slot] = 0;
      const j = () => rngRange(this.rng, -COLOR_JITTER, COLOR_JITTER);
      this.colorR[slot] = Math.max(0, COLOR_BASE[0] + j());
      this.colorG[slot] = Math.max(0, COLOR_BASE[1] + j());
      this.colorB[slot] = Math.max(0, COLOR_BASE[2] + j());

      this.slotActiveIdx[slot] = this.activeCount;
      this.activeList[this.activeCount] = slot;
      this.activeCount++;
      emitted++;
    }
    return emitted;
  }

  _kill(activeIdx) {
    const slot = this.activeList[activeIdx];
    const lastActiveIdx = this.activeCount - 1;
    const lastSlot = this.activeList[lastActiveIdx];
    this.activeList[activeIdx] = lastSlot;
    this.slotActiveIdx[lastSlot] = activeIdx;
    this.slotActiveIdx[slot] = -1;
    this.activeCount--;
    this.freeSlots[this.freeTop++] = slot;
  }

  update(dt) {
    for (let i = this.activeCount - 1; i >= 0; i--) {
      const slot = this.activeList[i];
      this.life[slot] -= dt;
      if (this.life[slot] <= 0) { this._kill(i); continue; }
      this.velY[slot] -= GRAVITY * dt;
      this.posX[slot] += this.velX[slot] * dt;
      this.posY[slot] += this.velY[slot] * dt;
      this.posZ[slot] += this.velZ[slot] * dt;
      if (!this.contacted[slot] && this.posY[slot] <= GROUND_Y && this.velY[slot] < 0) {
        this.contacted[slot] = 1;
        this.posY[slot] = GROUND_Y;
        if (this.onGroundContact && this.rng() < GROUND_DECAL_CHANCE) {
          this.onGroundContact([this.posX[slot], GROUND_Y, this.posZ[slot]], [0, 1, 0], GROUND_DECAL_SIZE);
        }
      }
    }
    this._writeInstances();
  }

  _writeInstances() {
    for (let i = 0; i < this.activeCount; i++) {
      const slot = this.activeList[i];
      const frac = Math.max(0, this.life[slot] / this.maxLife[slot]);
      const scale = this.size0[slot] * (0.3 + 0.7 * frac); // shrink toward 0.3x
      this._pos.set(this.posX[slot], this.posY[slot], this.posZ[slot]);
      this._scale.set(scale, scale, scale);
      this._m4.compose(this._pos, this._quat, this._scale);
      this.mesh.setMatrixAt(i, this._m4);
      const base = i * 4;
      this.colorAttr.array[base] = this.colorR[slot];
      this.colorAttr.array[base + 1] = this.colorG[slot];
      this.colorAttr.array[base + 2] = this.colorB[slot];
      this.colorAttr.array[base + 3] = frac; // fade
    }
    this.mesh.count = this.activeCount;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  /** clear all live particles, keep GPU buffers (§1 setRecipes contract) */
  reset() {
    this.activeCount = 0;
    this.freeTop = this.capacity;
    for (let i = 0; i < this.capacity; i++) this.freeSlots[i] = this.capacity - 1 - i;
    this.slotActiveIdx.fill(-1);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
