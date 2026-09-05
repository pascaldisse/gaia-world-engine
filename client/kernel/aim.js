import * as THREE from 'three/webgpu';

// Pointer aiming math — data-driven, opt-in per camera rig (a `side`/top-down
// rig may declare `aim: 'pointer'`). Ports the Boomtown DotsCity PLAYER path:
//
//   PlayerShootMouseTargetProvider.GetShootDirection (Assets/DotsCity/Samples/
//   Demo City/.../Player/Factory/PlayerShootMouseTargetProvider.cs): on held
//   LMB it casts mainCamera.ScreenPointToRay(mouse) onto a HORIZONTAL plane
//   `new Plane(Vector3.up, new Vector3(0, sourcePosition.y, 0))` — i.e. at the
//   player SOURCE ROOT height, NOT y=0 (the generic shared PcMotionInput.FireInput
//   uses Vector3.zero / plane 0; the CONFIGURED player provider uses source Y),
//   then aims from the body toward that ground point. GeneralSettingData
//   .GetShotDirection defaults ShootDirectionSource.Mouse.
//
// GAIA reconciliation: player.position is the EYE; the Unity sourcePosition.y is
// the body ROOT, so the aim plane sits at the body root = eyeY - eyeHeight (the
// feet). Only YAW is consumed (top-down), so the exact plane height only shifts
// the hit by the camera's small parallax; we still honour the configured
// root-height plane rather than an arbitrary 0.

const _ray = new THREE.Ray();
const _near = new THREE.Vector3();
const _far = new THREE.Vector3();

// Screen pixel -> normalized device coords, using the ACTUAL canvas client rect
// ({ left, top, width, height } from getBoundingClientRect).
export function pointerToNdc(clientX, clientY, rect) {
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}

// Unproject an NDC point through the real camera matrices and intersect the
// horizontal plane y = worldY. Returns `out` (Vector3) or null when the ray is
// parallel to the plane or the plane lies behind the camera. Works for both
// perspective and orthographic cameras (pure unproject, no camera-type branch).
export function screenRayGroundPoint(camera, ndcX, ndcY, worldY, out = new THREE.Vector3()) {
  _near.set(ndcX, ndcY, -1).unproject(camera);
  _far.set(ndcX, ndcY, 1).unproject(camera);
  _ray.origin.copy(_near);
  _ray.direction.copy(_far).sub(_near).normalize();
  const denom = _ray.direction.y;
  if (Math.abs(denom) < 1e-9) return null; // parallel to the ground plane
  const t = (worldY - _ray.origin.y) / denom;
  if (t < 0) return null; // ground is behind the camera along the ray
  return out.copy(_ray.origin).addScaledVector(_ray.direction, t);
}

// Body/fire yaw from a source (x,z) toward a target (x,z), in the engine's
// heading convention forward = (-sin yaw, 0, -cos yaw) (matches player.js body
// forward and the movement-facing atan2(-vx,-vz)).
export function yawTo(fromX, fromZ, targetX, targetZ) {
  return Math.atan2(-(targetX - fromX), -(targetZ - fromZ));
}

// Full opt-in aim resolve: pointer pixel + canvas rect + camera + body pose ->
// { yaw, point } or null when there is no valid ground hit (aim is then held).
// planeY defaults to the body root (`from.y`); callers pass feet = eyeY-eyeHeight.
export function aimYawFromPointer({ camera, rect, clientX, clientY, from, planeY }) {
  if (!camera || !rect || !from) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const ndc = pointerToNdc(clientX, clientY, rect);
  const py = Number.isFinite(planeY) ? planeY : from.y;
  const point = screenRayGroundPoint(camera, ndc.x, ndc.y, py);
  if (!point) return null;
  return { yaw: yawTo(from.x, from.z, point.x, point.z), point };
}
