import * as THREE from 'three/webgpu';

// Always-on hands: look at a thing, E to grab, scroll to push/pull, E to drop.
// A carry is a stream of merge ops — every other client (and agent) sees it live.
export class Interact {
  constructor({ camera, scene, store, view, send, player, hintEl, history }) {
    this.camera = camera;
    this.scene = scene;
    this.store = store;
    this.view = view;
    this.send = send;
    this.player = player;
    this.hintEl = hintEl;
    this.history = history;
    this.grabStart = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 40;
    this.center = new THREE.Vector2(0, 0);
    this.hovered = null;
    this.holding = null;
    this.helper = null;
    this.dist = 5;
    this.lastSent = 0;
    this.dir = new THREE.Vector3();
    this.target = new THREE.Vector3();

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyE' || !this.player.locked) return;
      if (this.holding) this.drop();
      else if (this.hovered) this.grab(this.hovered);
    });
    document.addEventListener('wheel', (e) => {
      if (this.holding) this.dist = Math.min(30, Math.max(1.5, this.dist - Math.sign(e.deltaY) * 0.8));
    });
  }

  rootIdOf(object) {
    let node = object;
    while (node && node.parent !== this.scene) node = node.parent;
    return node?.name || null;
  }

  pick() {
    const candidates = [];
    for (const [id, group] of this.view.groups) {
      const comps = this.store.get(id);
      if (!comps || comps.terrain) continue;
      candidates.push(group);
    }
    this.raycaster.setFromCamera(this.center, this.camera);
    for (const hit of this.raycaster.intersectObjects(candidates, true)) {
      const id = this.rootIdOf(hit.object);
      if (id) return id;
    }
    return null;
  }

  grab(id) {
    const group = this.view.getGroup(id);
    if (!group) return;
    this.holding = id;
    this.grabStart = structuredClone(this.store.get(id)?.transform ?? null);
    this.view.suppress(id);
    this.dist = Math.min(30, Math.max(1.5, this.camera.position.distanceTo(group.position)));
    this.setHover(null);
  }

  drop() {
    const id = this.holding;
    this.holding = null;
    const group = this.view.getGroup(id);
    if (group && this.store.get(id)) {
      const p = group.position;
      const position = [r2(p.x), r2(p.y), r2(p.z)];
      this.send([{ op: 'merge', id, component: 'transform', value: { position } }]);
      this.history?.push(
        [{ op: 'set', id, component: 'transform', value: this.grabStart }],
        [{ op: 'set', id, component: 'transform', value: { ...(this.grabStart ?? {}), position } }],
      );
    }
    this.view.unsuppress(id);
  }

  setHover(id) {
    if (id === this.hovered) return;
    this.hovered = id;
    if (this.helper) {
      this.scene.remove(this.helper);
      this.helper.dispose();
      this.helper = null;
    }
    const group = id && this.view.getGroup(id);
    if (group) {
      this.helper = new THREE.BoxHelper(group, '#7df9ff');
      this.scene.add(this.helper);
    }
  }

  update(dt, now) {
    if (!this.player.locked) {
      if (this.holding) this.drop();
      this.setHover(null);
      this.updateHint();
      return;
    }
    if (this.holding) {
      const group = this.view.getGroup(this.holding);
      if (!group || !this.store.get(this.holding)) {
        this.holding = null;
      } else {
        this.camera.getWorldDirection(this.dir);
        this.target.copy(this.camera.position).addScaledVector(this.dir, this.dist);
        group.position.lerp(this.target, Math.min(1, dt * 14));
        if (now - this.lastSent > 60) {
          this.lastSent = now;
          const p = group.position;
          this.send([
            { op: 'merge', id: this.holding, component: 'transform', value: { position: [r2(p.x), r2(p.y), r2(p.z)] } },
          ]);
        }
      }
    } else {
      this.setHover(this.pick());
      this.helper?.update();
    }
    this.updateHint();
  }

  updateHint() {
    const text = this.holding
      ? `holding ${this.holding} — E drop · scroll push/pull`
      : this.hovered
        ? `${this.hovered} — E grab`
        : '';
    if (this.hintEl.textContent !== text) this.hintEl.textContent = text;
  }
}

function r2(v) {
  return Math.round(v * 100) / 100;
}
