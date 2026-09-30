import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// § Per-URL template cache (per loader). N entities with one src = ONE fetch/parse + ONE GPU copy of geometry/textures.
// Instance = SkeletonUtils clone (skins rebound) · geometry + textures SHARED (userData.shared → skipped by
// disposeGltf/geometry.disposeOwn) · materials CLONED per instance (games tint/fade per entity). Template never mounted.
// Failed load → entry evicted (retry possible).
const DEFAULT_LOADER = new GLTFLoader(), TEMPLATES = new WeakMap();
function template(loader, url) {
  let byUrl = TEMPLATES.get(loader);
  if (!byUrl) TEMPLATES.set(loader, byUrl = new Map());
  let pending = byUrl.get(url);
  if (!pending) {
    pending = loader.loadAsync(url).then(result => {
      result.scene.traverse(object => {
        if (object.geometry) object.geometry.userData.shared = true;
        for (const material of [].concat(object.material ?? []))
          for (const value of Object.values(material)) if (value?.isTexture) value.userData.shared = true;
      });
      return result.scene;
    });
    pending.catch(() => { if (byUrl.get(url) === pending) byUrl.delete(url); });
    byUrl.set(url, pending);
  }
  return pending;
}
function instance(scene) {
  const root = cloneSkinned(scene);
  root.traverse(object => {
    if (object.material) object.material = Array.isArray(object.material) ? object.material.map(m => m.clone()) : object.material.clone();
  });
  return root;
}
export const _gltfTemplateCache = { has: (loader, url) => !!TEMPLATES.get(loader)?.has(url) }; // tests only

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
}

export async function mountGltf(group, spec, token, onReady = () => {}, { loader = DEFAULT_LOADER } = {}) {
  // port.js reads location at module load → imported lazily so headless imports of view.js (bun/node tests) stay DOM-free
  const { GAIA_PORT } = await import('./port.js');
  const url = new URL(spec.src, `http://${location.hostname}:${GAIA_PORT}/`).href;
  group.userData.gltfStatus = 'loading';
  try {
    const root = instance(await template(loader, url));
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
    if (group.userData.gltfToken === token && group.parent) {
      group.userData.gltfStatus = 'error';
      console.error('glTF load failed', spec.src, error);
    }
    return null;
  }
}
