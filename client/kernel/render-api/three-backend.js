// render-api/three-backend.js — backend #1: three.js (WebGPURenderer). Implements interface.js on top of the
// existing kernel (geometry.js caches + presets/transmission materials). Behaviour = the code it replaced.
//
// Beyond the data-only interface this backend ALSO exposes three-only TRANSITIONAL adapters, listed in
// `capabilities` and never to be called from backend-neutral code:
//   createMeshFromRecipe(part)  recipe → cached BufferGeometry (tessellation still lives in geometry.js, imports three)
//   adoptNode(Object3D) → NodeId   register a game/kernel-owned three Group so instances can parent into it
//   nativeNode(NodeId) → Object3D  escape hatch for code that still talks three (editor picking, nebula cull list)
import * as THREE from 'three/webgpu';
import { makeGeometry, makePartMaterial, disposeOwn } from '../geometry.js';
import { RENDER_API_VERSION, validateMeshArrays, isMat4 } from './interface.js';

const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap'];

export function createThreeBackend({ scene, camera = null, renderer = null, draw = null } = {}) {
  if (!scene) throw new Error('createThreeBackend requires { scene }');
  let next = 1;
  const meshes = new Map();     // MeshId → { geometry, cached }
  const materials = new Map();  // MaterialId → { material, cached }
  const nodes = new Map();      // NodeId → { object, adopted }
  const lights = new Map();     // LightId → Light
  const meshByGeometry = new Map();   // cache-owned geometry → MeshId (recipe handles are deduped)
  const materialByObject = new Map(); // cache-owned material → MaterialId
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();

  const need = (map, id, what) => {
    const v = map.get(id);
    if (!v) throw new Error(`render-api(three): unknown ${what} ${id}`);
    return v;
  };
  const colorOf = (c) => (Array.isArray(c) ? _c.setRGB(c[0], c[1], c[2]).clone() : new THREE.Color(c));

  function applyMat4(object, mat4, euler) {
    if (!isMat4(mat4)) throw new Error('render-api(three): mat4 must be 16 finite numbers');
    _m.fromArray(mat4);
    _m.decompose(_p, _q, _s);
    object.position.copy(_p);
    object.scale.copy(_s);
    if (euler) object.rotation.set(euler[0], euler[1], euler[2]);
    else object.quaternion.copy(_q);
  }
  function applyFlags(object, f) {
    if (!f) return;
    if (f.castShadow !== undefined) object.castShadow = !!f.castShadow;
    if (f.receiveShadow !== undefined) object.receiveShadow = !!f.receiveShadow;
    if (f.visible !== undefined) object.visible = !!f.visible;
    if (f.renderOrder !== undefined) object.renderOrder = f.renderOrder;
    if (f.tags) Object.assign(object.userData, f.tags);
  }
  const register = (object, adopted = false) => {
    const id = next++;
    nodes.set(id, { object, adopted });
    object.userData.renderNodeId = id;
    return id;
  };

  const backend = {
    name: 'three',
    apiVersion: RENDER_API_VERSION,
    capabilities: ['mesh-arrays', 'recipe-mesh', 'pbr', 'presets', 'textures-rgba8', 'instances', 'nodes', 'sun', 'point-lights', 'native-node'],

    // ── geometry
    createMesh(arrays) {
      validateMeshArrays(arrays);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
      if (arrays.normals) g.setAttribute('normal', new THREE.BufferAttribute(arrays.normals, 3));
      if (arrays.uvs) g.setAttribute('uv', new THREE.BufferAttribute(arrays.uvs, 2));
      if (arrays.indices) g.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
      if (!arrays.normals) g.computeVertexNormals();
      g.computeBoundingSphere();
      const id = next++;
      meshes.set(id, { geometry: g, cached: false });
      return id;
    },
    createMeshFromRecipe(part) {
      const g = makeGeometry(part); // cache-shared (userData.shared)
      let id = meshByGeometry.get(g);
      if (!id) {
        id = next++;
        meshes.set(id, { geometry: g, cached: true });
        meshByGeometry.set(g, id);
      }
      return id;
    },
    destroyMesh(id) {
      const m = need(meshes, id, 'mesh');
      if (m.cached) return; // cache-owned: lives as long as the recipe cache
      m.geometry.dispose();
      meshes.delete(id);
    },

    // ── materials
    createMaterial(params = {}, textures = null) {
      const base = makePartMaterial(params); // library resolution + presets + transmission + cache, unchanged
      const hasTex = textures && TEXTURE_SLOTS.some((k) => textures[k]);
      if (!hasTex) {
        let id = materialByObject.get(base);
        if (!id) {
          id = next++;
          materials.set(id, { material: base, cached: true });
          materialByObject.set(base, id);
        }
        return id;
      }
      const material = base.clone(); // textures are per-handle: never mutate the shared recipe material
      material.userData = { ...base.userData, shared: false };
      for (const slot of TEXTURE_SLOTS) {
        const t = textures[slot];
        if (!t) continue;
        if (!t.data || !(t.width > 0) || !(t.height > 0)) throw new Error(`createMaterial: texture ${slot} needs { width, height, data }`);
        const tex = new THREE.DataTexture(t.data, t.width, t.height, THREE.RGBAFormat);
        tex.colorSpace = t.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        material[slot] = tex;
      }
      material.needsUpdate = true;
      const id = next++;
      materials.set(id, { material, cached: false });
      return id;
    },
    destroyMaterial(id) {
      const m = need(materials, id, 'material');
      if (m.cached) return;
      for (const slot of TEXTURE_SLOTS) m.material[slot]?.dispose?.();
      m.material.dispose();
      materials.delete(id);
    },

    // ── scene nodes
    createNode(mat4, parent = 0) {
      const g = new THREE.Group();
      applyMat4(g, mat4);
      (parent ? need(nodes, parent, 'node').object : scene).add(g);
      return register(g);
    },
    createInstance(meshId, materialId, mat4, flags = {}) {
      const mesh = new THREE.Mesh(need(meshes, meshId, 'mesh').geometry, need(materials, materialId, 'material').material);
      applyMat4(mesh, mat4, flags.euler);
      applyFlags(mesh, flags);
      (flags.parent ? need(nodes, flags.parent, 'node').object : scene).add(mesh);
      return register(mesh);
    },
    updateNode(id, u = {}) {
      const { object } = need(nodes, id, 'node');
      if (u.mat4) applyMat4(object, u.mat4, u.euler);
      if (u.material !== undefined) object.material = need(materials, u.material, 'material').material;
      applyFlags(object, u);
    },
    removeNode(id) {
      const n = need(nodes, id, 'node');
      nodes.delete(id);
      delete n.object.userData.renderNodeId;
      if (n.adopted) return; // owner keeps the object; only the handle goes
      n.object.parent?.remove(n.object);
      n.object.traverse((o) => { if (o.userData?.renderNodeId) { nodes.delete(o.userData.renderNodeId); delete o.userData.renderNodeId; } disposeOwn(o); });
    },
    adoptNode(object) {
      return object.userData.renderNodeId ?? register(object, true);
    },
    nativeNode(id) {
      return need(nodes, id, 'node').object;
    },

    // ── camera / lights
    setCamera(view, proj) {
      if (!camera) throw new Error('render-api(three): setCamera needs a camera');
      if (!isMat4(view) || !isMat4(proj)) throw new Error('setCamera: view/proj must be mat4');
      camera.matrixAutoUpdate = false;
      camera.matrixWorldAutoUpdate = false;
      camera.matrixWorldInverse.fromArray(view);
      camera.matrixWorld.copy(camera.matrixWorldInverse).invert();
      camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
      camera.matrix.copy(camera.matrixWorld);
      camera.projectionMatrix.fromArray(proj);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    },
    setSun({ direction, color = [1, 1, 1], intensity = 1, castShadow = false }) {
      const light = new THREE.DirectionalLight(colorOf(color), intensity);
      light.position.set(direction[0], direction[1], direction[2]).multiplyScalar(100);
      light.castShadow = !!castShadow;
      scene.add(light);
      const id = next++;
      lights.set(id, light);
      return id;
    },
    addPointLight({ position, color = [1, 1, 1], intensity = 1, distance = 0, decay = 2 }) {
      const light = new THREE.PointLight(colorOf(color), intensity, distance, decay);
      light.position.set(position[0], position[1], position[2]);
      scene.add(light);
      const id = next++;
      lights.set(id, light);
      return id;
    },
    updatePointLight(id, u = {}) {
      const l = need(lights, id, 'light');
      if (u.position) l.position.set(u.position[0], u.position[1], u.position[2]);
      if (u.color) l.color.copy(colorOf(u.color));
      if (u.intensity !== undefined) l.intensity = u.intensity;
      if (u.distance !== undefined) l.distance = u.distance;
      if (u.decay !== undefined) l.decay = u.decay;
    },
    removeLight(id) {
      const l = need(lights, id, 'light');
      scene.remove(l);
      l.dispose?.();
      lights.delete(id);
    },

    // ── frame
    renderFrame(dt) {
      if (draw) return draw(dt); // the kernel's existing frame path (post chain / GI / exposure) stays authoritative this round
      if (!renderer || !camera) throw new Error('renderFrame: no draw() and no renderer+camera');
      return renderer.render(scene, camera);
    },
    resize(renderHeight) {
      if (!(renderHeight > 0)) throw new Error('resize: renderHeight must be > 0');
      if (!renderer) return;
      const el = renderer.domElement;
      const h = el?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : renderHeight);
      const w = el?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : renderHeight);
      renderer.setPixelRatio(renderHeight / h);
      renderer.setSize(w, h, false);
    },
    dispose() {
      for (const id of [...nodes.keys()]) backend.removeNode(id);
      for (const id of [...lights.keys()]) backend.removeLight(id);
      for (const id of [...materials.keys()]) backend.destroyMaterial(id);
      for (const id of [...meshes.keys()]) backend.destroyMesh(id);
    },
  };
  return backend;
}

// backend selection by engine config, default three; other names register here (native/wgpu later).
const FACTORIES = { three: createThreeBackend };
export function registerBackend(name, factory) { FACTORIES[name] = factory; }
export function createBackend(name = 'three', opts) {
  const f = FACTORIES[name];
  if (!f) throw new Error(`unknown render backend '${name}' (have: ${Object.keys(FACTORIES).join(', ')})`);
  return f(opts);
}
