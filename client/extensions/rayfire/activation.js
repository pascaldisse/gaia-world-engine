// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §12 activation: kinematic (held in place) -> dynamic (falls) when a trigger fires.
import { rand01 } from './prng.js';

export const ACTIVATION_SPIN = 0.3; // rad/s per axis, seeded: debris tumbles instead of sliding rigidly (tunable)

export function createActivationState({ off = 0, vel = 0, dmg = 0, con = false, uny = false, atb = false, seed = 1 } = {}) {
  return { off, vel, dmg, con, uny, atb, seed, activated: false, origin: null };
}

// An unyielding fragment is protected unless it is also flagged activatable-too (atb).
const activatable = s => !(s.uny && !s.atb);

// Note: the first call records the body's position as the offset trigger's "original position".
export function shouldActivate(state, body, { damage = 0, connectivityLost = false } = {}) {
  if (state.activated || !activatable(state)) return false;
  if (!state.origin && body?.position) state.origin = { x: body.position.x, y: body.position.y, z: body.position.z };
  if (state.vel > 0 && body?.velocity && Math.hypot(body.velocity.x, body.velocity.y, body.velocity.z) > state.vel) return true;
  if (state.off > 0 && state.origin && body?.position && Math.hypot(body.position.x - state.origin.x, body.position.y - state.origin.y, body.position.z - state.origin.z) > state.off) return true;
  if (state.dmg > 0 && damage >= state.dmg) return true;
  if (state.con === true && connectivityLost === true) return true;
  return false;
}

export function activate(state, world, bodyId) {
  if (state.activated || !activatable(state)) return false;
  const body = world.getBody(bodyId);
  if (!body) return false;
  body.kinematic = false; body.awake = true; body.sleepCounter = 0;
  const still = body.velocity.x === 0 && body.velocity.y === 0 && body.velocity.z === 0 && body.angularVelocity.x === 0 && body.angularVelocity.y === 0 && body.angularVelocity.z === 0;
  if (still) {
    const r = axis => (2 * rand01(state.seed, bodyId, axis) - 1) * ACTIVATION_SPIN;
    world.applyAngularVelocity(bodyId, { x: r(0), y: r(1), z: r(2) });
  }
  state.activated = true;
  return true;
}
