// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §14 bomb (radial impulse) & gun (ray impulse). Reference falloff = clamped linear 1 - d/range; gain x10.
import { rand01 } from './prng.js';

export const EXPLODE_GAIN = 10;
const DEG = Math.PI / 180;

export function explode(world, fragments, position, { range = 5, strength = 1, variation = 50, chaos = 30, forceByMass = true, seed = 1 } = {}) {
  const affected = [];
  fragments.forEach((f, index) => {
    const body = f?.bodyId === undefined ? undefined : world.getBody(f.bodyId);
    if (!body || body.kinematic) return;
    let dx = body.position.x - position.x, dy = body.position.y - position.y, dz = body.position.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (!(distance <= range)) return;
    if (distance > 0) { dx /= distance; dy /= distance; dz /= distance; } else { dx = 0; dy = 1; dz = 0; }
    const roll = 1 + rand01(seed, index, 1) * (variation / 100); // strength .. strength+variation%
    const magnitude = strength * roll * Math.max(0, 1 - distance / range) * EXPLODE_GAIN;
    world.applyImpulse(f.bodyId, { x: dx * magnitude, y: dy * magnitude, z: dz * magnitude }, forceByMass ? 'impulse' : 'velocityChange');
    if (chaos > 0) { // chaos: degrees/s bound per axis is chaos/2
      const s = axis => (2 * rand01(seed, index, 2 + axis) - 1) * (chaos / 2) * DEG;
      world.applyAngularVelocity(f.bodyId, { x: s(0), y: s(1), z: s(2) });
    }
    affected.push({ index, bodyId: f.bodyId, distance, magnitude });
  });
  return affected;
}

// Linear only (documented simplification): torque-from-offset is not modelled.
export function shoot(world, origin, direction, { strength = 10, maxDistance = 1000 } = {}) {
  const hit = world.raycast(origin, direction, maxDistance);
  if (!hit) return null;
  const l = Math.hypot(direction.x, direction.y, direction.z);
  const impulse = { x: (direction.x / l) * strength, y: (direction.y / l) * strength, z: (direction.z / l) * strength };
  world.applyImpulse(hit.id, impulse, 'velocityChange');
  return { hit, impulse };
}
