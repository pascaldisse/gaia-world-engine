// headless Rapier for tests (devDependency, pinned 0.21.0)
import R from '@dimforge/rapier3d-compat';
await R.init();
export default R;
export function ground(world, R, size = 50) {
  const b = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(R.ColliderDesc.cuboid(size, 0.5, size).setFriction(0.9), b);
  return b;
}
