// PREFAB ROOT NORMALIZATION -- pure helpers for the Unity importer.
//
// THE DEFECT THESE FIX (audited against the real source, see the worked example
// at the bottom of this comment):
//
// 1. DOUBLE ROOT. A prefab's IR gives every descendant a world transform
//    computed INSIDE the prefab file, which already contains the prefab ROOT's
//    own local TRS. emit.mjs then places the prefab as an entity whose transform
//    is the scene PrefabInstance's root placement -- and Unity's rule is that an
//    instance root REPLACES the authored root, it does not stack on it. Baking
//    the authored root into the parts and then applying the instance root put
//    every prefab's geometry at (instanceRoot * authoredRoot) instead of
//    instanceRoot.
//    => Prefab descendants must be expressed RELATIVE TO THE ROOT: root^-1 * world.
//
// 2. PARTIAL OVERRIDES ASSUMED IDENTITY. parse.mjs built an instance's local
//    transform from the m_Local* modifications alone, starting at
//    position 0 / rotation identity / scale 1. Unity applies overrides ON TOP OF
//    the authored root, per axis: an instance that overrides only the position
//    keeps the prefab root's authored rotation AND scale.
//    => Absent axes must inherit the AUTHORED ROOT's values, never identity.
//
// WORKED EXAMPLE (raw source, not a report):
//   Assets/Modular Buildings/Building_ApartmentSmall_Red fragments rayfire v3.prefab
//     root Transform 6129902004204677189:
//       m_LocalPosition (44.351006, 0, -20.299002)
//       m_LocalRotation (0, -1, 0, 0)          // 180 deg about Y
//       m_LocalScale    (1, 1.5, 1)            // NON-UNIFORM
//   Assets/Scenes/boomtown.unity PrefabInstance 1776860175 overrides that same
//   target with m_LocalPosition (0, 0, 200) and m_LocalRotation (0, 1, 0, 0).
//   It does NOT override m_LocalScale.
//   => the instance root is position (0,0,200), rotation 180 deg about Y,
//      scale (1, 1.5, 1)   <-- the emitted entity had NO scale at all (defect 2)
//   => and the emitted parts carried the authored root offset (44.35, *, 20.30)
//      on top of that entity (defect 1), which is why the building rendered ~44 m
//      east/south of where the scene puts it and swallowed the pickup authored at
//      (-39.06, 0, -229.16).
//
// Non-uniform root scale + rotated children means root^-1 * world is generally a
// SHEARED matrix. TRS output cannot represent that, so the helpers return
// matrices and say so explicitly (`decomposable`); callers that can only emit TRS
// must refuse rather than approximate.

export const ZERO_VEC = Object.freeze({ x: 0, y: 0, z: 0 });
export const ONE_VEC = Object.freeze({ x: 1, y: 1, z: 1 });
export const ID_QUAT = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
export const M4_IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function v3(v, fallback = ZERO_VEC) {
  return { x: num(v?.x, fallback.x), y: num(v?.y, fallback.y), z: num(v?.z, fallback.z) };
}
export function q4(q, fallback = ID_QUAT) {
  return { x: num(q?.x, fallback.x), y: num(q?.y, fallback.y), z: num(q?.z, fallback.z), w: num(q?.w, fallback.w) };
}
export function trs(t, fallback = null) {
  return {
    position: v3(t?.position, fallback?.position ?? ZERO_VEC),
    rotation: q4(t?.rotation, fallback?.rotation ?? ID_QUAT),
    scale: v3(t?.scale, fallback?.scale ?? ONE_VEC),
  };
}

// ---- 4x4 matrices (column-major, three.js element order) --------------------
export function m4FromTRS(t) {
  const { position, rotation, scale } = trs(t);
  const { x, y, z, w } = rotation;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * scale.x, (xy + wz) * scale.x, (xz - wy) * scale.x, 0,
    (xy - wz) * scale.y, (1 - (xx + zz)) * scale.y, (yz + wx) * scale.y, 0,
    (xz + wy) * scale.z, (yz - wx) * scale.z, (1 - (xx + yy)) * scale.z, 0,
    position.x, position.y, position.z, 1,
  ];
}
export function m4Mul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}
export function m4Invert(m) {
  const a = m.slice();
  const inv = M4_IDENTITY.slice();
  for (let i = 0; i < 4; i++) {
    let pivot = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(a[i * 4 + r]) > Math.abs(a[i * 4 + pivot])) pivot = r;
    if (Math.abs(a[i * 4 + pivot]) < 1e-12) throw new Error('prefab root transform is singular (zero scale?)');
    if (pivot !== i) {
      for (let c = 0; c < 4; c++) {
        [a[c * 4 + i], a[c * 4 + pivot]] = [a[c * 4 + pivot], a[c * 4 + i]];
        [inv[c * 4 + i], inv[c * 4 + pivot]] = [inv[c * 4 + pivot], inv[c * 4 + i]];
      }
    }
    const d = a[i * 4 + i];
    for (let c = 0; c < 4; c++) { a[c * 4 + i] /= d; inv[c * 4 + i] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === i) continue;
      const f = a[i * 4 + r];
      if (f === 0) continue;
      for (let c = 0; c < 4; c++) { a[c * 4 + r] -= f * a[c * 4 + i]; inv[c * 4 + r] -= f * inv[c * 4 + i]; }
    }
  }
  return inv;
}
export function m4Decompose(m) {
  const col = (i) => ({ x: m[i * 4], y: m[i * 4 + 1], z: m[i * 4 + 2] });
  const len = (v) => Math.hypot(v.x, v.y, v.z);
  const c0 = col(0), c1 = col(1), c2 = col(2);
  const det = c0.x * (c1.y * c2.z - c1.z * c2.y) - c1.x * (c0.y * c2.z - c0.z * c2.y) + c2.x * (c0.y * c1.z - c0.z * c1.y);
  const scale = { x: len(c0) * (det < 0 ? -1 : 1), y: len(c1), z: len(c2) };
  const r = [
    scale.x ? c0.x / scale.x : 0, scale.x ? c0.y / scale.x : 0, scale.x ? c0.z / scale.x : 0,
    scale.y ? c1.x / scale.y : 0, scale.y ? c1.y / scale.y : 0, scale.y ? c1.z / scale.y : 0,
    scale.z ? c2.x / scale.z : 0, scale.z ? c2.y / scale.z : 0, scale.z ? c2.z / scale.z : 0,
  ];
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = r;
  const trace = m00 + m11 + m22;
  let rotation;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    rotation = { x: (m12 - m21) / s, y: (m20 - m02) / s, z: (m01 - m10) / s, w: 0.25 * s };
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    rotation = { x: 0.25 * s, y: (m10 + m01) / s, z: (m20 + m02) / s, w: (m12 - m21) / s };
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    rotation = { x: (m10 + m01) / s, y: 0.25 * s, z: (m21 + m12) / s, w: (m20 - m02) / s };
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    rotation = { x: (m20 + m02) / s, y: (m21 + m12) / s, z: 0.25 * s, w: (m01 - m10) / s };
  }
  return { position: { x: m[12], y: m[13], z: m[14] }, rotation, scale };
}
// Does a position/rotation/scale triple reproduce this matrix? false => shear,
// i.e. a TRS-only consumer must refuse instead of emitting a wrong pose.
export function m4IsDecomposable(m, eps = 1e-6) {
  const rebuilt = m4FromTRS(m4Decompose(m));
  return rebuilt.every((value, i) => Math.abs(value - m[i]) <= eps);
}

// ---- the two rules ----------------------------------------------------------

// The prefab file's ROOT transform: the entity whose transform has no parent.
// `entities` is the parsed IR list; each entry carries transform.local/.world and
// a parent link. Zero or many roots is ambiguous and refused -- the importer must
// not guess which one an instance places.
export function rootEntityOf(entities, { what = 'prefab' } = {}) {
  const list = (entities ?? []).filter((e) => e?.transform);
  const roots = list.filter((e) => !e.parentTransformFileID && !e.parent && e.transform?.parent !== true);
  if (roots.length === 1) return roots[0];
  // fall back to the entity whose world equals its local (a root by definition)
  const byIdentity = list.filter((e) => sameTRS(e.transform.local, e.transform.world));
  if (byIdentity.length === 1) return byIdentity[0];
  throw new Error(`${what}: expected exactly one root transform, found ${roots.length || byIdentity.length}`);
}
function sameTRS(a, b, eps = 1e-9) {
  if (!a || !b) return false;
  const A = trs(a), B = trs(b);
  return ['x', 'y', 'z'].every((k) => Math.abs(A.position[k] - B.position[k]) <= eps && Math.abs(A.scale[k] - B.scale[k]) <= eps)
    && ['x', 'y', 'z', 'w'].every((k) => Math.abs(A.rotation[k] - B.rotation[k]) <= eps);
}

// RULE 1 -- express a descendant's prefab-file world RELATIVE TO THE ROOT.
// Returns { matrix, decomposable, ...TRS } so a TRS-only caller can refuse.
export function normalizeByRoot(rootLocal, world) {
  const rootInverse = m4Invert(m4FromTRS(rootLocal));
  const matrix = m4Mul(rootInverse, m4FromTRS(world));
  const decomposable = m4IsDecomposable(matrix);
  return { matrix, decomposable, ...m4Decompose(matrix) };
}
export function rootInverseMatrix(rootLocal) { return m4Invert(m4FromTRS(rootLocal)); }

// RULE 2 -- an instance root REPLACES the authored root PER AXIS: every axis the
// modifications name wins, every axis they do not name keeps the AUTHORED value.
// `mods` is the raw m_Modifications list (propertyPath/value), already filtered
// to the instance's own root target.
export function instanceRootLocal(authoredRoot, mods, { what = 'prefab instance' } = {}) {
  const base = trs(authoredRoot);
  const out = { position: { ...base.position }, rotation: { ...base.rotation }, scale: { ...base.scale } };
  const touched = { position: false, rotation: false, scale: false };
  // per-axis record: which axes the instance actually names, so a consumer can
  // tell an inherited value from a coincidentally equal override
  const axes = { position: { x: false, y: false, z: false }, rotation: { x: false, y: false, z: false, w: false }, scale: { x: false, y: false, z: false } };
  for (const mod of mods ?? []) {
    const propertyPath = mod?.propertyPath;
    if (typeof propertyPath !== 'string') continue;
    const match = /^m_Local(Position|Rotation|Scale)\.([xyzw])$/.exec(propertyPath);
    if (!match) continue;
    const [, kind, axis] = match;
    const value = Number(mod.value);
    if (!Number.isFinite(value)) throw new Error(`${what}: ${propertyPath} is not a finite number (${JSON.stringify(mod.value)})`);
    if (kind === 'Position') { out.position[axis] = value; touched.position = true; axes.position[axis] = true; }
    else if (kind === 'Rotation') { out.rotation[axis] = value; touched.rotation = true; axes.rotation[axis] = true; }
    else { out.scale[axis] = value; touched.scale = true; axes.scale[axis] = true; }
  }
  return { local: out, overridden: touched, axes };
}
