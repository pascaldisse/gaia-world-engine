// VRM avatar support — load / edit / animate / export (VRM 0.x, VRoid-compatible).
//
// A `mesh.vrm = { src, edits }` component turns an entity into a VRM avatar.
// `src` is a URL (templates live in /assets/vrm/); `edits` is pure data —
// colors keyed by semantic slot, expression weights, humanoid bone scales,
// meta overrides — so avatar customization rides the same patch protocol as
// every other world edit. Every client re-derives the same look from the data.
//
// Spec: docs/VRM-CHARACTER-EDITOR-SPEC.md (measured from real VRoid exports).
// Export is the in-place GLB round-trip of §8: we keep the original bytes,
// patch the JSON chunk (MToon materialProperties, meta, node scales), and
// re-serialize — everything we didn't touch survives byte-for-byte.

import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, MToonMaterialLoaderPlugin } from '@pixiv/three-vrm';
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

// ---- semantic slot map (spec §4.1) ------------------------------------------
// VRoid names materials `F<base>_<variant>_<slot>_<Region>_<nn>_<CATEGORY>`;
// the region token identifies the editor slot straight from the file.
const SLOT_RULES = [
  { slot: 'iris', re: /EyeIris/ },
  { slot: 'eyeHighlight', re: /EyeHighlight/ },
  { slot: 'sclera', re: /EyeWhite/ },
  { slot: 'eyeExtra', re: /EyeExtra/ },
  { slot: 'eyeline', re: /FaceEyeline/ },
  { slot: 'eyelash', re: /FaceEyelash/ },
  { slot: 'brow', re: /FaceBrow/ },
  { slot: 'mouth', re: /FaceMouth/ },
  { slot: 'faceSkin', re: /Face_\d+_SKIN/ },
  { slot: 'bodySkin', re: /Body_\d+_SKIN/ },
  { slot: 'hairBack', re: /HairBack/ },
  { slot: 'hair', re: /_HAIR/ },
  { slot: 'tops', re: /Tops/ },
  { slot: 'bottoms', re: /Bottoms/ },
  { slot: 'neckAccessory', re: /AccessoryNeck/ },
  { slot: 'shoes', re: /Shoes/ },
  { slot: 'skin', re: /_SKIN/ }, // catch-all skin
  { slot: 'cloth', re: /_CLOTH/ }, // catch-all clothing
];

export function slotOfMaterialName(name) {
  for (const { slot, re } of SLOT_RULES) if (re.test(name)) return slot;
  return null;
}

// Editor-facing list: which slots exist on a loaded avatar, with live colors.
export function slotMapOf(vrm) {
  const slots = new Map(); // slot -> [materials]
  for (const mat of vrm.materials ?? []) {
    const slot = slotOfMaterialName(mat.name ?? '');
    if (!slot) continue;
    if (!slots.has(slot)) slots.set(slot, []);
    slots.get(slot).push(mat);
  }
  return slots;
}

// Bones the proportion editor drives (spec §7 — bone-scale rigging).
export const PROPORTION_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftUpperLeg', 'rightUpperLeg',
];

// ---- loading -----------------------------------------------------------------
// Cache the raw bytes per src (export needs the original file) and share
// in-flight loads. Each applyMesh call gets its OWN VRM instance (two
// entities may wear the same file), so only bytes are cached, not scenes.
const byteCache = new Map(); // src -> Promise<ArrayBuffer>

export function fetchVrmBytes(src) {
  if (!byteCache.has(src)) {
    byteCache.set(
      src,
      fetch(src).then((r) => {
        if (!r.ok) throw new Error(`vrm fetch failed: ${src} (${r.status})`);
        return r.arrayBuffer();
      }),
    );
  }
  return byteCache.get(src);
}

export async function loadVRM(src) {
  const bytes = await fetchVrmBytes(src);
  const loader = new GLTFLoader();
  loader.register(
    (parser) =>
      new VRMLoaderPlugin(parser, {
        // WebGPU renderer → MToon must build node materials (three-vrm ≥3, r167+)
        mtoonMaterialPlugin: new MToonMaterialLoaderPlugin(parser, { materialType: MToonNodeMaterial }),
      }),
  );
  const gltf = await loader.parseAsync(bytes.slice(0), '');
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  // VRM 0.x faces -Z; the engine's convention is +Z like everything else
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.userData.solid = false; // avatars are presence, not architecture
    }
  });
  return vrm;
}

// ---- edits: pure data -> live avatar -----------------------------------------
// edits = {
//   colors:      { iris: '#7a1128', hair: '#1a0d26', ... }         (slot -> hex)
//   expressions: { happy: 0.6, blink: 0, aa: 0, ... }              (preset -> 0..1)
//   bones:       { head: 1.08, leftUpperArm: [1,1.1,1], ... }      (bone -> scale)
//   meta:        { title, author, ... }                            (export only)
// }
const _color = new THREE.Color();

function shadeOf(hex) {
  // VRoid keeps _ShadeColor a darker multiple of _Color — mirror that contract
  _color.set(hex);
  _color.multiplyScalar(0.72);
  return _color.clone();
}

export function applyVrmColors(vrm, colors = {}) {
  const slots = slotMapOf(vrm);
  for (const [slot, hex] of Object.entries(colors)) {
    if (!hex) continue;
    for (const mat of slots.get(slot) ?? []) {
      mat.color?.set(hex);
      if (mat.shadeColorFactor) mat.shadeColorFactor.copy(shadeOf(hex));
      else if (mat.uniforms?.shadeColorFactor) mat.uniforms.shadeColorFactor.value.copy(shadeOf(hex));
      mat.needsUpdate = true;
    }
  }
}

export function applyVrmExpressions(vrm, expressions = {}) {
  const mgr = vrm.expressionManager;
  if (!mgr) return;
  for (const [name, weight] of Object.entries(expressions)) {
    if (!mgr.getExpression(name)) continue;
    mgr.setValue(name, Math.max(0, Math.min(1, Number(weight) || 0)));
  }
  mgr.update();
}

export function applyVrmBones(vrm, bones = {}) {
  for (const [bone, scale] of Object.entries(bones)) {
    const node = vrm.humanoid?.getRawBoneNode(bone);
    if (!node) continue;
    if (Array.isArray(scale)) node.scale.set(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1);
    else node.scale.setScalar(Number(scale) || 1);
  }
}

// raw scene nodes by name substring — reaches non-humanoid bones (J_Sec_*_Bust*,
// skirt, hair roots) that the humanoid map doesn't know
export function applyVrmNodes(vrm, nodes = {}) {
  for (const [needle, scale] of Object.entries(nodes)) {
    vrm.scene.traverse((obj) => {
      if (!obj.isBone && !obj.isObject3D) return;
      if (!obj.name?.includes(needle)) return;
      if (Array.isArray(scale)) obj.scale.set(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1);
      else obj.scale.setScalar(Number(scale) || 1);
    });
  }
}

export function applyVrmEdits(vrm, edits = {}) {
  if (edits.colors) applyVrmColors(vrm, edits.colors);
  if (edits.expressions) applyVrmExpressions(vrm, edits.expressions);
  if (edits.bones) applyVrmBones(vrm, edits.bones);
  if (edits.nodes) applyVrmNodes(vrm, edits.nodes);
}

// ---- export: in-place GLB round-trip (spec §8) --------------------------------
// Patch the JSON chunk of the ORIGINAL file: glTF materials (pbr fallback) +
// extensions.VRM.materialProperties (MToon truth) + node scales + meta.
// BIN chunk passes through untouched.

export function parseGlb(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  const chunks = [];
  let off = 12;
  while (off < dv.getUint32(8, true)) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    chunks.push({ type, data: buffer.slice(off + 8, off + 8 + len) });
    off += 8 + len;
  }
  const jsonChunk = chunks.find((c) => c.type === 0x4e4f534a);
  const binChunk = chunks.find((c) => c.type === 0x004e4942);
  return { json: JSON.parse(new TextDecoder().decode(jsonChunk.data)), bin: binChunk?.data };
}

export function buildGlb(json, bin) {
  const enc = new TextEncoder();
  let jsonBytes = enc.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.length); // JSON chunk pads with spaces
    jsonBytes = padded;
  }
  const binLen = bin ? bin.byteLength : 0;
  const binPad = (4 - (binLen % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + (bin ? 8 + binLen + binPad : 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  const u8 = new Uint8Array(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  u8.set(jsonBytes, 20);
  if (bin) {
    const boff = 20 + jsonBytes.length;
    dv.setUint32(boff, binLen + binPad, true);
    dv.setUint32(boff + 4, 0x004e4942, true);
    u8.set(new Uint8Array(bin), boff + 8);
  }
  return out;
}

function hexToRgb(hex) {
  _color.set(hex);
  return [_color.r, _color.g, _color.b];
}

// Patch material colors into BOTH truth stores (spec §8 step 2).
function patchColors(json, colors) {
  const props = json.extensions?.VRM?.materialProperties ?? [];
  for (const mp of props) {
    const slot = slotOfMaterialName(mp.name ?? '');
    const hex = slot && colors[slot];
    if (!hex) continue;
    const [r, g, b] = hexToRgb(hex);
    const a = mp.vectorProperties?._Color?.[3] ?? 1;
    if (mp.vectorProperties?._Color) mp.vectorProperties._Color = [r, g, b, a];
    if (mp.vectorProperties?._ShadeColor) {
      mp.vectorProperties._ShadeColor = [r * 0.72, g * 0.72, b * 0.72, mp.vectorProperties._ShadeColor[3] ?? 1];
    }
    // pbr fallback material of the same name
    const gm = (json.materials ?? []).find((m) => m.name === mp.name);
    if (gm?.pbrMetallicRoughness?.baseColorFactor) {
      const fa = gm.pbrMetallicRoughness.baseColorFactor[3] ?? 1;
      gm.pbrMetallicRoughness.baseColorFactor = [r, g, b, fa];
    }
  }
}

// Bake humanoid bone scales into node transforms.
function patchBones(json, bones) {
  const humanBones = json.extensions?.VRM?.humanoid?.humanBones ?? [];
  for (const [bone, scale] of Object.entries(bones)) {
    const hb = humanBones.find((b) => b.bone === bone);
    const node = hb && json.nodes?.[hb.node];
    if (!node) continue;
    const s = Array.isArray(scale) ? scale : [scale, scale, scale];
    const base = node.scale ?? [1, 1, 1];
    node.scale = [base[0] * (s[0] ?? 1), base[1] * (s[1] ?? 1), base[2] * (s[2] ?? 1)];
  }
}

// VRM 0.x meta — note the canonical double-s spellings (spec §8.1); pass
// fields verbatim, only overriding what the editor set.
function patchMeta(json, meta) {
  const m = json.extensions?.VRM?.meta;
  if (!m) return;
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== null && v !== '') m[k] = v;
  }
}

// Pure byte transform (also the Node-testable core of exportVRM).
export function patchVrmBytes(buffer, edits = {}) {
  const { json, bin } = parseGlb(buffer);
  if (edits.colors) patchColors(json, edits.colors);
  if (edits.bones) patchBones(json, edits.bones);
  if (edits.meta) patchMeta(json, edits.meta);
  // resting expression weights are a runtime pose, not file data — skipped by design
  return buildGlb(json, bin);
}

export async function exportVRM(src, edits = {}) {
  const bytes = await fetchVrmBytes(src);
  return new Blob([patchVrmBytes(bytes, edits)], { type: 'model/gltf-binary' });
}

// ---- procedural idle: animation as data ---------------------------------------
// No animation FILE for being alive — breath, sway, and blinking are
// parameters, deterministic from accumulated time, so the look is data-driven
// and tunable per entity: `mesh.vrm.idle = { breath, sway, blink, arms }`.
// (Clip playback — .vrma via @pixiv/three-vrm-animation — is the next layer;
// this is the resting state every avatar owns without any asset.)
const IDLE_DEFAULTS = { breath: 1, sway: 1, blink: 1, arms: 1 };

function applyIdle(vrm, t, spec) {
  const s = { ...IDLE_DEFAULTS, ...spec };
  const bone = (name) => vrm.humanoid?.getNormalizedBoneNode(name);
  // breath: slow spine/chest pitch + shoulder rise
  const breath = Math.sin(t * 1.15) * 0.02 * s.breath;
  const chest = bone('chest');
  if (chest) chest.rotation.x = breath;
  const neck = bone('neck');
  if (neck) neck.rotation.x = -breath * 0.5;
  // sway: hips drift in a slow lissajous — weight shifting foot to foot
  const hips = bone('hips');
  if (hips) {
    hips.rotation.z = Math.sin(t * 0.42) * 0.015 * s.sway;
    hips.rotation.y = Math.sin(t * 0.27) * 0.03 * s.sway;
  }
  const head = bone('head');
  if (head) {
    head.rotation.z = Math.sin(t * 0.35 + 1.3) * 0.02 * s.sway;
    head.rotation.y = Math.sin(t * 0.21 + 0.7) * 0.04 * s.sway;
  }
  // arms: relax out of the T-pose (VRM rest pose) toward the sides
  if (s.arms) {
    const drop = 1.15 * s.arms + Math.sin(t * 1.15 + 0.5) * 0.012 * s.breath;
    const lu = bone('leftUpperArm');
    const ru = bone('rightUpperArm');
    if (lu) lu.rotation.z = drop;
    if (ru) ru.rotation.z = -drop;
    const ll = bone('leftLowerArm');
    const rl = bone('rightLowerArm');
    if (ll) ll.rotation.z = 0.12 * s.arms;
    if (rl) rl.rotation.z = -0.12 * s.arms;
  }
  // blink: periodic double-beat with a little phase noise from entity identity
  if (s.blink && vrm.expressionManager?.getExpression('blink')) {
    const cycle = (t + (vrm._blinkPhase ?? (vrm._blinkPhase = Math.random() * 4))) % 3.7;
    let w = 0;
    if (cycle < 0.12) w = cycle / 0.06 <= 1 ? cycle / 0.06 : 2 - cycle / 0.06; // close-open
    vrm.expressionManager.setValue('blink', Math.max(0, Math.min(1, w)) * s.blink);
  }
}

// ---- layer 1.5: procedural locomotion + dance ---------------------------------
// The walk cycle is MATH, not an asset: a phase-driven gait (legs scissor,
// arms counter-swing, body bob) whose speed follows actual world velocity —
// the locomotion nerve. view.js measures each avatar group's velocity per
// frame and sets vrm.userData.speed; anything that moves an entity (agent
// intents, behaviors, ops) gets a walking body for free. Dance is the same
// trick in a different key: `mesh.vrm.dance = { style, bpm, energy }`.
function applyWalk(vrm, t, speed) {
  const bone = (name) => vrm.humanoid?.getNormalizedBoneNode(name);
  // stride frequency scales with speed (Froude-ish): ~2.2 steps/s at 1.5 m/s
  const freq = 2.2 * Math.min(1.6, Math.max(0.5, speed / 1.5));
  const ph = (vrm._walkPhase = (vrm._walkPhase ?? 0) + freq * Math.PI * 2 * (t - (vrm._walkT ?? t)));
  vrm._walkT = t;
  const w = Math.min(1, speed / 0.4); // blend weight: fade gait in above a crawl
  const swing = 0.55 * w;
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  const set = (name, axis, v) => {
    const b = bone(name);
    if (b) b.rotation[axis] = v;
  };
  set('leftUpperLeg', 'x', s * swing);
  set('rightUpperLeg', 'x', -s * swing);
  // knees bend only on the back-swing (no hyperextension)
  set('leftLowerLeg', 'x', Math.max(0, -s) * -0.9 * w);
  set('rightLowerLeg', 'x', Math.max(0, s) * -0.9 * w);
  // arms counter-swing, slightly relaxed from the idle drop
  const armDrop = 1.15;
  const lu = bone('leftUpperArm');
  const ru = bone('rightUpperArm');
  if (lu) {
    lu.rotation.z = armDrop;
    lu.rotation.x = -s * 0.35 * w;
  }
  if (ru) {
    ru.rotation.z = -armDrop;
    ru.rotation.x = s * 0.35 * w;
  }
  // bob + lean: two footfalls per stride cycle
  const hips = bone('hips');
  if (hips) {
    hips.rotation.y = s * 0.06 * w;
    hips.rotation.x = 0.05 * w; // slight forward lean into the motion
  }
  set('spine', 'y', -s * 0.05 * w);
  set('head', 'y', s * 0.03 * w);
}

// dance: beat-locked full-body groove. Deterministic from world time — every
// client sees the same move on the same beat. energy 0..1 scales amplitude.
function applyDance(vrm, t, spec) {
  const bone = (name) => vrm.humanoid?.getNormalizedBoneNode(name);
  const bpm = spec.bpm ?? 108;
  const e = spec.energy ?? 0.8;
  const beat = (t * bpm) / 60;
  const ph = beat * Math.PI; // half-cycle per beat: sway alternates L/R
  const s = Math.sin(ph);
  const c = Math.cos(ph);
  const set = (name, axis, v) => {
    const b = bone(name);
    if (b) b.rotation[axis] = v;
  };
  // grounded groove: weight shifts side to side, knees spring on the beat,
  // body stays stacked over the feet — sway, not flail
  const hips = bone('hips');
  if (hips) {
    hips.rotation.z = s * 0.08 * e;
    hips.rotation.y = s * 0.1 * e;
  }
  set('spine', 'z', -s * 0.06 * e);
  set('chest', 'z', -s * 0.05 * e);
  set('chest', 'y', c * 0.08 * e);
  set('head', 'z', s * 0.05 * e);
  set('head', 'y', -s * 0.09 * e);
  // knees: spring down on every beat (both legs, small)
  const spring = Math.abs(s) * 0.22 * e;
  set('leftUpperLeg', 'x', -spring * 0.5);
  set('rightUpperLeg', 'x', -spring * 0.5);
  set('leftLowerLeg', 'x', -spring);
  set('rightLowerLeg', 'x', -spring);
  // arms: stay low and groove — elbows swing with the beat, no T-flail
  const lu = bone('leftUpperArm');
  const ru = bone('rightUpperArm');
  if (lu) {
    lu.rotation.z = 1.05 - Math.max(0, s) * 0.35 * e;
    lu.rotation.x = s * 0.15 * e;
  }
  if (ru) {
    ru.rotation.z = -1.05 - Math.max(0, -s) * 0.35 * e;
    ru.rotation.x = -s * 0.15 * e;
  }
  set('leftLowerArm', 'z', 0.5 + s * 0.25 * e);
  set('rightLowerArm', 'z', -0.5 + s * 0.25 * e);
}

// ---- layer 2: clip playback (.vrma — VRM Animation, VRMC_vrm_animation) ------
// A clip is CONTENT (a humanoid-retargetable file in /assets/vrma/); which clip
// an avatar plays is DATA: `mesh.vrm.animation = { clip, loop, speed, fade }`.
// createVRMAnimationClip retargets the clip to THIS avatar's proportions, so
// one file animates every body. While a clip owns the skeleton the procedural
// idle yields (expressions/blink stay live unless the clip drives them).
const vrmaCache = new Map(); // src -> Promise<VRMAnimation>

export function loadVRMA(src) {
  if (!vrmaCache.has(src)) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    vrmaCache.set(
      src,
      loader.loadAsync(src).then((gltf) => {
        const anim = gltf.userData.vrmAnimations?.[0];
        if (!anim) throw new Error(`no VRMC_vrm_animation in ${src}`);
        return anim;
      }),
    );
  }
  return vrmaCache.get(src);
}

export async function playClip(vrm, spec) {
  // spec: { clip: '/assets/vrma/x.vrma', loop = true, speed = 1, fade = 0.3 }
  const anim = await loadVRMA(spec.clip);
  const clip = createVRMAnimationClip(anim, vrm);
  if (!vrm.userData.mixer) vrm.userData.mixer = new THREE.AnimationMixer(vrm.scene);
  const mixer = vrm.userData.mixer;
  const action = mixer.clipAction(clip);
  action.loop = spec.loop === false ? THREE.LoopOnce : THREE.LoopRepeat;
  action.clampWhenFinished = true;
  action.timeScale = spec.speed ?? 1;
  const prev = vrm.userData.action;
  if (prev && prev !== action) {
    action.reset();
    prev.crossFadeTo(action, spec.fade ?? 0.3, false);
    action.play();
  } else {
    action.reset().play();
  }
  vrm.userData.action = action;
  vrm.userData.clipOwnsPose = true; // idle yields the skeleton
  return action;
}

export function stopClip(vrm, fade = 0.3) {
  vrm.userData.action?.fadeOut(fade);
  vrm.userData.action = null;
  // idle reclaims the skeleton after the fade
  setTimeout(() => {
    if (!vrm.userData.action) vrm.userData.clipOwnsPose = false;
  }, fade * 1000 + 50);
}

// ---- registry: live VRM instances needing per-frame update -------------------
// view.js registers each mounted avatar; the render loop ticks them (idle
// pose first, then vrm.update drives expressions + spring bones + lookAt).
export const liveVrms = new Set();
let _idleT = 0;

export function updateVrms(dt) {
  _idleT += dt;
  for (const vrm of liveVrms) {
    // locomotion nerve: velocity measured from the entity group's world
    // position — whatever moves the entity (intents, behaviors, ops) makes
    // the body walk, no coupling to any mover
    const grp = vrm.userData?.group;
    if (grp && dt > 0) {
      // velocity over a sliding window, not per-frame: server-driven movers
      // arrive as impulses (one jump, then stillness) and per-frame smoothing
      // reads that as speed≈0 — rain convicted it (#rain !STIFF: body sliding
      // at 3m/s with dead stride columns). The window spreads impulses into
      // a continuous speed, so streamed motion walks like local motion.
      const p = grp.position;
      const hist = vrm._posHist ?? (vrm._posHist = []);
      hist.push([_idleT, p.x, p.z]);
      while (hist.length > 2 && _idleT - hist[0][0] > 0.45) hist.shift();
      const [t0, x0, z0] = hist[0];
      const span = _idleT - t0;
      if (span > 0.08) {
        const dx = p.x - x0;
        const dz = p.z - z0;
        const v = Math.hypot(dx, dz) / span;
        vrm.userData.speed = v;
        // face the direction of travel: the body turns, not just slides.
        // heading is relative to the group's own yaw (transform owns the group).
        // +π: after rotateVRM0 the mesh faces -Z at yaw 0 — convicted by rain
        // (#rain proprio err≈180, walking backwards) and corrected empirically.
        if (v > 0.15) {
          const heading = Math.atan2(dx, dz) - grp.rotation.y + Math.PI;
          const cur = vrm.scene.rotation.y;
          let diff = heading - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          vrm.scene.rotation.y = cur + diff * Math.min(1, dt * 8);
        }
      }
    }
    // who owns the skeleton, in priority order: dance > clip > walk > idle.
    // Blink stays procedural in every state (ours always blink).
    const u = vrm.userData ?? {};
    const blinkOnly = { ...(u.idle || {}), breath: 0, sway: 0, arms: 0 };
    if (u.dance) {
      applyDance(vrm, _idleT, u.dance);
      if (u.idle !== false) applyIdle(vrm, _idleT, blinkOnly);
    } else if (u.clipOwnsPose) {
      u.mixer?.update(dt);
      if (u.idle !== false) applyIdle(vrm, _idleT, blinkOnly);
    } else if ((u.speed ?? 0) > 0.04) {
      applyWalk(vrm, _idleT, u.speed);
      if (u.idle !== false) applyIdle(vrm, _idleT, blinkOnly);
    } else if (u.idle !== false) {
      vrm._walkPhase = 0;
      applyIdle(vrm, _idleT, u.idle);
    }
    vrm.update(dt);
  }
}
