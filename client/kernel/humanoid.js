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
  measureLengthAxis, NEXT_BONE, DEFAULT_COLOR_SLOTS, validateHumanoid, mergeSkinnedParts, deriveLodUrl, lodLevelFor,
} from '../../shared/humanoid.js';

import { loadTeamMasks, acquireTeamMaterial, releaseTeamMaterial } from './humanoid-team.js';
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
async function prepareBase(scene, gltf) {
  scene.updateMatrixWorld(true);
  markShared(scene);
  const masks = await loadTeamMasks(scene, gltf);
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
  return { kind: 'base', scene, axes: measureAxes(bones), inverses, footY, masks };
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

async function preparePiece(scene, gltf) {
  scene.updateMatrixWorld(true);
  markShared(scene);
  const masks = await loadTeamMasks(scene, gltf);
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
  return { kind: 'piece', scene, skinned, rigid, masks };
}

function template(loader, url, prepare) {
  let byUrl = TEMPLATES.get(loader);
  if (!byUrl) TEMPLATES.set(loader, (byUrl = new Map()));
  const slot = `${prepare === prepareBase ? 'base' : 'piece'}|${url}`;
  let pending = byUrl.get(slot);
  if (!pending) {
    pending = loader.loadAsync(url).then((r) => prepare(r.scene, r));
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
// ---- stage 5: template-level piece merge + LOD ------------------------------------
// All skinned parts that share ONE source material (base meshes + every costume piece, per LOD level) are
// concatenated ONCE per (level base, costume set) into a single BufferGeometry whose skinIndex is remapped
// onto a merged joint table. Per instance: ONE SkinnedMesh per merged group (≤1 draw/material/level),
// colour variants via a per-object uniform (humanoid-team.js), never a material clone.
const MERGED = new WeakMap(); // level base template -> Map(pieceKey -> merged template)
const invKey = (m) => Array.from(m.elements, (v) => Math.round(v * 1e5)).join(',');

function attrArray(attr, size) {
  if (!attr) return null;
  const out = new Float32Array(attr.count * size);
  for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) out[i * size + k] = attr.getComponent(i, k);
  return out;
}

// piece skeleton -> (template bones of the base it rebinds to, bind inverses): same rules as the per-piece path
function mapPieceSkin(sk, bones, baseTpl, report, slot) {
  const mapped = [];
  const inverses = [];
  sk.chains.forEach((chain, i) => {
    const pick = chain.findIndex((c) => bones.has(c.canon));
    if (pick === 0) {
      mapped.push(bones.get(chain[0].canon));
      inverses.push(sk.boneInverses[i]);
    } else if (pick > 0) {
      mapped.push(bones.get(chain[pick].canon));
      inverses.push(chain[pick].inverse);
    } else {
      mapped.push(bones.get('hips') ?? [...bones.values()][0]);
      inverses.push(baseTpl.inverses.get('hips') ?? sk.boneInverses[i]);
      report.unmapped.push({ slot, bone: sk.mesh.skeleton.bones[i].name });
    }
  });
  return { mapped, inverses };
}

export function mergedTemplate(levelTpl, loaded, baseTpl, report) {
  let byKey = MERGED.get(levelTpl);
  if (!byKey) MERGED.set(levelTpl, (byKey = new Map()));
  const pieceKey = loaded.map((e) => `${e.slot}=${e.pieceUrl}`).sort().join('|');
  const hit = byKey.get(pieceKey);
  if (hit) { report.unmapped.push(...hit.unmapped); return hit; }
  baseTpl.canon ??= indexBones(baseTpl.scene);
  const unmapped = [];
  const scratch = { unmapped };
  const parts = [];
  levelTpl.scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    parts.push({ mesh: o, geometry: o.geometry, material: o.material, bindMatrix: o.bindMatrix, jointNames: o.skeleton.bones.map((b) => b.name), inverses: o.skeleton.boneInverses, masks: levelTpl.masks });
  });
  for (const { slot, tpl } of loaded) {
    for (const sk of tpl.skinned) {
      const { mapped, inverses } = mapPieceSkin(sk, baseTpl.canon, baseTpl, scratch, slot);
      parts.push({ mesh: sk.mesh, geometry: sk.geometry, material: sk.material, bindMatrix: sk.bindMatrix, jointNames: mapped.map((b) => b.name), inverses, masks: tpl.masks });
    }
  }
  const buckets = new Map();
  for (const p of parts) {
    const mergeable = !Array.isArray(p.material) && !p.geometry.groups?.length;
    const key = mergeable ? `${p.material.uuid}|${invKey(p.bindMatrix)}` : `solo|${p.mesh.uuid}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const groups = [];
  for (const list of buckets.values()) {
    const joint = new Map(); // merged-joint key -> { name, inverse }
    const data = list.map((p) => {
      const keys = p.jointNames.map((n, i) => {
        const k = `${n}|${invKey(p.inverses[i])}`;
        if (!joint.has(k)) joint.set(k, { name: n, inverse: p.inverses[i] });
        return k;
      });
      const g = p.geometry;
      return {
        position: attrArray(g.attributes.position, 3), normal: attrArray(g.attributes.normal, 3), uv: attrArray(g.attributes.uv, 2),
        skinIndex: attrArray(g.attributes.skinIndex, 4), skinWeight: attrArray(g.attributes.skinWeight, 4),
        index: g.index ? g.index.array : null, jointKeys: keys,
      };
    });
    const m = mergeSkinnedParts(data);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    if (m.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
    if (m.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(m.skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(m.skinWeight, 4));
    geometry.setIndex(new THREE.BufferAttribute(m.index, 1));
    geometry.userData.shared = true; // template-owned: shared by every instance, never disposed per instance
    const infos = m.jointKeys.map((k) => joint.get(k));
    const first = list[0];
    const maskPart = list.find((p) => !Array.isArray(p.material) && p.masks?.get(p.material.uuid));
    groups.push({
      material: first.material, bindMatrix: first.bindMatrix, geometry, parts: list.length, vertexCount: m.vertexCount, indexCount: m.indexCount,
      jointNames: infos.map((j) => j.name), inverses: infos.map((j) => j.inverse),
      mask: maskPart ? maskPart.masks.get(maskPart.material.uuid) : null,
    });
  }
  const out = { groups, unmapped, parts: parts.length };
  byKey.set(pieceKey, out);
  report.unmapped.push(...unmapped);
  return out;
}

// ---- LOD: switch merged level groups by camera distance (view.update() drives the tick) ----
const LOD_LIVE = new Set();
const _lodCam = new THREE.Vector3();
export function tickHumanoidLod(camera) {
  if (!LOD_LIVE.size || !camera) return;
  camera.getWorldPosition(_lodCam);
  for (const l of LOD_LIVE) {
    const e = l.root.matrixWorld.elements;
    const d = Math.hypot(e[12] - _lodCam.x, e[13] - _lodCam.y, e[14] - _lodCam.z);
    const lvl = lodLevelFor(d, l.distances, l.cur, l.hysteresis);
    if (lvl !== l.cur) {
      l.groups[l.cur].visible = false;
      l.groups[lvl].visible = true;
      l.cur = lvl;
    }
  }
}
export const humanoidLodStats = () => { const per = {}; for (const l of LOD_LIVE) per[l.cur] = (per[l.cur] ?? 0) + 1; return { live: LOD_LIVE.size, perLevel: per }; };

async function buildMergedInstance(concrete, deps) {
  const { loader, resolveUrl } = deps;
  const baseUrl = await resolveUrl(concrete.base);
  const baseTpl = await template(loader, baseUrl, prepareBase);
  const slotNames = [...new Set([...DEFAULT_COLOR_SLOTS, ...Object.keys(concrete.colors)])];
  const report = { drift: [], unmapped: [], failed: [] };
  const wanted = Object.entries(concrete.costume).filter(([, url]) => url);
  const loaded = (await Promise.all(wanted.map(async ([slot, url]) => {
    try {
      const pieceUrl = await resolveUrl(url);
      return { slot, pieceUrl, tpl: await template(loader, pieceUrl, preparePiece) };
    } catch (error) {
      report.failed.push({ slot, url, error: String(error?.message ?? error) });
      return null;
    }
  }))).filter(Boolean);
  // LOD levels (level 0 = base); a level that fails to load is skipped, never fatal
  const levels = [baseTpl];
  const lodSpec = concrete.render?.lod;
  if (lodSpec) {
    const urls = lodSpec.bases ?? Array.from({ length: lodSpec.count }, (_, i) => deriveLodUrl(concrete.base, i + 1));
    for (const u of urls) {
      try { levels.push(await template(loader, await resolveUrl(u), prepareBase)); } catch (error) { (report.lod ??= []).push({ url: u, error: String(error?.message ?? error) }); }
    }
  }
  const root = cloneSkinned(baseTpl.scene);
  const bones = indexBones(root);
  const byName = new Map();
  root.traverse((o) => { if (!o.isMesh && !byName.has(o.name)) byName.set(o.name, o); });
  const hipsFallback = bones.get('hips') ?? [...bones.values()][0];
  const strip = [];
  root.traverse((o) => { if (o.isSkinnedMesh) strip.push(o); });
  strip.forEach((o) => o.removeFromParent()); // the merged meshes replace the cloned base meshes
  const keys = [];
  const teamKeys = [];
  const skeletons = [];
  const colorize = (mat) => {
    const one = (m) => {
      const hex = concrete.colors[slotOfMaterial(m.name, slotNames, m.userData?.slot ?? m.userData?.extras?.slot)];
      if (!hex) return m;
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
    if (m.isSkinnedMesh) m.frustumCulled = false;
  };
  root.traverse((o) => { if (o.isMesh) { o.material = colorize(o.material); finishMesh(o); } });
  const teamHex = concrete.colors.team ?? null;
  const levelGroups = [];
  const pieces = {};
  let draws = 0;
  for (const [li, levelTpl] of levels.entries()) {
    const merged = mergedTemplate(levelTpl, loaded, baseTpl, report);
    const group = new THREE.Group();
    group.name = `humanoid-lod${li}`;
    for (const g of merged.groups) {
      const jb = g.jointNames.map((n) => byName.get(n) ?? hipsFallback);
      const skeleton = new THREE.Skeleton(jb, g.inverses);
      let material = null;
      if (teamHex && g.mask && !Array.isArray(g.material)) {
        const a = await acquireTeamMaterial(g.material, g.mask);
        if (a) { teamKeys.push(a.key); material = a.material; }
      }
      const mesh = new THREE.SkinnedMesh(g.geometry, material ?? colorize(g.material));
      mesh.name = `humanoid-merged${li}`;
      mesh.bind(skeleton, g.bindMatrix);
      if (material && teamHex) mesh.userData.teamColor = teamHex;
      finishMesh(mesh);
      group.add(mesh);
      skeletons.push(skeleton);
      draws += li === 0 ? 1 : 0;
    }
    group.visible = li === 0;
    root.add(group);
    levelGroups.push(group);
  }
  for (const { slot, pieceUrl, tpl } of loaded) {
    const made = (pieces[slot] = { url: pieceUrl, meshes: [], merged: true });
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
      draws++;
    }
  }
  // body params -> bone scales + grounding (same as the per-piece path)
  const solved = solveBoneScales(concrete, { axes: baseTpl.axes, has: (b) => bones.has(b) });
  for (const [bone, s] of Object.entries(solved.bones)) bones.get(bone).scale.multiply(new THREE.Vector3(...s));
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
  const lod = levelGroups.length > 1
    ? { root, groups: levelGroups, cur: 0, distances: lodSpec.distances.slice(0, levelGroups.length - 1), hysteresis: lodSpec.hysteresis }
    : null;
  if (lod) LOD_LIVE.add(lod);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (lod) LOD_LIVE.delete(lod);
    for (const k of keys) releaseMaterial(k);
    for (const k of teamKeys) releaseTeamMaterial(k);
    for (const s of skeletons) s.dispose();
  };
  root.userData.kind = 'mesh-part';
  root.userData.humanoid = {
    concrete, bones, pieces, report, axes: baseTpl.axes, rootScale: solved.root, release, lod,
    merged: { levels: levelGroups.length, drawsPerLevel0: draws, groupsPerLevel: levelGroups.map((g) => g.children.length) },
  };
  return { root, solved };
}

async function buildInstance(concrete, deps) {
  if (concrete.render?.merge !== false) return buildMergedInstance(concrete, deps);
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
