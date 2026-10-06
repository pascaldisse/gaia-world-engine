// render-api/material-map.js — three Material → render-api material description. NO three import (duck-typed).
//   MeshStandard/Physical/Basic/Lambert/Phong-ish → { kind:'pbr', params, textures, sig }  (createMaterial)
//   NodeMaterial (TSL)                           → { kind:'wgsl', package, fallbackParams, sig }  (createShaderMaterial; package from tsl-export.js)
// sig = cheap string compared every frame to detect edits that three's `version` counter does not cover (m.color.set(), m.opacity=…).
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
const rgb = (c) => (c ? [c.r, c.g, c.b] : [1, 1, 1]);
const nodeCache = new WeakMap(); // NodeMaterial → { version, package }

// ---- textures: ONE CPU read per (texture, version), lazy. textureData(t) returns a descriptor {width,height,srgb,key,data(getter)}:
//   key = `${uuid}:${version}` (backend caches GPU textures by it, refcounted); `data` is only touched on a backend cache MISS, so an idle frame
//   and every material sharing the texture cost 0 reads. Sources: Uint8 DataTexture as-is · canvas/ImageBitmap/HTMLImageElement/VideoFrame/ImageData
//   via ONE drawImage+getImageData (image-level WeakMap: texture clones sharing an ImageBitmap read it once; canvases are re-read only when texture.version moves).
const texCache = new WeakMap();   // Texture → { version, image, desc }
const pixelCache = new WeakMap(); // immutable image (ImageBitmap/HTMLImageElement/ImageData) → Uint8Array rgba
export const textureReads = { count: 0, ms: 0 }; // instrumentation: how many CPU pixel reads happened (proof: idle frame = 0)
let scratch = null;
const isBytes = (d) => d instanceof Uint8Array || d instanceof Uint8ClampedArray;
function drawable(im) {
  return (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && im instanceof HTMLImageElement) ||
    (typeof VideoFrame !== 'undefined' && im instanceof VideoFrame) || (typeof OffscreenCanvas !== 'undefined' && im instanceof OffscreenCanvas) || (typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement);
}
function readPixels(im, w, h) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  let out = null;
  if (isBytes(im.data) && im.data.length === w * h * 4) out = new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.length);
  else if (typeof ImageData !== 'undefined' && im instanceof ImageData) out = new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength);
  else if (typeof im.getContext === 'function' && !drawable(im)) { // duck-typed canvas (own 2d context): re-read only when texture.version moves
    const d = im.getContext('2d')?.getImageData(0, 0, w, h);
    if (d) out = new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.byteLength);
  } else if (drawable(im)) {
    const immutable = !(typeof HTMLCanvasElement !== 'undefined' && im instanceof HTMLCanvasElement) && !(typeof OffscreenCanvas !== 'undefined' && im instanceof OffscreenCanvas);
    if (immutable && pixelCache.has(im)) return pixelCache.get(im);
    if (!scratch) scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    const c = scratch.getContext('2d', { willReadFrequently: true });
    c.globalCompositeOperation = 'copy'; c.drawImage(im, 0, 0, w, h);
    out = new Uint8Array(c.getImageData(0, 0, w, h).data.buffer);
    if (immutable) pixelCache.set(im, out);
  }
  if (out) { textureReads.count++; textureReads.ms += (typeof performance !== 'undefined' ? performance.now() : 0) - t0; }
  return out;
}
function textureData(t) {
  const im = t?.image;
  if (!im) return null;
  const c = texCache.get(t);
  if (c && c.version === t.version && c.image === im) return c.desc;
  const w = im.width ?? im.videoWidth ?? im.displayWidth, h = im.height ?? im.videoHeight ?? im.displayHeight;
  const readable = isBytes(im.data) || drawable(im) || typeof im.getContext === 'function' || (typeof ImageData !== 'undefined' && im instanceof ImageData);
  if (!readable || !(w > 0 && h > 0)) return undefined; // present but not CPU-readable here
  let px; // lazy + memoised
  const desc = { width: w, height: h, srgb: t.colorSpace === 'srgb', key: `${t.uuid}:${t.version}`, get data() { return px ??= readPixels(im, w, h); } };
  texCache.set(t, { version: t.version, image: im, desc });
  return desc;
}
export function pbrParams(m) {
const kind = m.isMeshBasicMaterial || m.isMeshBasicNodeMaterial ? 'basic' : m.isMeshLambertMaterial ? 'lambert' : m.isMeshPhysicalMaterial ? 'physical' : 'standard';
const p = {
color: rgb(m.color), opacity: m.opacity ?? 1, transparent: !!m.transparent, doubleSide: m.side === 2, backSide: m.side === 1,
flatShading: !!m.flatShading, fog: m.fog !== false, wireframe: !!m.wireframe, depthWrite: m.depthWrite !== false, depthTest: m.depthTest !== false,
alphaTest: m.alphaTest ?? 0, visible: m.visible !== false,
roughness: kind === 'lambert' ? 1 : kind === 'basic' ? 1 : (m.roughness ?? 1), metalness: kind === 'standard' || kind === 'physical' ? (m.metalness ?? 0) : 0,
emissive: rgb(m.emissive ?? { r: 0, g: 0, b: 0 }), emissiveIntensity: m.emissiveIntensity ?? 1,
};
// r8: Basic = no lighting (three MeshBasic*Material). NOT for a NodeMaterial with custom *Node slots: its look comes from those nodes (TSL package path); the plain-PBR fallback of such a material stays lit (r6: flat white walls).
if (kind === 'basic' && !(m.isNodeMaterial && hasNodes(m))) { p.unlit = true; p.toneMapped = true; /* r8 MEASURED (r8-blend.html): three r180 WebGPURenderer with renderer.toneMapping set tone-maps EVERY canvas fragment, `material.toneMapped:false` white opaque reads 188 (= Reinhard(1) sRGB) not 255 → unlit stays tone-mapped in the core */ }
if (kind === 'physical') for (const k of ['clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'sheen', 'iridescence']) if (m[k]) p[k] = m[k];
if (m.userData?.preset) p.preset = m.userData.preset;
// r9: three's GI attach (kernel/gi/gi-attach.js isGIEligibleMaterial) only wires probe GI into Standard/Physical/Lambert *NodeMaterial*; a plain MeshStandardMaterial (GLTFLoader figure, skinned or not) is lit by the hemisphere light only → tell the core not to sample the probes for it.
if (!(m.isMeshStandardNodeMaterial || m.isMeshPhysicalNodeMaterial || m.isMeshLambertNodeMaterial)) p.noGi = true;
if (m.blending === 2) p.blending = 'additive';
return p;
}

const SLOT_SIG = (m) => { let s = ''; for (const slot of TEX_SLOTS) { const t = m[slot]; if (t) s += `|${slot}:${t.uuid}:${t.version}:${t.image ? 1 : 0}`; } return s; };
// cheap per-frame change signature (NO allocation of params/textures, NO pixel reads). conv.sig === materialSig(m) by construction.
export function materialSig(m, { exportNodeMaterial = null } = {}) {
  if (m.isNodeMaterial && exportNodeMaterial && customNode(m)) return `wgsl:${m.uuid}:${m.version}`;
  const c = m.color, e = m.emissive;
  return `pbr:${c ? c.r + ',' + c.g + ',' + c.b : ''}|${m.opacity}|${+!!m.transparent}|${m.side}|${+!!m.flatShading}|${m.roughness}|${m.metalness}|${e ? e.r + ',' + e.g + ',' + e.b : ''}|${m.emissiveIntensity}|${m.alphaTest}|${+(m.visible !== false)}|${m.blending}|${m.toneMapped}|${+!!m.wireframe}|${+(m.depthWrite !== false)}|${+(m.depthTest !== false)}|${m.clearcoat ?? ''}|${m.clearcoatRoughness ?? ''}|${m.transmission ?? ''}|${m.ior ?? ''}|${m.thickness ?? ''}|${m.sheen ?? ''}|${m.iridescence ?? ''}|${m.userData?.preset ?? ''}${SLOT_SIG(m)}`;
}
const customCache = new WeakMap(); // NodeMaterial → { version, v }
function customNode(m) { let c = customCache.get(m); if (!c || c.version !== m.version) { c = { version: m.version, v: isCustomNode(m) }; customCache.set(m, c); } return c.v; }
export function materialToParams(m, { exportNodeMaterial = null, three = null, tslOptions = {} } = {}) {
  const params = pbrParams(m);
  const textures = {};
  for (const slot of TEX_SLOTS) { const t = m[slot]; if (!t) continue; const d = textureData(t); if (d) textures[slot] = d; }
  const hasTex = Object.keys(textures).length > 0;
  const sig = materialSig(m, { exportNodeMaterial });
  if (m.isNodeMaterial && customNode(m)) {
    if (!exportNodeMaterial) return { kind: 'pbr', params, textures: hasTex ? textures : null, sig, degraded: 'NodeMaterial-without-exporter:pbr-fallback' };
    let c = nodeCache.get(m);
    if (!c || c.version !== m.version) { c = { version: m.version, package: exportNodeMaterial(m, { ...tslOptions }) }; nodeCache.set(m, c); }
    return { kind: 'wgsl', package: c.package, fallbackParams: params, sig };
  }
  const emDistinct = textures.emissiveMap && textures.emissiveMap.key !== textures.map?.key ? 'emissiveMap-distinct' : undefined; // wgpu binds emissiveMap only when === map (r7)
  return { kind: 'pbr', params, textures: hasTex ? textures : null, sig, degraded: m.isNodeMaterial ? 'NodeMaterial-without-exporter:pbr-fallback' : emDistinct };
}
// a *NodeMaterial with no custom *Node slot set renders exactly like its non-node twin → plain PBR is faithful
function hasNodes(m) {
for (const k in m) if (k.endsWith('Node') && m[k]) return true;
return false;
}
// only Mesh*NodeMaterial have a plain-PBR twin the backend draws faithfully; Sprite/Points/Line*NodeMaterial carry their own
// vertex stage (billboard, point size, line width) → always the shader package (Round 3b: SpriteNodeMaterial drew as a PBR cube).
const PBR_TWIN = /^Mesh(Basic|Standard|Physical|Lambert|Phong|Toon|Matcap|Normal)NodeMaterial$/;
const isCustomNode = (m) => !PBR_TWIN.test(m.type ?? '') || hasNodes(m) || (m.constructor?.name && m.type && m.constructor.name !== m.type) || typeof m.setupDiffuseColor === 'function' && m.setupDiffuseColor !== Object.getPrototypeOf(Object.getPrototypeOf(m))?.setupDiffuseColor;
