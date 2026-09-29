// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §6 lightweight own rigid world (swappable backend interface: step/addBody/removeBody/getBody/raycast/
// applyImpulse/applyAngularVelocity). Semi-implicit (symplectic) Euler, single ground plane, sleep, bounding-sphere raycast.
// No body-vs-body contact (out of scope, §6.1 / U11).
const vec = (o, d = 0) => ({ x: Number(o?.x ?? d) || 0, y: Number(o?.y ?? d) || 0, z: Number(o?.z ?? d) || 0 });

export const RF_WORLD_DEFAULTS = Object.freeze({
  gravity: Object.freeze({ x: 0, y: -9.81, z: 0 }), // real-world, so authored timings read naturally
  groundY: 0,
  sleepLinear: 0.02, sleepFrames: 10, // m/s, steps: settled debris goes cheap and is detectable as "at rest"
  restitution: 0.05, // nearly inelastic: debris, not rubber
  friction: 0.6,
});

function extentY(shape) { return shape.type === 'sphere' ? shape.radius : shape.halfExtents.y; }
function boundRadius(shape) { return shape.type === 'sphere' ? shape.radius : Math.hypot(shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z); }

export class RFWorld {
  constructor(opts = {}) {
    const d = RF_WORLD_DEFAULTS;
    this.gravity = vec(opts.gravity ?? d.gravity);
    this.groundY = Number(opts.groundY ?? d.groundY);
    this.sleepLinear = Number(opts.sleepLinear ?? d.sleepLinear);
    this.sleepFrames = Number(opts.sleepFrames ?? d.sleepFrames);
    this.restitution = Number(opts.restitution ?? d.restitution);
    this.friction = Number(opts.friction ?? d.friction);
    this.bodies = new Map();
    this._nextId = 1; // strictly increasing, never reused
  }

  addBody(desc = {}) {
    const s = desc.shape;
    let shape;
    if (s?.type === 'sphere' && Number.isFinite(s.radius) && s.radius >= 0) shape = { type: 'sphere', radius: s.radius };
    else if (s?.type === 'obb' && s.halfExtents) shape = { type: 'obb', halfExtents: vec(s.halfExtents) };
    else throw new Error('RFWorld.addBody: shape must be {type:"sphere",radius} or {type:"obb",halfExtents}');
    const mass = desc.mass === undefined ? 1 : Number(desc.mass);
    if (!(mass > 0) || !Number.isFinite(mass)) throw new Error('RFWorld.addBody: mass must be a finite number > 0');
    const id = this._nextId++;
    const body = {
      id, position: vec(desc.position), rotation: vec(desc.rotation), velocity: vec(desc.velocity), angularVelocity: vec(desc.angularVelocity),
      mass, shape, kinematic: !!desc.kinematic, awake: true, sleepCounter: 0,
    };
    this.bodies.set(id, body);
    return id;
  }

  removeBody(id) { return this.bodies.delete(id); }
  getBody(id) { return this.bodies.get(id); }

  step(dt) {
    if (dt === 0) { this._resolveGround(); return; } // no time passes, but a just-activated body must never sit below the plane
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const g = this.gravity, restThreshold = Math.abs(g.y) * dt * 2; // approach speeds this small = resting contact, not a bounce
    const damp = Math.max(0, 1 - this.friction * dt);
    for (const b of this.bodies.values()) {
      if (b.kinematic || !b.awake) continue;
      const v = b.velocity, p = b.position, w = b.angularVelocity, r = b.rotation;
      v.x += g.x * dt; v.y += g.y * dt; v.z += g.z * dt;
      p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
      r.x += w.x * dt; r.y += w.y * dt; r.z += w.z * dt;
      let grounded = false;
      const ext = extentY(b.shape);
      if (p.y - ext <= this.groundY) {
        grounded = true;
        p.y = this.groundY + ext;
        if (v.y < 0) v.y = -v.y <= restThreshold ? 0 : -v.y * this.restitution;
        v.x *= damp; v.z *= damp; w.x *= damp; w.y *= damp; w.z *= damp;
      }
      const speed = Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z);
      if (grounded && speed < this.sleepLinear) {
        if (++b.sleepCounter >= this.sleepFrames) { b.awake = false; v.x = v.y = v.z = 0; w.x = w.y = w.z = 0; }
      } else b.sleepCounter = 0;
    }
  }

  _resolveGround() {
    for (const b of this.bodies.values()) {
      if (b.kinematic || !b.awake) continue;
      const lo = this.groundY + extentY(b.shape);
      if (b.position.y < lo) { b.position.y = lo; if (b.velocity.y < 0) b.velocity.y = 0; }
    }
  }

  applyImpulse(id, impulse, mode = 'impulse') {
    if (mode !== 'impulse' && mode !== 'velocityChange') throw new Error(`RFWorld.applyImpulse: unknown mode "${mode}" (impulse | velocityChange)`);
    const b = this.bodies.get(id);
    if (!b || b.kinematic) return;
    const k = mode === 'impulse' ? 1 / b.mass : 1;
    b.velocity.x += (impulse?.x ?? 0) * k; b.velocity.y += (impulse?.y ?? 0) * k; b.velocity.z += (impulse?.z ?? 0) * k;
    b.awake = true; b.sleepCounter = 0;
  }

  applyAngularVelocity(id, angVel) {
    const b = this.bodies.get(id);
    if (!b || b.kinematic) return;
    b.angularVelocity = vec(angVel);
    b.awake = true; b.sleepCounter = 0;
  }

  // Nearest body along the ray within maxDistance, by bounding sphere (conservative for OBBs).
  raycast(origin, direction, maxDistance = Infinity) {
    const dl = Math.hypot(direction?.x ?? 0, direction?.y ?? 0, direction?.z ?? 0);
    if (!(dl > 0)) return null;
    const dx = direction.x / dl, dy = direction.y / dl, dz = direction.z / dl;
    let best = null;
    for (const b of this.bodies.values()) {
      const R = boundRadius(b.shape);
      const ox = origin.x - b.position.x, oy = origin.y - b.position.y, oz = origin.z - b.position.z;
      const bq = ox * dx + oy * dy + oz * dz, cq = ox * ox + oy * oy + oz * oz - R * R;
      const disc = bq * bq - cq;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      let t = -bq - sq;
      if (t < 0) t = cq <= 0 ? 0 : -bq + sq; // origin inside the sphere -> hit at once
      if (t < 0 || t > maxDistance) continue;
      if (best && t >= best.distance) continue;
      const point = { x: origin.x + dx * t, y: origin.y + dy * t, z: origin.z + dz * t };
      let nx = point.x - b.position.x, ny = point.y - b.position.y, nz = point.z - b.position.z;
      const nl = Math.hypot(nx, ny, nz);
      if (nl > 0) { nx /= nl; ny /= nl; nz /= nl; } else { nx = -dx; ny = -dy; nz = -dz; }
      best = { id: b.id, point, distance: t, normal: { x: nx, y: ny, z: nz } };
    }
    return best;
  }
}
