import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';
import { disposeOwn, tubeRadii } from './geometry.js';
import { behaviorList } from '../../shared/motion.js';

// Gizmos draw the invisible data: collider boxes, trigger volumes, water
// areas, light and sound ranges, ferry routes, scene bounds. X-ray lines
// (no depth test) so a trigger inside a dark cave still reads. The selected
// entity always shows its own; the outliner chips switch whole categories on.

const COLORS = {
  walkable: '#39d98a',
  blocker: '#ff5c5c',
  trigger: '#ffd24a',
  water: '#4aa3ff',
  light: '#ffe9a8',
  sound: '#c79bff',
  path: '#ffa94d',
  scatter: '#9be8c0',
  particles: '#e8b4f0',
  scene: '#51708f',
  sceneCurrent: '#7df9ff',
  sceneLoad: '#74c7a8',
  spawn: '#7dffb0',
};

const RELEVANT = new Set(['collider', 'trigger', 'interact', 'water', 'light', 'sound', 'behavior', 'scatter', 'particles', 'spawn', 'mesh']);

export class Gizmos {
  constructor({ scene, store, view, scenes }) {
    this.scene = scene;
    this.store = store;
    this.view = view;
    this.worldScenes = scenes;
    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);
    this.enabled = false;
    this.show = new Set();
    this.categories = [
      { key: 'colliders', label: 'colliders' },
      { key: 'triggers', label: 'triggers' },
      { key: 'water', label: 'water' },
      { key: 'lights', label: 'lights' },
      { key: 'sounds', label: 'sounds' },
      { key: 'paths', label: 'paths' },
      { key: 'areas', label: 'areas' },
      { key: 'scenes', label: 'scenes' },
    ];
    this.selected = null;
    this.tracked = []; // wrappers that follow a (possibly moving) entity
    this.dirty = false;
    this.lastBuild = 0;
    this.sceneSeen = null;
    store.onChange((event) => {
      if (event.kind !== 'set') this.dirty = true;
      else if (RELEVANT.has(event.component)) this.dirty = true;
    });
  }

  setEnabled(on) {
    this.enabled = on;
    this.root.visible = on;
    if (on) this.rebuild();
    else this.clear();
  }

  setSelected(id) {
    if (id === this.selected) return;
    this.selected = id;
    if (this.enabled) this.rebuild();
  }

  toggle(key) {
    if (this.show.has(key)) this.show.delete(key);
    else this.show.add(key);
    if (this.enabled) this.rebuild();
  }

  update() {
    if (!this.enabled) return;
    if (this.view.currentScene !== this.sceneSeen) {
      this.sceneSeen = this.view.currentScene;
      this.dirty = true;
    }
    if (this.dirty && performance.now() - this.lastBuild > 250) this.rebuild();
    // attached gizmos ride their entity — colliders on the moving barge
    for (const t of this.tracked) {
      const group = this.view.getGroup(t.id);
      if (group) {
        t.object.position.copy(group.position);
        t.object.rotation.y = group.rotation.y;
      }
    }
  }

  rebuild() {
    this.clear();
    this.build();
    this.dirty = false;
    this.lastBuild = performance.now();
  }

  clear() {
    for (const child of [...this.root.children]) {
      disposeObject(child);
      this.root.remove(child);
    }
    this.tracked = [];
  }

  want(category, id) {
    return this.show.has(category) || id === this.selected;
  }

  build() {
    for (const [id, comps] of this.store.entities) {
      if (comps.collider?.boxes && this.want('colliders', id)) this.addColliders(id, comps);
      if (comps.trigger && this.want('triggers', id)) this.addTrigger(comps);
      if (comps.interact && this.want('triggers', id)) this.addInteract(id, comps);
      if (comps.water && this.want('water', id)) this.addWater(comps.water);
      if (comps.light && this.want('lights', id)) this.addLight(id, comps);
      if (comps.sound && !comps.sound.ambient && this.want('sounds', id)) this.addSound(id, comps);
      if (this.want('paths', id)) {
        for (const b of behaviorList(comps)) {
          if (b.type === 'path' && b.points?.length >= 2) this.addPath(b);
          if (b.type === 'orbit') this.addOrbit(b);
        }
        for (const p of comps.mesh?.parts ?? []) {
          if (p.shape === 'tube' && p.path?.length >= 2) this.addTubeSpline(id, p);
        }
      }
      if (this.want('areas', id)) {
        if (comps.scatter) this.addArea(comps.scatter.area ?? { center: [0, 0], radius: 60 }, COLORS.scatter);
        if (comps.particles) this.addArea(comps.particles.area ?? { center: [0, 0], radius: 20 }, COLORS.particles);
      }
      if (comps.spawn && this.want('scenes', id)) this.addSpawn(comps.spawn);
    }
    if (this.show.has('scenes')) this.addScenes();
  }

  // ---- attached gizmos: a wrapper that mirrors the entity's pose ----
  attach(id) {
    const wrapper = new THREE.Group();
    const group = this.view.getGroup(id);
    if (group) {
      wrapper.position.copy(group.position);
      wrapper.rotation.y = group.rotation.y;
    } else {
      const comps = this.store.get(id);
      wrapper.position.set(...(comps?.transform?.position ?? [0, 0, 0]));
      wrapper.rotation.y = comps?.transform?.rotation?.[1] ?? 0;
    }
    this.root.add(wrapper);
    this.tracked.push({ object: wrapper, id });
    return wrapper;
  }

  addColliders(id, comps) {
    const wrapper = this.attach(id);
    for (const box of comps.collider.boxes) {
      const [sx, sy, sz] = box.size ?? [1, 1, 1];
      const source = new THREE.BoxGeometry(sx, sy, sz);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(source), lineMaterial(box.blocker ? COLORS.blocker : COLORS.walkable));
      source.dispose();
      edges.position.set(...(box.position ?? [0, 0, 0]));
      mark(edges);
      wrapper.add(edges);
      if (!box.blocker) {
        // the walkable top is the surface that matters — outline it brighter
        const top = new THREE.Line(rectGeometry(sx, sz), lineMaterial(COLORS.walkable, 1));
        top.position.set(...(box.position ?? [0, 0, 0]));
        top.position.y += sy / 2 + 0.02;
        mark(top);
        wrapper.add(top);
      }
    }
  }

  addTrigger(comps) {
    const trig = comps.trigger;
    const area = trig.area ?? {};
    const [cx, cz] = area.center ?? (comps.transform?.position ? [comps.transform.position[0], comps.transform.position[2]] : [0, 0]);
    const y0 = trig.yMin ?? -2;
    const y1 = trig.yMax ?? 8;
    const holder = new THREE.Group();
    holder.position.set(cx, 0, cz);
    const material = () => lineMaterial(COLORS.trigger, 0.9);
    const posts = [];
    if (area.radius) {
      for (const y of [y0, y1]) {
        const ring = new THREE.Line(circleGeometry(area.radius), material());
        ring.position.y = y;
        mark(ring);
        holder.add(ring);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        posts.push([Math.cos(a) * area.radius, Math.sin(a) * area.radius]);
      }
    } else {
      const [sx, sz] = area.size ?? [10, 10];
      for (const y of [y0, y1]) {
        const rect = new THREE.Line(rectGeometry(sx, sz), material());
        rect.position.y = y;
        mark(rect);
        holder.add(rect);
      }
      posts.push([-sx / 2, -sz / 2], [sx / 2, -sz / 2], [sx / 2, sz / 2], [-sx / 2, sz / 2]);
    }
    const points = [];
    for (const [x, z] of posts) points.push(new THREE.Vector3(x, y0, z), new THREE.Vector3(x, y1, z));
    const verticals = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material());
    mark(verticals);
    holder.add(verticals);
    this.root.add(holder);
  }

  // use-range: a dashed reach ring at chest height — same family as triggers
  // (it IS world logic), dashed to say "deliberate", not "walk-in"
  addInteract(id, comps) {
    const wrapper = this.attach(id);
    const ring = new THREE.Line(circleGeometry(comps.interact.radius ?? 4), dashedMaterial(COLORS.trigger, 0.8));
    ring.computeLineDistances();
    ring.position.y = 1.2;
    mark(ring);
    wrapper.add(ring);
  }

  addWater(water) {
    const area = water.area ?? { center: [0, 0], size: [100, 100] };
    const level = water.level ?? 0;
    const [cx, cz] = area.center ?? [0, 0];
    const holder = new THREE.Group();
    holder.position.set(cx, level, cz);
    const outline = area.radius
      ? new THREE.Line(circleGeometry(area.radius), lineMaterial(COLORS.water, 0.7))
      : new THREE.Line(rectGeometry(...(area.size ?? [100, 100])), lineMaterial(COLORS.water, 0.7));
    mark(outline);
    holder.add(outline);
    // a cross through the middle says "surface", not "fence"
    const [ex, ez] = area.radius ? [area.radius, area.radius] : [(area.size?.[0] ?? 100) / 2, (area.size?.[1] ?? 100) / 2];
    const cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-ex, 0, 0),
        new THREE.Vector3(ex, 0, 0),
        new THREE.Vector3(0, 0, -ez),
        new THREE.Vector3(0, 0, ez),
      ]),
      lineMaterial(COLORS.water, 0.35),
    );
    mark(cross);
    holder.add(cross);
    this.root.add(holder);
  }

  addLight(id, comps) {
    const distance = comps.light.distance;
    if (!distance) return; // unbounded light — no meaningful range sphere
    const wrapper = this.attach(id);
    const holder = new THREE.Group();
    holder.position.set(...(comps.light.offset ?? [0, 0, 0]));
    wrapper.add(holder);
    const color = comps.light.color ?? COLORS.light;
    for (const rotation of [null, ['x', Math.PI / 2], ['z', Math.PI / 2]]) {
      const ring = new THREE.Line(circleGeometry(distance), lineMaterial(color, 0.5));
      if (rotation) ring.rotation[rotation[0]] = rotation[1];
      mark(ring);
      holder.add(ring);
    }
  }

  addSound(id, comps) {
    const wrapper = this.attach(id);
    const ring = new THREE.Line(circleGeometry(comps.sound.refDistance ?? 8), dashedMaterial(COLORS.sound, 0.55));
    ring.computeLineDistances();
    mark(ring);
    wrapper.add(ring);
  }

  addPath(b) {
    const pts = b.points.map((p) => new THREE.Vector3(...p));
    const linePts = b.loop ? [...pts, pts[0]] : pts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), lineMaterial(COLORS.path, 0.9));
    mark(line);
    this.root.add(line);
    const markerMat = new THREE.MeshBasicMaterial({ color: COLORS.path, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, fog: false });
    pts.forEach((p, i) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.45 : 0.22, 8, 6), markerMat);
      m.position.copy(p);
      mark(m);
      this.root.add(m);
    });
    // direction cones at each segment midpoint — which way does the ferry go
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 1; i < linePts.length; i++) {
      const dir = linePts[i].clone().sub(linePts[i - 1]);
      if (dir.lengthSq() < 0.01) continue;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.8, 6), markerMat);
      cone.position.copy(linePts[i - 1]).addScaledVector(dir, 0.5);
      cone.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      mark(cone);
      this.root.add(cone);
    }
  }

  // a tube part's spine: the spline through its control points, a marker at
  // each, and a ring of that point's radius oriented along the local run —
  // thickness made visible, editable as plain numbers in the inspector
  addTubeSpline(id, p) {
    const wrapper = this.attach(id);
    const offset = new THREE.Vector3(...(p.position ?? [0, 0, 0]));
    const pts = p.path.map((v) => new THREE.Vector3(...v).add(offset));
    const linePts = p.closed ? [...pts, pts[0]] : pts;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), lineMaterial(COLORS.path, 0.9));
    mark(line);
    wrapper.add(line);
    const radii = tubeRadii(p);
    const markerMat = new THREE.MeshBasicMaterial({ color: COLORS.path, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, fog: false });
    const up = new THREE.Vector3(0, 1, 0);
    pts.forEach((pt, i) => {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.45 : 0.22, 8, 6), markerMat);
      marker.position.copy(pt);
      mark(marker);
      wrapper.add(marker);
      const r = radii[Math.min(radii.length - 1, i)];
      const ring = new THREE.Line(circleGeometry(r, 40), lineMaterial(COLORS.path, 0.5));
      const tangent = pts[Math.min(pts.length - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]);
      if (tangent.lengthSq() > 0.001) ring.quaternion.setFromUnitVectors(up, tangent.normalize());
      ring.position.copy(pt);
      mark(ring);
      wrapper.add(ring);
    });
  }

  addOrbit(b) {
    const [cx, cy, cz] = b.center ?? [0, 0, 0];
    const ring = new THREE.Line(circleGeometry(b.radius ?? 10), lineMaterial(COLORS.path, 0.5));
    ring.position.set(cx, cy + (b.height ?? 0), cz);
    mark(ring);
    this.root.add(ring);
  }

  // scatter/particle footprints, draped over the terrain (or the water,
  // whichever is the visible surface)
  addArea(area, color) {
    const [cx, cz] = area.center ?? [0, 0];
    const points = [];
    if (area.size && (area.shape === 'rect' || !area.radius)) {
      const [sx, sz] = area.size;
      const segs = 24;
      const corners = [
        [-sx / 2, -sz / 2],
        [sx / 2, -sz / 2],
        [sx / 2, sz / 2],
        [-sx / 2, sz / 2],
      ];
      for (let c = 0; c < 4; c++) {
        const [ax, az] = corners[c];
        const [bx, bz] = corners[(c + 1) % 4];
        for (let i = 0; i < segs; i++) {
          const x = cx + ax + ((bx - ax) * i) / segs;
          const z = cz + az + ((bz - az) * i) / segs;
          points.push(new THREE.Vector3(x, this.surfaceY(x, z) + 0.4, z));
        }
      }
    } else {
      const r = area.radius ?? 60;
      for (let i = 0; i < 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        points.push(new THREE.Vector3(x, this.surfaceY(x, z) + 0.4, z));
      }
    }
    points.push(points[0].clone());
    const loop = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial(color, 0.55));
    mark(loop);
    this.root.add(loop);
  }

  addSpawn(spawn) {
    const [x, y, z] = spawn.position ?? [0, 2, 0];
    const material = new THREE.MeshBasicMaterial({ color: COLORS.spawn, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, fog: false });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.3, 8), material);
    cone.position.set(x, y + 1.4, z);
    cone.rotation.x = Math.PI;
    mark(cone);
    this.root.add(cone);
    const ring = new THREE.Line(circleGeometry(0.9), lineMaterial(COLORS.spawn, 0.85));
    ring.position.set(x, y + 0.05, z);
    mark(ring);
    this.root.add(ring);
  }

  addScenes() {
    const index = this.worldScenes?.index;
    if (!index) return;
    for (const scene of index.scenes) {
      if (!scene.bounds) continue;
      const [cx, cz] = scene.bounds.center ?? [0, 0];
      const r = scene.bounds.radius ?? 0;
      const current = scene.name === this.view.currentScene;
      const color = current ? COLORS.sceneCurrent : COLORS.scene;
      const points = [];
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        points.push(new THREE.Vector3(x, this.surfaceY(x, z) + 2, z));
      }
      points.push(points[0].clone());
      const loop = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial(color, current ? 0.9 : 0.45));
      mark(loop);
      this.root.add(loop);
      const y = this.surfaceY(cx, cz);
      const beacon = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(cx, y, cz), new THREE.Vector3(cx, y + 40, cz)]),
        lineMaterial(color, current ? 0.7 : 0.3),
      );
      mark(beacon);
      this.root.add(beacon);
    }
    // load volumes: the explicit streaming triggers — a capped cylinder cage
    // (dashed: "condition", not "place"). Drawn at their authored y range.
    for (const scene of index.scenes) {
      for (const volume of scene.load ?? []) {
        const [cx, cz] = volume.center ?? [0, 0];
        const r = volume.radius ?? 0;
        const [y0, y1] = volume.y ?? [this.surfaceY(cx, cz) - 4, this.surfaceY(cx, cz) + 30];
        const top = Math.min(y1, y0 + 200); // a sky-high cap still reads as a cage
        const holder = new THREE.Group();
        holder.position.set(cx, 0, cz);
        for (const y of [y0, top]) {
          const ring = new THREE.Line(circleGeometry(r), dashedMaterial(COLORS.sceneLoad, 0.85));
          ring.computeLineDistances();
          ring.position.y = y;
          mark(ring);
          holder.add(ring);
        }
        const points = [];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          points.push(
            new THREE.Vector3(Math.cos(a) * r, y0, Math.sin(a) * r),
            new THREE.Vector3(Math.cos(a) * r, top, Math.sin(a) * r),
          );
        }
        const verticals = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), dashedMaterial(COLORS.sceneLoad, 0.5));
        verticals.computeLineDistances();
        mark(verticals);
        holder.add(verticals);
        this.root.add(holder);
      }
    }
  }

  surfaceY(x, z) {
    const water = this.view.waterAt(x, z);
    return Math.max(heightAt(x, z), water ? water.level : -Infinity);
  }
}

// fog: false — gizmos are x-ray annotations, not things in the world; a
// range ring 80m away must read exactly like one at arm's length
function lineMaterial(color, opacity = 0.85) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false });
}

function dashedMaterial(color, opacity = 0.6) {
  return new THREE.LineDashedMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, fog: false, dashSize: 0.8, gapSize: 0.5 });
}

// closed strips, not THREE.LineLoop — WebGPU has no line-loop primitive
// topology, so LineLoop silently draws nothing on the WebGPU renderer
export function circleGeometry(radius, segs = 64) {
  const points = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function rectGeometry(sx, sz) {
  return new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-sx / 2, 0, -sz / 2),
    new THREE.Vector3(sx / 2, 0, -sz / 2),
    new THREE.Vector3(sx / 2, 0, sz / 2),
    new THREE.Vector3(-sx / 2, 0, sz / 2),
    new THREE.Vector3(-sx / 2, 0, -sz / 2),
  ]);
}

// x-ray: draw over everything, last
function mark(object) {
  object.renderOrder = 999;
}

// gizmo chrome owns all its resources, so the shared-cache-aware dispose
// from geometry.js is simply correct here too
function disposeObject(object) {
  object.traverse((node) => disposeOwn(node));
}
