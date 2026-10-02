// PLACEHOLDER humanoid kit generator — procedural base body + costume pieces, as real skinned GLBs.
// A stand-in until a game ships its own modelled base (EE has a parallel lane for that): the kit
// is rig-agnostic, so swapping `base` + kit.json is all it takes. Spec: docs/HUMANOID-KIT-SPEC.md
//
//   node tools/humanoid-placeholder.mjs [outDir]   (default client/assets/humanoid)
//
// Writes base.glb (Mixamo-named skeleton, skinned mannequin), costume/*.glb (skinned to the SAME
// rest pose; hair uses VRoid bone names, cape uses VRM names — proves rebind-by-name across rigs),
// presets/*.json, kit.json. Pure node, no deps. Materials are named by COLOR SLOT.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- skeleton (rest pose, world-space joint positions; all bone rotations identity) ----
export const BONES = (() => {
  const b = {
    hips: [null, [0, 0.95, 0]], spine: ['hips', [0, 1.05, 0]], chest: ['spine', [0, 1.2, 0]], upperChest: ['chest', [0, 1.35, 0]],
    neck: ['upperChest', [0, 1.52, 0]], head: ['neck', [0, 1.6, 0]], headTop: ['head', [0, 1.84, 0]],
  };
  for (const [side, sx] of [['left', 1], ['right', -1]]) {
    b[`${side}Shoulder`] = ['upperChest', [0.04 * sx, 1.45, 0]];
    b[`${side}UpperArm`] = [`${side}Shoulder`, [0.19 * sx, 1.44, 0]];
    b[`${side}LowerArm`] = [`${side}UpperArm`, [0.19 * sx, 1.15, 0]];
    b[`${side}Hand`] = [`${side}LowerArm`, [0.19 * sx, 0.9, 0]];
    b[`${side}UpperLeg`] = ['hips', [0.09 * sx, 0.92, 0]];
    b[`${side}LowerLeg`] = [`${side}UpperLeg`, [0.09 * sx, 0.5, 0]];
    b[`${side}Foot`] = [`${side}LowerLeg`, [0.09 * sx, 0.08, 0]];
    b[`${side}Toes`] = [`${side}Foot`, [0.09 * sx, 0.04, 0.12]];
  }
  return b;
})();
const MIXAMO = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head', headTop: 'HeadTop_End' };
for (const S of ['Left', 'Right']) {
  Object.assign(MIXAMO, {
    [`${S.toLowerCase()}Shoulder`]: `${S}Shoulder`, [`${S.toLowerCase()}UpperArm`]: `${S}Arm`, [`${S.toLowerCase()}LowerArm`]: `${S}ForeArm`,
    [`${S.toLowerCase()}Hand`]: `${S}Hand`, [`${S.toLowerCase()}UpperLeg`]: `${S}UpLeg`, [`${S.toLowerCase()}LowerLeg`]: `${S}Leg`,
    [`${S.toLowerCase()}Foot`]: `${S}Foot`, [`${S.toLowerCase()}Toes`]: `${S}ToeBase`,
  });
}
export const NAMING = {
  mixamo: (k) => `mixamorig:${MIXAMO[k]}`,
  vrm: (k) => (k === 'headTop' ? 'headTop' : k),
  vroid: (k) => {
    if (k === 'headTop') return 'J_Sec_HeadTop';
    const m = /^(left|right)(.+)$/.exec(k);
    const [side, rest] = m ? [m[1][0].toUpperCase(), m[2]] : ['C', k[0].toUpperCase() + k.slice(1)];
    return `J_Bip_${side}_${rest === 'Toes' ? 'ToeBase' : rest}`;
  },
};

// ---- palette (slot → default sRGB hex) -------------------------------------------
export const SLOT_DEFAULTS = {
  skin: '#d9a784', hair: '#3a2416', eyes: '#1b1b22', primary: '#8c7a5b', secondary: '#4d5a6e',
  accent: '#6b3b2a', trim: '#c9b36b', metal: '#a9b0b8', team: '#c0392b',
};
const PBR = { metal: { metalness: 0.45, roughness: 0.4 }, eyes: { metalness: 0, roughness: 0.2 } };
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLin = (hex) => [1, 3, 5].map((i) => srgb2lin(parseInt(hex.slice(i, i + 2), 16) / 255));

// ---- geometry helpers --------------------------------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => a + (b - a) * t;

// one growing triangle soup per (material); each vertex remembers its bone key
export class Geo {
  constructor() { this.p = []; this.n = []; this.i = []; this.bone = []; }
  get count() { return this.p.length; }
  vert(p, n, bone) { this.p.push(p); this.n.push(norm(n)); this.bone.push(bone); return this.p.length - 1; }
  // outward winding: flip any triangle whose face normal disagrees with its analytic vertex normals
  tri(a, b, c) {
    const fn = cross(sub(this.p[b], this.p[a]), sub(this.p[c], this.p[a]));
    if (Math.hypot(...fn) < 1e-12) return;
    const vn = add(add(this.n[a], this.n[b]), this.n[c]);
    if (dot(fn, vn) < 0) this.i.push(a, c, b);
    else this.i.push(a, b, c);
  }
}

// tapered elliptic tube p0→p1; radii = [rx, rz]; rx lies on `u`, rz on `v` (see frame below)
export function tube(g, bone, p0, p1, r0, r1, { sides = 14, rings = 3, caps = [true, true] } = {}) {
  const a = norm(sub(p1, p0));
  const ref = Math.abs(a[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = norm(cross(ref, a));
  const v = cross(a, u);
  const ringIdx = [];
  for (let k = 0; k < rings; k++) {
    const t = rings === 1 ? 0 : k / (rings - 1);
    const c = [lerp(p0[0], p1[0], t), lerp(p0[1], p1[1], t), lerp(p0[2], p1[2], t)];
    const rx = lerp(r0[0], r1[0], t), rz = lerp(r0[1], r1[1], t);
    const row = [];
    for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
      const pos = add(c, add(mul(u, cs * rx), mul(v, sn * rz)));
      row.push(g.vert(pos, add(mul(u, cs / rx), mul(v, sn / rz)), bone));
    }
    ringIdx.push(row);
  }
  for (let k = 0; k + 1 < rings; k++) {
    for (let s = 0; s < sides; s++) {
      const A = ringIdx[k][s], B = ringIdx[k][s + 1], C = ringIdx[k + 1][s], D = ringIdx[k + 1][s + 1];
      g.tri(A, B, C);
      g.tri(B, D, C);
    }
  }
  const cap = (center, r, dir, sign) => {
    const c = g.vert(center, mul(dir, sign), bone);
    const row = [];
    for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * Math.PI * 2;
      row.push(g.vert(add(center, add(mul(u, Math.cos(th) * r[0]), mul(v, Math.sin(th) * r[1]))), mul(dir, sign), bone));
    }
    for (let s = 0; s < sides; s++) g.tri(c, row[s], row[s + 1]);
  };
  if (caps[0]) cap(p0, r0, a, -1);
  if (caps[1]) cap(p1, r1, a, 1);
}

// ellipsoid / dome. theta1 < PI ⇒ open dome from the top pole down to theta1
export function ellipsoid(g, bone, c, [rx, ry, rz], { lon = 16, lat = 12, theta1 = Math.PI } = {}) {
  const rows = [];
  for (let i = 0; i <= lat; i++) {
    const th = (i / lat) * theta1, row = [];
    for (let j = 0; j <= lon; j++) {
      const ph = (j / lon) * Math.PI * 2;
      const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      row.push(g.vert([c[0] + d[0] * rx, c[1] + d[1] * ry, c[2] + d[2] * rz], [d[0] / rx, d[1] / ry, d[2] / rz], bone));
    }
    rows.push(row);
  }
  for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
    g.tri(rows[i][j], rows[i][j + 1], rows[i + 1][j]);
    g.tri(rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]);
  }
}

export function box(g, bone, c, [sx, sy, sz]) {
  const h = [sx / 2, sy / 2, sz / 2];
  for (const ax of [0, 1, 2]) for (const sg of [-1, 1]) {
    const n = [0, 0, 0]; n[ax] = sg;
    const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
    const ids = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s1, s2]) => {
      const p = [0, 0, 0]; p[ax] = sg * h[ax]; p[o1] = s1 * h[o1]; p[o2] = s2 * h[o2];
      return g.vert(add(c, p), n, bone);
    });
    g.tri(ids[0], ids[1], ids[2]); g.tri(ids[0], ids[2], ids[3]);
  }
}

// ---- glTF/GLB writer ---------------------------------------------------------------
export class GlbWriter {
  constructor() {
    this.json = { asset: { version: '2.0', generator: 'gaia humanoid-placeholder' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], skins: [], accessors: [], bufferViews: [] };
    this.chunks = []; this.len = 0; this.matIdx = new Map(); this.boneNode = new Map(); this.jointOrder = [];
  }
  view(typed, target) {
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.len += pad; }
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    this.json.bufferViews.push({ buffer: 0, byteOffset: this.len, byteLength: buf.length, ...(target ? { target } : {}) });
    this.chunks.push(buf); this.len += buf.length;
    return this.json.bufferViews.length - 1;
  }
  accessor(typed, type, componentType, count, extra = {}) {
    this.json.accessors.push({ bufferView: this.view(typed, extra.target), componentType, count, type, ...(extra.min ? { min: extra.min, max: extra.max } : {}), ...(extra.normalized ? { normalized: true } : {}) });
    return this.json.accessors.length - 1;
  }
  material(slot, hexOverride) {
    const key = `${slot}|${hexOverride ?? ''}`;
    if (!this.matIdx.has(key)) {
      const hex = hexOverride ?? SLOT_DEFAULTS[slot] ?? '#888888';
      const pbr = PBR[slot] ?? { metalness: 0, roughness: 0.75 };
      this.json.materials.push({ name: slot, pbrMetallicRoughness: { baseColorFactor: [...hexLin(hex), 1], metallicFactor: pbr.metalness, roughnessFactor: pbr.roughness }, extras: { slot } });
      this.matIdx.set(key, this.json.materials.length - 1);
    }
    return this.matIdx.get(key);
  }
  // bones: keys to include (ancestors must be included); naming: mixamo|vrm|vroid
  skeleton(keys, naming) {
    const set = new Set(keys);
    for (const k of keys) if (BONES[k][0] && !set.has(BONES[k][0])) throw new Error(`bone ${k} missing ancestor ${BONES[k][0]}`);
    for (const k of keys) {
      const [parent, pos] = BONES[k];
      const local = parent ? sub(pos, BONES[parent][1]) : pos;
      this.json.nodes.push({ name: NAMING[naming](k), translation: local.map((x) => +x.toFixed(6)) });
      this.boneNode.set(k, this.json.nodes.length - 1);
      this.jointOrder.push(k);
    }
    for (const k of keys) {
      const [parent] = BONES[k];
      if (parent) (this.json.nodes[this.boneNode.get(parent)].children ??= []).push(this.boneNode.get(k));
      else this.json.scenes[0].nodes.push(this.boneNode.get(k));
    }
  }
  primitives(geos, jointIndexOf, skinned) {
    const prims = [];
    for (const [slot, g] of Object.entries(geos)) {
      if (!g.count) continue;
      const P = new Float32Array(g.p.flat()), N = new Float32Array(g.n.flat());
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const p of g.p) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
      const attributes = {
        POSITION: this.accessor(P, 'VEC3', 5126, g.count, { target: 34962, min, max }),
        NORMAL: this.accessor(N, 'VEC3', 5126, g.count, { target: 34962 }),
      };
      if (skinned) {
        const J = new Uint8Array(g.count * 4), W = new Float32Array(g.count * 4);
        g.bone.forEach((b, v) => { J[v * 4] = jointIndexOf(b); W[v * 4] = 1; });
        attributes.JOINTS_0 = this.accessor(J, 'VEC4', 5121, g.count, { target: 34962 });
        attributes.WEIGHTS_0 = this.accessor(W, 'VEC4', 5126, g.count, { target: 34962 });
      }
      const I = new Uint16Array(g.i);
      prims.push({ attributes, indices: this.accessor(I, 'SCALAR', 5123, g.i.length, { target: 34963 }), material: this.material(slot), mode: 4 });
    }
    return prims;
  }
  skinnedMesh(name, geos) {
    const prims = this.primitives(geos, (b) => { const j = this.jointOrder.indexOf(b); if (j < 0) throw new Error(`vertex bone ${b} not in skeleton`); return j; }, true);
    if (!prims.length) return;
    const ibm = new Float32Array(this.jointOrder.length * 16);
    this.jointOrder.forEach((k, i) => { const [x, y, z] = BONES[k][1]; ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1], i * 16); });
    const ibmAcc = this.accessor(ibm, 'MAT4', 5126, this.jointOrder.length);
    this.json.skins.push({ inverseBindMatrices: ibmAcc, joints: this.jointOrder.map((k) => this.boneNode.get(k)), skeleton: this.boneNode.get(this.jointOrder[0]) });
    this.json.meshes.push({ name, primitives: prims });
    this.json.nodes.push({ name, mesh: this.json.meshes.length - 1, skin: this.json.skins.length - 1 });
    this.json.scenes[0].nodes.push(this.json.nodes.length - 1);
  }
  // rigid mesh parented under a bone; geometry authored in WORLD rest coords → shifted into bone space
  rigidMesh(name, boneKey, geos) {
    const off = BONES[boneKey][1];
    for (const g of Object.values(geos)) g.p = g.p.map((p) => sub(p, off));
    const prims = this.primitives(geos, null, false);
    if (!prims.length) return;
    this.json.meshes.push({ name, primitives: prims });
    this.json.nodes.push({ name, mesh: this.json.meshes.length - 1, extras: { bone: boneKey } });
    (this.json.nodes[this.boneNode.get(boneKey)].children ??= []).push(this.json.nodes.length - 1);
  }
  build() {
    const bin = Buffer.concat(this.chunks);
    const padBin = (4 - (bin.length % 4)) % 4;
    const binPadded = padBin ? Buffer.concat([bin, Buffer.alloc(padBin)]) : bin;
    this.json.buffers = [{ byteLength: binPadded.length }];
    let js = Buffer.from(JSON.stringify(this.json));
    const padJs = (4 - (js.length % 4)) % 4;
    if (padJs) js = Buffer.concat([js, Buffer.alloc(padJs, 0x20)]);
    const total = 12 + 8 + js.length + 8 + binPadded.length;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
    out.writeUInt32LE(js.length, 12); out.writeUInt32LE(0x4e4f534a, 16); js.copy(out, 20);
    const bo = 20 + js.length;
    out.writeUInt32LE(binPadded.length, bo); out.writeUInt32LE(0x004e4942, bo + 4); binPadded.copy(out, bo + 8);
    return out;
  }
}

// ---- the mannequin -----------------------------------------------------------------
export const ALL_BONES = Object.keys(BONES);
const P = (k) => BONES[k][1];
const V = (x, y, z) => [x, y, z];
const SIDES = [['left', 1], ['right', -1]];

function bodyGeos(inflate = 0) {
  const G = { skin: new Geo(), eyes: new Geo() };
  const g = G.skin;
  ellipsoid(g, 'hips', V(0, 0.98, 0), [0.165, 0.11, 0.105]);
  tube(g, 'spine', V(0, 1.0, 0), V(0, 1.22, 0), [0.145, 0.095], [0.15, 0.1]);
  tube(g, 'chest', V(0, 1.22, 0), V(0, 1.42, 0), [0.15, 0.1], [0.175, 0.11]);
  tube(g, 'upperChest', V(0, 1.4, 0), V(0, 1.5, 0), [0.175, 0.11], [0.085, 0.07]);
  tube(g, 'neck', V(0, 1.48, 0), V(0, 1.63, 0), [0.05, 0.05], [0.045, 0.045]);
  ellipsoid(g, 'head', V(0, 1.72, 0.012), [0.095, 0.115, 0.105]);
  ellipsoid(g, 'head', V(0, 1.7, 0.112), [0.018, 0.026, 0.03], { lon: 8, lat: 6 }); // nose — shows facing (+Z)
  for (const [side, sx] of SIDES) {
    ellipsoid(G.eyes, 'head', V(0.036 * sx, 1.745, 0.1), [0.013, 0.013, 0.01], { lon: 8, lat: 6 });
    ellipsoid(g, `${side}UpperArm`, V(0.19 * sx, 1.44, 0), [0.058, 0.058, 0.058], { lon: 10, lat: 8 });
    tube(g, `${side}UpperArm`, V(0.19 * sx, 1.44, 0), V(0.19 * sx, 1.16, 0), [0.048, 0.048], [0.04, 0.04], { sides: 10 });
    tube(g, `${side}LowerArm`, V(0.19 * sx, 1.16, 0), V(0.19 * sx, 0.93, 0), [0.04, 0.04], [0.032, 0.032], { sides: 10 });
    ellipsoid(g, `${side}Hand`, V(0.19 * sx, 0.85, 0), [0.03, 0.065, 0.02], { lon: 10, lat: 8 });
    tube(g, `${side}UpperLeg`, V(0.09 * sx, 0.93, 0), V(0.09 * sx, 0.51, 0), [0.082, 0.082], [0.058, 0.058], { sides: 12 });
    tube(g, `${side}LowerLeg`, V(0.09 * sx, 0.51, 0), V(0.09 * sx, 0.1, 0), [0.056, 0.056], [0.04, 0.04], { sides: 12 });
    tube(g, `${side}Foot`, V(0.09 * sx, 0.04, -0.05), V(0.09 * sx, 0.04, 0.17), [0.04, 0.04], [0.035, 0.026], { sides: 10 });
  }
  return G;
}

// inflated copy of a body tube: costume = skin shape + offset, same bones ⇒ deforms with the body
const inf = (r, d) => [r[0] + d, r[1] + d];

// each piece: { name, naming, bones[], skinned:{slot:Geo}, rigid:[{bone, geos}] }
function pieces() {
  const out = [];
  const mk = (file, naming, bones) => ({ file, naming, bones, skinned: {}, rigid: [] });
  const geo = (p, slot) => (p.skinned[slot] ??= new Geo());
  const TORSO_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
  const LEG_BONES = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];
  const CHAIN = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
  const ARM = (side) => [`${side}Shoulder`, `${side}UpperArm`, `${side}LowerArm`, `${side}Hand`];

  { // torso/tunic
    const p = mk('torso/tunic', 'mixamo', TORSO_BONES);
    ellipsoid(geo(p, 'primary'), 'hips', V(0, 0.98, 0), [0.177, 0.12, 0.117]);
    tube(geo(p, 'primary'), 'spine', V(0, 1.0, 0), V(0, 1.22, 0), inf([0.145, 0.095], 0.013), inf([0.15, 0.1], 0.013));
    tube(geo(p, 'primary'), 'chest', V(0, 1.22, 0), V(0, 1.42, 0), inf([0.15, 0.1], 0.013), inf([0.175, 0.11], 0.013));
    tube(geo(p, 'primary'), 'upperChest', V(0, 1.4, 0), V(0, 1.5, 0), inf([0.175, 0.11], 0.013), [0.09, 0.075]);
    tube(geo(p, 'trim'), 'hips', V(0, 0.84, 0), V(0, 0.92, 0), [0.19, 0.13], [0.185, 0.125]);
    tube(geo(p, 'accent'), 'spine', V(0, 1.0, 0), V(0, 1.05, 0), [0.16, 0.112], [0.16, 0.112]);
    for (const [side, sx] of SIDES) tube(geo(p, 'primary'), `${side}UpperArm`, V(0.19 * sx, 1.45, 0), V(0.19 * sx, 1.27, 0), [0.063, 0.063], [0.055, 0.055], { sides: 10 });
    out.push(p);
  }
  { // torso/armor
    const p = mk('torso/armor', 'mixamo', TORSO_BONES);
    tube(geo(p, 'metal'), 'chest', V(0, 1.22, 0), V(0, 1.42, 0), inf([0.15, 0.1], 0.03), inf([0.175, 0.11], 0.03));
    tube(geo(p, 'metal'), 'upperChest', V(0, 1.4, 0), V(0, 1.5, 0), inf([0.175, 0.11], 0.03), [0.1, 0.08]);
    tube(geo(p, 'secondary'), 'spine', V(0, 1.0, 0), V(0, 1.22, 0), inf([0.145, 0.095], 0.026), inf([0.15, 0.1], 0.026));
    ellipsoid(geo(p, 'secondary'), 'hips', V(0, 0.98, 0), [0.19, 0.12, 0.12]);
    for (const [side, sx] of SIDES) {
      ellipsoid(geo(p, 'team'), `${side}UpperArm`, V(0.2 * sx, 1.47, 0), [0.095, 0.055, 0.085], { lon: 14, lat: 8, theta1: Math.PI * 0.72 });
      tube(geo(p, 'trim'), `${side}UpperArm`, V(0.2 * sx, 1.45, 0), V(0.2 * sx, 1.42, 0), [0.1, 0.09], [0.1, 0.09], { sides: 12 });
    }
    out.push(p);
  }
  { // torso/robe — long, covers the legs (different silhouette)
    const p = mk('torso/robe', 'mixamo', [...TORSO_BONES, 'leftUpperLeg', 'rightUpperLeg']);
    tube(geo(p, 'primary'), 'chest', V(0, 1.22, 0), V(0, 1.42, 0), inf([0.15, 0.1], 0.02), inf([0.175, 0.11], 0.02));
    tube(geo(p, 'primary'), 'upperChest', V(0, 1.4, 0), V(0, 1.5, 0), inf([0.175, 0.11], 0.02), [0.095, 0.078]);
    tube(geo(p, 'primary'), 'spine', V(0, 1.0, 0), V(0, 1.22, 0), inf([0.145, 0.095], 0.02), inf([0.15, 0.1], 0.02));
    tube(geo(p, 'primary'), 'hips', V(0, 0.2, 0), V(0, 1.0, 0), [0.33, 0.3], [0.165, 0.125], { rings: 4 });
    tube(geo(p, 'trim'), 'hips', V(0, 0.12, 0), V(0, 0.2, 0), [0.335, 0.305], [0.33, 0.3]);
    tube(geo(p, 'accent'), 'spine', V(0, 1.0, 0), V(0, 1.06, 0), [0.17, 0.125], [0.17, 0.125]);
    for (const [side, sx] of SIDES) {
      tube(geo(p, 'secondary'), `${side}UpperArm`, V(0.19 * sx, 1.45, 0), V(0.19 * sx, 1.16, 0), [0.066, 0.066], [0.058, 0.058], { sides: 10 });
      tube(geo(p, 'secondary'), `${side}LowerArm`, V(0.19 * sx, 1.16, 0), V(0.19 * sx, 0.9, 0), [0.058, 0.058], [0.05, 0.05], { sides: 10 });
    }
    out.push(p);
  }
  { // legs/trousers
    const p = mk('legs/trousers', 'mixamo', LEG_BONES);
    for (const [side, sx] of SIDES) {
      tube(geo(p, 'secondary'), `${side}UpperLeg`, V(0.09 * sx, 0.95, 0), V(0.09 * sx, 0.51, 0), inf([0.082, 0.082], 0.012), inf([0.058, 0.058], 0.012));
      tube(geo(p, 'secondary'), `${side}LowerLeg`, V(0.09 * sx, 0.51, 0), V(0.09 * sx, 0.14, 0), inf([0.056, 0.056], 0.012), inf([0.04, 0.04], 0.012));
    }
    out.push(p);
  }
  { // legs/shorts
    const p = mk('legs/shorts', 'mixamo', LEG_BONES);
    for (const [side, sx] of SIDES) tube(geo(p, 'accent'), `${side}UpperLeg`, V(0.09 * sx, 0.96, 0), V(0.09 * sx, 0.68, 0), inf([0.082, 0.082], 0.012), inf([0.07, 0.07], 0.012));
    out.push(p);
  }
  { // feet/boots
    const p = mk('feet/boots', 'mixamo', LEG_BONES);
    for (const [side, sx] of SIDES) {
      tube(geo(p, 'accent'), `${side}LowerLeg`, V(0.09 * sx, 0.34, 0), V(0.09 * sx, 0.1, 0), inf([0.05, 0.05], 0.018), inf([0.04, 0.04], 0.018));
      tube(geo(p, 'accent'), `${side}Foot`, V(0.09 * sx, 0.04, -0.06), V(0.09 * sx, 0.04, 0.19), [0.05, 0.048], [0.044, 0.034]);
      tube(geo(p, 'trim'), `${side}LowerLeg`, V(0.09 * sx, 0.355, 0), V(0.09 * sx, 0.335, 0), [0.07, 0.07], [0.07, 0.07], { sides: 12 });
    }
    out.push(p);
  }
  { // head/helmet
    const p = mk('head/helmet', 'mixamo', CHAIN);
    ellipsoid(geo(p, 'metal'), 'head', V(0, 1.76, -0.008), [0.112, 0.118, 0.118], { theta1: Math.PI * 0.46 });
    box(geo(p, 'team'), 'head', V(0, 1.9, -0.01), [0.02, 0.07, 0.17]);
    out.push(p);
  }
  { // head/cap
    const p = mk('head/cap', 'mixamo', CHAIN);
    ellipsoid(geo(p, 'primary'), 'head', V(0, 1.765, -0.005), [0.107, 0.11, 0.113], { theta1: Math.PI * 0.4 });
    tube(geo(p, 'trim'), 'head', V(0, 1.82, 0.03), V(0, 1.826, 0.03), [0.12, 0.135], [0.12, 0.135], { sides: 16 });
    out.push(p);
  }
  { // hair/short — VRoid-named skeleton
    const p = mk('hair/short', 'vroid', CHAIN);
    ellipsoid(geo(p, 'hair'), 'head', V(0, 1.74, -0.008), [0.1, 0.123, 0.112], { theta1: Math.PI * 0.55 });
    out.push(p);
  }
  { // hair/long
    const p = mk('hair/long', 'vroid', CHAIN);
    ellipsoid(geo(p, 'hair'), 'head', V(0, 1.74, -0.008), [0.1, 0.123, 0.112], { theta1: Math.PI * 0.55 });
    ellipsoid(geo(p, 'hair'), 'head', V(0, 1.55, -0.085), [0.105, 0.22, 0.06], { lon: 14, lat: 10 });
    out.push(p);
  }
  { // back/cape — VRM-named skeleton
    const p = mk('back/cape', 'vrm', ['hips', 'spine', 'chest', 'upperChest']);
    tube(geo(p, 'team'), 'upperChest', V(0, 1.47, -0.115), V(0, 0.74, -0.15), [0.16, 0.014], [0.245, 0.014], { rings: 4 });
    tube(geo(p, 'trim'), 'upperChest', V(0, 1.49, -0.1), V(0, 1.45, -0.1), [0.13, 0.09], [0.13, 0.09], { caps: [false, false] });
    out.push(p);
  }
  { // weaponR/sword — RIGID, parented under the right hand
    const p = mk('weapon/sword', 'mixamo', ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']);
    const h = P('rightHand');
    const G = { metal: new Geo(), accent: new Geo(), trim: new Geo() };
    box(G.accent, 'rightHand', add(h, V(0, -0.03, 0.02)), [0.032, 0.036, 0.11]);
    box(G.trim, 'rightHand', add(h, V(0, -0.03, 0.09)), [0.07, 0.03, 0.02]);
    box(G.metal, 'rightHand', add(h, V(0, -0.03, 0.42)), [0.026, 0.05, 0.66]);
    p.rigid.push({ bone: 'rightHand', geos: G });
    out.push(p);
  }
  { // weaponL/shield — RIGID, under the left hand
    const p = mk('weapon/shield', 'mixamo', ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand']);
    const h = P('leftHand');
    const G = { team: new Geo(), metal: new Geo(), trim: new Geo() };
    tube(G.team, 'leftHand', add(h, V(0.13, 0.1, 0.14)), add(h, V(0.13, 0.1, 0.155)), [0.2, 0.16], [0.2, 0.16], { sides: 16 }); // disc facing +Z
    ellipsoid(G.metal, 'leftHand', add(h, V(0.13, 0.1, 0.16)), [0.05, 0.05, 0.03], { lon: 12, lat: 8, theta1: Math.PI * 0.5 });
    tube(G.trim, 'leftHand', add(h, V(0.13, 0.1, 0.137)), add(h, V(0.13, 0.1, 0.14)), [0.215, 0.175], [0.215, 0.175], { sides: 16 });
    p.rigid.push({ bone: 'leftHand', geos: G });
    out.push(p);
  }
  return out;
}

export function buildBaseGlb() {
  const w = new GlbWriter();
  w.skeleton(ALL_BONES, 'mixamo');
  w.skinnedMesh('Mannequin', bodyGeos());
  return w.build();
}

export function buildPieceGlb(piece) {
  const w = new GlbWriter();
  w.skeleton(piece.bones, piece.naming);
  w.skinnedMesh(piece.file.split('/').pop(), piece.skinned);
  for (const r of piece.rigid) w.rigidMesh(piece.file.split('/').pop(), r.bone, r.geos);
  return w.build();
}

export { pieces as buildPieces };

// ---- kit.json + presets ------------------------------------------------------------
const PREFIX = '/assets/humanoid';
export function kitFiles() {
  const piece = (slot, name) => `${PREFIX}/costume/${slot}/${name}.glb`;
  const kit = {
    name: 'placeholder-mannequin',
    doc: 'procedural stand-in kit (tools/humanoid-placeholder.mjs). Rig = Mixamo names; hair = VRoid names, cape = VRM names.',
    bases: { mannequin: `${PREFIX}/base.glb` },
    slots: {
      hair: { pieces: { short: piece('hair', 'short'), long: piece('hair', 'long') } },
      head: { pieces: { helmet: piece('head', 'helmet'), cap: piece('head', 'cap') } },
      torso: { pieces: { tunic: piece('torso', 'tunic'), armor: piece('torso', 'armor'), robe: piece('torso', 'robe') } },
      legs: { pieces: { trousers: piece('legs', 'trousers'), shorts: piece('legs', 'shorts') } },
      feet: { pieces: { boots: piece('feet', 'boots') } },
      back: { pieces: { cape: piece('back', 'cape') } },
      weaponR: { pieces: { sword: piece('weapon', 'sword') } },
      weaponL: { pieces: { shield: piece('weapon', 'shield') } },
    },
    colorSlots: Object.keys(SLOT_DEFAULTS),
    presets: { mannequin: `${PREFIX}/presets/mannequin.json`, soldier: `${PREFIX}/presets/soldier.json`, peasant: `${PREFIX}/presets/peasant.json`, mage: `${PREFIX}/presets/mage.json` },
  };
  const c = (slot, name) => piece(slot, name);
  const presets = {
    mannequin: { name: 'mannequin', base: `${PREFIX}/base.glb`, colors: { skin: '#d9a784' } },
    soldier: {
      name: 'soldier', extends: `${PREFIX}/presets/mannequin.json`,
      params: { build: 1.06, shoulders: 1.08 },
      costume: { head: c('head', 'helmet'), torso: c('torso', 'armor'), legs: c('legs', 'trousers'), feet: c('feet', 'boots'), weaponR: c('weapon', 'sword'), weaponL: c('weapon', 'shield') },
      colors: { secondary: '#4a5160', accent: '#3b2a1e', team: '#c0392b' },
      vary: {
        params: { height: 0.07, build: 0.1, headScale: 0.05, legLength: 0.05 },
        palettes: { skin: ['#f1c7a8', '#d9a784', '#b5835a', '#8f5f4d', '#5e3c2c'] },
        costume: { head: [c('head', 'helmet'), c('head', 'helmet'), c('head', 'cap'), null], weaponL: [c('weapon', 'shield'), null] },
      },
    },
    peasant: {
      name: 'peasant', extends: `${PREFIX}/presets/mannequin.json`,
      params: { build: 0.96, height: 0.96 },
      costume: { torso: c('torso', 'tunic'), legs: c('legs', 'shorts'), feet: c('feet', 'boots') },
      colors: { primary: '#8c7a5b', accent: '#4b3322', trim: '#b79c5a' },
      vary: {
        params: { height: 0.1, build: 0.18, headScale: 0.08 },
        palettes: { skin: ['#f1c7a8', '#d9a784', '#b5835a', '#8f5f4d'], primary: ['#8c7a5b', '#6f8a5b', '#8a5b5b', '#5b6f8a', '#a59a7a'], hair: ['#20130f', '#5a3a1e', '#b89a5a', '#cfc7b5'], accent: ['#4b3322', '#2f3a2a'] },
        costume: { hair: [c('hair', 'short'), c('hair', 'long'), null], head: [null, c('head', 'cap')] },
      },
    },
    mage: {
      name: 'mage', extends: `${PREFIX}/presets/mannequin.json`,
      params: { height: 1.04, build: 0.9, neckLength: 1.1, handScale: 1.1 },
      costume: { torso: c('torso', 'robe'), hair: c('hair', 'long'), back: c('back', 'cape') },
      colors: { primary: '#43357a', secondary: '#2c2352', trim: '#d4af37', team: '#5b2a86', hair: '#d9d4c7' },
      vary: { params: { height: 0.06, build: 0.08 }, palettes: { primary: ['#43357a', '#2f5a7a', '#7a3550', '#2f6a4a'], hair: ['#d9d4c7', '#20130f', '#8a4a2a'] } },
    },
  };
  return { kit, presets };
}

// ---- CLI ---------------------------------------------------------------------------
export function generate(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const put = (rel, data) => {
    const f = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
    written.push([rel, data.length]);
  };
  put('base.glb', buildBaseGlb());
  for (const p of pieces()) put(`costume/${p.file}.glb`, buildPieceGlb(p));
  const { kit, presets } = kitFiles();
  put('kit.json', JSON.stringify(kit, null, 2) + '\n');
  for (const [name, doc] of Object.entries(presets)) put(`presets/${name}.json`, JSON.stringify(doc, null, 2) + '\n');
  return written;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'assets', 'humanoid');
  for (const [rel, n] of generate(out)) console.log(`${rel}  ${n} B`);
}
