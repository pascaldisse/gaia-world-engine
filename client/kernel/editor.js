import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Creator mode: Tab frees the cursor without leaving the world. Click selects,
// G/R/S switch gizmos, the panel edits the document, the palette stamps prefabs.
// Every change is the same ops any agent sends.
export class Editor {
  constructor({ camera, scene, renderer, store, view, send, player, history, panel, palette, modeEl }) {
    this.camera = camera;
    this.scene = scene;
    this.renderer = renderer;
    this.store = store;
    this.view = view;
    this.send = send;
    this.player = player;
    this.history = history;
    this.panel = panel;
    this.palette = palette;
    this.modeEl = modeEl;
    this.mode = 'play';
    this.selected = null;
    this.selBox = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.lastStream = 0;
    this.dragStart = null;

    this.tc = new TransformControls(camera, renderer.domElement);
    this.tc.enabled = false;
    this.tc.addEventListener('dragging-changed', (e) => this.onDragChanged(e.value));
    this.tc.addEventListener('objectChange', () => this.onObjectChange());
    this.helper = this.tc.getHelper();
    this.helper.visible = false;
    scene.add(this.helper);

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'create' || e.button !== 0) return;
      if (this.tc.axis) return; // gizmo interaction
      if (this.palette.armed) return; // palette stamps
      this.selectAt(e);
    });

    document.addEventListener('keydown', (e) => {
      if (isTyping()) return;
      if (e.code === 'Tab') {
        e.preventDefault();
        this.toggle();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) this.history.redo();
        else this.history.undo();
        return;
      }
      if (this.mode !== 'create') return;
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD') {
        e.preventDefault();
        if (this.selected) this.duplicate(this.selected);
        return;
      }
      if (e.code === 'KeyG') this.setGizmoMode('translate');
      if (e.code === 'KeyR') this.setGizmoMode('rotate');
      if (e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) this.setGizmoMode('scale');
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (this.selected) this.delete(this.selected);
      }
      if (e.code === 'Escape') {
        if (this.palette.armed) this.palette.disarm();
        else this.select(null);
      }
    });
  }

  toggle() {
    if (this.mode === 'play') this.enterCreate();
    else this.enterPlay();
  }

  enterCreate() {
    this.mode = 'create';
    this.player.editorMode = true;
    this.tc.enabled = true;
    document.exitPointerLock();
    this.modeEl.style.display = 'block';
    this.palette.show();
  }

  enterPlay() {
    this.mode = 'play';
    this.player.editorMode = false;
    this.tc.enabled = false;
    this.select(null);
    this.palette.disarm();
    this.palette.hide();
    this.modeEl.style.display = 'none';
    this.renderer.domElement.requestPointerLock();
  }

  selectAt(event) {
    this.pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.view.groups.values()], true);
    for (const hit of hits) {
      let node = hit.object;
      while (node && node.parent !== this.scene) node = node.parent;
      if (node?.name) {
        this.select(node.name);
        return;
      }
    }
    this.select(null);
  }

  select(id) {
    this.selected = id;
    if (this.selBox) {
      this.scene.remove(this.selBox);
      this.selBox.dispose();
      this.selBox = null;
    }
    this.tc.detach();
    this.helper.visible = false;
    if (!id) {
      this.panel.hide();
      return;
    }
    const group = this.view.getGroup(id);
    const comps = this.store.get(id);
    if (!group || !comps) return;
    this.selBox = new THREE.BoxHelper(group, '#ffb347');
    this.scene.add(this.selBox);
    if (comps.transform) {
      this.tc.attach(group);
      this.helper.visible = true;
      this.updateGizmoConstraints();
    }
    this.panel.show(id);
  }

  setGizmoMode(mode) {
    this.tc.setMode(mode);
    this.updateGizmoConstraints();
  }

  updateGizmoConstraints() {
    const comps = this.selected && this.store.get(this.selected);
    this.tc.showY = !(comps?.ground && this.tc.mode === 'translate');
  }

  onDragChanged(dragging) {
    if (!this.selected) return;
    if (dragging) {
      this.view.suppress(this.selected);
      this.dragStart = structuredClone(this.store.get(this.selected)?.transform ?? null);
    } else {
      const value = this.transformFromGroup();
      if (value) {
        this.send([{ op: 'set', id: this.selected, component: 'transform', value }]);
        this.history.push(
          [{ op: 'set', id: this.selected, component: 'transform', value: this.dragStart }],
          [{ op: 'set', id: this.selected, component: 'transform', value }],
        );
      }
      this.view.unsuppress(this.selected);
    }
  }

  onObjectChange() {
    const now = performance.now();
    if (now - this.lastStream < 60 || !this.selected) return;
    this.lastStream = now;
    const value = this.transformFromGroup();
    if (value) this.send([{ op: 'set', id: this.selected, component: 'transform', value }]);
  }

  transformFromGroup() {
    const group = this.view.getGroup(this.selected);
    if (!group) return null;
    return {
      position: [r2(group.position.x), r2(group.position.y), r2(group.position.z)],
      rotation: [r2(group.rotation.x), r2(group.rotation.y), r2(group.rotation.z)],
      scale: [r2(group.scale.x), r2(group.scale.y), r2(group.scale.z)],
    };
  }

  duplicate(id) {
    const comps = structuredClone(this.store.get(id));
    if (!comps) return;
    let copyId = `${id}-copy`;
    let n = 2;
    while (this.store.get(copyId)) copyId = `${id}-copy${n++}`;
    comps.transform = comps.transform ?? {};
    const [x = 0, y = 0, z = 0] = comps.transform.position ?? [];
    comps.transform.position = [x + 1.5, y, z + 1.5];
    this.send([{ op: 'spawn', id: copyId, components: comps }]);
    this.history.push([{ op: 'despawn', id: copyId }], [{ op: 'spawn', id: copyId, components: comps }]);
    setTimeout(() => this.store.get(copyId) && this.select(copyId), 150);
  }

  delete(id) {
    const comps = structuredClone(this.store.get(id));
    if (!comps) return;
    this.send([{ op: 'despawn', id }]);
    this.history.push([{ op: 'spawn', id, components: comps }], [{ op: 'despawn', id }]);
    this.select(null);
  }

  update() {
    if (this.selected && !this.store.get(this.selected)) this.select(null);
    this.selBox?.update();
  }
}

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

function r2(v) {
  return Math.round(v * 100) / 100;
}
