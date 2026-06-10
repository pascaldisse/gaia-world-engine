import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { heightAt } from './terrain.js';

// Creator mode with Unity controls: Q view / W move / E rotate / R scale,
// F frames the selection, hold RMB to fly (WASD + Q/E down/up), scroll dollies.
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
    this.tool = 'translate';
    this.selected = null;
    this.selBox = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.lastStream = 0;
    this.dragStart = null;
    this.dir = new THREE.Vector3();
    this.orbiting = false;
    this.pivot = new THREE.Vector3();
    this.pivotDist = 10;
    this.lastX = 0;
    this.lastY = 0;

    this.tc = new TransformControls(camera, renderer.domElement);
    this.tc.enabled = false;
    this.tc.addEventListener('dragging-changed', (e) => this.onDragChanged(e.value));
    this.tc.addEventListener('objectChange', () => this.onObjectChange());
    this.helper = this.tc.getHelper();
    this.helper.visible = false;
    scene.add(this.helper);

    renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'create') return;
      if (e.button === 2) {
        if (this.palette.armed) {
          this.palette.disarm();
          return;
        }
        this.player.flyActive = true;
        this.renderer.domElement.requestPointerLock();
        return;
      }
      if (e.button !== 0 || this.player.flyActive) return;
      if (e.altKey) {
        this.startOrbit(e);
        return;
      }
      if (this.tc.axis) return; // gizmo interaction
      if (this.palette.armed) return; // palette stamps
      this.selectAt(e);
    });

    document.addEventListener('pointermove', (e) => {
      if (this.orbiting) this.moveOrbit(e);
    });

    document.addEventListener('pointerup', (e) => {
      if (e.button === 0 && this.orbiting) {
        this.orbiting = false;
        this.pivotDist = this.player.position.distanceTo(this.pivot);
      }
      if (e.button === 2 && this.player.flyActive) {
        this.player.flyActive = false;
        if (this.mode === 'create') document.exitPointerLock();
      }
    });

    document.addEventListener('pointerlockchange', () => {
      if (!document.pointerLockElement) this.player.flyActive = false;
    });

    renderer.domElement.addEventListener('contextmenu', (e) => {
      if (this.mode === 'create') e.preventDefault();
    });

    renderer.domElement.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'create') return;
        e.preventDefault();
        this.camera.getWorldDirection(this.dir);
        this.player.position.addScaledVector(this.dir, -Math.sign(e.deltaY) * 1.2);
      },
      { passive: false },
    );

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
      if (e.code === 'KeyV') {
        if (this.mode === 'create') this.player.flyLatched = !this.player.flyLatched;
        else if (this.player.locked) this.player.noclip = !this.player.noclip;
        return;
      }
      if (this.mode !== 'create' || this.player.flyActive || this.player.flyLatched) return;
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD') {
        e.preventDefault();
        if (this.selected) this.duplicate(this.selected);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      switch (e.code) {
        case 'KeyQ':
          this.setTool(null);
          break;
        case 'KeyW':
          this.setTool('translate');
          break;
        case 'KeyE':
          this.setTool('rotate');
          break;
        case 'KeyR':
          this.setTool('scale');
          break;
        case 'KeyF':
          this.frameSelected();
          break;
        case 'Delete':
        case 'Backspace':
          if (this.selected) this.delete(this.selected);
          break;
        case 'Escape':
          if (this.palette.armed) this.palette.disarm();
          else this.select(null);
          break;
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
    this.player.flyActive = false;
    this.orbiting = false;
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
    this.attachGizmo();
    this.panel.show(id);
  }

  attachGizmo() {
    const group = this.selected && this.view.getGroup(this.selected);
    const comps = this.selected && this.store.get(this.selected);
    if (group && comps?.transform && this.tool) {
      this.tc.setMode(this.tool);
      this.tc.attach(group);
      this.helper.visible = true;
    } else {
      this.tc.detach();
      this.helper.visible = false;
    }
  }

  setTool(tool) {
    this.tool = tool;
    this.attachGizmo();
  }

  startOrbit(e) {
    this.orbiting = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const group = this.selected && this.view.getGroup(this.selected);
    if (group) {
      new THREE.Box3().setFromObject(group).getCenter(this.pivot);
    } else {
      this.camera.getWorldDirection(this.dir);
      this.pivot.copy(this.player.position).addScaledVector(this.dir, this.pivotDist);
    }
  }

  moveOrbit(e) {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const offset = this.player.position.clone().sub(this.pivot);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx * 0.008;
    spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - dy * 0.008));
    offset.setFromSpherical(spherical);
    this.player.position.copy(this.pivot).add(offset);
    const look = this.pivot.clone().sub(this.player.position).normalize();
    this.player.pitch = Math.asin(THREE.MathUtils.clamp(look.y, -1, 1));
    this.player.yaw = Math.atan2(-look.x, -look.z);
    this.player.velocity.set(0, 0, 0);
  }

  frameSelected() {
    const group = this.selected && this.view.getGroup(this.selected);
    if (!group) return;
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.camera.getWorldDirection(this.dir);
    this.player.position.copy(center).addScaledVector(this.dir, -Math.max(4, sphere.radius * 2.5));
    this.player.velocity.set(0, 0, 0);
  }

  onDragChanged(dragging) {
    if (!this.selected) return;
    if (dragging) {
      this.view.suppress(this.selected);
      const comps = this.store.get(this.selected);
      this.dragStart = {
        transform: structuredClone(comps?.transform ?? null),
        ground: structuredClone(comps?.ground),
      };
    } else {
      const ops = this.streamOps();
      if (ops) {
        this.send(ops);
        const undoOps = [{ op: 'set', id: this.selected, component: 'transform', value: this.dragStart.transform }];
        if (this.dragStart.ground !== undefined) {
          undoOps.push({ op: 'set', id: this.selected, component: 'ground', value: this.dragStart.ground });
        }
        this.history.push(undoOps, ops);
      }
      this.view.unsuppress(this.selected);
    }
  }

  onObjectChange() {
    const now = performance.now();
    if (now - this.lastStream < 60 || !this.selected) return;
    this.lastStream = now;
    const ops = this.streamOps();
    if (ops) this.send(ops);
  }

  // gizmo edits as ops: the Y arrow on grounded entities edits ground.offset,
  // so a lifted object hovers relative to the terrain instead of snapping back
  streamOps() {
    const group = this.view.getGroup(this.selected);
    if (!group) return null;
    const value = {
      position: [r2(group.position.x), r2(group.position.y), r2(group.position.z)],
      rotation: [r2(group.rotation.x), r2(group.rotation.y), r2(group.rotation.z)],
      scale: [r2(group.scale.x), r2(group.scale.y), r2(group.scale.z)],
    };
    const ops = [{ op: 'set', id: this.selected, component: 'transform', value }];
    const comps = this.store.get(this.selected);
    if (comps?.ground) {
      const offset = r2(group.position.y - heightAt(group.position.x, group.position.z));
      ops.push({ op: 'merge', id: this.selected, component: 'ground', value: { offset } });
    }
    return ops;
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
