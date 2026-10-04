import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// § Per-URL template cache (per loader). N entities with one src = ONE fetch/parse + ONE GPU copy of geometry/textures.
// Instance = SkeletonUtils clone (skins rebound) · geometry + textures SHARED (userData.shared → skipped by
// disposeGltf/geometry.disposeOwn) · materials CLONED per instance (games tint/fade per entity). Template never mounted.
// Failed load → entry evicted (retry possible).
// § Refcount eviction: every mountGltf takes a LEASE on its URL entry when it starts (in-flight mounts pin the entry) and
// releases it when the instance is disposed (disposeGltf / releaseGltf; view.js disposeObject calls releaseGltf) or the mount
// drops (stale token / load error). Lease count 0 → entry leaves the cache and the template's shared geometry + textures +
// template materials are disposed (once; idempotent per lease). Next mount of that URL reloads.
// § Ownership rule (game side may free shared resources itself, e.g. EE client/animation.js alternates, listener-guarded):
// the engine disposes a template's shared geometry/textures at lease-count 0 UNLESS they already fired 'dispose' since the entry's
// last acquire (game freed them → no second dispose event). A new acquire resets that flag (resource in use again → may re-upload).
// If the engine frees first, the game's guard sees the 'dispose' event and skips. Leases the game never releases → entry just
// stays cached (status quo, never a premature free).
const DEFAULT_LOADER = new GLTFLoader(), TEMPLATES = new WeakMap(), LEASES = new WeakMap();
const sharedResources = scene => {
  const out = new Set();
  scene.traverse(object => {
    if (object.geometry) out.add(object.geometry);
    for (const material of [].concat(object.material ?? [])) for (const value of Object.values(material)) if (value?.isTexture) out.add(value);
  });
  return out;
};
function freeTemplate(entry) {
  const scene = entry.scene; if (!scene) return;
  entry.scene = null;
  const materials = new Set();
  scene.traverse(object => { for (const material of [].concat(object.material ?? [])) materials.add(material); });
  for (const resource of sharedResources(scene)) {
    resource.removeEventListener('dispose', entry.onFreed);
    if (!entry.freed.has(resource)) resource.dispose();
  }
  for (const material of materials) material.dispose();
}
function lease(loader, url) {
  let byUrl = TEMPLATES.get(loader);
  if (!byUrl) TEMPLATES.set(loader, byUrl = new Map());
  let entry = byUrl.get(url);
  if (!entry) {
    entry = { refs: 0, scene: null, freed: new WeakSet(), pending: null };
    const owner = entry;
    owner.onFreed = event => owner.freed.add(event.target);
    owner.pending = loader.loadAsync(url).then(result => {
      result.scene.traverse(object => {
        if (object.geometry) object.geometry.userData.shared = true;
        for (const material of [].concat(object.material ?? []))
          for (const value of Object.values(material)) if (value?.isTexture) value.userData.shared = true;
      });
      for (const resource of sharedResources(result.scene)) resource.addEventListener('dispose', owner.onFreed);
      owner.scene = result.scene;
      return result.scene;
    });
    owner.pending.catch(() => { if (byUrl.get(url) === owner) byUrl.delete(url); });
    byUrl.set(url, entry);
  }
  entry.refs++; entry.freed = new WeakSet();
  let released = false;
  return { entry, release() {
    if (released) return; released = true;
    if (--entry.refs > 0) return;
    if (byUrl.get(url) === entry) byUrl.delete(url);
    freeTemplate(entry); // release happens only after the load landed (instance exists) or failed (scene null → no-op)
  } };
}
function instance(scene) {
  const root = cloneSkinned(scene);
  root.traverse(object => {
    if (object.material) object.material = Array.isArray(object.material) ? object.material.map(m => m.clone()) : object.material.clone();
  });
  return root;
}
export const _gltfTemplateCache = { // tests only
  has: (loader, url) => !!TEMPLATES.get(loader)?.has(url),
  size: loader => TEMPLATES.get(loader)?.size ?? 0,
  refs: (loader, url) => TEMPLATES.get(loader)?.get(url)?.refs ?? 0,
};

// Release the URL lease of every mounted glTF root at/under `object` (idempotent). Resources are NOT touched here — the entry frees them at count 0.
export function releaseGltf(object) {
  object.traverse(node => { const held = LEASES.get(node); if (held) { LEASES.delete(node); held.release(); } });
}

export function disposeGltf(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material ?? [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const texture of textures) if (!texture.userData?.shared) texture.dispose();
  for (const material of materials) if (!material.userData?.shared) material.dispose();
  for (const geometry of geometries) if (!geometry.userData?.shared) geometry.dispose();
  releaseGltf(root);
}

export async function mountGltf(group, spec, token, onReady = () => {}, { loader = DEFAULT_LOADER } = {}) {
  // port.js reads location at module load → imported lazily so headless imports of view.js (bun/node tests) stay DOM-free
  const { GAIA_PORT } = await import('./port.js');
  const url = new URL(spec.src, `http://${location.hostname}:${GAIA_PORT}/`).href;
  group.userData.gltfStatus = 'loading';
  const held = lease(loader, url);
  let root = null;
  try {
    root = instance(await held.entry.pending);
    LEASES.set(root, held);
    if (group.userData.gltfToken !== token || !group.parent) {
      disposeGltf(root);
      return null;
    }
    root.userData.kind = 'mesh-part';
    root.scale.setScalar(spec.scale ?? 1);
    root.rotation.set(...(spec.rotation ?? [0, 0, 0]));
    root.position.set(...(spec.position ?? [0, 0, 0]));
    root.traverse(object => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      object.userData.solid = spec.solid ?? false;
    });
    group.add(root);
    group.userData.gltfStatus = 'ready';
    onReady();
    return root;
  } catch (error) {
    if (!root) held.release();
    if (group.userData.gltfToken === token && group.parent) {
      group.userData.gltfStatus = 'error';
      console.error('glTF load failed', spec.src, error);
    }
    return null;
  }
}
