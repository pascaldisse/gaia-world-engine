import * as THREE from 'three/webgpu';

// Always-on hands: look at a thing, E to grab, scroll to push/pull, E to drop.
// A carry is a stream of merge ops — every other client (and agent) sees it live.
// Entities with an `interact` component answer E differently: a `use` op goes
// to the server, which decides what happens — the only hands a game world has.
export class Interact {
  constructor({ camera, scene, store, view, send, player, hintEl, history, presence }) {
    this.camera = camera;
    this.scene = scene;
    this.store = store;
    this.view = view;
    this.send = send;
    this.player = player;
    this.hintEl = hintEl;
    this.history = history;
    this.presence = presence;
    this.grabStart = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 40;
    this.center = new THREE.Vector2(0, 0);
    this.hovered = null;
    this.holding = null;
    this.usable = null;
    this.usePrompt = '';
    this.helper = null;
    this.dist = 5;
    this.lastSent = 0;
    this.dir = new THREE.Vector3();
    this.target = new THREE.Vector3();

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyE' || !this.player.locked || this.player.editorMode) return;
      if (this.holding) this.drop();
      else if (this.usable) this.use(this.usable);
      else if (!this.player.gameMode && this.hovered) this.grab(this.hovered);
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
      if (id) return { id, distance: hit.distance };
    }
    return null;
  }

  // the looked-at entity's interact component, if the player may use it now —
  // same gates the server applies, so the prompt never lies
  usableAct(picked) {
    const act = picked && this.store.get(picked.id)?.interact;
    if (!act || picked.distance > (act.radius ?? 4)) return null;
    if (act.when && !this.matches(act.when)) return null;
    return act;
  }

  matches(when) {
    for (const [path, expected] of Object.entries(when)) {
      const [id, ...keys] = path.split('.');
      let value = this.store.get(id);
      for (const key of keys) value = value?.[key];
      if (value !== expected) return false;
    }
    return true;
  }

  use(id) {
    this.send([{ op: 'use', id, by: this.presence }]);
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
    if (!this.player.locked || this.player.editorMode) {
      if (this.holding) this.drop();
      this.setHover(null);
      this.usable = null;
      this.updateHint();
      return;
    }
    if (this.player.gameMode) {
      // no grabbing in a game world — but interactables still answer E
      if (this.holding) this.drop();
      this.setHover(null);
      const picked = this.pick();
      const act = this.usableAct(picked);
      this.usable = act ? picked.id : null;
      this.usePrompt = act?.prompt ?? 'use';
      this.updateHint();
      return;
    }
    if (this.holding) {
      this.usable = null;
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
      const picked = this.pick();
      const act = this.usableAct(picked);
      this.usable = act ? picked.id : null;
      this.usePrompt = act?.prompt ?? 'use';
      this.setHover(this.usable ? null : picked?.id ?? null);
      this.helper?.update();
    }
    this.updateHint();
  }

  updateHint() {
    const text = this.holding
      ? `holding ${this.holding} — E drop · scroll push/pull`
      : this.usable
        ? `${this.usePrompt} — E`
        : this.hovered
          ? `${this.hovered} — E grab`
          : this.player.noclip && this.player.locked
            ? 'flight — space up · C down · V to land'
            : '';
    if (this.hintEl.textContent !== text) this.hintEl.textContent = text;
  }
}

function r2(v) {
  return Math.round(v * 100) / 100;
}
