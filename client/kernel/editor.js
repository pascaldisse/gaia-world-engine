import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { heightAt } from './terrain.js';

// Creator mode with Unity controls: Q view / W move / E rotate / R scale,
// F frames the selection, hold RMB to fly (WASD + Q/E down/up), scroll dollies.
// Every change is the same ops any agent sends.
export class Editor {
  constructor({ camera, scene, renderer, store, view, send, player, history, panel, palette, outliner, gizmos, viewbar, modeEl }) {
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
    this.outliner = outliner;
    this.gizmos = gizmos;
    this.viewbar = viewbar;
    this.modeEl = modeEl;
    this.mode = 'play';
    this.tool = 'translate';
    this.selected = null;
    this.selBox = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.lastStream = 0;
    this.dragStart = null;
    this.pathEdit = null;
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

    // path mode follows the data, not its own edits: undo, another agent's
    // op, or our own commit echo all land here and re-place the handles
    store.onChange((event) => {
      if (!this.pathEdit) return;
      if (event.kind === 'snapshot') this.refreshPathHandles();
      else if (event.id !== this.pathEdit.id) return;
      else if (event.kind === 'despawn') this.exitPathEdit();
      else if (event.kind === 'set' && event.component === 'mesh') this.refreshPathHandles();
    });

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
      if (this.pathEdit) {
        this.pickPathPoint(e); // path mode owns the click — esc leaves
        return;
      }
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
      if (e.code === 'KeyG' && !e.metaKey && !e.ctrlKey) {
        this.toggleGameMode();
        return;
      }
      if (this.player.gameMode) return; // game mode: all editing/debug locked
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
      if (this.pathEdit) {
        // a spline point translates and thickens — no rotate, and delete
        // still means "delete the entity", too heavy a key to leave armed
        switch (e.code) {
          case 'KeyQ':
            this.setTool(null);
            break;
          case 'KeyW':
            this.setTool('translate');
            break;
          case 'KeyR':
            this.setTool('scale');
            break;
          case 'KeyF':
            this.frameSelected();
            break;
          case 'Escape':
            this.exitPathEdit();
            break;
        }
        return;
      }
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
    if (this.player.gameMode) return;
    if (this.mode === 'play') this.enterCreate();
    else this.enterPlay();
  }

  // G: pure play — no creator mode, no grab, no noclip, no HUD
  toggleGameMode() {
    if (this.mode === 'create') this.enterPlay();
    const on = !this.player.gameMode;
    this.player.gameMode = on;
    if (on) this.player.noclip = false;
    document.getElementById('hud').style.display = on ? 'none' : '';
    const hint = document.getElementById('hint');
    hint.textContent = on ? 'game mode — G to exit' : 'creation enabled';
    clearTimeout(this.gameToast);
    this.gameToast = setTimeout(() => {
      if (hint.textContent === 'game mode — G to exit' || hint.textContent === 'creation enabled') {
        hint.textContent = '';
      }
    }, 2600);
  }

  enterCreate() {
    this.mode = 'create';
    this.player.editorMode = true;
    this.tc.enabled = true;
    document.exitPointerLock();
    this.modeEl.style.display = 'block';
    this.palette.show();
    this.outliner?.show();
    this.gizmos?.setEnabled(true);
    this.viewbar?.show();
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
    this.outliner?.hide();
    this.gizmos?.setEnabled(false);
    // play never looks through a scene-view lens: back to lit, sim running
    this.viewbar?.hide();
    this.viewbar?.reset();
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
    this.exitPathEdit();
    this.selected = id;
    if (this.selBox) {
      this.scene.remove(this.selBox);
      this.selBox.dispose();
      this.selBox = null;
    }
    this.tc.detach();
    this.helper.visible = false;
    this.outliner?.setSelected(id);
    this.gizmos?.setSelected(id);
    if (!id || !this.store.get(id)) {
      this.panel.hide();
      return;
    }
    // entities without a body (triggers, water, environment…) are still
    // selectable — from the outliner — with the panel and their own gizmos
    const group = this.view.getGroup(id);
    if (group) {
      if (!new THREE.Box3().setFromObject(group).isEmpty()) {
        this.selBox = new THREE.BoxHelper(group, '#ffb347');
        this.scene.add(this.selBox);
      }
      this.attachGizmo();
    }
    this.panel.show(id);
  }

  attachGizmo() {
    const group = this.selected && this.view.getGroup(this.selected);
    const comps = this.selected && this.store.get(this.selected);
    this.tc.showX = this.tc.showY = this.tc.showZ = true;
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
    if (this.pathEdit) this.attachPathGizmo();
    else this.attachGizmo();
  }

  // ---- path edit: tube splines as grabbable points ----
  // The inspector's numbers are exact but blind; this is the hands-on lens.
  // Click a control point, W drags it with the same translate gizmo entities
  // use, R scales its radius — one axis, because a spline point has
  // thickness, not volume, and rotation doesn't exist for it at all. The
  // tube itself rebuilds on release, not per frame: a carve-heavy tube
  // re-runs CSG every rebuild, so the orange spline and the radius ring are
  // the live preview while dragging.

  editPath(id, partIndex = 0) {
    if (this.player.gameMode) return;
    if (this.mode !== 'create') this.enterCreate();
    this.select(id); // also tears down any previous path session
    if (!this.store.get(id)) return;
    this.tc.detach();
    this.helper.visible = false;
    this.pathEdit = {
      id,
      part: partIndex,
      index: null,
      handles: [],
      proxy: new THREE.Object3D(),
      root: null,
      frame: null,
      line: null,
      ring: null,
      closed: false,
      dragging: false,
      dragMode: null,
      startMesh: null,
      startRadius: 1,
    };
    this.scene.add(this.pathEdit.proxy);
    if (this.tool === 'rotate' || !this.tool) this.tool = 'translate';
    this.buildPathHandles();
    if (this.pathEdit) hintText('path edit — click a point · W move · R radius · esc done');
  }

  exitPathEdit() {
    if (!this.pathEdit) return;
    this.disposePathVisuals();
    this.scene.remove(this.pathEdit.proxy);
    this.pathEdit = null;
    this.tc.detach();
    this.tc.showX = this.tc.showY = this.tc.showZ = true;
    this.helper.visible = false;
    hintText('');
    this.attachGizmo();
  }

  // handle space is the part's own frame (scene ∘ entity ∘ part transform),
  // so a handle's position IS a path coordinate — no conversion drift
  buildPathHandles() {
    const pe = this.pathEdit;
    this.disposePathVisuals();
    const comps = this.store.get(pe.id);
    const mesh = comps?.mesh;
    const part = (mesh?.parts ?? [mesh])[pe.part];
    if (!part || !Array.isArray(part.path) || part.path.length < 2) {
      this.exitPathEdit();
      return;
    }
    pe.closed = part.closed ?? false;
    const root = new THREE.Group();
    const group = this.view.getGroup(pe.id);
    if (group) {
      group.updateWorldMatrix(true, false);
      root.applyMatrix4(group.matrixWorld);
    } else {
      const t = comps.transform ?? {};
      root.position.set(...(t.position ?? [0, 0, 0]));
      root.rotation.set(...(t.rotation ?? [0, 0, 0]));
    }
    const frame = new THREE.Group();
    frame.position.set(...(part.position ?? [0, 0, 0]));
    frame.rotation.set(...(part.rotation ?? [0, 0, 0]));
    if (part.scale) {
      if (Array.isArray(part.scale)) frame.scale.set(...part.scale);
      else frame.scale.setScalar(part.scale);
    }
    root.add(frame);
    this.scene.add(root);
    root.updateWorldMatrix(true, true);
    pe.root = root;
    pe.frame = frame;

    part.path.forEach((p, i) => {
      const material = new THREE.MeshBasicMaterial({ color: '#ffa94d', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false });
      const handle = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), material);
      handle.position.set(...p);
      handle.userData.pathIndex = i;
      handle.renderOrder = 999;
      frame.add(handle);
      pe.handles.push(handle);
    });
    const xray = (color, opacity) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false });
    const pts = pe.handles.map((h) => h.position);
    pe.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pe.closed ? [...pts, pts[0]] : pts), xray('#ffa94d', 0.9));
    pe.line.renderOrder = 999;
    frame.add(pe.line);
    pe.ring = new THREE.Line(unitCircle(), xray('#7df9ff', 0.8));
    pe.ring.renderOrder = 999;
    pe.ring.visible = false;
    frame.add(pe.ring);
  }

  disposePathVisuals() {
    const pe = this.pathEdit;
    if (!pe) return;
    if (pe.root) {
      pe.root.traverse((node) => {
        node.geometry?.dispose();
        node.material?.dispose();
      });
      this.scene.remove(pe.root);
    }
    pe.root = pe.frame = pe.line = pe.ring = null;
    pe.handles = [];
  }

  refreshPathHandles() {
    const pe = this.pathEdit;
    if (!pe || pe.dragging) return;
    const index = pe.index;
    this.buildPathHandles();
    if (!this.pathEdit) return; // the part lost its path — session closed
    if (index !== null && index < pe.handles.length) this.selectPathPoint(index);
    else {
      pe.index = null;
      this.tc.detach();
      this.helper.visible = false;
    }
  }

  pickPathPoint(event) {
    this.pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pathEdit.handles, false);
    if (hits.length) this.selectPathPoint(hits[0].object.userData.pathIndex);
    // a miss keeps the mode — deliberate exit only (esc), so a sloppy
    // click near a thin spline never dumps you back to entity selection
  }

  selectPathPoint(i) {
    const pe = this.pathEdit;
    pe.index = i;
    for (const h of pe.handles) h.material.color.set(h.userData.pathIndex === i ? '#7df9ff' : '#ffa94d');
    pe.handles[i].getWorldPosition(pe.proxy.position);
    pe.proxy.scale.set(1, 1, 1);
    this.attachPathGizmo();
    this.updateRing();
  }

  attachPathGizmo() {
    const pe = this.pathEdit;
    if (this.tool === 'rotate') this.tool = 'translate'; // spline points don't rotate
    if (!pe || pe.index === null || !this.tool) {
      this.tc.detach();
      this.helper.visible = false;
      return;
    }
    const scale = this.tool === 'scale';
    this.tc.setMode(this.tool);
    // thickness is one number — the scale gizmo offers a single axis
    this.tc.showX = true;
    this.tc.showY = !scale;
    this.tc.showZ = !scale;
    this.tc.attach(pe.proxy);
    this.helper.visible = true;
  }

  onPathDragChanged(dragging) {
    const pe = this.pathEdit;
    if (pe.index === null) return;
    if (dragging) {
      pe.dragging = true;
      pe.dragMode = this.tool;
      pe.startMesh = structuredClone(this.store.get(pe.id)?.mesh ?? null);
      pe.startRadius = this.pointRadius(pe.index);
    } else {
      pe.dragging = false;
      const value = this.pathCommitMesh();
      pe.proxy.scale.set(1, 1, 1);
      if (!value) return;
      const redo = [{ op: 'set', id: pe.id, component: 'mesh', value }];
      this.send(redo);
      this.history.push([{ op: 'set', id: pe.id, component: 'mesh', value: pe.startMesh }], redo);
    }
  }

  onPathChange() {
    const pe = this.pathEdit;
    if (pe.index === null || !pe.dragging) return;
    if (pe.dragMode === 'scale') {
      this.updateRing(Math.max(0.15, pe.startRadius * pe.proxy.scale.x));
    } else {
      pe.handles[pe.index].position.copy(pe.frame.worldToLocal(_v.copy(pe.proxy.position)));
      this.updatePathLine();
      this.updateRing();
    }
  }

  pathCommitMesh() {
    const pe = this.pathEdit;
    const mesh = structuredClone(this.store.get(pe.id)?.mesh ?? null);
    const part = mesh ? (mesh.parts ?? [mesh])[pe.part] : null;
    if (!part || !Array.isArray(part.path)) return null;
    if (pe.dragMode === 'scale') {
      const radii = fullRadii(part);
      radii[pe.index] = r2(Math.max(0.15, pe.startRadius * pe.proxy.scale.x));
      part.radii = radii;
    } else {
      const p = pe.handles[pe.index].position;
      part.path[pe.index] = [r2(p.x), r2(p.y), r2(p.z)];
    }
    return mesh;
  }

  pointRadius(i) {
    const mesh = this.store.get(this.pathEdit.id)?.mesh;
    const part = (mesh?.parts ?? [mesh])[this.pathEdit.part];
    return part?.path ? fullRadii(part)[i] : 1;
  }

  updatePathLine() {
    const pe = this.pathEdit;
    const pts = pe.handles.map((h) => h.position);
    pe.line.geometry.dispose();
    pe.line.geometry = new THREE.BufferGeometry().setFromPoints(pe.closed ? [...pts, pts[0]] : pts);
  }

  updateRing(liveRadius = null) {
    const pe = this.pathEdit;
    if (!pe.ring) return;
    if (pe.index === null) {
      pe.ring.visible = false;
      return;
    }
    pe.ring.visible = true;
    pe.ring.position.copy(pe.handles[pe.index].position);
    const pts = pe.handles.map((h) => h.position);
    const tangent = _v.copy(pts[Math.min(pts.length - 1, pe.index + 1)]).sub(pts[Math.max(0, pe.index - 1)]);
    if (tangent.lengthSq() > 0.001) pe.ring.quaternion.setFromUnitVectors(_up, tangent.normalize());
    pe.ring.scale.setScalar(Math.max(0.05, liveRadius ?? this.pointRadius(pe.index)));
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
    if (group) {
      const box = new THREE.Box3().setFromObject(group);
      if (!box.isEmpty()) {
        const center = box.getCenter(new THREE.Vector3());
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        this.camera.getWorldDirection(this.dir);
        this.player.position.copy(center).addScaledVector(this.dir, -Math.max(4, sphere.radius * 2.5));
        this.player.velocity.set(0, 0, 0);
        return;
      }
    }
    // no body to frame: fly to where the data says it is
    const comps = this.selected && this.store.get(this.selected);
    const pos = comps && dataPosition(comps);
    if (!pos) return;
    this.camera.getWorldDirection(this.dir);
    this.player.position.set(...pos).addScaledVector(this.dir, -12);
    this.player.velocity.set(0, 0, 0);
  }

  onDragChanged(dragging) {
    if (this.pathEdit) {
      this.onPathDragChanged(dragging);
      return;
    }
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
    if (this.pathEdit) {
      this.onPathChange();
      return;
    }
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

// where a bodiless entity lives, judged from whichever component is spatial
function dataPosition(comps) {
  if (comps.transform?.position) return comps.transform.position;
  const trigger = comps.trigger;
  if (trigger?.area?.center) {
    const [x, z] = trigger.area.center;
    return [x, ((trigger.yMin ?? 0) + (trigger.yMax ?? 4)) / 2, z];
  }
  if (comps.water?.area?.center) {
    const [x, z] = comps.water.area.center;
    return [x, comps.water.level ?? 0, z];
  }
  const area = comps.scatter?.area ?? comps.particles?.area;
  if (area?.center) return [area.center[0], 2, area.center[1]];
  if (comps.spawn?.position) return comps.spawn.position;
  return null;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

// expand radii (single number, short array, or legacy radius) to one entry
// per path point — the tube maps radius i to point i, clamping past the
// end, so this expansion reproduces the existing shape exactly
function fullRadii(part) {
  const radii = Array.isArray(part.radii) ? part.radii : [part.radii ?? part.radius ?? 3];
  return part.path.map((_, i) => radii[Math.min(radii.length - 1, i)]);
}

// closed strip, not LineLoop — WebGPU silently drops line-loop topology
function unitCircle(segs = 48) {
  const points = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function hintText(text) {
  const el = document.getElementById('hint');
  if (el) el.textContent = text;
}
