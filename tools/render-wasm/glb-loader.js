// glb-loader.js — test/import path ONLY: GLB → render-api backend calls (any backend implementing interface.js).
// Mirrors gaia-render's own load_scene_into (mesh+material per glTF index, node hierarchy, KHR lights, camera or fit).
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORM = { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 };

export function parseGlb(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12, json = null, bin = null;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    else if (type === 0x004e4942 && !bin) bin = { start, len };
    off = start + len;
  }
  return { json, bin, buf };
}

function accessor(g, idx) {
  const a = g.json.accessors[idx], bv = g.json.bufferViews[a.bufferView];
  const T = COMP[a.componentType], n = NCOMP[a.type], es = T.BYTES_PER_ELEMENT * n;
  const base = g.bin.start + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || es;
  let out;
  if (stride === es && base % T.BYTES_PER_ELEMENT === 0) out = new T(g.buf, base, a.count * n);
  else {
    out = new T(a.count * n);
    const src = new Uint8Array(g.buf), dst = new Uint8Array(out.buffer);
    for (let i = 0; i < a.count; i++) dst.set(src.subarray(base + i * stride, base + i * stride + es), i * es);
  }
  if (a.normalized && NORM[a.componentType] && T !== Float32Array) {
    const f = new Float32Array(out.length); for (let i = 0; i < f.length; i++) f[i] = Math.max(out[i] / NORM[a.componentType], -1); out = f;
  }
  return out;
}

async function decodeImage(g, i) {
  const im = g.json.images[i], bv = g.json.bufferViews[im.bufferView];
  const blob = new Blob([new Uint8Array(g.buf, g.bin.start + (bv.byteOffset || 0), bv.byteLength)], { type: im.mimeType || 'image/png' });
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  const d = x.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer), srgb: true };
}

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function trs(n) {
  if (n.matrix) return Float64Array.from(n.matrix);
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], [tx, ty, tz] = n.translation || [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return Float64Array.of((1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, tx, ty, tz, 1);
}
function mul(a, b) { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; }

// returns { stats, camera:{world,yfov,znear,zfar}|null, bounds:{min,max} }
export async function loadGlbInto(backend, buf, { onProgress = () => {}, concurrency = 8 } = {}) {
  const g = parseGlb(buf), j = g.json;
  const stats = { nodes: 0, instances: 0, meshes: 0, materials: 0, textures: 0, tris: 0, point_lights: 0 };

  // textures (decoded once per image, shared by materials via the same decoded bytes)
  const imgs = new Map();
  const needed = new Set();
  for (const m of j.materials || []) { const t = m.pbrMetallicRoughness?.baseColorTexture; if (t) needed.add(j.textures[t.index].source); }
  const queue = [...needed]; let done = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) { const i = queue.pop(); imgs.set(i, await decodeImage(g, i)); onProgress(`textures ${++done}/${needed.size}`); }
  }));
  stats.textures = needed.size;

  const mats = (j.materials || []).map((m) => {
    const p = m.pbrMetallicRoughness || {}, t = p.baseColorTexture;
    const textures = t ? { map: imgs.get(j.textures[t.index].source) } : null;
    stats.materials++;
    return backend.createMaterial({
      color: (p.baseColorFactor || [1, 1, 1, 1]).slice(0, 3), opacity: (p.baseColorFactor || [1, 1, 1, 1])[3],
      metalness: p.metallicFactor ?? 1, roughness: p.roughnessFactor ?? 1, emissive: m.emissiveFactor || [0, 0, 0],
      alphaTest: m.alphaMode === 'MASK' ? (m.alphaCutoff ?? 0.5) : 0,
    }, textures);
  });
  const defMat = backend.createMaterial({ color: [0.8, 0.8, 0.8], roughness: 0.9, metalness: 0 });

  const meshCache = new Map(); // glTF mesh index → [{ mesh, material }]
  const meshPrims = (mi) => {
    if (meshCache.has(mi)) return meshCache.get(mi);
    const out = [];
    for (const p of j.meshes[mi].primitives) {
      if ((p.mode ?? 4) !== 4 || p.attributes.POSITION === undefined) continue;
      const positions = accessor(g, p.attributes.POSITION);
      const indices = p.indices !== undefined ? accessor(g, p.indices) : undefined;
      const arrays = { positions, normals: p.attributes.NORMAL !== undefined ? accessor(g, p.attributes.NORMAL) : undefined,
        uvs: p.attributes.TEXCOORD_0 !== undefined ? accessor(g, p.attributes.TEXCOORD_0) : undefined, indices };
      const mesh = backend.createMesh(arrays);
      stats.meshes++; stats.tris += (indices ? indices.length : positions.length / 3) / 3;
      const acc = j.accessors[p.attributes.POSITION];
      out.push({ mesh, material: p.material !== undefined ? mats[p.material] : defMat, min: acc.min, max: acc.max });
    }
    meshCache.set(mi, out); return out;
  };

  const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
  let camera = null; const sunLights = []; const lights = j.extensions?.KHR_lights_punctual?.lights || [];
  const walk = (ni, parent, parentWorld) => {
    const n = j.nodes[ni]; stats.nodes++;
    const local = trs(n), world = parentWorld ? mul(parentWorld, local) : local;
    const id = backend.createNode(local, parent);
    if (n.mesh !== undefined) for (const pr of meshPrims(n.mesh)) {
      backend.createInstance(pr.mesh, pr.material, I4(), { parent: id }); stats.instances++;
      if (pr.min && pr.max) for (let c = 0; c < 8; c++) {
        const v = [c & 1 ? pr.max[0] : pr.min[0], c & 2 ? pr.max[1] : pr.min[1], c & 4 ? pr.max[2] : pr.min[2]];
        for (let k = 0; k < 3; k++) { const w = world[k] * v[0] + world[4 + k] * v[1] + world[8 + k] * v[2] + world[12 + k]; bmin[k] = Math.min(bmin[k], w); bmax[k] = Math.max(bmax[k], w); }
      }
    }
    if (n.camera !== undefined && !camera) { const c = j.cameras[n.camera].perspective; camera = { world, yfov: c.yfov, znear: c.znear, zfar: c.zfar || 0 }; }
    const li = n.extensions?.KHR_lights_punctual?.light;
    if (li !== undefined) {
      const L = lights[li];
      if (L.type === 'directional') backend.setSun({ direction: [world[8], world[9], world[10]], color: L.color || [1, 1, 1], intensity: L.intensity ?? 1 }); // light looks down -Z → toward-light = +Z
      else if (L.type === 'point') { backend.addPointLight({ position: [world[12], world[13], world[14]], color: L.color || [1, 1, 1], intensity: L.intensity ?? 1, distance: L.range || 0 }); stats.point_lights++; }
    }
    for (const c of n.children || []) walk(c, id, world);
  };
  for (const r of j.scenes[j.scene ?? 0].nodes) walk(r, 0, null);
  return { stats, camera, bounds: { min: bmin, max: bmax } };
}

// column-major view (world→camera) from camera-to-world matrix, and GL perspective
export function perspectiveGL(yfov, aspect, near, far) {
  const f = 1 / Math.tan(yfov / 2), m = new Float64Array(16);
  m[0] = f / aspect; m[5] = f;
  if (far > 0) { m[10] = (far + near) / (near - far); m[14] = 2 * far * near / (near - far); } else { m[10] = -1; m[14] = -2 * near; }
  m[11] = -1; return m;
}
