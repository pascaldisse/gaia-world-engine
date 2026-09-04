#!/usr/bin/env node
// glb-aabb.mjs
// Compute the analytic axis-aligned bounding box of a GLB's geometry by
// reading each mesh primitive's POSITION accessor min/max (glTF accessors
// carry min/max) and transforming the 8 corners by the node's world matrix.
// This is the OG collision shape: the hull mesh's own computed geometry
// bounds, not an invented number.
//
// ESM, no deps. glTF is Y-up right-handed — the same frame GAIA/three use.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// ---- minimal column-major mat4 math ----
function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mat4Multiply(a, b) {
  // returns a * b (column-major, three/glTF convention)
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function mat4FromTRS(t, q, s) {
  // t: [x,y,z], q: quaternion [x,y,z,w], s: [x,y,z]
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
// Euler XYZ (radians) -> quaternion, matching three's default rotation order.
function quatFromEulerXYZ(e) {
  const [ex, ey, ez] = e;
  const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2);
  const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}
function transformPoint(m, p) {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}
function nodeLocalMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation ?? [0, 0, 0];
  const q = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  return mat4FromTRS(t, q, s);
}

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const length = dv.getUint32(8, true);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < length) {
    const chunkLen = dv.getUint32(off, true);
    const chunkType = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(buf.subarray(start, start + chunkLen)));
    } else if (chunkType === 0x004e4942) {
      bin = buf.subarray(start, start + chunkLen);
    }
    off = start + chunkLen;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

// Expand a running [min,max] with a world-space point.
function expand(box, p) {
  for (let i = 0; i < 3; i++) {
    if (p[i] < box.min[i]) box.min[i] = p[i];
    if (p[i] > box.max[i]) box.max[i] = p[i];
  }
}

// AABB (world space within the GLB) over every mesh primitive's POSITION
// accessor min/max, transformed by node world matrices. Returns {min,max} or
// null if the file has no positioned geometry.
export function glbAABB(glbPath) {
  const buf = readFileSync(glbPath);
  const { json } = parseGlb(buf);
  const accessors = json.accessors ?? [];
  const meshes = json.meshes ?? [];
  const nodes = json.nodes ?? [];
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let hit = false;

  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i);
  const walk = (nodeIndex, parentMat) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const world = mat4Multiply(parentMat, nodeLocalMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      for (const prim of mesh?.primitives ?? []) {
        const posIdx = prim.attributes?.POSITION;
        if (posIdx === undefined) continue;
        const acc = accessors[posIdx];
        if (!acc?.min || !acc?.max) continue;
        const [nx, ny, nz] = acc.min;
        const [xx, xy, xz] = acc.max;
        const corners = [
          [nx, ny, nz], [xx, ny, nz], [nx, xy, nz], [xx, xy, nz],
          [nx, ny, xz], [xx, ny, xz], [nx, xy, xz], [xx, xy, xz],
        ];
        for (const c of corners) {
          expand(box, transformPoint(world, c));
          hit = true;
        }
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  for (const n of sceneNodes) walk(n, mat4Identity());
  return hit ? box : null;
}

// Union AABB over a list of GAIA mesh `parts` (each {src, position?, rotation?,
// scale?}), each part's GLB AABB placed by the part's local transform, in the
// entity-local frame. Returns {center:[x,y,z], size:[x,y,z]} or null.
// `resolveSrc(part.src)` must map a part `src` (e.g. "/assets/models/x.glb")
// to an absolute file path.
export function partsAABB(parts, resolveSrc) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let hit = false;
  for (const part of parts ?? []) {
    if (part.shape !== 'model' || !part.src) continue;
    const file = resolveSrc(part.src);
    let bb;
    try {
      bb = glbAABB(file);
    } catch {
      bb = null;
    }
    if (!bb) continue;
    const t = part.position ?? [0, 0, 0];
    const q = quatFromEulerXYZ(part.rotation ?? [0, 0, 0]);
    const s = Array.isArray(part.scale) ? part.scale : part.scale ? [part.scale, part.scale, part.scale] : [1, 1, 1];
    const m = mat4FromTRS(t, q, s);
    const [nx, ny, nz] = bb.min;
    const [xx, xy, xz] = bb.max;
    const corners = [
      [nx, ny, nz], [xx, ny, nz], [nx, xy, nz], [xx, xy, nz],
      [nx, ny, xz], [xx, ny, xz], [nx, xy, xz], [xx, xy, xz],
    ];
    for (const c of corners) {
      expand(box, transformPoint(m, c));
      hit = true;
    }
  }
  if (!hit) return null;
  return boxToCenterSize(box);
}

export function boxToCenterSize(box) {
  return {
    center: [
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ],
    size: [
      box.max[0] - box.min[0],
      box.max[1] - box.min[1],
      box.max[2] - box.min[2],
    ],
  };
}

// CLI: node glb-aabb.mjs <file.glb>
if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.argv[2];
  if (!f) throw new Error('usage: node glb-aabb.mjs <file.glb>');
  const bb = glbAABB(path.resolve(f));
  console.log(JSON.stringify(bb && boxToCenterSize(bb), null, 2));
}
