// GAIA-World-Engine motion extension — real-time procedural active ragdoll (Euphoria-style controllers) on Rapier.
// Contract: README.md §Contract. Rapier is INJECTED (createMotion({ rapier })) — the engine carries no physics dependency.
// Entry: register(ctx?) -> { name:'motion', api }. Pure api factory, no module state.
import { createMotion } from './motion.js';
import { humanoidRig, resolveRoles, rigFrame } from './rig.js';
import { BEHAVIOURS, DEFAULTS } from './behaviours.js';
import { syncThree } from './three-sync.js';

export { createMotion, humanoidRig, resolveRoles, rigFrame, BEHAVIOURS, DEFAULTS, syncThree };

export const api = Object.freeze({ createMotion, humanoidRig, resolveRoles, rigFrame, BEHAVIOURS, DEFAULTS, syncThree });

export function register() {
  return { name: 'motion', api };
}

export default register;
