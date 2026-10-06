#!/usr/bin/env node
// scene-export — engine-generic static-scene exporter: source .glb + manifest -> clean static glTF 2.0 .glb.
//   node tools/scene-export/export.mjs <manifest.json> [-o out.glb] [--stats stats.json]
// Manifest (game-supplied; paths relative to the manifest file; no game knowledge lives in this tool):
//   { input: "world.glb", output?: "out.glb",
//     include?: { roots?: [node names], },            // scene-root node names to keep (default: all)
//     exclude?: { skinned?: true, nodes?: [regex], materials?: [regex] },
//     keepTexCoord1?: true,                           // keep TEXCOORD_1 (lightmap UV) when present
//     materialFlags?: [{ name?: regex, extras?: {key: regex}, set: {blend:'alpha'|'additive'|'subtractive', unlit, depthWrite, renderOrder, castShadow} }],
//     sun?: { direction:[x,y,z] (travel, glTF basis) | rotationDeg:[pitch,yaw] (+pitch = from above) + basisFlip?:[1,1,-1], color:[r,g,b], intensity },
//     pointLights?: [{ name, position:[x,y,z], color:[r,g,b], intensity, range }],
//     camera?: { name, position:[x,y,z], yawDeg, pitchDeg, fovYDeg, near, far },
//     skinned?: { nodes?: regex (skinned node names, default '^skinned:'), clip?: regex (animation name; default = first clip
//                 whose name starts with the node's character id), maxCharacters? } }   // -> glTF skins + ONE merged animation
// Output contract: POSITION/NORMAL/TEXCOORD_0 (+TANGENT/TEXCOORD_1/COLOR_0 if present) · u32 indices · PBR MR materials ·
// PNG textures (DDS decoded) · node transforms · KHR_lights_punctual · one camera node. Skins + one animation ONLY when manifest.skinned.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeDds, encodePng } from './dds.mjs';

const CT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGlb(path) {
  const b = readFileSync(path);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + path);
  let o = 12, json = null, bin = null;
  while (o < b.length) { const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4), d = b.subarray(o + 8, o + 8 + len); if (type === 0x4e4f534a) json = JSON.parse(d.toString('utf8')); else if (type === 0x004e4942 && !bin) bin = d; o += 8 + len; }
  return { json, bin };
}

// accessor -> tightly packed typed array (honours byteStride, sparse unsupported -> error, normalized ints -> float)
function readAccessor(gltf, bin, idx, asFloat = false) {
  const a = gltf.accessors[idx]; if (a.sparse) throw new Error('sparse accessor unsupported');
  const [T, sz] = CT[a.componentType], n = NCOMP[a.type], out = new T(a.count * n);
  if (a.bufferView === undefined) return out;
  const bv = gltf.bufferViews[a.bufferView], stride = bv.byteStride || sz * n, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.length);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
  for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = dv[get](base + i * stride + c * sz, true);
  if (asFloat && T !== Float32Array) { const f = new Float32Array(out.length); const d = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] : 1; for (let i = 0; i < out.length; i++) f[i] = Math.max(out[i] / d, -1); return f; }
  return out;
}

function genNormals(pos, idx) {
  const nrm = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { nrm[i] += nx; nrm[i + 1] += ny; nrm[i + 2] += nz; }
  }
  for (let i = 0; i < nrm.length; i += 3) { const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1; nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l; }
  return nrm;
}

const quatFromYawPitch = (yaw, pitch) => { // yaw about +Y, then pitch about local X; camera looks down -Z
  const [cy, sy, cp, sp] = [Math.cos(yaw / 2), Math.sin(yaw / 2), Math.cos(pitch / 2), Math.sin(pitch / 2)];
  return [cy * sp, sy * cp, -sy * sp, cy * cp]; // q = qY * qX
};
const quatFromDir = (d) => { // rotate -Z onto direction d
  const l = Math.hypot(...d), v = d.map(x => x / l), f = [0, 0, -1];
  const dot = f[0] * v[0] + f[1] * v[1] + f[2] * v[2];
  if (dot < -0.999999) return [0, 1, 0, 0];
  const c = [f[1] * v[2] - f[2] * v[1], f[2] * v[0] - f[0] * v[2], f[0] * v[1] - f[1] * v[0]], w = 1 + dot, n = Math.hypot(c[0], c[1], c[2], w);
  return [c[0] / n, c[1] / n, c[2] / n, w / n];
};

export function exportScene(manifest, baseDir = '.') {
  const { json: src, bin } = readGlb(resolve(baseDir, manifest.input));
  const ex = manifest.exclude ?? {}, inc = manifest.include ?? {};
  const nodeEx = (ex.nodes ?? []).map(r => new RegExp(r)), matEx = (ex.materials ?? []).map(r => new RegExp(r));
  const skipSkinned = ex.skinned !== false;
  const stats = { warnings: [], skippedPrimitives: { skinned: 0, material: 0, noPosition: 0, nonTriangles: 0 }, generatedNormals: 0, droppedNodes: 0 };

  // output builders
  const outNodes = [], outMeshes = [], outMaterials = [], outTextures = [], outImages = [], accessors = [], bufferViews = [], chunks = [];
  let binLen = 0;
  const addView = (data, target) => { const pad = (4 - (binLen % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; } const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength); chunks.push(buf); bufferViews.push({ buffer: 0, byteOffset: binLen, byteLength: buf.length, ...(target ? { target } : {}) }); binLen += buf.length; return bufferViews.length - 1; };
  const addAcc = (arr, componentType, type, target, minmax) => { const a = { bufferView: addView(arr, target), componentType, count: arr.length / NCOMP[type], type }; if (minmax) { const n = NCOMP[type], mn = Array(n).fill(Infinity), mx = Array(n).fill(-Infinity); for (let i = 0; i < arr.length; i++) { const c = i % n; if (arr[i] < mn[c]) mn[c] = arr[i]; if (arr[i] > mx[c]) mx[c] = arr[i]; } a.min = mn; a.max = mx; } accessors.push(a); return accessors.length - 1; };

  // images/textures: DDS -> PNG, dedup by content hash
  const imgMap = new Map(), texMap = new Map(), imgByHash = new Map();
  const mapImage = (si) => {
    if (imgMap.has(si)) return imgMap.get(si);
    const im = src.images[si]; let data, mime = im.mimeType, w = 0, h = 0;
    const raw = im.bufferView !== undefined ? (() => { const bv = src.bufferViews[im.bufferView]; return bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength); })() : null;
    if (!raw) { stats.warnings.push(`image ${si}: external uri kept`); outImages.push({ uri: im.uri, name: im.name }); imgMap.set(si, outImages.length - 1); return outImages.length - 1; }
    if (mime === 'image/vnd-ms.dds' || raw.toString('latin1', 0, 4) === 'DDS ') {
      try { const d = decodeDds(raw); data = encodePng(d.width, d.height, d.rgba); mime = 'image/png'; w = d.width; h = d.height; stats.ddsDecoded = (stats.ddsDecoded ?? 0) + 1; }
      catch (e) { stats.warnings.push(`image ${si} (${im.name}): ${e.message} -> 1x1 magenta placeholder`); data = encodePng(1, 1, Buffer.from([255, 0, 255, 255])); mime = 'image/png'; stats.imagePlaceholders = (stats.imagePlaceholders ?? 0) + 1; }
    } else data = Buffer.from(raw);
    const hash = createHash('sha1').update(data).digest('hex');
    if (imgByHash.has(hash)) { imgMap.set(si, imgByHash.get(hash)); stats.imagesDeduped = (stats.imagesDeduped ?? 0) + 1; return imgByHash.get(hash); }
    outImages.push({ name: im.name, mimeType: mime, bufferView: addView(new Uint8Array(data.buffer, data.byteOffset, data.length)) });
    imgMap.set(si, outImages.length - 1); imgByHash.set(hash, outImages.length - 1); return outImages.length - 1;
  };
  const mapTexture = (ti) => {
    if (texMap.has(ti)) return texMap.get(ti);
    const t = src.textures[ti], source = t.source ?? t.extensions?.MSFT_texture_dds?.source ?? t.extensions?.KHR_texture_basisu?.source;
    outTextures.push({ ...(t.sampler !== undefined ? { sampler: 0 } : {}), source: mapImage(source) });
    texMap.set(ti, outTextures.length - 1); return outTextures.length - 1;
  };
  const remapTexInfo = (ti) => ti ? { ...ti, index: mapTexture(ti.index) } : ti;
  // manifest.materialFlags: [{ name?: regex, extras?: {key: regex} , set: {blend, unlit, depthWrite, renderOrder, castShadow} }]
  // → material.extras.gaia (engine render flags). Rules apply in order, later keys win. Game knowledge lives in the manifest only.
  const flagRules = (manifest.materialFlags ?? []).map(r => ({ name: r.name && new RegExp(r.name), extras: Object.entries(r.extras ?? {}).map(([k, v]) => [k, new RegExp(v)]), set: r.set }));
  const materialFlagsFor = (m) => { let out = null;
    for (const r of flagRules) {
      if (r.name && !r.name.test(m.name ?? '')) continue;
      if (!r.extras.every(([k, re]) => m.extras?.[k] !== undefined && re.test(String(m.extras[k])))) continue;
      out = { ...(out ?? {}), ...r.set };
    }
    return out; };
  const matMap = new Map();
  const mapMaterial = (mi) => {
    if (mi === undefined) return undefined;
    if (matMap.has(mi)) return matMap.get(mi);
    const m = structuredClone(src.materials[mi]);
    if (m.pbrMetallicRoughness) { const p = m.pbrMetallicRoughness; p.baseColorTexture = remapTexInfo(p.baseColorTexture); p.metallicRoughnessTexture = remapTexInfo(p.metallicRoughnessTexture); for (const k of ['baseColorTexture', 'metallicRoughnessTexture']) if (!p[k]) delete p[k]; }
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) if (m[k]) m[k] = remapTexInfo(m[k]);
    if (m.extensions) { delete m.extensions.MSFT_texture_dds; if (!Object.keys(m.extensions).length) delete m.extensions; }
    const lm = m.extras?.lightmap; if (lm && lm.texture !== undefined) lm.texture = mapTexture(lm.texture);
    const fl = materialFlagsFor(m); if (fl) { (m.extras ??= {}).gaia = fl; stats.flaggedMaterials = (stats.flaggedMaterials ?? 0) + 1; }
    outMaterials.push(m); matMap.set(mi, outMaterials.length - 1); return outMaterials.length - 1;
  };

  // meshes: filter primitives, repack
  const meshMap = new Map();
  const mapMesh = (mi, skinned = false) => {
const key = skinned ? mi + ':s' : mi;
if (meshMap.has(key)) return meshMap.get(key);
    const sm = src.meshes[mi], prims = [];
    for (const p of sm.primitives) {
      const at = p.attributes;
      if (at.POSITION === undefined) { stats.skippedPrimitives.noPosition++; continue; }
      if ((p.mode ?? 4) !== 4) { stats.skippedPrimitives.nonTriangles++; continue; }
      if (skinned ? (at.JOINTS_0 === undefined || at.WEIGHTS_0 === undefined) : (skipSkinned && at.JOINTS_0 !== undefined)) { stats.skippedPrimitives.skinned++; continue; }
      const mat = p.material !== undefined ? src.materials[p.material] : null;
      if (mat && matEx.some(r => r.test(mat.name ?? ''))) { stats.skippedPrimitives.material++; continue; }
      const pos = readAccessor(src, bin, at.POSITION, true);
      let idx = p.indices !== undefined ? readAccessor(src, bin, p.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      if (!(idx instanceof Uint32Array)) idx = Uint32Array.from(idx);
      const attrs = { POSITION: addAcc(pos, 5126, 'VEC3', 34962, true) };
      let nrm; if (at.NORMAL !== undefined) nrm = readAccessor(src, bin, at.NORMAL, true); else { nrm = genNormals(pos, idx); stats.generatedNormals++; }
      attrs.NORMAL = addAcc(nrm, 5126, 'VEC3', 34962);
      if (at.TEXCOORD_0 !== undefined) attrs.TEXCOORD_0 = addAcc(readAccessor(src, bin, at.TEXCOORD_0, true), 5126, 'VEC2', 34962);
      if (at.TANGENT !== undefined) attrs.TANGENT = addAcc(readAccessor(src, bin, at.TANGENT, true), 5126, 'VEC4', 34962);
      if (manifest.keepTexCoord1 && at.TEXCOORD_1 !== undefined) attrs.TEXCOORD_1 = addAcc(readAccessor(src, bin, at.TEXCOORD_1, true), 5126, 'VEC2', 34962);
      if (skinned) { attrs.JOINTS_0 = addAcc(Uint16Array.from(readAccessor(src, bin, at.JOINTS_0)), 5123, 'VEC4', 34962); attrs.WEIGHTS_0 = addAcc(readAccessor(src, bin, at.WEIGHTS_0, true), 5126, 'VEC4', 34962); stats.skinnedVertices = (stats.skinnedVertices ?? 0) + pos.length / 3; }
if (at.COLOR_0 !== undefined) { const ca = src.accessors[at.COLOR_0]; attrs.COLOR_0 = addAcc(readAccessor(src, bin, at.COLOR_0, true), 5126, ca.type, 34962); }
      const op = { attributes: attrs, indices: addAcc(idx, 5125, 'SCALAR', 34963), mode: 4 };
      const m = mapMaterial(p.material); if (m !== undefined) op.material = m;
      if (p.extras) op.extras = p.extras;
      stats.triangles = (stats.triangles ?? 0) + idx.length / 3; stats.vertices = (stats.vertices ?? 0) + pos.length / 3;
      prims.push(op);
    }
    if (!prims.length) { meshMap.set(key, -1); return -1; }
outMeshes.push({ name: sm.name, primitives: prims }); meshMap.set(key, outMeshes.length - 1); return outMeshes.length - 1;
  };

  // nodes: depth-first copy with pruning
  const copyNode = (ni) => {
    const n = src.nodes[ni];
    if ((skipSkinned && n.skin !== undefined) || nodeEx.some(r => r.test(n.name ?? ''))) { stats.droppedNodes++; return -1; }
    const kids = (n.children ?? []).map(copyNode).filter(c => c >= 0);
    let mesh; if (n.mesh !== undefined) { mesh = mapMesh(n.mesh); if (mesh < 0) mesh = undefined; }
    if (mesh === undefined && !kids.length) return -1;
    const o = {}; for (const k of ['name', 'matrix', 'translation', 'rotation', 'scale']) if (n[k] !== undefined) o[k] = n[k];
    if (mesh !== undefined) o.mesh = mesh; if (kids.length) o.children = kids; if (n.extras) o.extras = n.extras;
    outNodes.push(o); return outNodes.length - 1;
  };
  const roots = [];
  for (const r of src.scenes[src.scene ?? 0].nodes) {
    if (inc.roots && !inc.roots.includes(src.nodes[r].name)) continue;
    const c = copyNode(r); if (c >= 0) roots.push(c);
  }
  const staticMeshNodes = outNodes.length;
// skinned characters: skins + joint hierarchy (ancestors kept for their transforms) + ONE merged clip
const outSkins = [], outAnims = [];
if (manifest.skinned) {
const sk = manifest.skinned, want = new RegExp(sk.nodes ?? '^skinned:'), clipRe = sk.clip ? new RegExp(sk.clip) : null;
const par = new Map(); src.nodes.forEach((n, i) => (n.children ?? []).forEach(c => par.set(c, i)));
const jm = new Map();
const ensure = (ni) => { if (jm.has(ni)) return jm.get(ni); const n = src.nodes[ni], o = {}; for (const k of ['name', 'matrix', 'translation', 'rotation', 'scale']) if (n[k] !== undefined) o[k] = n[k]; outNodes.push(o); const i = outNodes.length - 1; jm.set(ni, i); const p = par.get(ni); if (p !== undefined) { const pi = ensure(p); (outNodes[pi].children ??= []).push(i); } else roots.push(i); return i; };
const ch = [], samplers = []; const usedClips = new Set(); let chars = 0;
for (const ni of src.nodes.keys()) {
const n = src.nodes[ni]; if (n.skin === undefined || n.mesh === undefined || !want.test(n.name ?? '')) continue;
if (sk.maxCharacters && chars >= sk.maxCharacters) break;
const mesh = mapMesh(n.mesh, true); if (mesh < 0) continue;
const s = src.skins[n.skin], joints = s.joints.map(ensure);
const skin = { name: n.name, joints, ...(s.skeleton !== undefined ? { skeleton: ensure(s.skeleton) } : {}) };
if (s.inverseBindMatrices !== undefined) skin.inverseBindMatrices = addAcc(readAccessor(src, bin, s.inverseBindMatrices, true), 5126, 'MAT4');
outSkins.push(skin); chars++;
const o = { name: n.name, mesh, skin: outSkins.length - 1 }; if (n.extras) o.extras = n.extras;
const pi = par.get(ni), po = pi !== undefined ? ensure(pi) : -1; outNodes.push(o); const oi = outNodes.length - 1; if (po >= 0) (outNodes[po].children ??= []).push(oi); else roots.push(oi);
const id = n.extras?.character ?? (n.name ?? '').replace(/^skinned:/, '');
const jointSet = new Set(s.joints);
const ok = (a) => (clipRe ? clipRe.test(a.name ?? '') : true) && a.channels.some(c => jointSet.has(c.target.node));
const clip = (src.animations ?? []).find(a => (a.name ?? '').startsWith(id + '/') && ok(a)) ?? (src.animations ?? []).find(ok);
if (!clip || usedClips.has(clip)) continue; usedClips.add(clip);
const sm = new Map();
for (const c of clip.channels) {
if (!jm.has(c.target.node) || c.target.path === 'weights') continue;
if (!sm.has(c.sampler)) { const sp = clip.samplers[c.sampler], out = src.accessors[sp.output]; samplers.push({ input: addAcc(readAccessor(src, bin, sp.input, true), 5126, 'SCALAR', undefined, true), output: addAcc(readAccessor(src, bin, sp.output, true), 5126, out.type), interpolation: sp.interpolation ?? 'LINEAR' }); sm.set(c.sampler, samplers.length - 1); }
ch.push({ sampler: sm.get(c.sampler), target: { node: jm.get(c.target.node), path: c.target.path } });
}
(stats.clips ??= []).push(`${n.name} <- ${clip.name}`);
}
if (ch.length) outAnims.push({ name: 'skinned-characters', channels: ch, samplers });
Object.assign(stats, { skins: outSkins.length, joints: outSkins.reduce((a, s) => a + s.joints.length, 0), animChannels: ch.length });
}

  // lights + camera
  const lights = [];
  const extUsed = [];
  if (manifest.sun) {
    const s = manifest.sun; let dir = s.direction;
    if (!dir && s.rotationDeg) { // [pitch,yaw] deg → light TRAVEL dir = Ry(yaw)·Rx(pitch)·(0,0,1) in the SOURCE basis, then × s.basisFlip (default [1,1,-1]: source +Z → glTF -Z)
      const [p, y] = s.rotationDeg.map(d => d * Math.PI / 180), f = s.basisFlip ?? [1, 1, -1];
      dir = [Math.sin(y) * Math.cos(p) * f[0], -Math.sin(p) * f[1], Math.cos(y) * Math.cos(p) * f[2]];
    }
    if (dir[1] > 0) (stats.warnings ??= []).push(`sun '${s.name ?? 'sun'}' travels UP (dir.y=${(dir[1] / Math.hypot(...dir)).toFixed(3)}) → lights only undersides; check the source row`);
    lights.push({ type: 'directional', name: s.name ?? 'sun', color: s.color ?? [1, 1, 1], intensity: s.intensity ?? 3 });
    outNodes.push({ name: s.name ?? 'sun', rotation: quatFromDir(dir), extensions: { KHR_lights_punctual: { light: lights.length - 1 } } }); roots.push(outNodes.length - 1);
  }
  for (const pl of manifest.pointLights ?? []) {
    lights.push({ type: 'point', name: pl.name, color: pl.color ?? [1, 1, 1], intensity: pl.intensity ?? 10, ...(pl.range ? { range: pl.range } : {}) });
    outNodes.push({ name: pl.name, translation: pl.position, extensions: { KHR_lights_punctual: { light: lights.length - 1 } } }); roots.push(outNodes.length - 1);
  }
  const cameras = [];
  if (manifest.camera) {
    const c = manifest.camera; cameras.push({ type: 'perspective', name: c.name ?? 'start', perspective: { yfov: (c.fovYDeg ?? 60) * Math.PI / 180, znear: c.near ?? 0.1, zfar: c.far ?? 1000 } });
    outNodes.push({ name: c.name ?? 'camera', translation: c.position, rotation: quatFromYawPitch((c.yawDeg ?? 0) * Math.PI / 180, (c.pitchDeg ?? 0) * Math.PI / 180), camera: 0 }); roots.push(outNodes.length - 1);
  }

  const gltf = {
    asset: { version: '2.0', generator: 'gaia-world-engine tools/scene-export' },
    scene: 0, scenes: [{ nodes: roots }], nodes: outNodes, meshes: outMeshes, materials: outMaterials,
    ...(outTextures.length ? { textures: outTextures, images: outImages, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
    accessors, bufferViews, buffers: [{ byteLength: 0 }],
    ...(cameras.length ? { cameras } : {}),
...(outSkins.length ? { skins: outSkins } : {}),
...(outAnims.length ? { animations: outAnims } : {}),
};
  if (lights.length) { gltf.extensionsUsed = ['KHR_lights_punctual']; gltf.extensions = { KHR_lights_punctual: { lights } }; }
  const pad = (4 - (binLen % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); binLen += pad; }
  gltf.buffers[0].byteLength = binLen;
  const binBuf = Buffer.concat(chunks);
  let js = Buffer.from(JSON.stringify(gltf), 'utf8'); const jp = (4 - (js.length % 4)) % 4; js = Buffer.concat([js, Buffer.alloc(jp, 0x20)]);
  const head = Buffer.alloc(12 + 8); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binBuf.length, 8); head.writeUInt32LE(js.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binBuf.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([head, js, bh, binBuf]);
  Object.assign(stats, { nodes: outNodes.length, meshes: outMeshes.length, primitives: outMeshes.reduce((s, m) => s + m.primitives.length, 0), materials: outMaterials.length, textures: outTextures.length, images: outImages.length, lights: lights.length, cameras: cameras.length, bytes: glb.length, staticMeshNodes });
  return { glb, gltf, stats };
}

// structural self-check of an output GLB (used by tests and as validator fallback)
export function selfCheck(glbBuf, { allowSkins = false } = {}) {
  const errs = [], b = glbBuf;
  if (b.readUInt32LE(0) !== 0x46546c67 || b.readUInt32LE(4) !== 2) errs.push('bad header'); if (b.readUInt32LE(8) !== b.length) errs.push('length mismatch');
  const jl = b.readUInt32LE(12), j = JSON.parse(b.toString('utf8', 20, 20 + jl)), bl = b.readUInt32LE(20 + jl), bin = b.subarray(28 + jl, 28 + jl + bl);
  if (jl % 4 || bl % 4) errs.push('chunk alignment'); if (j.buffers[0].byteLength !== bl) errs.push('buffer length != BIN chunk');
  j.bufferViews.forEach((v, i) => { if (v.byteOffset + v.byteLength > bl) errs.push(`bufferView ${i} out of range`); });
  j.accessors.forEach((a, i) => { const v = j.bufferViews[a.bufferView], need = a.count * NCOMP[a.type] * CT[a.componentType][1]; if (!v || need > v.byteLength) errs.push(`accessor ${i} overflow`); if ((v.byteOffset ?? 0) % 4) errs.push(`bufferView ${a.bufferView} unaligned`); });
  const nA = j.accessors.length, nM = (j.materials ?? []).length, nT = (j.textures ?? []).length, nI = (j.images ?? []).length;
  for (const [mi, m] of j.meshes.entries()) for (const p of m.primitives) {
    const vc = j.accessors[p.attributes.POSITION].count;
    for (const [k, a] of Object.entries(p.attributes)) { if (a >= nA) errs.push(`mesh ${mi} ${k} accessor oob`); else if (j.accessors[a].count !== vc) errs.push(`mesh ${mi} ${k} count mismatch`); }
    if (p.attributes.NORMAL === undefined) errs.push(`mesh ${mi} no NORMAL`);
    const ia = j.accessors[p.indices]; if (ia.componentType !== 5125) errs.push(`mesh ${mi} indices not u32`); if (ia.count % 3) errs.push(`mesh ${mi} index count % 3`);
    const idx = new Uint32Array(bin.buffer.slice(bin.byteOffset + j.bufferViews[ia.bufferView].byteOffset, bin.byteOffset + j.bufferViews[ia.bufferView].byteOffset + ia.count * 4)); for (let i = 0; i < idx.length; i++) if (idx[i] >= vc) { errs.push(`mesh ${mi} index >= vertexCount`); break; }
    if (p.material !== undefined && p.material >= nM) errs.push(`mesh ${mi} material oob`);
  }
  for (const [i, m] of (j.materials ?? []).entries()) { const t = m.pbrMetallicRoughness?.baseColorTexture; if (t && t.index >= nT) errs.push(`material ${i} texture oob`); }
  for (const t of j.textures ?? []) if (t.source >= nI) errs.push('texture source oob');
  for (const [i, im] of (j.images ?? []).entries()) { if (im.bufferView !== undefined) { const v = j.bufferViews[im.bufferView]; const sig = bin.subarray(v.byteOffset, v.byteOffset + 4).toString('latin1'); if (im.mimeType === 'image/png' && sig.slice(1) !== 'PNG') errs.push(`image ${i} not PNG`); } }
  j.nodes.forEach((n, i) => { for (const c of n.children ?? []) if (c >= j.nodes.length) errs.push(`node ${i} child oob`); if (n.mesh !== undefined && n.mesh >= j.meshes.length) errs.push(`node ${i} mesh oob`); });
  const lights = j.extensions?.KHR_lights_punctual?.lights ?? []; j.nodes.forEach((n, i) => { const l = n.extensions?.KHR_lights_punctual?.light; if (l !== undefined && l >= lights.length) errs.push(`node ${i} light oob`); });
  if (!allowSkins && (j.skins || j.animations)) errs.push('skins/animations present in static output');
  const camNodes = j.nodes.filter(n => n.camera !== undefined).length; if (camNodes > 1) errs.push('more than one camera node');
  return { ok: !errs.length, errors: errs.slice(0, 20), errorCount: errs.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2); const mpath = args.find(a => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '-o' && args[args.indexOf(a) - 1] !== '--stats');
  if (!mpath) { console.error('usage: export.mjs <manifest.json> [-o out.glb] [--stats stats.json]'); process.exit(2); }
  const mp = resolve(mpath), manifest = JSON.parse(readFileSync(mp, 'utf8')), base = dirname(mp);
  const oi = args.indexOf('-o'), out = oi >= 0 ? resolve(args[oi + 1]) : resolve(base, manifest.output ?? 'scene.glb');
  const t0 = Date.now(); const { glb, stats } = exportScene(manifest, base); const chk = selfCheck(glb, { allowSkins: !!manifest.skinned });
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, glb);
  stats.ms = Date.now() - t0; stats.selfCheck = chk; stats.output = out;
  const si = args.indexOf('--stats'); if (si >= 0) writeFileSync(resolve(args[si + 1]), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify({ ...stats, warnings: stats.warnings.slice(0, 5), warningCount: stats.warnings.length }, null, 1));
  process.exit(chk.ok ? 0 : 1);
}
