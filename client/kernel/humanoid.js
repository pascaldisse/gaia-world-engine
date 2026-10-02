// Humanoid kit — THREE glue: load / rebind / apply. Data core + spec: shared/humanoid.js,
// docs/HUMANOID-KIT-SPEC.md. `mesh.humanoid = { preset, base, params, bones, costume, colors, seed }`.
//
// One base GLB (any glTF humanoid), costume pieces skinned to the same rest pose, rebound BY BONE
// NAME at mount; body params become bone scales; color slots pick SHARED materials.
//   GPU once: geometry + textures live in a per-URL template cache (userData.shared); a recolored
//   material is one clone per (source material, hex) shared by every instance, refcounted — NEVER
//   per-instance clones, NEVER mutating a template material (AGENTS.md perf law).
//   per instance: SkeletonUtils clone of the base + one Skeleton per skinned piece mesh.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  canonicalBone, loadPresetChain, resolveHumanoid, solveBoneScales, slotOfMaterial,
  measureLengthAxis, NEXT_BONE, DEFAULT_COLOR_SLOTS, validateHumanoid,
} from '../../shared/humanoid.js';

const DEFAULT_LOADER = new GLTFLoader();
const TEMPLATES = new WeakMap(); // loader -> Map(url -> Promise<template>)
const PRESETS = new Map(); // url -> Promise<json>
const DRIFT = new Map(); // `${baseUrl}|${pieceUrl}` -> [{bone, drift}]
const DRIFT_EPS = 1e-3;

// ---- shared material cache (refcounted) --------------------------------------
const MATERIALS = new Map(); // `${srcUuid}|${hex}` -> { material, refs }
export function acquireMaterial(src, hex) {
  const key = `${src.uuid}|${hex}`;
  let e = MATERIALS.get(key);
  if (!e) {
    const material = src.clone();
    material.color?.set(hex);
    material.name = `${src.name}@${hex}`;
    material.userData = { ...material.userData, shared: true, humanoidTint: hex }; // disposeOwn leaves it alone
    MATERIALS.set(key, e = { material, refs: 0 });
  }
  e.refs++;
  return { key, material: e.material };
}
export function releaseMaterial(key) {
  const e = MATERIALS.get(key);
  if (!e) return;
  if (--e.refs <= 0) {
    MATERIALS.delete(key);
    e.material.dispose();
  }
}
export const humanoidStats = () => ({ materials: MATERIALS.size, refs: [...MATERIALS.values()].reduce((s, e) => s + e.refs, 0), keys: [...MATERIALS.keys()] });

// ---- rig helpers --------------------------------------------------------------
const boneLike = (o) => !o.isMesh && canonicalBone(o.name) !== null;
// canonical → Object3D (first wins) over a subtree
export function indexBones(root) {
  const out = new Map();
  root.traverse((o) => {
    if (!boneLike(o)) return;
    const c = canonicalBone(o.name);
    if (!out.has(c)) out.set(c, o);
  });
  return out;
}
// per canonical bone: index (0 x, 1 y, 2 z) of the bone-LOCAL axis pointing at the next bone in the
// humanoid chain (measured from rest-pose world positions); leaves inherit their parent's axis
export function measureAxes(bones) {
  const axes = {};
  const wp = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
  const q = new THREE.Quaternion();
  for (const [name, nexts] of Object.entries(NEXT_BONE)) {
    const bone = bones.get(name);
    const next = nexts.map((n) => bones.get(n)).find(Boolean);
    if (!bone || !next) continue;
    const dir = wp(next).sub(wp(bone));
    bone.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    dir.applyQuaternion(q.invert());
    axes[name] = measureLengthAxis([dir.x, dir.y, dir.z]);
  }
  return axes;
}
export function matrixDrift(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a.elements[i] - b.elements[i]));
  return d;
}

function markShared(scene) {
  scene.traverse((o) => {
    if (o.geometry) o.geometry.userData.shared = true;
    for (const m of [].concat(o.material ?? [])) {
      m.userData.shared = true;
      for (const v of Object.values(m)) if (v?.isTexture) v.userData.shared = true;
    }
  });
}

// ---- template preparation -------------------------------------------------------
function prepareBase(scene) {
  scene.updateMatrixWorld(true);
  markShared(scene);
  const bones = indexBones(scene);
  const inverses = new Map(); // canonical → bind inverse (first skinned mesh that has it)
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    o.skeleton.bones.forEach((b, i) => {
      const c = canonicalBone(b.name);
      if (c && !inverses.has(c)) inverses.set(c, o.skeleton.boneInverses[i]);
    });
  });
  const feet = ['leftFoot', 'rightFoot'].map((n) => bones.get(n)).filter(Boolean);
  const footY = feet.length ? Math.min(...feet.map((f) => new THREE.Vector3().setFromMatrixPosition(f.matrixWorld).y)) : null;
  return { kind: 'base', scene, axes: measureAxes(bones), inverses, footY };
}

// ancestors-or-self that resolve to a canonical bone, nearest first, each with its bind inverse
function chainOf(node, inverseOf) {
  const chain = [];
  for (let n = node; n; n = n.parent) {
    const c = boneLike(n) ? canonicalBone(n.name) : null;
    if (c && !chain.some((e) => e.canon === c)) chain.push({ canon: c, inverse: inverseOf(n) });
  }
  return chain;
}

function preparePiece(scene) {
  scene.updateMatrixWorld(true);
  markShared(scene);
  const skinned = [];
  const rigid = [];
  scene.traverse((o) => {
    if (o.isSkinnedMesh) {
      const bones = o.skeleton.bones;
      const inverseOf = (n) => { const i = bones.indexOf(n); return i >= 0 ? o.skeleton.boneInverses[i] : n.matrixWorld.clone().invert(); };
      skinned.push({
        mesh: o, geometry: o.geometry, material: o.material, bindMatrix: o.bindMatrix.clone(),
        boneInverses: o.skeleton.boneInverses, chains: bones.map((b) => chainOf(b, inverseOf)),
      });
    } else if (o.isMesh) {
      const chain = chainOf(o.parent, () => null);
      const anchorNode = (() => { for (let n = o.parent; n; n = n.parent) if (boneLike(n)) return n; return null; })();
      const rel = anchorNode ? anchorNode.matrixWorld.clone().invert().multiply(o.matrixWorld) : o.matrixWorld.clone();
      rigid.push({ mesh: o, anchor: chain[0]?.canon ?? null, rel });
    }
  });
  return { kind: 'piece', scene, skinned, rigid };
}

function template(loader, url, prepare) {
  let byUrl = TEMPLATES.get(loader);
  if (!byUrl) TEMPLATES.set(loader, (byUrl = new Map()));
  const slot = `${prepare === prepareBase ? 'base' : 'piece'}|${url}`;
  let pending = byUrl.get(slot);
  if (!pending) {
    pending = loader.loadAsync(url).then((r) => prepare(r.scene));
    pending.catch(() => { if (byUrl.get(slot) === pending) byUrl.delete(slot); });
    byUrl.set(slot, pending);
  }
  return pending;
}

// ---- defaults (browser) ---------------------------------------------------------
// `http(s)://` as-is · `/x` → client origin (engine-bundled /assets/…) · `x` → world asset on the world server
export async function resolveAssetUrl(src) {
  if (/^https?:/i.test(src) || src.startsWith('/')) return src;
  const { GAIA_PORT } = await import('./port.js'); // lazy: headless imports stay DOM-free
  return new URL(src, `http://${location.hostname}:${GAIA_PORT}/`).href;
}
export function fetchAssetJson(url) {
  let p = PRESETS.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`humanoid preset fetch failed: ${url} (${r.status})`);
      return r.json();
    });
    p.catch(() => PRESETS.delete(url));
    PRESETS.set(url, p);
  }
  return p;
}

// ---- instance -------------------------------------------------------------------
async function buildInstance(concrete, deps) {
  const { loader, resolveUrl } = deps;
  const baseUrl = await resolveUrl(concrete.base);
  const baseTpl = await template(loader, baseUrl, prepareBase);
  const slotNames = [...new Set([...DEFAULT_COLOR_SLOTS, ...Object.keys(concrete.colors)])];
  const report = { drift: [], unmapped: [], failed: [] };

  // costume templates load in parallel; one bad piece never kills the unit
  const wanted = Object.entries(concrete.costume).filter(([, url]) => url);
  const loaded = await Promise.all(wanted.map(async ([slot, url]) => {
    try {
      const pieceUrl = await resolveUrl(url);
      return { slot, pieceUrl, tpl: await template(loader, pieceUrl, preparePiece) };
    } catch (error) {
      report.failed.push({ slot, url, error: String(error?.message ?? error) });
      return null;
    }
  }));

  const root = cloneSkinned(baseTpl.scene);
  const bones = indexBones(root);
  const keys = [];
  const skeletons = [];
  const colorize = (mat) => {
    const one = (m) => {
      const hex = concrete.colors[slotOfMaterial(m.name, slotNames, m.userData?.slot ?? m.userData?.extras?.slot)];
      if (!hex) return m; // untouched slot ⇒ the shared TEMPLATE material, zero clones
      const a = acquireMaterial(m, hex);
      keys.push(a.key);
      return a.material;
    };
    return Array.isArray(mat) ? mat.map(one) : one(mat);
  };
  const finishMesh = (m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.solid = false;
    if (m.isSkinnedMesh) m.frustumCulled = false; // bone scaling invalidates bind-pose bounds
  };

  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = colorize(o.material);
    finishMesh(o);
    if (o.isSkinnedMesh) skeletons.push(o.skeleton);
  });

  const pieces = {};
  for (const entry of loaded) {
    if (!entry) continue;
    const { slot, pieceUrl, tpl } = entry;
    const made = (pieces[slot] = { url: pieceUrl, meshes: [] });

    const driftKey = `${baseUrl}|${pieceUrl}`;
    if (!DRIFT.has(driftKey)) {
      const drift = [];
      const seen = new Set();
      for (const sk of tpl.skinned) for (const chain of sk.chains) {
        const direct = chain[0];
        if (!direct || seen.has(direct.canon)) continue;
        seen.add(direct.canon);
        const baseInv = baseTpl.inverses.get(direct.canon);
        if (!baseInv) continue;
        const d = matrixDrift(direct.inverse, baseInv);
        if (d > DRIFT_EPS) drift.push({ bone: direct.canon, drift: +d.toFixed(4) });
      }
      DRIFT.set(driftKey, drift);
      if (drift.length) console.warn(`[humanoid] rest-pose drift: ${pieceUrl} vs ${baseUrl}`, drift);
    }
    for (const d of DRIFT.get(driftKey)) report.drift.push({ slot, ...d });

    for (const sk of tpl.skinned) {
      const mapped = [];
      const inverses = [];
      let custom = false;
      sk.chains.forEach((chain, i) => {
        const pick = chain.findIndex((c) => bones.has(c.canon));
        if (pick === 0) {
          mapped.push(bones.get(chain[0].canon));
          inverses.push(sk.boneInverses[i]);
        } else if (pick > 0) { // folded onto the nearest mapped ancestor, with ITS bind inverse
          custom = true;
          mapped.push(bones.get(chain[pick].canon));
          inverses.push(chain[pick].inverse);
        } else { // nothing maps: ride the hips, rest-pose-correct via the base's hips inverse
          custom = true;
          const hips = bones.get('hips') ?? [...bones.values()][0];
          mapped.push(hips);
          inverses.push(baseTpl.inverses.get('hips') ?? sk.boneInverses[i]);
          report.unmapped.push({ slot, bone: sk.mesh.skeleton.bones[i].name });
        }
      });
      const mesh = new THREE.SkinnedMesh(sk.geometry, colorize(sk.material));
      mesh.name = sk.mesh.name;
      const skeleton = new THREE.Skeleton(mapped, custom ? inverses : sk.boneInverses);
      mesh.bind(skeleton, sk.bindMatrix);
      finishMesh(mesh);
      root.add(mesh);
      skeletons.push(skeleton);
      made.meshes.push(mesh);
    }

    for (const r of tpl.rigid) {
      const anchor = bones.get(r.anchor) ?? bones.get('hips');
      if (!anchor) continue;
      if (!bones.get(r.anchor)) report.unmapped.push({ slot, bone: r.mesh.name });
      const mesh = new THREE.Mesh(r.mesh.geometry, colorize(r.mesh.material));
      mesh.name = r.mesh.name;
      r.rel.decompose(mesh.position, mesh.quaternion, mesh.scale);
      finishMesh(mesh);
      anchor.add(mesh);
      made.meshes.push(mesh);
    }
  }

  // body params → bone scales (axes measured once per base template)
  const solved = solveBoneScales(concrete, { axes: baseTpl.axes, has: (b) => bones.has(b) });
  for (const [bone, s] of Object.entries(solved.bones)) bones.get(bone).scale.multiply(new THREE.Vector3(...s));
  // keep the feet planted: leg/torso params move the feet relative to the hips — lift/lower the hips so
  // the lowest foot joint sits where it did at rest (the instance origin is the ground)
  const hips = bones.get('hips');
  if (hips?.parent && baseTpl.footY !== null) {
    root.updateMatrixWorld(true);
    const feet = ['leftFoot', 'rightFoot'].map((n) => bones.get(n)).filter(Boolean);
    const y = Math.min(...feet.map((f) => new THREE.Vector3().setFromMatrixPosition(f.matrixWorld).y));
    const dy = baseTpl.footY - y;
    if (Math.abs(dy) > 1e-6) {
      const p = new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld);
      p.y += dy;
      hips.position.copy(hips.parent.worldToLocal(p));
      root.updateMatrixWorld(true);
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const k of keys) releaseMaterial(k);
    for (const s of skeletons) s.dispose();
  };
  root.userData.kind = 'mesh-part';
  root.userData.humanoid = { concrete, bones, pieces, report, axes: baseTpl.axes, rootScale: solved.root, release };
  return { root, solved };
}

export async function mountHumanoid(group, spec, token, onReady = () => {}, deps = {}) {
  const d = { loader: DEFAULT_LOADER, resolveUrl: resolveAssetUrl, fetchJson: fetchAssetJson, ...deps };
  group.userData.humanoidStatus = 'loading';
  try {
    const issues = validateHumanoid(spec);
    if (issues.length) console.warn('[humanoid] spec issues:', issues);
    const preset = spec.preset ? await loadPresetChain(spec.preset, async (u) => d.fetchJson(await d.resolveUrl(u))) : null;
    const concrete = resolveHumanoid(spec, preset);
    if (!concrete.base) throw new Error('humanoid: no base (set mesh.humanoid.base or a preset with one)');
    const { root, solved } = await buildInstance(concrete, d);
    if (group.userData.humanoidToken !== token || !group.parent) {
      root.userData.humanoid.release();
      return null;
    }
    const { place } = concrete;
    root.scale.setScalar((place.scale ?? 1) * solved.root);
    root.rotation.set(...place.rotation);
    root.position.set(...place.position);
    root.traverse((o) => { if (o.isMesh) o.userData.solid = place.solid; });
    group.add(root);
    group.userData.humanoidStatus = 'ready';
    group.userData.humanoid = root.userData.humanoid;
    onReady(root);
    return root;
  } catch (error) {
    if (group.userData.humanoidToken === token && group.parent) {
      group.userData.humanoidStatus = 'error';
      console.error('humanoid load failed', error);
    }
    return null;
  }
}

// view.js disposeObject hook — idempotent
export function releaseHumanoid(node) {
  node.userData?.humanoid?.release?.();
}

export const _humanoidCache = { has: (loader, kind, url) => !!TEMPLATES.get(loader)?.has(`${kind}|${url}`) }; // tests only
