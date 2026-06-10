import * as THREE from 'three/webgpu';
import { buildTerrainMesh, heightAt, setActiveTerrain } from './terrain.js';
import { makeGeometry, makePartMaterial } from './geometry.js';
import { buildScatter } from './scatter.js';
import { buildParticles } from './particles.js';

// Reconciles world store documents into three.js objects. Each entity gets a
// Group; components map onto children/properties of that group.
export class View {
  constructor({ scene, store, audio, effects, environment }) {
    this.scene = scene;
    this.store = store;
    this.audio = audio;
    this.effects = effects;
    this.environment = environment;
    this.groups = new Map();
    this.lights = new Map();
    this.sounds = new Map();
    this.particleSystems = new Map();
    this.suppressed = new Set();
    store.onChange((event) => this.handle(event));
  }

  handle(event) {
    if (event.kind === 'snapshot') this.rebuildAll();
    else if (event.kind === 'spawn') this.buildAnimated(event.id);
    else if (event.kind === 'despawn') this.removeAnimated(event.id);
    else if (event.kind === 'set') this.applyComponent(event.id, event.component);
  }

  buildAnimated(id) {
    this.build(id);
    const group = this.groups.get(id);
    const components = this.store.get(id);
    if (!group || !this.effects || components?.terrain || id === this.ownPresence) return;
    group.visible = false;
    this.effects.wispTo(group.position.clone(), () => {
      group.visible = true;
      this.effects.scaleIn(group);
    });
  }

  removeAnimated(id) {
    const group = this.groups.get(id);
    if (!group || !this.effects) {
      this.remove(id);
      return;
    }
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    this.effects.scaleOut(group, () => this.remove(id));
  }

  suppress(id) {
    this.suppressed.add(id);
  }

  unsuppress(id) {
    this.suppressed.delete(id);
    if (this.store.get(id) && this.groups.has(id)) this.applyTransform(id);
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
    if (id === this.ownPresence) group.visible = false; // don't render your own head
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
        if (!this.suppressed.has(id)) this.applyTransform(id);
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
      case 'scatter':
        this.applyScatter(group, value);
        break;
      case 'particles':
        this.applyParticles(id, group, value);
        break;
      case 'environment':
        this.environment?.apply(value);
        break;
    }
  }

  applyScatter(group, value) {
    for (const child of [...group.children]) {
      if (child.userData.kind === 'scatter') {
        disposeObject(child);
        group.remove(child);
      }
    }
    if (!value) return;
    const scatter = buildScatter(value);
    scatter.userData.kind = 'scatter';
    group.add(scatter);
  }

  applyParticles(id, group, value) {
    const prev = this.particleSystems.get(id);
    if (prev) {
      group.remove(prev.mesh);
      prev.mesh.geometry.dispose();
      prev.mesh.material.dispose();
      this.particleSystems.delete(id);
    }
    if (!value) return;
    const state = buildParticles(value);
    group.add(state.mesh);
    this.particleSystems.set(id, state);
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
      const mesh = new THREE.Mesh(makeGeometry(part), makePartMaterial(part));
      // preset parts (water, flame, glow, hologram) are visual, not walkable
      mesh.userData.solid = !part.preset && part.solid !== false;
      // invisible parts still collide — walkway/box colliders
      if (part.visible === false) mesh.visible = false;
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
      if (components.scatter && this.groups.has(id)) this.applyScatter(this.groups.get(id), components.scatter);
    }
  }

  remove(id) {
    const group = this.groups.get(id);
    if (!group) return;
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    this.lights.delete(id);
    this.particleSystems.delete(id);
    disposeObject(group);
    this.scene.remove(group);
    this.groups.delete(id);
  }

  // highest solid mesh surface under (x, z), cast from fromY downward —
  // walkable docks, bridges, platforms without a physics engine
  surfaceAt(x, z, fromY) {
    this._down ??= new THREE.Vector3(0, -1, 0);
    this._rayOrigin ??= new THREE.Vector3();
    this._surfaceRay ??= new THREE.Raycaster();
    const candidates = [];
    for (const [id, group] of this.groups) {
      const comps = this.store.get(id);
      if (!comps?.mesh || comps.terrain) continue;
      if (Math.hypot(group.position.x - x, group.position.z - z) > 60) continue;
      group.traverse((node) => {
        if (node.isMesh && !node.isInstancedMesh && node.userData.solid) candidates.push(node);
      });
    }
    if (!candidates.length) return null;
    this._rayOrigin.set(x, fromY, z);
    this._surfaceRay.set(this._rayOrigin, this._down);
    this._surfaceRay.far = 80;
    const hits = this._surfaceRay.intersectObjects(candidates, false);
    return hits.length ? hits[0].point.y : null;
  }

  getGroup(id) {
    return this.groups.get(id);
  }

  getLight(id) {
    return this.lights.get(id);
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
