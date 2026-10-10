// render-api/interface.js — the renderer contract. PLAIN JS, NO three IMPORTS.
//
// Everything crossing this boundary is data: numbers, strings, plain objects, typed arrays — so the
// same calls can be marshalled into wasm or a native (Rust/wgpu) process. Backends hand back opaque
// integer handles (>0); 0 = none/world root. Matrices are column-major 16-number arrays (Float32Array
// or Float64Array; three + wgpu both use this layout). Right-handed, +Y up, metres, radians.
//
// Handle kinds: MeshId (geometry) · MaterialId · NodeId (group or instance) · LightId.
//
// § methods (all sync, all data-only):
//   createMesh({ positions:Float32Array(3n), normals?:Float32Array(3n), uvs?:Float32Array(2n), indices?:Uint16Array|Uint32Array }) → MeshId
//   destroyMesh(MeshId)
//   createMaterial(params, textures?) → MaterialId
//       params   = { color, roughness, metalness, emissive, emissiveIntensity, opacity, flatShading, doubleSide,
//                    fog, preset?:string, …preset params }  (color = '#rrggbb' | 0xrrggbb | [r,g,b] 0..1)
//                  `preset` = NAME of a procedural look; the backend implements it by name or degrades to pbr.
//       textures = { map?: TextureData, normalMap?, roughnessMap?, … }  TextureData = { width, height, data:Uint8Array(rgba) , srgb?:bool }
//   destroyMaterial(MaterialId)
//   createNode(mat4, parent=0) → NodeId          (pure transform group)
//   createInstance(MeshId, MaterialId, mat4, flags?) → NodeId
//       flags = { parent:NodeId, castShadow, receiveShadow, visible, renderOrder, euler?:[x,y,z] (XYZ authoring rotation hint),
//                 tags?:{[k]:string|number|boolean} (opaque metadata — picking/solid/sky),
//                 groups?: { bits?:int[] | words?:Uint32Array, parent?:NodeId } (visibility groups; see setActiveGroups) }
//   updateNode(NodeId, { mat4?, visible?, castShadow?, receiveShadow?, renderOrder?, material?:MaterialId, euler?, groups?:{bits|words,parent?}|null })
//   removeNode(NodeId)                              (instances + groups; detaches + frees backend-owned resources)
//   setCamera(view:mat4, proj:mat4)
//   setSun({ direction:[x,y,z] (toward the light), color:[r,g,b], intensity, castShadow }) → LightId
//   addPointLight({ position:[x,y,z], color:[r,g,b], intensity, distance, decay? }) → LightId
//   updatePointLight(LightId, partial) ; removeLight(LightId)
//   renderFrame(dt)
//   resize(renderHeight)    // internal render height in px; width follows the output aspect
//   dispose()
// plus read-only: name (string), apiVersion (number), capabilities (string[]).

export const RENDER_API_VERSION = 1;

export const RENDER_API_METHODS = Object.freeze([
  'createMesh', 'destroyMesh', 'createMaterial', 'destroyMaterial',
  'createNode', 'createInstance', 'updateNode', 'removeNode',
  'setCamera', 'setSun', 'addPointLight', 'updatePointLight', 'removeLight',
  'renderFrame', 'resize', 'dispose',
]);

// OPTIONAL (scene-adapter uses them when present, else degrades loudly via adapter.stats.degraded):
//   updateMesh(MeshId, arrays) · updateMaterial(MaterialId, params, textures) · createInstanced(MeshId, MaterialId, mat4s:Float32Array(16n), count, flags{...,matrix}) → NodeId
//   updateInstances(NodeId, mat4s, count, matrixWorld) · createShaderMaterial(pkg from tsl-export.js: {vertex,fragment,bindGroups,attributes,…}) → MaterialId
//   setShaderUniforms(MaterialId, [{key,value}]) — r4: changed live TSL uniform values (tsl-export pkg.live.update()); keys = package uniform `key`
//   setShaderUniformsBatch([[MaterialId, [{key,value}]]]) - r10-5: setShaderUniforms for many materials in ONE call (values shared across materials shipped once); optional
//   setActiveGroups(active: int[] bit indices | {bits?:int[], words?:Uint32Array} | null) — visibility groups: instance drawn iff its group mask ∩ active ≠ ∅; no groups = always drawn;
//     instance with groups.parent follows that node's mask; null = culling off (default). Applies to main AND shadow passes. Bit b of word w = group 32w+b (128+ groups ok).
export const RENDER_API_OPTIONAL_METHODS = Object.freeze(['updateMesh', 'updateMaterial', 'createInstanced', 'updateInstances', 'setInstanceUvs', 'createShaderMaterial', 'setShaderUniforms', 'setShaderUniformsBatch', 'updateShaderBuffers', 'setMeshAttribute', 'createSkin', 'updateSkin', 'createSkinnedMesh', 'destroySkin', 'destroySkinnedMesh', 'setAmbient', 'setBackground', 'setGiProbes', 'giComputeInit', 'giComputeVoxels', 'giComputeStep', 'giComputeDestroy', 'giComputeStats', 'giComputeError', 'setBackgroundTexture', 'setFog', 'setToneMapping', 'setExposure', 'setBloom', 'setColorGrade', 'setGtao', 'setAutoExposure', 'autoExposureGrid', 'setEnvironment', 'setActiveGroups']);
export function assertRenderBackend(backend) {
  const missing = RENDER_API_METHODS.filter((m) => typeof backend?.[m] !== 'function');
  if (missing.length) throw new Error(`render backend missing: ${missing.join(', ')}`);
  if (backend.apiVersion !== RENDER_API_VERSION) throw new Error(`render backend apiVersion ${backend.apiVersion} ≠ ${RENDER_API_VERSION}`);
  return backend;
}

const isNums = (a, n) => a != null && typeof a.length === 'number' && a.length === n && Array.prototype.every.call(a, Number.isFinite);
export const isMat4 = (m) => isNums(m, 16);

// throws on malformed geometry; returns the vertex count
export function validateMeshArrays(a) {
  if (!a?.positions || a.positions.length % 3 !== 0 || a.positions.length === 0) throw new Error('createMesh: positions must be a non-empty multiple of 3');
  const n = a.positions.length / 3;
  if (a.normals && a.normals.length !== n * 3) throw new Error('createMesh: normals length ≠ positions length');
  if (a.uvs && a.uvs.length !== n * 2) throw new Error('createMesh: uvs length ≠ 2 per vertex');
  if (a.indices) {
    if (a.indices.length % 3 !== 0) throw new Error('createMesh: indices must be triangles');
    for (let i = 0; i < a.indices.length; i++) if (a.indices[i] >= n) throw new Error(`createMesh: index ${a.indices[i]} ≥ vertex count ${n}`);
  }
  return n;
}

export const IDENTITY_MAT4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// TRS → column-major mat4. Euler is three's default 'XYZ' order, so the result equals
// THREE.Matrix4.compose(position, Quaternion.setFromEuler(rotation), scale) bit-for-bit (same formula).
// scale: number | [x,y,z]. `out` defaults to Float64Array so authoring doubles survive the crossing.
export function composeMat4({ position = [0, 0, 0], rotation = [0, 0, 0], scale = 1 } = {}, out = new Float64Array(16)) {
  const [ex, ey, ez] = rotation;
  const [sx, sy, sz] = Array.isArray(scale) ? scale : [scale, scale, scale];
  const c1 = Math.cos(ex / 2), c2 = Math.cos(ey / 2), c3 = Math.cos(ez / 2);
  const s1 = Math.sin(ex / 2), s2 = Math.sin(ey / 2), s3 = Math.sin(ez / 2);
  const x = s1 * c2 * c3 + c1 * s2 * s3;
  const y = c1 * s2 * c3 - s1 * c2 * s3;
  const z = c1 * c2 * s3 + s1 * s2 * c3;
  const w = c1 * c2 * c3 - s1 * s2 * s3;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}

// mat4 → { position, scale } (rotation stays in the matrix / euler hint). Mirrors three's Matrix4.decompose scale.
export function decomposeMat4(m) {
  let sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  if (det < 0) sx = -sx;
  return { position: [m[12], m[13], m[14]], scale: [sx, sy, sz] };
}

// visibility groups helpers (plain data; shared by backends)
export function bitsToWords(bits) {
  let n = 0; for (const b of bits) { if (!Number.isInteger(b) || b < 0) throw new Error(`visibility group bit ${b}: want a non-negative integer`); n = Math.max(n, (b >>> 5) + 1); }
  const w = new Uint32Array(n); for (const b of bits) w[b >>> 5] |= (1 << (b & 31)) >>> 0; return w;
}
// accepts: int[] (bit indices) | { bits?, words?, parent? } → { words:Uint32Array, parent?:NodeId }; bits and words are OR-ed
export function normalizeGroups(g) {
  const spec = Array.isArray(g) ? { bits: g } : g;
  const a = spec.words ? Uint32Array.from(spec.words) : new Uint32Array(0), b = spec.bits ? bitsToWords(spec.bits) : new Uint32Array(0);
  const w = new Uint32Array(Math.max(a.length, b.length)); for (let i = 0; i < w.length; i++) w[i] = ((a[i] ?? 0) | (b[i] ?? 0)) >>> 0;
  return spec.parent ? { words: w, parent: spec.parent } : { words: w };
}
