// render-api/material-map.js — three Material → render-api material description. NO three import (duck-typed).
//   MeshStandard/Physical/Basic/Lambert/Phong-ish → { kind:'pbr', params, textures, sig }  (createMaterial)
//   NodeMaterial (TSL)                           → { kind:'wgsl', package, fallbackParams, sig }  (createShaderMaterial; package from tsl-export.js)
// sig = cheap string compared every frame to detect edits that three's `version` counter does not cover (m.color.set(), m.opacity=…).
const TEX_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];
const rgb = (c) => (c ? [c.r, c.g, c.b] : [1, 1, 1]);
const nodeCache = new WeakMap(); // NodeMaterial → { version, package }

function textureData(t) {
const im = t?.image;
if (!im) return null;
if (im.data instanceof Uint8Array || im.data instanceof Uint8ClampedArray) return { width: im.width, height: im.height, data: im.data, srgb: t.colorSpace === 'srgb' };
if (typeof im.getContext === 'function') { // canvas
const d = im.getContext('2d')?.getImageData(0, 0, im.width, im.height);
if (d) return { width: im.width, height: im.height, data: new Uint8Array(d.data.buffer), srgb: t.colorSpace === 'srgb' };
}
return undefined; // present but not CPU-readable here (ImageBitmap/HTMLImageElement): decode path = backend-side loader, UNVERIFIED
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
if (kind === 'basic') p.unlit = true;
if (kind === 'physical') for (const k of ['clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'sheen', 'iridescence']) if (m[k]) p[k] = m[k];
if (m.userData?.preset) p.preset = m.userData.preset;
if (m.blending === 2) p.blending = 'additive';
return p;
}

export function materialToParams(m, { exportNodeMaterial = null, three = null, tslOptions = {} } = {}) {
const params = pbrParams(m);
const textures = {}; let tsig = '';
for (const slot of TEX_SLOTS) {
const t = m[slot]; if (!t) continue;
const d = textureData(t);
tsig += `|${slot}:${t.uuid}:${t.version}`;
if (d) textures[slot] = d;
}
const hasTex = Object.keys(textures).length > 0;
const base = `${params.color}|${params.opacity}|${+params.transparent}|${m.side}|${+params.flatShading}|${params.roughness}|${params.metalness}|${params.emissive}|${params.emissiveIntensity}|${params.alphaTest}|${+params.visible}|${params.blending ?? ''}|${params.clearcoat ?? ''}|${params.transmission ?? ''}${tsig}`;
if (m.isNodeMaterial && isCustomNode(m)) {
if (!exportNodeMaterial) return { kind: 'pbr', params, textures: hasTex ? textures : null, sig: `pbr:${base}`, degraded: 'NodeMaterial-without-exporter:pbr-fallback' };
let c = nodeCache.get(m);
if (!c || c.version !== m.version) { c = { version: m.version, package: exportNodeMaterial(m, { ...tslOptions }) }; nodeCache.set(m, c); }
return { kind: 'wgsl', package: c.package, fallbackParams: params, sig: `wgsl:${m.uuid}:${m.version}` };
}
return { kind: 'pbr', params, textures: hasTex ? textures : null, sig: `pbr:${base}`, degraded: m.isNodeMaterial ? 'NodeMaterial-without-exporter:pbr-fallback' : undefined };
}
// a *NodeMaterial with no custom *Node slot set renders exactly like its non-node twin → plain PBR is faithful
function hasNodes(m) {
for (const k in m) if (k.endsWith('Node') && m[k]) return true;
return false;
}
const isCustomNode = (m) => hasNodes(m) || (m.constructor?.name && m.type && m.constructor.name !== m.type) || typeof m.setupDiffuseColor === 'function' && m.setupDiffuseColor !== Object.getPrototypeOf(Object.getPrototypeOf(m))?.setupDiffuseColor;
