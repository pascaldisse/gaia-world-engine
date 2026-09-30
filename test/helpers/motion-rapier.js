// headless Rapier 0.21.0 for motion tests. Engine has NO rapier dependency (games inject it via createMotion({rapier})),
// so tests take it from a game's node_modules: GAIA_RAPIER_FROM=<dir containing node_modules/@dimforge/rapier3d-compat>.
// Missing → throws (never a silent skip).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const from = process.env.GAIA_RAPIER_FROM;
const spec = from ? pathToFileURL(createRequire(from.replace(/\/?$/, '/')).resolve('@dimforge/rapier3d-compat')).href : '@dimforge/rapier3d-compat';
let R;
try { R = (await import(spec)).default; } catch (e) { throw new Error(`motion tests need Rapier 0.21.0: set GAIA_RAPIER_FROM (${e.message})`); }
await R.init();
export default R;
export function ground(world, R, size = 50) {
  const b = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(R.ColliderDesc.cuboid(size, 0.5, size).setFriction(0.9), b);
  return b;
}
