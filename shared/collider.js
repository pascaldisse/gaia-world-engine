// XYZ Euler → horizontal +Z heading; [π,0,π] is yaw π, not yaw 0.
export function planarYaw(rotation) {
  const x = rotation?.x ?? rotation?.[0] ?? 0;
  const y = rotation?.y ?? rotation?.[1] ?? 0;
  return Math.atan2(Math.sin(y), Math.cos(x) * Math.cos(y));
}

// Interact reach measured to a collider SURFACE, not the entity pivot.
// Boomtown's PlayerInteract is a short forward raycast that hits the car's
// collider — distance-to-surface, never distance-to-origin. A car's blocker
// box (`collider.boxes[0] {position, size, blocker}`) keeps the body ~1.8m
// off the pivot, so a pivot-distance check with radius 1.3 can never fire.
//
// pointToInteractDistance(bodyPos, entity, origin?)
//   bodyPos — {x,z} or [x,_,z] (vertical dropped; see below)
//   entity  — the target's components ({ transform, collider, ... })
//   origin  — the target's RESOLVED world position [x,y,z] (animated/ground-
//             snapped); defaults to entity.transform.position.
//
// With a collider it transforms the body point into each box's yaw-local frame
// (entity heading = planarYaw(rotation), matching view.resolveBlockers), clamps
// to the half-extents and returns the distance to the clamped point (0 inside).
// Without one it falls back to distance to the origin.
//
// Vertical is DROPPED on both paths — the body stands on the ground while the
// boxes ride up on the cars, and the recent interact.js fix measures body-space
// horizontal distance so ground-level items stay reachable. Keeping it 2D here
// makes both sides agree and removes presence eye-height contamination.
export function pointToInteractDistance(bodyPos, entity, origin) {
  const bx = bodyPos.x ?? bodyPos[0] ?? 0;
  const bz = bodyPos.z ?? bodyPos[2] ?? 0;
  const t = entity?.transform ?? {};
  const [ox, , oz] = origin ?? t.position ?? [0, 0, 0];
  const boxes = entity?.collider?.boxes;
  if (!boxes || !boxes.length) return Math.hypot(bx - ox, bz - oz);
  const yaw = planarYaw(t.rotation);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // world offset → entity-local frame (inverse of the group's Y rotation)
  const wx = bx - ox;
  const wz = bz - oz;
  const lx = wx * cos - wz * sin;
  const lz = wx * sin + wz * cos;
  let best = Infinity;
  for (const box of boxes) {
    const [cx, , cz] = box.position ?? [0, 0, 0];
    const [sx, , sz] = box.size ?? [1, 1, 1];
    const boxYaw = planarYaw(box.rotation);
    const c = Math.cos(boxYaw), s = Math.sin(boxYaw);
    const px = lx - cx, pz = lz - cz;
    const dx = Math.max(0, Math.abs(px * c - pz * s) - sx / 2);
    const dz = Math.max(0, Math.abs(px * s + pz * c) - sz / 2);
    const d = Math.hypot(dx, dz);
    if (d < best) best = d;
  }
  return best;
}
