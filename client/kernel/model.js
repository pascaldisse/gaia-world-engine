// Static prop/architecture model loading — real extracted geometry (e.g.
// converted FromSoftware FLVER->OBJ chalice-dungeon pieces), as opposed to
// the procedural primitive shapes in geometry.js. Mirrors vrm.js's loadVRM:
// fetch bytes, parse, normalize (shadows, `solid` default), return an
// Object3D. `mesh.model = { src, scale?, position?, rotation? }` on an
// entity mounts it as one mesh-part child (see view.js applyMesh).
//
// OBJ only for now (our converted assets have no .mtl — geometry-only), so
// a single shared material is applied to every mesh in the loaded object;
// pass `materialPart` (a geometry.js `part`-shaped descriptor, e.g.
// `{ preset: 'stone', material: 'labyrinthStone' }`) to control it.

import * as THREE from 'three/webgpu';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { makePartMaterial } from './geometry.js';

const objCache = new Map(); // src -> Promise<Group> (raw parse, not yet cloned per-use)

function parseOBJ(src) {
  if (!objCache.has(src)) {
    objCache.set(
      src,
      fetch(src)
        .then((res) => {
          if (!res.ok) throw new Error(`model fetch ${src} -> ${res.status}`);
          return res.text();
        })
        .then((text) => new OBJLoader().parse(text)),
    );
  }
  return objCache.get(src);
}

export async function loadModel(src, materialPart) {
  const raw = await parseOBJ(src);
  const group = raw.clone(true); // cache holds the parsed template; every mount gets its own instance
  const material = makePartMaterial(materialPart ?? { preset: 'stone', material: 'labyrinthStone' });
  group.traverse((obj) => {
    if (obj.isMesh) {
      obj.material = material;
      obj.castShadow = true;
      obj.receiveShadow = true;
      obj.userData.solid = true; // architecture pieces block movement by default
    }
  });
  return group;
}
