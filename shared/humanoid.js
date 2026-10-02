// Humanoid kit — PURE data core (no THREE, no DOM). Spec: docs/HUMANOID-KIT-SPEC.md
//
// One base body, modelled once. A unit = preset + overrides:
//   mesh.humanoid = { preset, base, params, bones, costume, colors, seed, scale, position, rotation }
// This module owns everything that is DATA: bone-name canonicalisation (VRM / Mixamo /
// VRoid), preset merge + `extends`, seeded variation, param → bone-scale solve, color-slot
// naming, validation. client/kernel/humanoid.js is the THREE glue (load / rebind / apply).
// No Math.random anywhere: same data ⇒ same unit on every client.

// ---- canonical rig (VRM humanoid names) ------------------------------------
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const SIDES = ['left', 'right'];
const LIMB = ['Shoulder', 'UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot', 'Toes'];
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'little'];
const THUMB_SEGS = ['Metacarpal', 'Proximal', 'Distal'];
const FINGER_SEGS = ['Proximal', 'Intermediate', 'Distal'];

export const CANONICAL_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw', 'leftEye', 'rightEye',
  ...SIDES.flatMap((side) => [
    ...LIMB.map((l) => side + l),
    ...FINGER_NAMES.flatMap((f) => (f === 'thumb' ? THUMB_SEGS : FINGER_SEGS).map((seg) => side + cap(f) + seg)),
  ]),
];

const norm = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// alias table: normalized name → canonical bone. Mixamo keys are stored WITHOUT the
// `mixamorig<N>` prefix (stripped at lookup). VRoid keys carry `jbip<c|l|r>`.
const ALIASES = new Map();
function alias(name, canon) {
  const k = norm(name);
  if (!ALIASES.has(k)) ALIASES.set(k, canon);
}
for (const b of CANONICAL_BONES) alias(b, b);
{
  const mixamoCore = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head' };
  const vroidCore = { hips: 'Hips', spine: 'Spine', chest: 'Chest', upperChest: 'UpperChest', neck: 'Neck', head: 'Head' };
  for (const [canon, m] of Object.entries(mixamoCore)) alias(m, canon);
  for (const [canon, v] of Object.entries(vroidCore)) alias(`J_Bip_C_${v}`, canon);
  alias('LeftEye', 'leftEye');
  alias('RightEye', 'rightEye');
  alias('Jaw', 'jaw');
  const mixamoLimb = { Shoulder: 'Shoulder', UpperArm: 'Arm', LowerArm: 'ForeArm', Hand: 'Hand', UpperLeg: 'UpLeg', LowerLeg: 'Leg', Foot: 'Foot', Toes: 'ToeBase' };
  const vroidLimb = { Shoulder: 'Shoulder', UpperArm: 'UpperArm', LowerArm: 'LowerArm', Hand: 'Hand', UpperLeg: 'UpperLeg', LowerLeg: 'LowerLeg', Foot: 'Foot', Toes: 'ToeBase' };
  for (const side of SIDES) {
    const Side = cap(side);
    const letter = side[0].toUpperCase();
    for (const l of LIMB) {
      alias(Side + mixamoLimb[l], side + l);
      alias(`J_Bip_${letter}_${vroidLimb[l]}`, side + l);
    }
    for (const f of FINGER_NAMES) {
      const segs = f === 'thumb' ? THUMB_SEGS : FINGER_SEGS;
      segs.forEach((seg, i) => {
        alias(`${Side}Hand${cap(f)}${i + 1}`, side + cap(f) + seg); // Mixamo
        alias(`J_Bip_${letter}_${cap(f)}${i + 1}`, side + cap(f) + seg); // VRoid
      });
    }
  }
}

// name → canonical bone | null. Accepts VRM names, Mixamo (`mixamorig:Hips`, `mixamorig1:LeftArm`,
// or three's colon-stripped `mixamorigHips`), VRoid (`J_Bip_L_UpperArm`).
export function canonicalBone(name) {
  const k = norm(name).replace(/^mixamorig\d*/, '');
  return ALIASES.get(k) ?? ALIASES.get(norm(name)) ?? null;
}

// names[] → { canonical: name } (first wins) for the bones a rig actually has
export function indexBoneNames(names) {
  const out = {};
  for (const n of names) {
    const c = canonicalBone(n);
    if (c && !(c in out)) out[c] = n;
  }
  return out;
}

// designated NEXT bone along the humanoid chain (first present wins) — defines each
// bone's length axis. leaf bones inherit their parent's.
export const NEXT_BONE = (() => {
  const next = {
    hips: ['spine', 'chest', 'upperChest', 'neck'],
    spine: ['chest', 'upperChest', 'neck'],
    chest: ['upperChest', 'neck'],
    upperChest: ['neck'],
    neck: ['head'],
  };
  for (const side of SIDES) {
    next[`${side}Shoulder`] = [`${side}UpperArm`];
    next[`${side}UpperArm`] = [`${side}LowerArm`];
    next[`${side}LowerArm`] = [`${side}Hand`];
    next[`${side}UpperLeg`] = [`${side}LowerLeg`];
    next[`${side}LowerLeg`] = [`${side}Foot`];
    next[`${side}Foot`] = [`${side}Toes`];
  }
  return next;
})();

// local-space direction to the next bone → index of the dominant axis (0 x, 1 y, 2 z)
export function measureLengthAxis(v) {
  const [x, y, z] = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  if (x === 0 && y === 0 && z === 0) return 1;
  return y >= x && y >= z ? 1 : x >= z ? 0 : 2;
}

// ---- params ----------------------------------------------------------------
export const PARAM_DEFS = {
  height: { range: [0.5, 1.8], doc: 'overall height (instance root scale)' },
  build: { range: [0.6, 1.6], doc: 'body width/depth (hips width axes; propagates down the body)' },
  torsoLength: { range: [0.7, 1.4], doc: 'spine/chest length' },
  shoulders: { range: [0.7, 1.4], doc: 'clavicle length → arm spacing' },
  neckLength: { range: [0.6, 1.6], doc: 'neck length' },
  headScale: { range: [0.7, 1.5], doc: 'head size' },
  armLength: { range: [0.7, 1.4], doc: 'upper+lower arm length' },
  legLength: { range: [0.7, 1.4], doc: 'upper+lower leg length' },
  handScale: { range: [0.6, 1.6], doc: 'hand size' },
  footScale: { range: [0.7, 1.4], doc: 'foot size' },
};
export const PARAM_NAMES = Object.keys(PARAM_DEFS);
const perSide = (fn) => SIDES.flatMap(fn);
// Bone scale propagates down the hierarchy, so a LENGTH rule scales ONE bone (everything below it
// stretches with it) and `counter` bones get the inverse on the SAME axis so they stay undistorted
// (foot after legLength, head after neckLength). Counters assume child/parent local frames share
// axes (VRM-normalized / identity-rotation rigs); every other rule is rig-agnostic.
// mode: uniform | length | width (relative to the rule bone's measured length axis)
export const PARAM_RULES = {
  height: [{ root: true }],
  build: [{ bone: 'hips', mode: 'width', counter: ['head'] }],
  torsoLength: [{ bone: 'spine', mode: 'length', counter: ['neck', 'leftShoulder', 'rightShoulder'] }],
  shoulders: perSide((s) => [{ bone: `${s}Shoulder`, mode: 'length', counter: [`${s}UpperArm`] }]),
  neckLength: [{ bone: 'neck', mode: 'length', counter: ['head'] }],
  headScale: [{ bone: 'head', mode: 'uniform' }],
  armLength: perSide((s) => [{ bone: `${s}UpperArm`, mode: 'length', counter: [`${s}Hand`] }]),
  legLength: perSide((s) => [{ bone: `${s}UpperLeg`, mode: 'length', counter: [`${s}Foot`] }]),
  handScale: perSide((s) => [{ bone: `${s}Hand`, mode: 'uniform' }]),
  footScale: perSide((s) => [{ bone: `${s}Foot`, mode: 'uniform' }]),
};
// used only when the rig didn't supply measured axes (VRM-normalized convention)
const DEFAULT_AXIS = { leftShoulder: 0, rightShoulder: 0 };
const BONE_SCALE_RANGE = [0.1, 4];

export const DEFAULT_COLOR_SLOTS = ['skin', 'hair', 'eyes', 'primary', 'secondary', 'accent', 'trim', 'metal', 'team'];
export const DEFAULT_COSTUME_SLOTS = ['hair', 'head', 'torso', 'legs', 'feet', 'back', 'weaponR', 'weaponL'];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function scaleVec(mode, s, axis) {
  if (mode === 'uniform') return [s, s, s];
  const v = mode === 'length' ? [1, 1, 1] : [s, s, s];
  v[axis] = mode === 'length' ? s : 1;
  return v;
}

// concrete → { root, bones: { canonical: [x,y,z] } }. `axes` = measured length axis per
// canonical bone; `has` = Set | (bone)=>bool — bones absent from the rig are skipped.
export function solveBoneScales(concrete, { axes = {}, has = null } = {}) {
  const hasFn = has instanceof Set ? (b) => has.has(b) : has;
  const bones = {};
  const mul = (bone, v) => {
    const c = bones[bone] ?? (bones[bone] = [1, 1, 1]);
    c[0] *= v[0];
    c[1] *= v[1];
    c[2] *= v[2];
  };
  let root = 1;
  for (const [name, rules] of Object.entries(PARAM_RULES)) {
    const s = concrete.params?.[name] ?? 1;
    if (s === 1) continue;
    for (const rule of rules) {
      if (rule.root) {
        root *= s;
        continue;
      }
      if (hasFn && !hasFn(rule.bone)) continue;
      const axis = axes[rule.bone] ?? DEFAULT_AXIS[rule.bone] ?? 1;
      mul(rule.bone, scaleVec(rule.mode, s, axis));
      for (const c of rule.counter ?? []) if (!hasFn || hasFn(c)) mul(c, scaleVec(rule.mode, 1 / s, axis));
    }
  }
  for (const [bone, v] of Object.entries(concrete.bones ?? {})) {
    if (hasFn && !hasFn(bone)) continue;
    mul(bone, v);
  }
  return { root, bones };
}

// ---- seeded PRNG -----------------------------------------------------------
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// one value per (seed, path) — independent streams, so adding/reordering vary keys never reshuffles others
export const draw = (seed, path) => mulberry32(hash32(`${seed}|${path}`))();

// ---- merge / presets -------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// deep merge, `b` wins; arrays/scalars/null replace; `vary` is replaced whole (nearest definer)
export function mergeSpec(a = {}, b = {}) {
  const out = clone(a) ?? {};
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v === undefined) continue;
    if (k === 'vary') out.vary = clone(v);
    else if (isObj(v) && isObj(out[k])) out[k] = mergeSpec(out[k], v);
    else out[k] = clone(v);
  }
  return out;
}

export const MAX_EXTENDS = 4;
// url → flattened preset (extends chain merged parent→child). fetchJson(url) → Promise<object>
export async function loadPresetChain(url, fetchJson, _seen = []) {
  if (_seen.includes(url)) throw new Error(`humanoid preset cycle: ${[..._seen, url].join(' -> ')}`);
  if (_seen.length >= MAX_EXTENDS) throw new Error(`humanoid preset extends chain deeper than ${MAX_EXTENDS}: ${url}`);
  const doc = await fetchJson(url);
  if (!isObj(doc)) throw new Error(`humanoid preset is not an object: ${url}`);
  const { extends: parent, ...own } = doc;
  if (!parent) return own;
  return mergeSpec(await loadPresetChain(parent, fetchJson, [..._seen, url]), own);
}

// ---- hex / validation ------------------------------------------------------
export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return `#${h}`;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function cleanBones(bones) {
  const out = {};
  for (const [bone, v] of Object.entries(bones ?? {})) {
    const arr = Array.isArray(v) ? v : [v, v, v];
    if (arr.length !== 3 || arr.some((n) => typeof n !== 'number' || !Number.isFinite(n))) continue;
    out[bone] = arr.map((n) => clamp(n, ...BONE_SCALE_RANGE));
  }
  return out;
}

// human-readable problems with a unit/preset doc (resolve itself never throws on these — it clamps/drops)
export function validateHumanoid(spec) {
  const issues = [];
  if (!isObj(spec)) return ['humanoid is not an object'];
  if (spec.base !== undefined && typeof spec.base !== 'string') issues.push('base must be a URL string');
  if (spec.preset !== undefined && typeof spec.preset !== 'string') issues.push('preset must be a URL string');
  if (spec.seed !== undefined && typeof spec.seed !== 'number' && typeof spec.seed !== 'string') issues.push('seed must be number|string');
  for (const [k, v] of Object.entries(spec.params ?? {})) {
    if (!(k in PARAM_DEFS)) issues.push(`unknown param: ${k}`);
    else if (typeof v !== 'number' || !Number.isFinite(v)) issues.push(`param ${k} must be a finite number`);
    else if (v < PARAM_DEFS[k].range[0] || v > PARAM_DEFS[k].range[1]) issues.push(`param ${k}=${v} outside [${PARAM_DEFS[k].range}] (will clamp)`);
  }
  for (const [slot, v] of Object.entries(spec.costume ?? {})) {
    if (v !== null && typeof v !== 'string') issues.push(`costume.${slot} must be a URL string or null`);
  }
  for (const [slot, v] of Object.entries(spec.colors ?? {})) {
    if (!normalizeHex(v)) issues.push(`colors.${slot} is not a hex color: ${JSON.stringify(v)}`);
  }
  if (spec.clip !== undefined && spec.clip !== null && !normalizeClip(spec.clip)) issues.push('clip must be a name string or { name, speed?, loop?, t0? }');
  if (spec.clips !== undefined && typeof spec.clips !== 'string') issues.push('clips must be a URL string');
  for (const [bone, v] of Object.entries(spec.bones ?? {})) {
    const arr = Array.isArray(v) ? v : [v];
    if (!(arr.length === 1 || arr.length === 3) || arr.some((n) => typeof n !== 'number' || !Number.isFinite(n))) issues.push(`bones.${bone} must be a number or [x,y,z]`);
    else if (!CANONICAL_BONES.includes(bone)) issues.push(`bones.${bone} is not a canonical bone`);
  }
  return issues;
}

// ---- resolve: unit + preset → concrete ------------------------------------
// `preset` = already-flattened preset object (loadPresetChain) or null.
// explicit (unit) > seeded vary > preset > defaults.
export function resolveHumanoid(unit = {}, preset = null) {
  const merged = mergeSpec(preset ?? {}, unit ?? {});
  const seeded = merged.seed !== undefined && merged.seed !== null;
  const seed = seeded ? String(merged.seed) : '';
  const vary = merged.vary ?? {};
  const setByUnit = {
    params: new Set(Object.keys(unit?.params ?? {})),
    colors: new Set(Object.keys(unit?.colors ?? {})),
    costume: new Set(Object.keys(unit?.costume ?? {})),
  };

  const rawParams = { ...(merged.params ?? {}) };
  const colors = { ...(merged.colors ?? {}) };
  const costume = { ...(merged.costume ?? {}) };
  if (seeded) {
    for (const [name, amp] of Object.entries(vary.params ?? {})) {
      if (!(name in PARAM_DEFS) || setByUnit.params.has(name) || typeof amp !== 'number') continue;
      const base = Number(rawParams[name] ?? 1);
      rawParams[name] = base + (2 * draw(seed, `params.${name}`) - 1) * amp;
    }
    for (const [slot, list] of Object.entries(vary.palettes ?? {})) {
      if (setByUnit.colors.has(slot) || !Array.isArray(list) || !list.length) continue;
      colors[slot] = list[Math.floor(draw(seed, `palettes.${slot}`) * list.length)];
    }
    for (const [slot, list] of Object.entries(vary.costume ?? {})) {
      if (setByUnit.costume.has(slot) || !Array.isArray(list) || !list.length) continue;
      costume[slot] = list[Math.floor(draw(seed, `costume.${slot}`) * list.length)];
    }
  }

  const params = {};
  for (const [name, def] of Object.entries(PARAM_DEFS)) {
    const v = Number(rawParams[name] ?? 1);
    params[name] = Number.isFinite(v) ? clamp(v, ...def.range) : 1;
  }
  const outColors = {};
  for (const [slot, v] of Object.entries(colors)) {
    const hex = normalizeHex(v);
    if (hex) outColors[slot] = hex;
  }
  const outCostume = {};
  for (const [slot, v] of Object.entries(costume)) outCostume[slot] = typeof v === 'string' && v ? v : null;

  const concrete = {
    base: typeof merged.base === 'string' && merged.base ? merged.base : null,
    params,
    bones: cleanBones(merged.bones),
    costume: outCostume,
    colors: outColors,
    place: {
      scale: Number.isFinite(merged.scale) ? merged.scale : 1,
      position: Array.isArray(merged.position) ? merged.position : [0, 0, 0],
      rotation: Array.isArray(merged.rotation) ? merged.rotation : [0, 0, 0],
      solid: !!merged.solid,
    },
    // render strategy (stage 5) — NOT part of the unit identity key
    render: { merge: merged.merge !== false, lod: normalizeLod(merged.lod), clip: normalizeClip(merged.clip), clips: typeof merged.clips === 'string' && merged.clips ? merged.clips : null },
  };
  const { place: _place, render: _render, ...identity } = concrete;
  concrete.key = hash32(stable(identity)).toString(16).padStart(8, '0');
  return concrete;
}

// ---- color slots -----------------------------------------------------------
// slot of a material: explicit tag (glTF extras.slot) else the name: `skin`, `skin.001`,
// `skin_body`, `primary:trim` → longest matching slot wins.
export function slotOfMaterial(name = '', slots = DEFAULT_COLOR_SLOTS, tag = null) {
  if (typeof tag === 'string' && tag) return tag;
  const n = String(name).toLowerCase();
  let best = null;
  for (const s of slots) {
    const l = s.toLowerCase();
    if (n === l || (n.startsWith(l) && /[._:\- ]/.test(n[l.length]))) {
      if (best === null || l.length > best.toLowerCase().length) best = s;
    }
  }
  return best;
}

// ---- stage 5: piece merge (pure) + LOD helpers --------------------------------
// mergeSkinnedParts: concatenate skinned parts that share ONE material into ONE geometry's worth of
// arrays. each part = { position, normal?, uv?, skinIndex, skinWeight, index?, jointKeys:[string] } where
// skinIndex values index THAT part's jointKeys. result.jointKeys = unique keys in first-seen order,
// every part's skinIndex rewritten through jointMaps[part] (vertex data copied, never aliased).
export function mergeSkinnedParts(parts) {
  const jointKeys = [];
  const slot = new Map();
  const jointMaps = parts.map((p) => Uint16Array.from(p.jointKeys, (k) => {
    let i = slot.get(k);
    if (i === undefined) { i = jointKeys.length; slot.set(k, i); jointKeys.push(k); }
    return i;
  }));
  const vertexCount = parts.reduce((s, p) => s + p.position.length / 3, 0);
  const indexCount = parts.reduce((s, p) => s + (p.index ? p.index.length : p.position.length / 3), 0);
  const hasNormal = parts.some((p) => p.normal);
  const hasUv = parts.some((p) => p.uv);
  const position = new Float32Array(vertexCount * 3);
  const normal = hasNormal ? new Float32Array(vertexCount * 3) : null;
  const uv = hasUv ? new Float32Array(vertexCount * 2) : null;
  const skinIndex = new Uint16Array(vertexCount * 4);
  const skinWeight = new Float32Array(vertexCount * 4);
  const index = new (vertexCount > 65535 ? Uint32Array : Uint16Array)(indexCount);
  const ranges = [];
  let v = 0;
  let ii = 0;
  parts.forEach((p, pi) => {
    const n = p.position.length / 3;
    position.set(p.position, v * 3);
    if (p.normal) normal.set(p.normal, v * 3);
    if (p.uv) uv.set(p.uv, v * 2);
    const map = jointMaps[pi];
    for (let k = 0; k < n * 4; k++) {
      skinWeight[v * 4 + k] = p.skinWeight[k];
      skinIndex[v * 4 + k] = p.skinWeight[k] > 0 ? map[p.skinIndex[k]] : 0; // zero-weight slots point anywhere valid
    }
    const cnt = p.index ? p.index.length : n;
    for (let k = 0; k < cnt; k++) index[ii + k] = (p.index ? p.index[k] : k) + v;
    ranges.push({ vertexStart: v, vertexCount: n, indexStart: ii, indexCount: cnt });
    v += n;
    ii += cnt;
  });
  return { position, normal, uv, skinIndex, skinWeight, index, jointKeys, jointMaps, ranges, vertexCount, indexCount };
}
export const DEFAULT_LOD_DISTANCES = [25, 60];
// `lod`: true | { distances:[d1,d2,…], bases:[url,…]?, hysteresis? } → { distances, bases|null, count, hysteresis } | null
export function normalizeLod(lod) {
  if (!lod) return null;
  const o = lod === true ? {} : isObj(lod) ? lod : null;
  if (!o) return null;
  const bases = Array.isArray(o.bases) ? o.bases.filter((b) => typeof b === 'string' && b) : null;
  const distances = (Array.isArray(o.distances) ? o.distances : DEFAULT_LOD_DISTANCES).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  const count = bases ? bases.length : distances.length;
  if (!count) return null;
  return { distances: distances.slice(0, count), bases: bases?.length ? bases : null, count, hysteresis: Number.isFinite(o.hysteresis) ? o.hysteresis : 0.08 };
}
// `x/clubman.gltf` → `x/clubman_lod1.gltf` (the EE unit-build convention)
export const deriveLodUrl = (url, level) => url.replace(/(\.[a-z0-9]+)(\?.*)?$/i, `_lod${level}$1$2`);
// level 0..distances.length for camera distance `d`; `cur` + hysteresis stop edge flicker
export function lodLevelFor(d, distances, cur = 0, hysteresis = 0.08) {
  let lvl = 0;
  while (lvl < distances.length && d >= distances[lvl]) lvl++;
  if (cur !== lvl) { // stay on the current level while within the hysteresis band of its boundary
    const edge = lvl > cur ? distances[cur] : distances[cur - 1];
    if (edge !== undefined && Math.abs(d - edge) < edge * hysteresis) return cur;
  }
  return lvl;
}

// ---- stage 6: clip playback (pure) ------------------------------------------
export const CLIP_FADE = 0.15; // s — crossfade on clip change
// string | { name, speed=1, loop=true, t0=0 } → concrete | null (no/invalid ⇒ no clip)
export function normalizeClip(c) {
  const o = typeof c === 'string' ? { name: c } : isObj(c) ? c : null;
  if (!o || typeof o.name !== 'string' || !o.name) return null;
  return {
    name: o.name,
    speed: Number.isFinite(o.speed) ? o.speed : 1,
    loop: o.loop !== false,
    t0: Number.isFinite(o.t0) && o.t0 > 0 ? o.t0 : 0,
  };
}
// want → the clip name that exists: exact → `Armature|walk` tail → case-insensitive; else null
export function resolveClipName(names, want) {
  if (typeof want !== 'string' || !want) return null;
  const list = [...names];
  const tail = (n) => n.split('|').pop();
  const lc = want.toLowerCase();
  return list.find((n) => n === want) ?? list.find((n) => tail(n) === want) ?? list.find((n) => tail(n).toLowerCase() === lc) ?? null;
}
// retarget one track name `node.prop` onto the target rig by node name, else by canonical bone; null = drop
export function retargetTrackName(track, { has, nameOfCanon }) {
  const i = track.lastIndexOf('.');
  if (i <= 0) return null;
  const node = track.slice(0, i);
  if (has(node)) return track;
  const canon = canonicalBone(node);
  const target = canon ? nameOfCanon(canon) : null;
  return target ? `${target}${track.slice(i)}` : null;
}
