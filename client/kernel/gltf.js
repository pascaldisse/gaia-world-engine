import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GAIA_PORT } from './port.js';

export function disposeGltf(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of [].concat(object.material ?? [])) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

export async function mountGltf(group, spec, token, onReady = () => {}, { loader = new GLTFLoader() } = {}) {
  const url = new URL(spec.src, `http://${location.hostname}:${GAIA_PORT}/`).href;
  group.userData.gltfStatus = 'loading';
  try {
    const result = await loader.loadAsync(url), root = result.scene;
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
