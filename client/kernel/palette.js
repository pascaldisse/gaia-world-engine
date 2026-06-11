import * as THREE from 'three/webgpu';
import { makeGeometry } from './geometry.js';

const BASE = `http://${location.hostname}:${__GAIA_PORT__}`;

// Prefab palette with ghost stamping. The library lives on the server as
// plain component documents — agents can add new brushes at runtime.
export class Palette {
  constructor({ el, store, view, send, history, camera, renderer }) {
    this.el = el;
    this.store = store;
    this.view = view;
    this.send = send;
    this.history = history;
    this.camera = camera;
    this.prefabs = [];
    this.armed = null;
    this.ghost = null;
    this.ghostValid = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    renderer.domElement.addEventListener('pointermove', (e) => this.moveGhost(e));
    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.armed && e.button === 0 && this.ghostValid) this.stamp();
    });
    renderer.domElement.addEventListener('contextmenu', (e) => {
      if (this.armed) {
        e.preventDefault();
        this.disarm();
      }
    });
    this.load();
  }

  async load() {
    try {
      const res = await fetch(`${BASE}/prefabs`);
      this.prefabs = await res.json();
      this.renderChips();
    } catch {
      // server not up yet; palette stays empty until next load()
    }
  }

  renderChips() {
    this.el.innerHTML = '';
    for (const prefab of this.prefabs) {
      const chip = document.createElement('button');
      chip.textContent = prefab.name;
      chip.className = this.armed?.name === prefab.name ? 'chip active' : 'chip';
      chip.onclick = () => (this.armed?.name === prefab.name ? this.disarm() : this.arm(prefab));
      this.el.append(chip);
    }
  }

  show() {
    this.el.style.display = 'flex';
  }

  hide() {
    this.el.style.display = 'none';
  }

  arm(prefab) {
    this.disarm();
    this.armed = prefab;
    this.ghost = this.buildGhost(prefab.components);
    this.ghost.visible = false;
    this.view.scene.add(this.ghost);
    this.renderChips();
  }

  disarm() {
    if (this.ghost) {
      this.view.scene.remove(this.ghost);
      this.ghost.traverse((node) => {
        if (node.geometry && !node.geometry.userData?.shared) node.geometry.dispose();
        node.material?.dispose(); // ghost materials are its own (basic, translucent)
      });
      this.ghost = null;
    }
    this.armed = null;
    this.ghostValid = false;
    this.renderChips();
  }

  buildGhost(components) {
    const group = new THREE.Group();
    const scale = components.transform?.scale ?? 1;
    if (Array.isArray(scale)) group.scale.set(...scale);
    else group.scale.setScalar(scale);
    for (const part of components.mesh?.parts ?? []) {
      const mesh = new THREE.Mesh(
        makeGeometry(part),
        new THREE.MeshBasicMaterial({
          color: part.color ?? '#ffffff',
          transparent: true,
          opacity: 0.4,
          depthWrite: false,
        }),
      );
      mesh.position.set(...(part.position ?? [0, 0, 0]));
      mesh.rotation.set(...(part.rotation ?? [0, 0, 0]));
      group.add(mesh);
    }
    return group;
  }

  terrainGroup() {
    for (const [id, comps] of this.store.entities) {
      if (comps.terrain) return this.view.getGroup(id);
    }
    return null;
  }

  moveGhost(event) {
    if (!this.armed || !this.ghost) return;
    const terrain = this.terrainGroup();
    if (!terrain) return;
    this.pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(terrain, true);
    if (!hits.length) {
      this.ghost.visible = false;
      this.ghostValid = false;
      return;
    }
    const p = hits[0].point;
    const offset = this.armed.components.ground?.offset ?? 0;
    this.ghost.position.set(p.x, p.y + offset, p.z);
    this.ghost.visible = true;
    this.ghostValid = true;
  }

  stamp() {
    const components = structuredClone(this.armed.components);
    // the stamp stays an INSTANCE: the scene file stores `prefab` + deltas,
    // and editing the prefab later updates every torch placed from it
    components.prefab = { name: this.armed.name };
    const p = this.ghost.position;
    components.transform = components.transform ?? {};
    components.transform.position = [r2(p.x), components.ground ? 0 : r2(p.y), r2(p.z)];
    let id;
    let n = 1;
    do id = `${this.armed.name}-${n++}`;
    while (this.store.get(id));
    this.send([{ op: 'spawn', id, components }]);
    this.history.push([{ op: 'despawn', id }], [{ op: 'spawn', id, components }]);
  }
}

function r2(v) {
  return Math.round(v * 100) / 100;
}
