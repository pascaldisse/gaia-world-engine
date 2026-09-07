// Hull extents for the AVP yaw-inertia approximation.
//
// WHY THIS EXISTS
// fixedDriveStep needs the car body's world-space box extents to approximate the
// yaw inertia Unity computes from its MeshCollider (that runtime tensor is never
// serialized). It used to read `spec.collider.size` directly, but a `vehicle`
// component does not necessarily carry that shape: a world may serialize the hull
// as the engine's `collider` COMPONENT form, `{ boxes: [{ size, position }] }`.
// Reading `.size` off that object yields undefined, the inertia silently falls
// back to the body MASS, and every such car steers with the wrong tensor.
//
// So the extents are resolved from the payload as it actually arrives, in a fixed
// precedence, and every candidate is validated before it is trusted:
//   1. spec.hull.size          explicit raw hull extents (the intended contract:
//                              the analytic source AABB, never a derived shape)
//   2. spec.collider.size      direct/legacy shape
//   3. spec.collider.boxes[0]  exactly ONE box — the serialized component form
// Ambiguity is not resolved by preference: several boxes means several candidate
// hulls, so it returns null and the caller keeps its documented fallback rather
// than picking one.
//
// Returns [x, y, z] with every component finite and > 0, or null.

const validExtent = (value) => Number.isFinite(value) && value > 0;

function asExtents(size) {
  if (!Array.isArray(size) || size.length !== 3) return null;
  const out = [size[0], size[1], size[2]];
  return out.every(validExtent) ? out : null;
}

export function hullExtents(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const explicit = asExtents(spec.hull?.size);
  if (explicit) return explicit;
  const collider = spec.collider;
  if (!collider || typeof collider !== 'object') return null;
  const direct = asExtents(collider.size);
  if (direct) return direct;
  const boxes = collider.boxes;
  if (!Array.isArray(boxes) || boxes.length !== 1) return null;
  return asExtents(boxes[0]?.size);
}

// Yaw inertia of a box about its vertical axis: m(w^2 + l^2)/12, w/l = x/z.
// Returns null when the extents are unusable, so the caller can decide.
export function boxYawInertia(mass, extents) {
  const size = asExtents(extents);
  if (!validExtent(mass) || !size) return null;
  const inertia = (mass * (size[0] ** 2 + size[2] ** 2)) / 12;
  return validExtent(inertia) ? inertia : null;
}
