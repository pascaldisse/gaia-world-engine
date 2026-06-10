import * as THREE from 'three/webgpu';
import { buildTerrainMesh, heightAt, setActiveTerrain } from './terrain.js';

// Reconciles world store documents into three.js objects. Each entity gets a
// Group; components map onto children/properties of that group.
export class View {
  constructor({ scene, store, audio }) {
    this.scene = scene;
    this.store = store;
    this.audio = audio;
    this.groups = new Map();
    this.lights = new Map();
    this.sounds = new Map();
    store.onChange((event) => this.handle(event));
  }

  handle(event) {
    if (event.kind === 'snapshot') this.rebuildAll();
    else if (event.kind === 'spawn') this.build(event.id);
    else if (event.kind === 'despawn') this.remove(event.id);
    else if (event.kind === 'set') this.applyComponent(event.id, event.component);
  }

  rebuildAll() {
    for (const id of [...this.groups.keys()]) this.remove(id);
    for (const id of this.store.entities.keys()) this.build(id);
  }

  build(id) {
    this.remove(id);
    const components = this.store.get(id);
    if (!components) return;
    const group = new THREE.Group();
    group.name = id;
    this.groups.set(id, group);
    this.scene.add(group);
    // terrain first so grounded transforms in the same entity resolve correctly
    const names = Object.keys(components).sort((a, b) => (a === 'terrain' ? -1 : b === 'terrain' ? 1 : 0));
    for (const name of names) this.applyComponent(id, name);
  }

  applyComponent(id, name) {
    const group = this.groups.get(id);
    const components = this.store.get(id);
    if (!group || !components) return;
    const value = components[name];
    switch (name) {
      case 'transform':
      case 'ground':
        this.applyTransform(id);
        break;
      case 'mesh':
        this.applyMesh(group, value);
        break;
      case 'light':
        this.applyLight(id, group, value);
        break;
      case 'sound':
        this.applySound(id, group, value);
        break;
      case 'terrain':
        this.applyTerrain(group, value);
        this.resnapGrounded();
        break;
    }
  }

  applyTransform(id) {
    const group = this.groups.get(id);
    const components = this.store.get(id);
    const t = components.transform ?? {};
    const [x, y, z] = t.position ?? [0, 0, 0];
    const py = components.ground ? heightAt(x, z) + (components.ground.offset ?? 0) : y;
    group.position.set(x, py, z);
    const [rx, ry, rz] = t.rotation ?? [0, 0, 0];
    group.rotation.set(rx, ry, rz);
    const s = t.scale ?? 1;
    if (Array.isArray(s)) group.scale.set(s[0], s[1], s[2]);
    else group.scale.setScalar(s);
    group.userData.base = { position: [x, py, z], rotation: [rx, ry, rz], scale: s };
  }

  applyMesh(group, recipe) {
    for (const child of [...group.children]) {
      if (child.userData.kind === 'mesh-part') {
        disposeObject(child);
        group.remove(child);
      }
    }
    if (!recipe) return;
    const parts = recipe.parts ?? [recipe];
    for (const part of parts) {
      const material = new THREE.MeshStandardMaterial({
        color: part.color ?? '#9aa0a6',
        roughness: part.roughness ?? 0.8,
        metalness: part.metalness ?? 0,
        flatShading: part.flatShading ?? false,
      });
      if (part.emissive) {
        material.emissive = new THREE.Color(part.emissive);
        material.emissiveIntensity = part.emissiveIntensity ?? 1;
      }
      if (part.opacity !== undefined && part.opacity < 1) {
        material.transparent = true;
        material.opacity = part.opacity;
      }
      const mesh = new THREE.Mesh(makeGeometry(part), material);
      mesh.position.set(...(part.position ?? [0, 0, 0]));
      mesh.rotation.set(...(part.rotation ?? [0, 0, 0]));
      if (part.scale) {
        if (Array.isArray(part.scale)) mesh.scale.set(...part.scale);
        else mesh.scale.setScalar(part.scale);
      }
      mesh.castShadow = part.castShadow ?? true;
      mesh.receiveShadow = true;
      mesh.userData.kind = 'mesh-part';
      group.add(mesh);
    }
  }

  applyLight(id, group, value) {
    const existing = this.lights.get(id);
    if (existing) {
      group.remove(existing);
      existing.dispose?.();
      this.lights.delete(id);
    }
    if (!value) return;
    let light;
    switch (value.type) {
      case 'spot':
        light = new THREE.SpotLight(value.color ?? '#ffffff', value.intensity ?? 10, value.distance ?? 0, value.angle ?? Math.PI / 5);
        break;
      case 'directional':
        light = new THREE.DirectionalLight(value.color ?? '#ffffff', value.intensity ?? 1);
        break;
      default:
        light = new THREE.PointLight(value.color ?? '#ffffff', value.intensity ?? 10, value.distance ?? 0);
    }
    light.position.set(...(value.offset ?? [0, 0, 0]));
    light.castShadow = value.castShadow ?? false;
    light.userData.baseIntensity = light.intensity;
    this.lights.set(id, light);
    group.add(light);
  }

  applySound(id, group, value) {
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    if (!value) return;
    this.sounds.set(id, this.audio.attach(group, value));
  }

  applyTerrain(group, value) {
    for (const child of [...group.children]) {
      if (child.userData.kind === 'terrain') {
        disposeObject(child);
        group.remove(child);
      }
    }
    if (!value) {
      setActiveTerrain(null);
      return;
    }
    const mesh = buildTerrainMesh(value);
    mesh.userData.kind = 'terrain';
    group.add(mesh);
  }

  resnapGrounded() {
    for (const [id, components] of this.store.entities) {
      if (components.ground && this.groups.has(id)) this.applyTransform(id);
    }
  }

  remove(id) {
    const group = this.groups.get(id);
    if (!group) return;
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    this.lights.delete(id);
    disposeObject(group);
    this.scene.remove(group);
    this.groups.delete(id);
  }

  getGroup(id) {
    return this.groups.get(id);
  }

  getLight(id) {
    return this.lights.get(id);
  }
}

function makeGeometry(part) {
  switch (part.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(part.radius ?? 0.5, 24, 16);
    case 'cylinder':
      return new THREE.CylinderGeometry(
        part.radiusTop ?? part.radius ?? 0.5,
        part.radiusBottom ?? part.radius ?? 0.5,
        part.height ?? 1,
        16,
      );
    case 'cone':
      return new THREE.ConeGeometry(part.radius ?? 0.5, part.height ?? 1, 16);
    case 'torus':
      return new THREE.TorusGeometry(part.radius ?? 1, part.tube ?? 0.3, 12, 32);
    case 'octahedron':
      return new THREE.OctahedronGeometry(part.radius ?? 0.5, 0);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(part.radius ?? 0.5, 0);
    case 'plane':
      return new THREE.PlaneGeometry(part.size?.[0] ?? 1, part.size?.[1] ?? 1);
    default:
      return new THREE.BoxGeometry(...(part.size ?? [1, 1, 1]));
  }
}

function disposeObject(object) {
  object.traverse((node) => {
    node.geometry?.dispose();
    if (node.material) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) material.dispose();
    }
  });
}
