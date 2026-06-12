import * as THREE from 'three/webgpu';
import { buildTerrainMesh, heightAt, registerTerrain, unregisterTerrain } from './terrain.js';
import { makeGeometry, makePartMaterial, disposeOwn, partsOf } from './geometry.js';
import { SKY_PRESETS } from './presets.js';
import { buildScatter } from './scatter.js';
import { buildParticles } from './particles.js';
import { inArea } from '../../shared/scenes.js';

// In the node renderer the SET of scene lights is part of every material's
// shader cache key (LightsNode hashes light.id + castShadow) — adding or
// removing one light recompiles every pipeline in the scene. So runtime
// lights live in a fixed pool of permanent PointLights: the pool objects
// never enter or leave the scene, only their position/color/intensity
// change (none of which touch the key). Light a hundred lanterns: zero
// recompiles. The pool is also the light BUDGET — the nearest N win, so
// forward-lighting cost stays constant no matter how much of the world is
// burning. (Playdead's INSIDE rule: never change the shader environment
// mid-play.)
// 16 is the M13-verified budget — 24 measurably hurt frame rate (every
// pooled light is in every lit fragment's loop, used or not). The pool must
// stay LARGER than any scene's live spec set: a smaller pool means per-frame
// sort/slice churn and starved lights — a burning candle casting nothing.
// Worlds keep within it by FAKING small sources (emissive glow cards +
// flicker), Cyberpunk-style: real lights are for the player and heroes.
const LIGHT_POOL_SIZE = 16;
const _lightPos = new THREE.Vector3();
const _lightDir = new THREE.Vector3();
const _probeGeometry = new THREE.BoxGeometry(0.01, 0.01, 0.01);

// Reconciles world store documents into three.js objects. Each entity gets a
// Group; components map onto children/properties of that group.
export class View {
  constructor({ scene, store, audio, effects, environment, camera, renderer }) {
    this.scene = scene;
    this.store = store;
    this.audio = audio;
    this.effects = effects;
    this.environment = environment;
    this.camera = camera;
    this.renderer = renderer;
    this.groups = new Map();
    this.lights = new Map(); // direct lights (spot/directional/shadow) — build-time only
    this.sounds = new Map();
    this.particleSystems = new Map();
    this.suppressed = new Set();
    // scene streaming: null = no index yet, everything builds
    this.activeScenes = null;
    this.currentScene = null;
    this.buildQueue = [];
    this.buildSet = new Set();
    this.hideQueue = [];
    this.showQueue = [];
    this.lightSpecs = new Map(); // id -> point light spec, pool-assigned by distance
    this.slotById = new Map(); // id -> pool slot currently lighting it
    // component indexes for the per-frame ground/water pipeline — the player
    // asks every frame, so it must never scan the whole entity map
    this.colliderIds = new Set();
    this.waterIds = new Set();
    // bumped whenever scene-graph content appears or changes — editor sweeps
    // (draw modes, skybox hiding) re-run only when this moves
    this.buildVersion = 0;
    this.lightPool = [];
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight('#ffffff', 0, 1);
      light.castShadow = false;
      scene.add(light);
      this.lightPool.push({ light, id: null });
    }
    store.onChange((event) => this.handle(event));
  }

  // entities outside the active scene set stay data-only — no meshes, no
  // sounds, no lights; they build when their scene streams in
  isActive(comps) {
    if (!this.activeScenes) return true;
    const scene = comps?.scene?.name;
    return !scene || this.activeScenes.has(scene);
  }

  // streamed-out scenes HIDE rather than tear down (the Dark Souls model: the
  // world stays resident, geometry never lies). Hidden groups keep their
  // meshes, render objects and compiled pipelines — re-entering a scene is a
  // visibility flip, not a rebuild. Only sounds and light slots let go.
  setActiveScenes(set) {
    this.activeScenes = set;
    for (const [id, comps] of this.store.entities) {
      const group = this.groups.get(id);
      const want = this.isActive(comps);
      if (want && !group) this.queueBuild(id);
      else if (want && group?.userData.hidden) this.showQueue.push(id);
      else if (!want && group && !group.userData.hidden) this.hideQueue.push(id);
    }
  }

  hide(id) {
    const group = this.groups.get(id);
    if (!group || group.userData.hidden) return;
    group.visible = false;
    group.userData.hidden = true;
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    this.releaseSlot(id);
  }

  show(id) {
    const group = this.groups.get(id);
    if (!group || !group.userData.hidden) return;
    group.visible = id !== this.ownPresence;
    group.userData.hidden = false;
    this.buildVersion++;
    const components = this.store.get(id);
    if (components?.sound) this.applySound(id, group, components.sound);
  }

  queueBuild(id) {
    if (this.buildSet.has(id)) return;
    this.buildSet.add(id);
    this.buildQueue.push(id);
  }

  // time-sliced streaming: a scene coming in never drops a frame — builds
  // run against a per-frame millisecond deadline, weighted by mesh-part
  // count (pipelines were all warmed at load; first-draw setup wasn't)
  update() {
    const deadline = performance.now() + 3;
    while (this.hideQueue.length && performance.now() < deadline) {
      this.hide(this.hideQueue.shift());
    }
    while (this.showQueue.length && performance.now() < deadline) {
      this.show(this.showQueue.shift());
    }
    // builds are weighted by mesh-part count: each part attached this frame
    // costs the NEXT render first-draw setup (render object, bind groups,
    // buffers), so a scene streams in a few parts per frame, never a burst
    let parts = 6;
    while (this.buildQueue.length && parts > 0 && performance.now() < deadline) {
      const id = this.buildQueue.shift();
      this.buildSet.delete(id);
      const comps = this.store.get(id);
      if (!this.groups.has(id) && comps) {
        this.build(id);
        parts -= comps.mesh?.parts?.length ?? 1;
      }
    }
    this.updateLights();
  }

  handle(event) {
    this.reindex(event);
    if (event.kind === 'snapshot') this.rebuildAll();
    else if (event.kind === 'spawn') this.buildAnimated(event.id);
    else if (event.kind === 'despawn') this.removeAnimated(event.id);
    else if (event.kind === 'set') this.applyComponent(event.id, event.component);
  }

  // keep the component indexes mirroring the store, build state aside —
  // water in a not-yet-built entity still drowns
  reindex(event) {
    if (event.kind === 'snapshot') {
      this.colliderIds.clear();
      this.waterIds.clear();
      for (const [id, comps] of this.store.entities) this.indexEntity(id, comps);
    } else if (event.kind === 'spawn') {
      this.indexEntity(event.id, this.store.get(event.id));
    } else if (event.kind === 'despawn') {
      this.colliderIds.delete(event.id);
      this.waterIds.delete(event.id);
    } else if (event.kind === 'set' && (event.component === 'collider' || event.component === 'water')) {
      this.indexEntity(event.id, this.store.get(event.id));
    }
  }

  indexEntity(id, comps) {
    if (comps?.collider?.boxes) this.colliderIds.add(id);
    else this.colliderIds.delete(id);
    if (comps?.water) this.waterIds.add(id);
    else this.waterIds.delete(id);
  }

  // every material recipe in the snapshot — including scenes not yet active,
  // and the mesh values hiding inside interact ops — gets drawn ONCE here,
  // on tiny probe meshes pushed through the REAL render path (post chain,
  // shadow pass and all) for two frames at load, behind the entry overlay.
  // compileAsync would warm the wrong context: the world renders through
  // the bloom pass, whose target needs different pipelines than the canvas.
  // After the warm-up, no streamed scene, spawn or lantern flame ever meets
  // a cold shader. (Playdead's INSIDE warm-up: draw every variant before
  // play, then never compile again.)
  warmMaterials() {
    if (!this.camera) return;
    const parts = [];
    const addParts = (mesh, instanced = false) => {
      for (const part of partsOf(mesh)) parts.push({ part, instanced });
    };
    const scanOps = (ops) => {
      for (const op of ops ?? []) {
        if (op.component === 'mesh') addParts(op.value);
        if (op.components) addParts(op.components.mesh);
      }
    };
    for (const comps of this.store.entities.values()) {
      addParts(comps.mesh);
      if (comps.scatter?.instance) addParts(comps.scatter.instance, true);
      scanOps(comps.interact?.ops);
      if (comps.triggers) for (const t of Object.values(comps.triggers)) scanOps(t?.ops);
    }
    const holder = new THREE.Group();
    const addProbe = (probe) => {
      // out of sight but never culled: the draw still runs, the pipeline
      // (and its shadow-pass twin) still compiles
      probe.frustumCulled = false;
      probe.castShadow = true;
      probe.receiveShadow = true;
      holder.add(probe);
    };
    const seen = new Set();
    for (const { part, instanced } of parts) {
      const material = makePartMaterial(part);
      const key = instanced ? material.uuid + 'i' : material.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      // instanced meshes build a different shader variant — probe faithfully
      addProbe(instanced ? new THREE.InstancedMesh(_probeGeometry, material, 1) : new THREE.Mesh(_probeGeometry, material));
    }
    // particle systems are their own material per spec — warm a 1-grain copy
    const particleSpecs = new Set();
    for (const comps of this.store.entities.values()) {
      if (!comps.particles) continue;
      const specKey = JSON.stringify(comps.particles);
      if (particleSpecs.has(specKey)) continue;
      particleSpecs.add(specKey);
      addProbe(buildParticles({ ...comps.particles, count: 1 }).mesh);
    }
    if (!holder.children.length) return;
    holder.position.set(0, -800, 0);
    this.scene.add(holder);
    let framesLeft = 2;
    const tick = () => {
      if (--framesLeft > 0) {
        requestAnimationFrame(tick);
        return;
      }
      this.scene.remove(holder);
      holder.traverse((node) => disposeOwn(node));
    };
    requestAnimationFrame(tick);
  }

  buildAnimated(id) {
    this.build(id);
    const group = this.groups.get(id);
    const components = this.store.get(id);
    // hidden builds (spawn into a streamed-out scene) materialize silently
    if (!group || group.userData.hidden || !this.effects || components?.terrain || id === this.ownPresence) return;
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
    this.effects.scaleOut(group, () => {
      // the id may have respawned while the shrink played (a scene reset
      // despawns and respawns in one batch) — never remove the replacement
      if (this.groups.get(id) === group) this.remove(id);
    });
  }

  suppress(id) {
    this.suppressed.add(id);
  }

  unsuppress(id) {
    this.suppressed.delete(id);
    if (this.store.get(id) && this.groups.has(id)) this.applyTransform(id);
  }

  // the whole world builds at load — and renders, ALL of it visible, for a
  // few frames behind the entry overlay, so every pipeline compiles and
  // every render object exists before play begins. Then the scenes the
  // player isn't in go to sleep. After that, streaming is pure visibility —
  // nothing is ever built, compiled or torn down mid-play (the Dark Souls
  // model: the world stays resident; INSIDE's rule: warm everything, then
  // never warm again).
  rebuildAll() {
    for (const id of [...this.groups.keys()]) this.remove(id);
    this.warming = true;
    for (const id of this.store.entities.keys()) this.build(id);
    this.warmMaterials();
    // render the warm frames UNCULLED: render objects only exist once drawn,
    // and the camera is at the spawn — anything outside its frustum would
    // stay cold and bill its setup to the first frame that looks at it
    const culled = [];
    for (const group of this.groups.values()) {
      group.traverse((node) => {
        if (node.isMesh && node.frustumCulled) {
          node.frustumCulled = false;
          culled.push(node);
        }
      });
    }
    let frames = 3;
    const settle = () => {
      if (--frames > 0) {
        requestAnimationFrame(settle);
        return;
      }
      for (const node of culled) node.frustumCulled = true;
      this.warming = false;
      for (const [id, comps] of this.store.entities) {
        if (!this.isActive(comps)) this.hide(id);
      }
    };
    requestAnimationFrame(settle);
  }

  build(id) {
    this.remove(id);
    const components = this.store.get(id);
    if (!components) return;
    const group = new THREE.Group();
    group.name = id;
    if (id === this.ownPresence) group.visible = false; // don't render your own head
    if (!this.warming && !this.isActive(components)) {
      // out-of-scene entities build resident-but-asleep: no draw, no sound,
      // no light slot — show() wakes them when their scene streams in
      group.visible = false;
      group.userData.hidden = true;
    }
    this.groups.set(id, group);
    this.scene.add(group);
    this.buildVersion++;
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
        this.buildVersion++;
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
        this.buildVersion++;
        break;
      case 'scatter':
        this.applyScatter(group, value);
        this.buildVersion++;
        break;
      case 'particles':
        this.applyParticles(id, group, value);
        this.buildVersion++;
        break;
      case 'environment':
        // in a multi-scene world, only the current scene's mood applies
        if (!this.activeScenes || !components.scene || components.scene.name === this.currentScene) {
          this.environment?.apply(value);
        }
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
    for (const part of partsOf(recipe)) {
      const mesh = new THREE.Mesh(makeGeometry(part), makePartMaterial(part));
      // preset parts (water, flame, glow, hologram) are visual, not walkable
      // by default — but an explicit solid wins either way: architectural
      // presets (a stone tube's cave floor) can opt in with solid: true
      mesh.userData.solid = part.solid !== undefined ? !!part.solid : !part.preset;
      // sky-as-geometry sheets — the editor's skybox toggle hides these
      if (SKY_PRESETS.has(part.preset)) mesh.userData.sky = true;
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
    this.lightSpecs.delete(id);
    this.releaseSlot(id);
    if (!value) return;
    if (value.type === 'spot' || value.type === 'directional' || value.castShadow) {
      // direct lights change the scene's light set — every material in the
      // scene recompiles. Fine at build time, never during play.
      let light;
      if (value.type === 'spot') {
        light = new THREE.SpotLight(value.color ?? '#ffffff', value.intensity ?? 10, value.distance ?? 0, value.angle ?? Math.PI / 5);
      } else if (value.type === 'directional') {
        light = new THREE.DirectionalLight(value.color ?? '#ffffff', value.intensity ?? 1);
      } else {
        light = new THREE.PointLight(value.color ?? '#ffffff', value.intensity ?? 10, value.distance ?? 0);
      }
      light.position.set(...(value.offset ?? [0, 0, 0]));
      light.castShadow = value.castShadow ?? false;
      light.userData.baseIntensity = light.intensity;
      this.lights.set(id, light);
      group.add(light);
      return;
    }
    // point lights go through the pool — updateLights assigns the nearest
    this.lightSpecs.set(id, value);
  }

  releaseSlot(id) {
    const slot = this.slotById.get(id);
    if (!slot) return;
    slot.id = null;
    slot.light.intensity = 0;
    this.slotById.delete(id);
  }

  assignSlot(slot, id, spec) {
    if (slot.id !== null) this.slotById.delete(slot.id);
    slot.id = id;
    this.slotById.set(id, slot);
    const light = slot.light;
    light.color.set(spec.color ?? '#ffffff');
    light.intensity = spec.intensity ?? 10;
    light.distance = spec.distance ?? 0;
    light.userData.baseIntensity = light.intensity;
  }

  // pool assignment: the nearest specs (by distance to camera, minus their
  // reach) hold slots; everyone else waits unlit. Positions follow their
  // entity every frame, so pooled lights ride moving platforms for free.
  updateLights() {
    const cam = this.camera?.position;
    if (!cam) return;
    const candidates = [];
    for (const [id, spec] of this.lightSpecs) {
      const group = this.groups.get(id);
      if (!group || group.userData.hidden) continue; // hidden = streamed out
      const d = Math.hypot(group.position.x - cam.x, group.position.y - cam.y, group.position.z - cam.z) - (spec.distance || 30);
      candidates.push({ id, spec, group, d });
    }
    if (candidates.length > this.lightPool.length) candidates.sort((a, b) => a.d - b.d);
    const want = candidates.slice(0, this.lightPool.length);
    const wantIds = new Set();
    for (const c of want) wantIds.add(c.id);
    for (const slot of this.lightPool) {
      if (slot.id !== null && !wantIds.has(slot.id)) this.releaseSlot(slot.id);
    }
    let free = null;
    for (const c of want) {
      let slot = this.slotById.get(c.id);
      if (!slot) {
        if (!free) free = this.lightPool.filter((s) => s.id === null);
        slot = free.pop();
        // skip just this candidate — a break here would freeze the position
        // of every later slotted light this frame, the carried flame included
        if (!slot) continue;
        this.assignSlot(slot, c.id, c.spec);
      }
      // scene lightScale, re-applied per frame (it crossfades at seams): a
      // flame authored against the dark washes out under a daylight env.
      // baseIntensity too, so flicker behaviors compose with the scale.
      const scaled = (c.spec.intensity ?? 10) * (this.environment?.lightScale ?? 1);
      slot.light.intensity = scaled;
      slot.light.userData.baseIntensity = scaled;
      if (c.id === this.ownPresence) {
        // your own carried light rides the camera, smooth at frame rate —
        // not the 300ms presence trickle the rest of the world sees. The
        // offset is in the camera's FLAT frame (yaw only, so looking down
        // doesn't bury it in the floor): z < 0 carries it ahead of you,
        // lighting where you're going instead of glaring where you stand.
        const [ox, oy, oz] = c.spec.offset ?? [0, 0, 0];
        this.camera.getWorldDirection(_lightDir);
        _lightDir.y = 0;
        _lightDir.normalize();
        slot.light.position.copy(this.camera.position).addScaledVector(_lightDir, -oz);
        slot.light.position.y += oy;
        slot.light.position.x += -_lightDir.z * ox;
        slot.light.position.z += _lightDir.x * ox;
      } else {
        _lightPos.set(...(c.spec.offset ?? [0, 0, 0]));
        slot.light.position.copy(c.group.localToWorld(_lightPos));
      }
    }
  }

  applySound(id, group, value) {
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    if (!value || group.userData.hidden) return; // hidden scenes are silent
    const handle = this.audio.attach(group, value);
    this.sounds.set(id, handle);
    // an ambient sound built for a non-current scene starts silent
    const scene = this.store.get(id)?.scene?.name;
    if (handle.ambient && this.activeScenes && scene && scene !== this.currentScene) handle.fade?.(0, 0.01);
  }

  applyTerrain(group, value) {
    for (const child of [...group.children]) {
      if (child.userData.kind === 'terrain') {
        disposeObject(child);
        group.remove(child);
      }
    }
    unregisterTerrain(group);
    if (!value) return;
    const mesh = buildTerrainMesh(value);
    mesh.userData.kind = 'terrain';
    group.add(mesh);
    registerTerrain(group, value);
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
    this.lightSpecs.delete(id);
    this.releaseSlot(id);
    this.particleSystems.delete(id);
    unregisterTerrain(group);
    disposeObject(group);
    this.scene.remove(group);
    this.groups.delete(id);
  }

  // analytic walkable boxes from `collider` components — the reliable path
  // for decks, bridges, floors (no raycast, no gaps). Returns the highest
  // {top, id} under (x, z) no higher than maxTop, or null — feet-aware so
  // stacked floors work (a switchback above you is not your ground). The id
  // lets the player ride a moving platform. Boxes are entity-relative and
  // yaw-aware.
  walkableAt(x, z, maxTop = Infinity) {
    let best = null;
    for (const id of this.colliderIds) {
      const boxes = this.store.get(id)?.collider?.boxes;
      if (!boxes) continue;
      const group = this.groups.get(id);
      if (!group) continue;
      const yaw = group.rotation.y;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const wx = x - group.position.x;
      const wz = z - group.position.z;
      // world → entity-local (inverse yaw)
      const lx = wx * cos - wz * sin;
      const lz = wx * sin + wz * cos;
      for (const box of boxes) {
        if (box.blocker) continue;
        const [bx, by, bz] = box.position ?? [0, 0, 0];
        const [sx, sy, sz] = box.size ?? [1, 0.2, 1];
        if (Math.abs(lx - bx) > sx / 2 || Math.abs(lz - bz) > sz / 2) continue;
        const top = group.position.y + by + sy / 2;
        if (top > maxTop) continue;
        if (best === null || top > best.top) best = { top, id };
      }
    }
    return best;
  }

  // water lookup: the first active `water` component whose area contains
  // (x, z) — {level, drownAfter} or null. Same containment math as the
  // server's trigger volumes (shared inArea), so the swim and the drown agree.
  waterAt(x, z) {
    for (const id of this.waterIds) {
      const comps = this.store.get(id);
      const water = comps?.water;
      if (!water || !this.isActive(comps)) continue;
      if (water.area && !inArea(water.area, x, z, [100, 100])) continue;
      return { level: water.level ?? 0, drownAfter: water.drownAfter };
    }
    return null;
  }

  // blocker boxes (`blocker: true` in a collider) push a body out
  // horizontally — cave walls, railings. Mutates `position` in place.
  resolveBlockers(position, eyeHeight) {
    const feet = position.y - eyeHeight;
    const head = position.y + 0.2;
    const r = 0.35;
    for (const id of this.colliderIds) {
      const boxes = this.store.get(id)?.collider?.boxes;
      if (!boxes) continue;
      const group = this.groups.get(id);
      if (!group) continue;
      const yaw = group.rotation.y;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      for (const box of boxes) {
        if (!box.blocker) continue;
        const [bx, by, bz] = box.position ?? [0, 0, 0];
        const [sx, sy, sz] = box.size ?? [1, 1, 1];
        const top = group.position.y + by + sy / 2;
        const bottom = group.position.y + by - sy / 2;
        if (feet >= top - 0.05 || head <= bottom) continue;
        const wx = position.x - group.position.x;
        const wz = position.z - group.position.z;
        const lx = wx * cos - wz * sin;
        const lz = wx * sin + wz * cos;
        const px = sx / 2 + r - Math.abs(lx - bx);
        const pz = sz / 2 + r - Math.abs(lz - bz);
        if (px <= 0 || pz <= 0) continue;
        let ox = 0;
        let oz = 0;
        if (px < pz) ox = lx > bx ? px : -px;
        else oz = lz > bz ? pz : -pz;
        position.x += ox * cos + oz * sin;
        position.z += -ox * sin + oz * cos;
      }
    }
  }

  // ambient sounds belong to their scene's mood: fade them with the player's
  // current scene (positional sounds attenuate by distance on their own)
  updateAmbience() {
    for (const [id, handle] of this.sounds) {
      if (!handle.ambient || !handle.fade) continue;
      const scene = this.store.get(id)?.scene?.name;
      if (!this.activeScenes || !scene) continue;
      handle.fade(scene === this.currentScene ? 1 : 0, 1.8);
    }
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
      // solid surfaces only ever come from mesh parts — direct children, so
      // this per-frame hot path never pays a recursive traverse
      for (const child of group.children) {
        if (child.userData.kind === 'mesh-part' && child.userData.solid) candidates.push(child);
      }
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

  // which entity a raycast hit belongs to: walk up to the group under the scene
  rootIdOf(object) {
    let node = object;
    while (node && node.parent !== this.scene) node = node.parent;
    return node?.name || null;
  }

  getLight(id) {
    return this.slotById.get(id)?.light ?? this.lights.get(id);
  }
}

function disposeObject(object) {
  object.traverse((node) => disposeOwn(node));
}
