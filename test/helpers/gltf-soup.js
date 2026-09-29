// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Test helper: minimal glTF 2.0 (embedded/data-URI or sibling .bin buffers) -> per-primitive triangle soups (no THREE).
import fs from 'node:fs';
import path from 'node:path';

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

export function loadGltfParts(file, { maxParts = 8 } = {}) {
  const gltf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bufs = gltf.buffers.map(b => {
    if (b.uri?.startsWith('data:')) return Buffer.from(b.uri.slice(b.uri.indexOf(',') + 1), 'base64');
    return fs.readFileSync(path.join(path.dirname(file), b.uri));
  });
  const read = ai => {
    const a = gltf.accessors[ai], bv = gltf.bufferViews[a.bufferView];
    const buf = bufs[bv.buffer], T = COMP[a.componentType], n = NCOMP[a.type];
    const off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const stride = bv.byteStride ?? n * T.BYTES_PER_ELEMENT;
    const out = new Array(a.count * n);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const get = { 5126: (o) => dv.getFloat32(o, true), 5125: (o) => dv.getUint32(o, true), 5123: (o) => dv.getUint16(o, true), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true), 5120: (o) => dv.getInt8(o) }[a.componentType];
    for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = get(off + i * stride + c * T.BYTES_PER_ELEMENT);
    return out;
  };
  const parts = [];
  // consumer convention: traverse nodes in scene order, one part per mesh primitive
  const visit = ni => {
    const node = gltf.nodes[ni];
    if (node.mesh !== undefined) for (const prim of gltf.meshes[node.mesh].primitives) {
      if (parts.length >= maxParts) return;
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const pos = read(prim.attributes.POSITION);
      const idx = prim.indices !== undefined ? read(prim.indices) : Array.from({ length: pos.length / 3 }, (_, i) => i);
      const tris = [];
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const P = k => ({ x: pos[idx[k] * 3], y: pos[idx[k] * 3 + 1], z: pos[idx[k] * 3 + 2] });
        tris.push([P(i), P(i + 1), P(i + 2)]);
      }
      if (tris.length) parts.push({ name: node.name ?? `node${ni}`, triangles: tris });
    }
    for (const c of node.children ?? []) visit(c);
  };
  for (const r of gltf.scenes[gltf.scene ?? 0].nodes) visit(r);
  return parts;
}
