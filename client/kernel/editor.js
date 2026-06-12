import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { heightAt } from './terrain.js';
import { makeGeometry, disposeOwn, partsOf, tubeRadii } from './geometry.js';
import { circleGeometry } from './gizmos.js';
import { isTyping, pointerNDC } from './dom.js';
import { r2 } from '../../shared/num.js';

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
    this.carveEdit = null;
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

    // path/hole modes follow the data, not their own edits: undo, another
    // agent's op, or our own commit echo all land here and re-place handles
    store.onChange((event) => {
      if (this.pathEdit) {
        if (event.kind === 'snapshot') this.refreshPathHandles();
        else if (event.id !== this.pathEdit.id) return;
        else if (event.kind === 'despawn') this.exitPathEdit();
        else if (event.kind === 'set' && event.component === 'mesh') this.refreshPathHandles();
      } else if (this.carveEdit) {
        if (event.kind === 'snapshot') this.refreshCarveHandles();
        else if (event.id !== this.carveEdit.id) return;
        else if (event.kind === 'despawn') this.exitCarveEdit();
        else if (event.kind === 'set' && event.component === 'mesh') this.refreshCarveHandles();
      }
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
      if (this.carveEdit) {
        this.pickCarve(e); // hole mode too
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
      // the tool keys are one vocabulary across normal and lens modes; a
      // spline point has no rotation, so E stays inert in path mode
      switch (e.code) {
        case 'KeyQ':
          this.setTool(null);
          return;
        case 'KeyW':
          this.setTool('translate');
          return;
        case 'KeyE':
          if (!this.pathEdit) this.setTool('rotate');
          return;
        case 'KeyR':
          this.setTool('scale');
          return;
        case 'KeyF':
          this.frameSelected();
          return;
      }
      if (this.carveEdit) {
        // hole mode owns the keys: delete removes the CUTTER, never the
        // entity — the entity is unreachable until esc leaves the mode
        if (e.code === 'KeyN') this.addCarve();
        else if (e.code === 'Delete' || e.code === 'Backspace') this.removeCarve();
        else if (e.code === 'Escape') this.exitCarveEdit();
        return;
      }
      if (this.pathEdit) {
        if (e.code === 'Escape') this.exitPathEdit();
        return;
      }
      switch (e.code) {
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
    this.raycaster.setFromCamera(pointerNDC(event, this.pointer), this.camera);
    const hits = this.raycaster.intersectObjects([...this.view.groups.values()], true);
    for (const hit of hits) {
      const id = this.view.rootIdOf(hit.object);
      if (id) {
        this.select(id);
        return;
      }
    }
    this.select(null);
  }

  select(id) {
    this.exitPathEdit();
    this.exitCarveEdit();
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
    else if (this.carveEdit) this.attachCarveGizmo();
    else this.attachGizmo();
  }

  // ---- the lens scaffolding: path edit and hole edit are the same kind of
  // session — edit a sub-array of one mesh part through grabbable handles.
  // Everything generic lives here; each lens keeps only its own handle
  // construction, gizmo axis policy and commit mutation. The next lens
  // (collider boxes, behavior waypoints) reuses all of it.

  // open a session: enters create mode, tears down any previous session via
  // select(id), and returns the fresh session (null = refused)
  enterLens(key, id, partIndex, extra) {
    if (this.player.gameMode) return null;
    if (this.mode !== 'create') this.enterCreate();
    this.select(id);
    if (!this.store.get(id)) return null;
    this.tc.detach();
    this.helper.visible = false;
    const session = {
      id,
      part: partIndex,
      index: null,
      handles: [],
      proxy: new THREE.Object3D(),
      root: null,
      frame: null,
      dragging: false,
      dragMode: null,
      startMesh: null,
      ...extra,
    };
    this[key] = session;
    this.scene.add(session.proxy);
    return session;
  }

  exitLens(key) {
    const s = this[key];
    if (!s) return;
    this.disposeLensVisuals(s);
    this.scene.remove(s.proxy);
    this[key] = null;
    this.tc.detach();
    this.tc.showX = this.tc.showY = this.tc.showZ = true;
    this.helper.visible = false;
    hintText('');
    this.attachGizmo();
  }

  // the mesh part a session edits, from the live document
  lensPart(s) {
    return partsOf(this.store.get(s.id)?.mesh)[s.part] ?? null;
  }

  // handle space is the part's own frame (scene ∘ entity ∘ part transform),
  // so a handle's pose IS a path/carve coordinate — no conversion drift
  buildPartFrame(id, part) {
    const root = new THREE.Group();
    const group = this.view.getGroup(id);
    if (group) {
      group.updateWorldMatrix(true, false);
      root.applyMatrix4(group.matrixWorld);
    } else {
      const t = this.store.get(id)?.transform ?? {};
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
    return { root, frame };
  }

  disposeLensVisuals(s) {
    if (!s) return;
    if (s.root) {
      // handle geometries may come from the shared recipe cache (carve
      // ghosts); materials are always the lens's own — disposeOwn knows
      s.root.traverse((node) => disposeOwn(node));
      this.scene.remove(s.root);
    }
    s.root = s.frame = null;
    if ('line' in s) s.line = s.ring = null;
    s.handles = [];
  }

  // the data changed under the session (echo, undo, another agent): rebuild
  // the handles and re-select what was selected, if it still exists
  refreshLens(key, rebuild, reselect) {
    const s = this[key];
    if (!s || s.dragging) return;
    const index = s.index;
    rebuild();
    const next = this[key];
    if (!next) return; // the part vanished — session closed
    if (index !== null && index < next.handles.length) reselect(index);
    else {
      next.index = null;
      this.tc.detach();
      this.helper.visible = false;
    }
  }

  pickLens(event, handles, indexKey, select) {
    this.raycaster.setFromCamera(pointerNDC(event, this.pointer), this.camera);
    const hits = this.raycaster.intersectObjects(handles, false);
    if (hits.length) select(hits[0].object.userData[indexKey]);
    // a miss keeps the mode — deliberate exit only (esc), so a sloppy
    // click near a thin handle never dumps you back to entity selection
  }

  // drag lifecycle shared by every lens: capture the mesh on grab, commit
  // one mesh op (with undo) on release
  lensDragChanged(s, dragging, onStart, commit) {
    if (s.index === null) return;
    if (dragging) {
      s.dragging = true;
      s.dragMode = this.tool;
      s.startMesh = structuredClone(this.store.get(s.id)?.mesh ?? null);
      onStart?.();
    } else {
      s.dragging = false;
      const value = commit();
      s.proxy.scale.set(1, 1, 1);
      if (!value) return;
      this.commitMeshOp(s.id, s.startMesh, value);
    }
  }

  commitMeshOp(id, startMesh, value) {
    const redo = [{ op: 'set', id, component: 'mesh', value }];
    this.send(redo);
    this.history.push([{ op: 'set', id, component: 'mesh', value: startMesh }], redo);
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
    const s = this.enterLens('pathEdit', id, partIndex, { line: null, ring: null, closed: false, startRadius: 1 });
    if (!s) return;
    if (this.tool === 'rotate' || !this.tool) this.tool = 'translate';
    this.buildPathHandles();
    if (this.pathEdit) hintText('path edit — click a point · W move · R radius · esc done');
  }

  exitPathEdit() {
    this.exitLens('pathEdit');
  }

  buildPathHandles() {
    const pe = this.pathEdit;
    this.disposeLensVisuals(pe);
    const part = this.lensPart(pe);
    if (!part || !Array.isArray(part.path) || part.path.length < 2) {
      this.exitPathEdit();
      return;
    }
    pe.closed = part.closed ?? false;
    const { root, frame } = this.buildPartFrame(pe.id, part);
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
    pe.ring = new THREE.Line(circleGeometry(1, 48), xray('#7df9ff', 0.8));
    pe.ring.renderOrder = 999;
    pe.ring.visible = false;
    frame.add(pe.ring);
  }

  refreshPathHandles() {
    this.refreshLens('pathEdit', () => this.buildPathHandles(), (i) => this.selectPathPoint(i));
  }

  pickPathPoint(event) {
    this.pickLens(event, this.pathEdit.handles, 'pathIndex', (i) => this.selectPathPoint(i));
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
    this.lensDragChanged(pe, dragging, () => (pe.startRadius = this.pointRadius(pe.index)), () => this.pathCommitMesh());
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
    const part = mesh ? partsOf(mesh)[pe.part] : null;
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
    const part = this.lensPart(this.pathEdit);
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

  // ---- hole edit: boolean cutters as grabbable ghost meshes ----
  // The cutters hang inside the rock as translucent red shapes — click one,
  // and the same W/E/R gizmos entities use move, turn and size it; the hole
  // follows on release (carves re-run CSG per rebuild, so the ghost is the
  // live preview). The DATA stays the flat `carve` array on the mesh part:
  // the "children" exist only as this lens, never as nested entities.

  editCarves(id, partIndex = 0) {
    const s = this.enterLens('carveEdit', id, partIndex, { startEntry: null });
    if (!s) return;
    if (!this.tool) this.tool = 'translate';
    this.buildCarveHandles();
    if (this.carveEdit) hintText('hole edit — click a cutter · W move E turn R size · N new ⌫ remove · esc done');
  }

  exitCarveEdit() {
    this.exitLens('carveEdit');
  }

  carveEntry(i) {
    const part = this.lensPart(this.carveEdit);
    return Array.isArray(part?.carve) ? part.carve[i] : null;
  }

  buildCarveHandles() {
    const ce = this.carveEdit;
    this.disposeLensVisuals(ce);
    const part = this.lensPart(ce);
    if (!part) {
      this.exitCarveEdit();
      return;
    }
    const { root, frame } = this.buildPartFrame(ce.id, part);
    ce.root = root;
    ce.frame = frame;
    (Array.isArray(part.carve) ? part.carve : []).forEach((c, i) => {
      const material = new THREE.MeshBasicMaterial({
        color: '#ff6b6b',
        transparent: true,
        opacity: 0.3,
        depthTest: false,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      });
      // the ghost IS the cutter's recipe — same geometry the CSG evaluates
      const handle = new THREE.Mesh(makeGeometry(c), material);
      handle.position.set(...(c.position ?? [0, 0, 0]));
      if (c.rotation) handle.rotation.set(...c.rotation);
      handle.userData.carveIndex = i;
      handle.renderOrder = 998;
      frame.add(handle);
      ce.handles.push(handle);
    });
  }

  refreshCarveHandles() {
    this.refreshLens('carveEdit', () => this.buildCarveHandles(), (i) => this.selectCarve(i));
  }

  pickCarve(event) {
    this.pickLens(event, this.carveEdit.handles, 'carveIndex', (i) => this.selectCarve(i));
  }

  selectCarve(i) {
    const ce = this.carveEdit;
    ce.index = i;
    for (const h of ce.handles) h.material.color.set(h.userData.carveIndex === i ? '#7df9ff' : '#ff6b6b');
    const h = ce.handles[i];
    h.getWorldPosition(ce.proxy.position);
    h.getWorldQuaternion(ce.proxy.quaternion);
    ce.proxy.scale.set(1, 1, 1);
    this.attachCarveGizmo();
  }

  attachCarveGizmo() {
    const ce = this.carveEdit;
    if (!ce || ce.index === null || !this.tool) {
      this.tc.detach();
      this.helper.visible = false;
      return;
    }
    this.tc.setMode(this.tool);
    // sizing follows the cutter's nature: a box scales on three axes, a
    // sphere has one radius (X), a cylinder radius (X) + height (Y)
    const entry = this.carveEntry(ce.index);
    const scale = this.tool === 'scale';
    this.tc.showX = true;
    this.tc.showY = !scale || !!entry?.size || entry?.height !== undefined;
    this.tc.showZ = !scale || !!entry?.size;
    this.tc.attach(ce.proxy);
    this.helper.visible = true;
  }

  onCarveDragChanged(dragging) {
    const ce = this.carveEdit;
    this.lensDragChanged(
      ce,
      dragging,
      () => (ce.startEntry = structuredClone(this.carveEntry(ce.index) ?? {})),
      () => this.carveCommitMesh(),
    );
  }

  onCarveChange() {
    const ce = this.carveEdit;
    if (ce.index === null || !ce.dragging) return;
    const h = ce.handles[ce.index];
    if (ce.dragMode === 'rotate') {
      ce.frame.getWorldQuaternion(_q);
      h.quaternion.copy(_q.invert().multiply(ce.proxy.quaternion));
    } else if (ce.dragMode === 'scale') {
      const entry = ce.startEntry;
      if (!entry.size && entry.height === undefined) h.scale.setScalar(ce.proxy.scale.x);
      else h.scale.copy(ce.proxy.scale);
    } else {
      h.position.copy(ce.frame.worldToLocal(_v.copy(ce.proxy.position)));
    }
  }

  carveCommitMesh() {
    const ce = this.carveEdit;
    const mesh = structuredClone(this.store.get(ce.id)?.mesh ?? null);
    const part = mesh ? partsOf(mesh)[ce.part] : null;
    const entry = part && Array.isArray(part.carve) ? part.carve[ce.index] : null;
    if (!entry) return null;
    const h = ce.handles[ce.index];
    if (ce.dragMode === 'rotate') {
      _e.setFromQuaternion(h.quaternion);
      entry.rotation = [r2(_e.x), r2(_e.y), r2(_e.z)];
    } else if (ce.dragMode === 'scale') {
      const s = [ce.proxy.scale.x, ce.proxy.scale.y, ce.proxy.scale.z];
      if (entry.size) entry.size = entry.size.map((v, i) => r2(Math.max(0.1, v * s[i])));
      else {
        if (entry.radius !== undefined) entry.radius = r2(Math.max(0.1, entry.radius * s[0]));
        if (entry.height !== undefined) entry.height = r2(Math.max(0.1, entry.height * s[1]));
      }
    } else {
      entry.position = [r2(h.position.x), r2(h.position.y), r2(h.position.z)];
    }
    return mesh;
  }

  // N: a new cutter is born where you look — raycast against the entity's
  // own surface; if the view misses it, 8m ahead of the camera
  addCarve() {
    const ce = this.carveEdit;
    const startMesh = structuredClone(this.store.get(ce.id)?.mesh ?? null);
    const mesh = structuredClone(startMesh);
    const part = mesh ? partsOf(mesh)[ce.part] : null;
    if (!part) return;
    this.raycaster.setFromCamera(_screenCenter, this.camera);
    const group = this.view.getGroup(ce.id);
    const hits = group ? this.raycaster.intersectObject(group, true) : [];
    if (hits.length) _v.copy(hits[0].point);
    else this.camera.getWorldPosition(_v).addScaledVector(this.camera.getWorldDirection(this.dir), 8);
    const local = ce.frame.worldToLocal(_v);
    part.carve = Array.isArray(part.carve) ? part.carve : [];
    part.carve.push({ shape: 'box', size: [2, 2, 2], position: [r2(local.x), r2(local.y), r2(local.z)] });
    this.commitMeshOp(ce.id, startMesh, mesh);
    // the commit echo rebuilds the handles — then hand the newborn the gizmo
    const newborn = part.carve.length - 1;
    setTimeout(() => {
      if (this.carveEdit?.id === ce.id && newborn < this.carveEdit.handles.length) this.selectCarve(newborn);
    }, 150);
  }

  removeCarve() {
    const ce = this.carveEdit;
    if (ce.index === null) return;
    const startMesh = structuredClone(this.store.get(ce.id)?.mesh ?? null);
    const mesh = structuredClone(startMesh);
    const part = mesh ? partsOf(mesh)[ce.part] : null;
    if (!part || !Array.isArray(part.carve) || !part.carve[ce.index]) return;
    part.carve.splice(ce.index, 1);
    if (!part.carve.length) delete part.carve;
    ce.index = null;
    this.commitMeshOp(ce.id, startMesh, mesh);
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
    if (this.carveEdit) {
      this.onCarveDragChanged(dragging);
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
    if (this.carveEdit) {
      this.onCarveChange();
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

const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _screenCenter = new THREE.Vector2(0, 0);

// expand radii (single number, short array, or legacy radius) to one entry
// per path point — the tube maps radius i to point i, clamping past the
// end, so this expansion reproduces the existing shape exactly
function fullRadii(part) {
  const radii = tubeRadii(part);
  return part.path.map((_, i) => radii[Math.min(radii.length - 1, i)]);
}

function hintText(text) {
  const el = document.getElementById('hint');
  if (el) el.textContent = text;
}
