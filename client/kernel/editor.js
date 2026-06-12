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
    this.meshEdit = null;
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

    // mesh edit follows the data, not its own edits: undo, another agent's
    // op, or our own commit echo all land here and re-place the handles
    store.onChange((event) => {
      if (!this.meshEdit) return;
      if (event.kind === 'snapshot') this.refreshMeshHandles();
      else if (event.id !== this.meshEdit.id) return;
      else if (event.kind === 'despawn') this.exitMeshEdit();
      else if (event.kind === 'set' && event.component === 'mesh') this.refreshMeshHandles();
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
      if (this.meshEdit) {
        this.pickHandle(e); // mesh edit owns the click — esc leaves
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
      // the tool keys are one vocabulary in and out of mesh edit; a spline
      // point has no rotation, so E stays inert while one is selected
      switch (e.code) {
        case 'KeyQ':
          this.setTool(null);
          return;
        case 'KeyW':
          this.setTool('translate');
          return;
        case 'KeyE':
          if (this.meshEdit?.sel?.kind !== 'point') this.setTool('rotate');
          return;
        case 'KeyR':
          this.setTool('scale');
          return;
        case 'KeyF':
          this.frameSelected();
          return;
      }
      if (this.meshEdit) {
        // mesh edit owns the keys: delete removes the selected HOLE, never
        // the entity — the entity is unreachable until esc leaves the mode
        if (e.code === 'KeyN') this.addCarve();
        else if (e.code === 'Delete' || e.code === 'Backspace') this.removeCarve();
        else if (e.code === 'Escape') this.exitMeshEdit();
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
    this.exitMeshEdit();
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
    if (this.meshEdit) this.attachHandleGizmo();
    else this.attachGizmo();
  }

  // ---- mesh edit: ONE lens for everything a mesh is made of ----
  // The inspector's `edit` button opens it. Spline control points appear as
  // grabbable orange dots (W moves, R thickens — one axis, a point has
  // thickness, not volume); the boolean cutters (`carve`) appear as
  // translucent red ghost meshes — the holes, listed in the outliner as
  // children of the entity, selectable there or in the world, moved/
  // turned/sized with the same W/E/R gizmos entities use. N births a hole
  // where you look, ⌫ removes the selected one, esc is done. Outside this
  // mode the holes stay invisible. The mesh rebuilds on RELEASE, not per
  // frame (carve-heavy parts re-run CSG per rebuild) — the handles are the
  // live preview, and each release is one undoable mesh op. The DATA stays
  // the flat `path`/`carve` arrays on the part: the "children" exist only
  // as this lens, never as entities.

  editMesh(id) {
    if (this.meshEdit?.id === id) {
      this.exitMeshEdit(); // the button toggles: edit ↔ done
      return;
    }
    if (this.player.gameMode) return;
    if (this.mode !== 'create') this.enterCreate();
    this.select(id); // also tears down any previous session
    if (!this.store.get(id)) return;
    this.tc.detach();
    this.helper.visible = false;
    this.meshEdit = {
      id,
      sel: null, // { kind: 'point'|'cutter', part, index }
      handles: [],
      proxy: new THREE.Object3D(),
      root: null,
      frames: [], // per-part frame (scene ∘ entity ∘ part transform)
      splines: new Map(), // part index → { line, ring, closed, points }
      dragging: false,
      dragMode: null,
      startMesh: null,
      startRadius: 1,
      startEntry: null,
    };
    this.scene.add(this.meshEdit.proxy);
    if (!this.tool) this.tool = 'translate';
    this.buildMeshHandles();
    if (this.meshEdit) {
      hintText('mesh edit — click a point or hole · W move E turn R size · N new hole ⌫ remove · esc done');
      this.panel?.refresh();
      this.outliner?.refresh(); // the holes appear as children of the entity
    }
  }

  exitMeshEdit() {
    const me = this.meshEdit;
    if (!me) return;
    this.disposeMeshVisuals(me);
    this.scene.remove(me.proxy);
    this.meshEdit = null;
    this.tc.detach();
    this.tc.showX = this.tc.showY = this.tc.showZ = true;
    this.helper.visible = false;
    hintText('');
    this.attachGizmo();
    this.panel?.refresh();
    this.outliner?.refresh();
  }

  // handle space is each part's own frame (scene ∘ entity ∘ part transform),
  // so a handle's pose IS a path/carve coordinate — no conversion drift
  buildMeshHandles() {
    const me = this.meshEdit;
    this.disposeMeshVisuals(me);
    const comps = this.store.get(me.id);
    const parts = partsOf(comps?.mesh);
    if (!parts.length) {
      this.exitMeshEdit();
      return;
    }
    const root = new THREE.Group();
    const group = this.view.getGroup(me.id);
    if (group) {
      group.updateWorldMatrix(true, false);
      root.applyMatrix4(group.matrixWorld);
    } else {
      const t = comps.transform ?? {};
      root.position.set(...(t.position ?? [0, 0, 0]));
      root.rotation.set(...(t.rotation ?? [0, 0, 0]));
    }
    this.scene.add(root);
    me.root = root;

    const xray = (color, opacity) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false });

    parts.forEach((part, pi) => {
      if (!part) return;
      const frame = new THREE.Group();
      frame.position.set(...(part.position ?? [0, 0, 0]));
      frame.rotation.set(...(part.rotation ?? [0, 0, 0]));
      if (part.scale) {
        if (Array.isArray(part.scale)) frame.scale.set(...part.scale);
        else frame.scale.setScalar(part.scale);
      }
      root.add(frame);
      me.frames[pi] = frame;

      // spline parts: a grabbable dot per control point, the spine, and a
      // radius ring that follows the selected point
      if (part.shape === 'tube' && Array.isArray(part.path) && part.path.length >= 2) {
        const closed = part.closed ?? false;
        const points = [];
        part.path.forEach((p, i) => {
          const material = new THREE.MeshBasicMaterial({ color: '#ffa94d', transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, fog: false });
          const handle = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), material);
          handle.position.set(...p);
          handle.userData.sel = { kind: 'point', part: pi, index: i };
          handle.renderOrder = 999;
          frame.add(handle);
          me.handles.push(handle);
          points.push(handle);
        });
        const pts = points.map((h) => h.position);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(closed ? [...pts, pts[0]] : pts), xray('#ffa94d', 0.9));
        line.renderOrder = 999;
        frame.add(line);
        const ring = new THREE.Line(circleGeometry(1, 48), xray('#7df9ff', 0.8));
        ring.renderOrder = 999;
        ring.visible = false;
        frame.add(ring);
        me.splines.set(pi, { line, ring, closed, points });
      }

      // every part's holes: the cutters as ghost meshes — the recipe the
      // CSG evaluates, visible only inside this mode. Depth-tested on
      // purpose: occlusion is what tells you WHERE a hole sits; the
      // polygon offset keeps the ghost from shimmering against the carved
      // walls it coincides with.
      (Array.isArray(part.carve) ? part.carve : []).forEach((c, i) => {
        const material = new THREE.MeshBasicMaterial({
          color: '#ff6b6b',
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -1,
          fog: false,
          side: THREE.DoubleSide,
        });
        const handle = new THREE.Mesh(makeGeometry(c), material);
        handle.position.set(...(c.position ?? [0, 0, 0]));
        if (c.rotation) handle.rotation.set(...c.rotation);
        handle.userData.sel = { kind: 'cutter', part: pi, index: i };
        frame.add(handle);
        me.handles.push(handle);
      });
    });
    root.updateWorldMatrix(true, true);
  }

  disposeMeshVisuals(me) {
    if (!me) return;
    if (me.root) {
      // handle geometries may come from the shared recipe cache (cutter
      // ghosts); materials are always the lens's own — disposeOwn knows
      me.root.traverse((node) => disposeOwn(node));
      this.scene.remove(me.root);
    }
    me.root = null;
    me.frames = [];
    me.splines = new Map();
    me.handles = [];
  }

  // the data changed under the session (echo, undo, another agent): rebuild
  // the handles and re-select what was selected, if it still exists
  refreshMeshHandles() {
    const me = this.meshEdit;
    if (!me || me.dragging) return;
    const sel = me.sel;
    this.buildMeshHandles();
    if (!this.meshEdit) return; // the mesh vanished — session closed
    if (sel && this.handleFor(sel)) this.selectHandle(sel);
    else {
      this.meshEdit.sel = null;
      this.tc.detach();
      this.helper.visible = false;
      this.outliner?.refresh();
    }
  }

  handleFor(sel) {
    if (!sel) return null;
    return (
      this.meshEdit?.handles.find(
        (h) => h.userData.sel.kind === sel.kind && h.userData.sel.part === sel.part && h.userData.sel.index === sel.index,
      ) ?? null
    );
  }

  pickHandle(event) {
    this.raycaster.setFromCamera(pointerNDC(event, this.pointer), this.camera);
    const hits = this.raycaster.intersectObjects(this.meshEdit.handles, false);
    if (hits.length) this.selectHandle(hits[0].object.userData.sel);
    // a miss keeps the mode — deliberate exit only (esc), so a sloppy
    // click near a thin handle never dumps you back to entity selection
  }

  selectHandle(sel) {
    const me = this.meshEdit;
    const handle = this.handleFor(sel);
    if (!me || !handle) return;
    me.sel = sel;
    for (const h of me.handles) {
      const u = h.userData.sel;
      const on = u.kind === sel.kind && u.part === sel.part && u.index === sel.index;
      h.material.color.set(on ? '#7df9ff' : u.kind === 'point' ? '#ffa94d' : '#ff6b6b');
    }
    handle.getWorldPosition(me.proxy.position);
    if (sel.kind === 'cutter') handle.getWorldQuaternion(me.proxy.quaternion);
    else me.proxy.quaternion.identity();
    me.proxy.scale.set(1, 1, 1);
    this.attachHandleGizmo();
    this.updateRing();
    this.outliner?.refresh(); // sync the selected hole row
  }

  attachHandleGizmo() {
    const me = this.meshEdit;
    if (!me || !me.sel || !this.tool) {
      this.tc.detach();
      this.helper.visible = false;
      return;
    }
    if (me.sel.kind === 'point' && this.tool === 'rotate') this.tool = 'translate'; // points don't rotate
    this.tc.setMode(this.tool);
    const scale = this.tool === 'scale';
    if (me.sel.kind === 'point') {
      // thickness is one number — the scale gizmo offers a single axis
      this.tc.showX = true;
      this.tc.showY = !scale;
      this.tc.showZ = !scale;
    } else {
      // sizing follows the cutter's nature: a box scales on three axes, a
      // sphere has one radius (X), a cylinder radius (X) + height (Y)
      const entry = this.carveEntry(me.sel);
      this.tc.showX = true;
      this.tc.showY = !scale || !!entry?.size || entry?.height !== undefined;
      this.tc.showZ = !scale || !!entry?.size;
    }
    this.tc.attach(me.proxy);
    this.helper.visible = true;
  }

  // drag lifecycle: capture the mesh on grab, commit one mesh op (with
  // undo) on release — the handles are the live preview in between
  onMeshDragChanged(dragging) {
    const me = this.meshEdit;
    if (!me.sel) return;
    if (dragging) {
      me.dragging = true;
      me.dragMode = this.tool;
      me.startMesh = structuredClone(this.store.get(me.id)?.mesh ?? null);
      if (me.sel.kind === 'point') me.startRadius = this.pointRadius(me.sel);
      else me.startEntry = structuredClone(this.carveEntry(me.sel) ?? {});
    } else {
      me.dragging = false;
      const value = me.sel.kind === 'point' ? this.pathCommitMesh() : this.carveCommitMesh();
      me.proxy.scale.set(1, 1, 1);
      if (!value) return;
      this.commitMeshOp(me.id, me.startMesh, value);
    }
  }

  onMeshChange() {
    const me = this.meshEdit;
    if (!me.sel || !me.dragging) return;
    const handle = this.handleFor(me.sel);
    const frame = me.frames[me.sel.part];
    if (!handle || !frame) return;
    if (me.sel.kind === 'point') {
      if (me.dragMode === 'scale') {
        this.updateRing(Math.max(0.15, me.startRadius * me.proxy.scale.x));
      } else {
        handle.position.copy(frame.worldToLocal(_v.copy(me.proxy.position)));
        this.updateSplineLine(me.sel.part);
        this.updateRing();
      }
    } else if (me.dragMode === 'rotate') {
      frame.getWorldQuaternion(_q);
      handle.quaternion.copy(_q.invert().multiply(me.proxy.quaternion));
    } else if (me.dragMode === 'scale') {
      const entry = me.startEntry;
      if (!entry.size && entry.height === undefined) handle.scale.setScalar(me.proxy.scale.x);
      else handle.scale.copy(me.proxy.scale);
    } else {
      handle.position.copy(frame.worldToLocal(_v.copy(me.proxy.position)));
    }
  }

  commitMeshOp(id, startMesh, value) {
    const redo = [{ op: 'set', id, component: 'mesh', value }];
    this.send(redo);
    this.history.push([{ op: 'set', id, component: 'mesh', value: startMesh }], redo);
  }

  pathCommitMesh() {
    const me = this.meshEdit;
    const mesh = structuredClone(this.store.get(me.id)?.mesh ?? null);
    const part = mesh ? partsOf(mesh)[me.sel.part] : null;
    if (!part || !Array.isArray(part.path)) return null;
    if (me.dragMode === 'scale') {
      const radii = fullRadii(part);
      radii[me.sel.index] = r2(Math.max(0.15, me.startRadius * me.proxy.scale.x));
      part.radii = radii;
    } else {
      const p = this.handleFor(me.sel).position;
      part.path[me.sel.index] = [r2(p.x), r2(p.y), r2(p.z)];
    }
    return mesh;
  }

  carveCommitMesh() {
    const me = this.meshEdit;
    const mesh = structuredClone(this.store.get(me.id)?.mesh ?? null);
    const part = mesh ? partsOf(mesh)[me.sel.part] : null;
    const entry = part && Array.isArray(part.carve) ? part.carve[me.sel.index] : null;
    if (!entry) return null;
    const handle = this.handleFor(me.sel);
    if (me.dragMode === 'rotate') {
      _e.setFromQuaternion(handle.quaternion);
      entry.rotation = [r2(_e.x), r2(_e.y), r2(_e.z)];
    } else if (me.dragMode === 'scale') {
      const s = [me.proxy.scale.x, me.proxy.scale.y, me.proxy.scale.z];
      if (entry.size) entry.size = entry.size.map((v, i) => r2(Math.max(0.1, v * s[i])));
      else {
        if (entry.radius !== undefined) entry.radius = r2(Math.max(0.1, entry.radius * s[0]));
        if (entry.height !== undefined) entry.height = r2(Math.max(0.1, entry.height * s[1]));
      }
    } else {
      entry.position = [r2(handle.position.x), r2(handle.position.y), r2(handle.position.z)];
    }
    return mesh;
  }

  carveEntry(sel) {
    const part = partsOf(this.store.get(this.meshEdit?.id)?.mesh)[sel?.part ?? 0];
    return Array.isArray(part?.carve) ? part.carve[sel.index] : null;
  }

  pointRadius(sel) {
    const part = partsOf(this.store.get(this.meshEdit.id)?.mesh)[sel.part];
    return part?.path ? fullRadii(part)[sel.index] : 1;
  }

  updateSplineLine(pi) {
    const spline = this.meshEdit.splines.get(pi);
    if (!spline) return;
    const pts = spline.points.map((h) => h.position);
    spline.line.geometry.dispose();
    spline.line.geometry = new THREE.BufferGeometry().setFromPoints(spline.closed ? [...pts, pts[0]] : pts);
  }

  updateRing(liveRadius = null) {
    const me = this.meshEdit;
    if (!me) return;
    const sel = me.sel;
    const spline = sel?.kind === 'point' ? me.splines.get(sel.part) : null;
    for (const s of me.splines.values()) s.ring.visible = s === spline;
    if (!spline) return;
    const pts = spline.points.map((h) => h.position);
    spline.ring.position.copy(pts[sel.index]);
    const tangent = _v.copy(pts[Math.min(pts.length - 1, sel.index + 1)]).sub(pts[Math.max(0, sel.index - 1)]);
    if (tangent.lengthSq() > 0.001) spline.ring.quaternion.setFromUnitVectors(_up, tangent.normalize());
    spline.ring.scale.setScalar(Math.max(0.05, liveRadius ?? this.pointRadius(sel)));
  }

  // N (or the inspector's + hole): a new cutter is born where you look —
  // raycast against the entity's own surface; if the view misses it, 8m
  // ahead of the camera. Lands in the selected handle's part, else part 0.
  addCarve() {
    const me = this.meshEdit;
    if (!me) return;
    const pi = me.sel?.part ?? 0;
    const frame = me.frames[pi];
    if (!frame) return;
    const startMesh = structuredClone(this.store.get(me.id)?.mesh ?? null);
    const mesh = structuredClone(startMesh);
    const part = mesh ? partsOf(mesh)[pi] : null;
    if (!part) return;
    this.raycaster.setFromCamera(_screenCenter, this.camera);
    const group = this.view.getGroup(me.id);
    const hits = group ? this.raycaster.intersectObject(group, true) : [];
    if (hits.length) _v.copy(hits[0].point);
    else this.camera.getWorldPosition(_v).addScaledVector(this.camera.getWorldDirection(this.dir), 8);
    const local = frame.worldToLocal(_v);
    part.carve = Array.isArray(part.carve) ? part.carve : [];
    part.carve.push({ shape: 'box', size: [2, 2, 2], position: [r2(local.x), r2(local.y), r2(local.z)] });
    this.commitMeshOp(me.id, startMesh, mesh);
    // the commit echo rebuilds the handles — then hand the newborn the gizmo
    const newborn = { kind: 'cutter', part: pi, index: part.carve.length - 1 };
    setTimeout(() => {
      if (this.meshEdit?.id === me.id) this.selectHandle(newborn);
    }, 150);
  }

  removeCarve() {
    const me = this.meshEdit;
    if (me?.sel?.kind !== 'cutter') return;
    const startMesh = structuredClone(this.store.get(me.id)?.mesh ?? null);
    const mesh = structuredClone(startMesh);
    const part = mesh ? partsOf(mesh)[me.sel.part] : null;
    if (!part || !Array.isArray(part.carve) || !part.carve[me.sel.index]) return;
    part.carve.splice(me.sel.index, 1);
    if (!part.carve.length) delete part.carve;
    me.sel = null;
    this.commitMeshOp(me.id, startMesh, mesh);
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
    if (this.meshEdit) {
      this.onMeshDragChanged(dragging);
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
    if (this.meshEdit) {
      this.onMeshChange();
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
