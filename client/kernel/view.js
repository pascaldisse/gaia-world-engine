import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildTerrainMesh, heightAt, registerTerrain, unregisterTerrain } from './terrain.js';
import { makeGeometry, makePartMaterial, disposeOwn, partsOf, loadModel, loadModelSkinned, cloneModel, libraryMaterialDoc } from './geometry.js';
import { SKY_PRESETS } from './presets.js';
import { buildScatter } from './scatter.js';
import { buildParticles } from './particles.js';
import { inArea } from '../../shared/scenes.js';
import { hasMotion } from '../../shared/motion.js';
import { planarYaw } from '../../shared/collider.js';
import { loadVRM, applyVrmEdits, liveVrms, playClip } from './vrm.js';
import { InstancedModels } from './instanced-models.js';
import { resolveRainBones } from './rain-body.js';
import { ImpostorCache, bucketOf, projectedExtents } from './impostors.js';

// `mesh.parts[].animated: true` picks skinned playback (below) instead of
// the static instancing path — `auto` gait picks a clip from the entity's
// own measured speed the same way vrm.js's locomotion nerve does.
function autoClipName(auto, speed) {
  if (!auto) return null;
  const idleBelow = auto.idleBelow ?? 0.1;
  const runAbove = auto.runAbove ?? 2.5;
  if (speed >= runAbove && auto.run) return auto.run;
  if (speed <= idleBelow) return auto.idle ?? auto.walk ?? auto.run ?? null;
  return auto.walk ?? auto.idle ?? auto.run ?? null;
}

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
    this.motion = new Map();
    this.smoothTau = 0.12;
    this.snapTransforms = false;
    this.instancedModels = new InstancedModels(this.scene);
    // sprite impostors: OFF until a scene declares `impostors` (see
    // client/kernel/impostors.js). Holders registered here are swapped to
    // billboards once their model has loaded, and only re-rendered when the
    // camera crosses an angle bucket.
    this.impostors = new ImpostorCache({ renderer: this.renderer, spec: null });
    this.impostorHolders = new Set();
    this.impostorBatches = new Map(); // cache cell -> one InstancedMesh draw
    this.impostorViewKey = null;
    // under a camera rig the protagonist is the BODY, not the lens: the own
    // presence renders (showOwnBody), follows the player at frame rate (the
    // 300ms presence trickle is for everyone else), and carries its light on
    // the body instead of the camera. main.js flips this with the rig.
    this.showOwnBody = false;
    this.player = null;
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
    this.modelWarmPromises = new Map(); // src -> Promise that has drawn the GLB once
    // skinned `animated: true` model parts: entityId -> { holder, mixer,
    // clips (name -> AnimationClip), actions (name -> AnimationAction),
    // current (playing clip name), spec (the `animation` component doc),
    // acc (step-quantization budget), lastPos (smoothed-speed sample).
    // Self-heals like instancedModels — updateAnimatedModels() prunes any
    // entry whose holder is no longer attached to the scene, so a despawn
    // (which never walks this map directly) still lets go of it.
    this.animatedModels = new Map();
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
    if (this.instancedModels) this.instancedModels.markDirty();
  }

  show(id) {
    const group = this.groups.get(id);
    if (!group || !group.userData.hidden) return;
    group.visible = id !== this.ownPresence || this.showOwnBody;
    group.userData.hidden = false;
    this.buildVersion++;
    const components = this.store.get(id);
    if (components?.sound) this.applySound(id, group, components.sound);
    if (this.instancedModels) this.instancedModels.markDirty();
  }

  queueBuild(id) {
    if (this.buildSet.has(id)) return;
    this.buildSet.add(id);
    this.buildQueue.push(id);
  }

  // time-sliced streaming: a scene coming in never drops a frame — builds
  // run against a per-frame millisecond deadline, weighted by mesh-part
  // count (pipelines were all warmed at load; first-draw setup wasn't)
  update(dt) {
    if (dt === undefined) {
      const now = performance.now();
      dt = Math.min(0.1, Math.max(0, (now - (this.lastUpdate ?? now)) / 1000));
      this.lastUpdate = now;
    }
    let eased = false;
    for (const [id, m] of this.motion) {
      const group = this.groups.get(id);
      if (!group) {
        this.motion.delete(id);
        continue;
      }
      eased = true;
      const k = 1 - Math.exp(-dt / this.smoothTau);
      group.position.x += (m.x - group.position.x) * k;
      group.position.z += (m.z - group.position.z) * k;
      if (m.grounded) group.position.y = heightAt(group.position.x, group.position.z) + m.groundOffset;
      else group.position.y += (m.y - group.position.y) * k;
      let dy = m.ry - group.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      group.rotation.y += dy * k;
      group.rotation.x = m.rx;
      group.rotation.z = m.rz;
      if (Math.hypot(m.x - group.position.x, m.z - group.position.z) < 0.01 && Math.abs(dy) < 0.01) {
        group.position.set(m.x, m.grounded ? heightAt(m.x, m.z) + m.groundOffset : m.y, m.z);
        group.rotation.set(m.rx, m.ry, m.rz);
        this.motion.delete(id);
      }
    }
    if (eased && this.instancedModels) this.instancedModels.markDirty();
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
    // the visible own body rides the LOCAL player at frame rate, facing the
    // way it moves — everyone else still sees the 300ms presence trickle
    if (this.ownPresence) {
      const own = this.groups.get(this.ownPresence);
      if (own) {
        if (this.showOwnBody && this.player) {
          if (!own.userData.hidden) own.visible = true;
          const pose = this.player.vehicle ? this.player.drivePose : null;
          own.position.copy(pose?.position ?? this.player.position);
          // Authored model offset → standing-eye frame; crouch changes the eye,
          // not the feet. Primitive head markers retain eye-following semantics.
          if (!pose && own.children.some((part) => part.userData.model)) {
            own.position.y += (this.player.eyeStand ?? this.player.eyeHeight) - this.player.eyeHeight;
          }
          // glTF model front is +Z; GAIA forward at yaw 0 is -Z (the same
          // convention the path behavior resolves via atan2(dx,dz)) — flip.
          own.rotation.y = (pose?.yaw ?? this.player.bodyYaw) + Math.PI;
        } else {
          own.visible = false;
        }
      }
    }
    this.updateLights();
    this.instancedModels.sync();
    this.syncImpostors();
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
      if (part.shape === 'model') {
        this.warmModelSource(part.src);
        continue;
      }
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

  warmModelSource(src) {
    if (!src || !this.scene) return Promise.resolve();
    if (this.modelWarmPromises.has(src)) return this.modelWarmPromises.get(src);
    const promise = loadModel(src)
      .then((asset) => {
        const probe = cloneModel(asset);
        probe.name = `model-warm:${src}`;
        // out of sight but unculled — the normal animation loop renders this
        // through the real post chain before any visible instance swaps in.
        probe.position.set(0, -800, 0);
        probe.traverse((node) => {
          if (node.isMesh) {
            node.frustumCulled = false;
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        this.scene.add(probe);
        return new Promise((resolve) => {
          let framesLeft = 2;
          const tick = () => {
            if (--framesLeft > 0) {
              requestAnimationFrame(tick);
              return;
            }
            this.scene.remove(probe);
            disposeObject(probe);
            resolve(asset);
          };
          requestAnimationFrame(tick);
        });
      })
      .catch((err) => {
        this.modelWarmPromises.delete(src);
        console.warn('[gaia] model load failed', src, err);
        throw err;
      });
    this.modelWarmPromises.set(src, promise);
    return promise;
  }

  buildAnimated(id) {
    this.build(id);
    const group = this.groups.get(id);
    const components = this.store.get(id);
    // hidden builds (spawn into a streamed-out scene) materialize silently
    if (!group || group.userData.hidden || !this.effects || components?.terrain || id === this.ownPresence) return;
    group.userData.groundTransient = true;
    group.visible = false;
    this.effects.wispTo(group.position.clone(), () => {
      if (this.groups.get(id) !== group || !this.store.get(id)) return;
      group.visible = !group.userData.hidden;
      this.effects.scaleIn(group, () => { group.userData.groundTransient = false; });
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
    if (id === this.ownPresence && !this.showOwnBody) group.visible = false; // don't render your own head
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
        group.userData.dynamic = Boolean(components.behavior);
        this.applyMesh(group, value, id);
        this.buildVersion++;
        break;
      case 'behavior': {
        const dynamic = Boolean(value);
        if (dynamic !== Boolean(group.userData.dynamic)) {
          group.userData.dynamic = dynamic;
          if (components.mesh) this.applyMesh(group, components.mesh, id);
        }
        break;
      }
      case 'animation':
        this.applyAnimation(id, value);
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
      case 'presence':
        // other players' bodies face their published yaw (your own body
        // follows the local player in update() at frame rate instead)
        if (id !== this.ownPresence && value?.yaw !== undefined) {
          const yawT = value.yaw + Math.PI; // +Z-front models vs -Z GAIA forward
          const m = this.motion.get(id);
          if (m) m.ry = yawT;
          else if (this.warming || this.snapTransforms) group.rotation.y = yawT;
          else {
            const ground = this.store.get(id)?.ground;
            this.motion.set(id, {
              x: group.position.x, y: group.position.y, z: group.position.z,
              rx: group.rotation.x, ry: yawT, rz: group.rotation.z,
              grounded: !!ground, groundOffset: ground?.offset ?? 0,
            });
          }
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
    const first = !group.userData.base;
    const components = this.store.get(id);
    const t = components.transform ?? {};
    const [x, y, z] = t.position ?? [0, 0, 0];
    const py = components.ground ? heightAt(x, z) + (components.ground.offset ?? 0) : y;
    const [rx, ry, rz] = t.rotation ?? [0, 0, 0];
    const s = t.scale ?? 1;
    if (Array.isArray(s)) group.scale.set(s[0], s[1], s[2]);
    else group.scale.setScalar(s);
    group.userData.base = { position: [x, py, z], rotation: [rx, ry, rz], scale: s };
    if (
      first ||
      this.warming ||
      this.snapTransforms ||
      id === this.ownPresence ||
      hasMotion(this.store.get(id)) ||
      Math.hypot(x - group.position.x, py - group.position.y, z - group.position.z) > 6
    ) {
      group.position.set(x, py, z);
      group.rotation.set(rx, ry, rz);
      this.motion.delete(id);
    } else {
      this.motion.set(id, { x, y: py, z, rx, ry, rz, grounded: !!components.ground, groundOffset: components.ground?.offset ?? 0 });
    }
    if (this.instancedModels) this.instancedModels.markDirty();
  }

  applyMesh(group, recipe, id) {
    for (const child of [...group.children]) {
      if (child.userData.kind === 'mesh-part') {
        if (child.userData.vrm) liveVrms.delete(child.userData.vrm);
        if (child.userData.animated && id !== undefined) this.animatedModels.delete(id);
        disposeObject(child);
        group.remove(child);
      }
    }
    if (group.userData.vrm) {
      liveVrms.delete(group.userData.vrm);
      delete group.userData.vrm;
    }
    delete group.userData.rainBody;
    if (!recipe) return;
    // VRM avatar source: `mesh.vrm = { src, edits }` — the whole avatar mounts
    // as one mesh-part child so the primitive dispose/rebuild path owns it.
    // Async: the loaded scene attaches when ready, guarded against a newer
    // applyMesh having replaced this recipe in the meantime.
    if (recipe.vrm?.src) {
      const spec = recipe.vrm;
      group.userData.vrmToken = (group.userData.vrmToken ?? 0) + 1;
      const token = group.userData.vrmToken;
      loadVRM(spec.src)
        .then((vrm) => {
          if (group.userData.vrmToken !== token) {
            // superseded while loading — discard
            disposeObject(vrm.scene);
            return;
          }
          applyVrmEdits(vrm, spec.edits ?? {});
          vrm.userData = vrm.userData ?? {};
          vrm.userData.idle = spec.idle; // undefined = defaults, false = off, {} = tuned
          vrm.userData.dance = spec.dance; // { style, bpm, energy } — beat-locked groove
          vrm.userData.group = group; // locomotion nerve: velocity measured per frame
          // data-driven clip: `mesh.vrm.animation = { clip, loop, speed }`
          if (spec.animation?.clip) {
            playClip(vrm, spec.animation).catch((err) => console.warn('[gaia] vrma failed', spec.animation.clip, err));
          }
          vrm.scene.userData.kind = 'mesh-part';
          vrm.scene.userData.vrm = vrm;
          if (spec.scale) vrm.scene.scale.setScalar(spec.scale);
          group.add(vrm.scene);
          group.userData.vrm = vrm;
          liveVrms.add(vrm);
          this.buildVersion++;
        })
        .catch((err) => console.warn('[gaia] vrm load failed', spec.src, err));
      if (!recipe.parts) return; // pure-VRM recipe: no primitive parts to build
    }
    for (const part of partsOf(recipe)) {
      if (part.shape === 'model') {
        if (part.animated) this.applyAnimatedModelPart(group, part, id);
        else this.applyModelPart(group, part);
        continue;
      }
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

  // A scene turns impostors on/off and tunes them; any declared change rebuilds
  // the batches, so a world can safely tune size/alpha without stale sprites.
  configureImpostors(spec) {
    this.impostors.configure(spec);
    this.impostorViewKey = null;
    if (!this.impostors.enabled) this.restoreImpostors();
  }

  registerImpostor(holder, src) {
    // Record the holder even when the system is off: a holder that kept its own
    // clone (the non-instanced path) can be swapped later, so a runtime toggle
    // works. Holders built while off went down the instancing path and simply
    // have no source to render from -- syncImpostors skips them.
    holder.userData.impostorSrc = src;
    this.impostorHolders.add(holder);
    this.impostorViewKey = null; // force a pass
    return true;
  }

  // Every cache cell becomes one InstancedMesh. The old path made one mesh
  // per holder, turning 330 geometry draws into 2,754 sprite draws; that is
  // an impostor-shaped regression, not an impostor system.
  disposeImpostorBatches() {
    for (const batch of this.impostorBatches.values()) {
      this.scene.remove(batch);
      batch.geometry.dispose();
      batch.material.dispose?.();
    }
    this.impostorBatches.clear();
  }

  faceImpostorBatches() {
    const matrix = new THREE.Matrix4();
    for (const batch of this.impostorBatches.values()) {
      for (let i = 0; i < batch.userData.instances.length; i++) {
        const instance = batch.userData.instances[i];
        matrix.compose(instance.position, this.camera.quaternion, instance.scale);
        batch.setMatrixAt(i, matrix);
      }
      batch.instanceMatrix.needsUpdate = true;
    }
  }

  // Only a new angle/animation cell re-renders a source. A continuous camera
  // turn merely rotates existing instance matrices.
  syncImpostors() {
    if (!this.impostors.enabled || !this.camera) return;
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    const view = { yaw: e.y, pitch: e.x };
    const cache = this.impostors;
    const bucket = bucketOf(cache.spec, view);
    const cellKey = `${cache.spec.tile}|${bucket.yawBucket}|${bucket.pitchBucket}|${this.impostorHolders.size}`;
    if (cellKey === this.impostorViewKey) {
      this.faceImpostorBatches();
      return;
    }
    this.impostorViewKey = cellKey;
    this.disposeImpostorBatches();
    const cells = new Map();
    for (const holder of [...this.impostorHolders]) {
      if (!holder.parent) {
        this.impostorHolders.delete(holder);
        continue;
      }
      const source = holder.userData.impostorSource ?? holder.children.find((c) => c.userData.kind !== 'impostor');
      if (!source) continue;
      holder.userData.impostorSource = source;
      if (holder.userData.impostorSourceVisible === undefined) holder.userData.impostorSourceVisible = source.visible;
      source.visible = holder.userData.impostorSourceVisible;
      const box = new THREE.Box3().setFromObject(source);
      if (box.isEmpty()) continue;
      const dimensions = box.getSize(new THREE.Vector3());
      const size = dimensions.length();
      if (size < cache.spec.minSize || (cache.spec.maxSize > 0 && size > cache.spec.maxSize)) continue;
      const half = dimensions.multiplyScalar(0.5);
      const ext = projectedExtents({ x: half.x, y: half.y, z: half.z }, view, cache.spec.padding);
      const acquired = cache.acquire(holder.userData.impostorSrc ?? source.name ?? 'model', source, view);
      const instances = cells.get(acquired.key) ?? [];
      instances.push({
        position: box.getCenter(new THREE.Vector3()),
        scale: new THREE.Vector3(ext.halfWidth * 2, ext.halfHeight * 2, 1),
        target: acquired.target,
      });
      cells.set(acquired.key, instances);
      source.visible = false;
    }
    for (const [key, instances] of cells) {
      const prototype = cache.billboard(instances[0].target, 1, 1);
      const batch = new THREE.InstancedMesh(prototype.geometry, prototype.material, instances.length);
      batch.userData.kind = 'impostor-batch';
      batch.userData.instances = instances;
      batch.frustumCulled = false;
      this.scene.add(batch);
      this.impostorBatches.set(key, batch);
    }
    this.faceImpostorBatches();
  }

  restoreImpostors() {
    this.disposeImpostorBatches();
    for (const holder of this.impostorHolders) {
      if (holder.userData.impostorSource) holder.userData.impostorSource.visible = holder.userData.impostorSourceVisible ?? true;
      holder.userData.impostorMesh = null; // compatibility with pre-batch sessions
    }
    this.impostors.clear();
  }

  applyModelPart(group, part) {
    const holder = new THREE.Group();
    holder.userData.kind = 'mesh-part';
    holder.userData.model = true;
    holder.userData.solid = part.solid !== undefined ? !!part.solid : !part.preset;
    holder.userData.src = part.src;
    holder.position.set(...(part.position ?? [0, 0, 0]));
    holder.rotation.set(...(part.rotation ?? [0, 0, 0]));
    if (part.scale) {
      if (Array.isArray(part.scale)) holder.scale.set(...part.scale);
      else holder.scale.setScalar(part.scale);
    }
    holder.castShadow = part.castShadow ?? true;
    holder.receiveShadow = true;
    if (part.visible === false) holder.visible = false;

    const placeholder = new THREE.Mesh(
      makeGeometry({ shape: 'box', size: part.placeholderSize ?? part.size ?? [1, 1, 1] }),
      makePartMaterial({ color: part.color ?? '#66aaff', roughness: 0.85, metalness: 0 }),
    );
    placeholder.name = `${part.src ?? 'model'} placeholder`;
    placeholder.userData.kind = 'model-placeholder';
    placeholder.userData.solid = holder.userData.solid;
    placeholder.castShadow = part.castShadow ?? true;
    placeholder.receiveShadow = true;
    holder.add(placeholder);
    group.add(holder);

    loadModel(part.src)
      .then((asset) => this.warmModelSource(part.src).then(() => asset))
      .then((asset) => {
        if (holder.parent !== group) return; // superseded while loading/warming
        const doc = libraryMaterialDoc(part.material);
        // instancing and impostors are rival batching strategies for the same
        // holder: an InstancedMesh has no per-holder object to hide, so when a
        // scene declares impostors the sprite path wins and this holder keeps
        // its own clone (which the impostor renders from, then hides).
        if (!this.impostors.enabled && !group.userData.dynamic && holder.userData.solid === false && asset.templates?.length && asset.templates.every((t) => !Array.isArray(t.material))) {
          const override = doc && doc.map ? makePartMaterial({ material: part.material }) : null;
          const materialKey = doc && doc.map ? part.material : '';
          for (const child of [...holder.children]) {
            disposeObject(child);
            holder.remove(child);
          }
          this.instancedModels.register(holder, {
            src: part.src,
            templates: asset.templates,
            material: override,
            materialKey,
            castShadow: part.castShadow ?? true,
          });
          this.buildVersion++;
          return;
        }
        const model = cloneModel(asset);
        if (doc && doc.map) {
          const override = makePartMaterial({ material: part.material });
          model.traverse((node) => {
            if (node.isMesh) node.material = Array.isArray(node.material) ? node.material.map(() => override) : override;
          });
        }
        model.name = part.src;
        model.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = part.castShadow ?? true;
          node.receiveShadow = true;
          node.userData.solid = holder.userData.solid;
        });
        for (const child of [...holder.children]) {
          disposeObject(child);
          holder.remove(child);
        }
        holder.add(model);
        this.registerImpostor(holder, part.src);
        this.buildVersion++;
      })
      .catch(() => {
        // Failure placeholder → visible; ground queries use authored support.
        // warmModelSource → failing src logged once.
      });
  }

  // `mesh.parts[].animated: true` — a skinned character. No instancing (that
  // path bakes sub-meshes into templates and throws the SkinnedMesh binding
  // away): each entity gets its OWN clone via SkeletonUtils.clone (the only
  // clone that re-parents bones correctly) and its own AnimationMixer.
  // `variant`: the glb may carry several outfit meshes on one skeleton
  // (Mesh, Mesh.001…) — showing only the named one is how one file plays
  // nine bodies.
  applyAnimatedModelPart(group, part, id) {
    const holder = new THREE.Group();
    holder.userData.kind = 'mesh-part';
    holder.userData.model = true;
    holder.userData.animated = true;
    holder.userData.solid = part.solid !== undefined ? !!part.solid : !part.preset;
    holder.userData.src = part.src;
    holder.position.set(...(part.position ?? [0, 0, 0]));
    holder.rotation.set(...(part.rotation ?? [0, 0, 0]));
    if (part.scale) {
      if (Array.isArray(part.scale)) holder.scale.set(...part.scale);
      else holder.scale.setScalar(part.scale);
    }
    holder.castShadow = part.castShadow ?? true;
    holder.receiveShadow = true;
    if (part.visible === false) holder.visible = false;

    const placeholder = new THREE.Mesh(
      makeGeometry({ shape: 'box', size: part.placeholderSize ?? part.size ?? [1, 1, 1] }),
      makePartMaterial({ color: part.color ?? '#66aaff', roughness: 0.85, metalness: 0 }),
    );
    placeholder.name = `${part.src ?? 'model'} placeholder`;
    placeholder.userData.kind = 'model-placeholder';
    placeholder.userData.solid = holder.userData.solid;
    placeholder.castShadow = part.castShadow ?? true;
    placeholder.receiveShadow = true;
    holder.add(placeholder);
    group.add(holder);

    loadModelSkinned(part.src)
      .then((asset) => {
        if (holder.parent !== group) return; // superseded while loading
        const model = cloneSkinned(asset.scene);
        model.name = part.src;
        model.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = part.castShadow ?? true;
          node.receiveShadow = true;
          node.userData.solid = holder.userData.solid;
          if (part.variant) node.visible = node.name === part.variant;
        });
        for (const child of [...holder.children]) {
          disposeObject(child);
          holder.remove(child);
        }
        holder.add(model);
        if (part.proprio) group.userData.rainBody = { bones: resolveRainBones(model, part.proprio) };
        const mixer = new THREE.AnimationMixer(model);
        const clips = new Map(asset.animations.map((c) => [c.name, c]));
        const entry = {
          holder,
          mixer,
          clips,
          actions: new Map(),
          current: null,
          acc: 0,
          spec: group.userData.animationSpec ?? {},
          lastPos: null,
        };
        this.animatedModels.set(id, entry);
        this.driveAnimationEntry(entry, 0);
        this.buildVersion++;
      })
      .catch((err) => {
        console.warn('[gaia] skinned model load failed', part.src, err);
      });
  }

  // the `animation` component: read like every other component, applied
  // both to a live registry entry (immediate crossfade) and stashed on the
  // group (spec.clip that arrives before the async skinned load resolves —
  // the entry reads it back at creation time, mirroring the vrm.animation
  // race the same recipe already handles).
  applyAnimation(id, value) {
    const group = this.groups.get(id);
    if (group) group.userData.animationSpec = value ?? null;
    const entry = this.animatedModels.get(id);
    if (!entry) return;
    entry.spec = value ?? {};
    entry.acc = 0;
    this.driveAnimationEntry(entry, entry.lastPos?.speed ?? 0);
  }

  // explicit `clip` always wins; otherwise `auto` picks idle/walk/run from
  // the entity's measured speed. Clip changes crossfade over `fade`
  // (mirrors vrm.js's playClip: reset+play the incoming action, crossFadeTo
  // it from whatever was playing).
  driveAnimationEntry(entry, speed) {
    const spec = entry.spec ?? {};
    const name = spec.clip ?? autoClipName(spec.auto, speed);
    if (!name || name === entry.current) return;
    const clip = entry.clips.get(name);
    if (!clip) {
      console.warn('[gaia] animation clip not found', name, '- have:', [...entry.clips.keys()]);
      return;
    }
    let action = entry.actions.get(name);
    if (!action) {
      action = entry.mixer.clipAction(clip);
      entry.actions.set(name, action);
    }
    action.loop = spec.loop === 'once' ? THREE.LoopOnce : THREE.LoopRepeat;
    action.clampWhenFinished = spec.loop === 'once';
    action.timeScale = spec.speed ?? 1;
    const prevAction = entry.current && entry.actions.get(entry.current);
    if (prevAction && prevAction !== action) {
      action.reset();
      prevAction.crossFadeTo(action, spec.fade ?? 0.2, false);
      action.play();
    } else {
      action.reset().play();
    }
    entry.current = name;
  }

  // per-frame tick, called from main.js next to updateVrms(dt). Prunes any
  // entry whose holder fell off the scene graph (despawn never walks this
  // map directly — the same lazy self-heal instancedModels.sync() uses),
  // measures horizontal speed off the owning entity's group for `auto`,
  // then advances the mixer either smoothly or step-quantized.
  updateAnimatedModels(dt) {
    for (const [id, entry] of this.animatedModels) {
      if (!this.isAttachedToScene(entry.holder)) {
        this.animatedModels.delete(id);
        continue;
      }
      const group = this.groups.get(id);
      let speed = 0;
      if (group && dt > 0) {
        const p = group.position;
        const last = entry.lastPos;
        if (last) {
          const raw = Math.hypot(p.x - last.x, p.z - last.z) / Math.max(dt, 1e-4);
          const alpha = Math.min(1, dt / 0.25); // ~0.25s smoothing window
          speed = last.speed + (raw - last.speed) * alpha;
        }
        entry.lastPos = { x: p.x, z: p.z, speed };
      }
      this.driveAnimationEntry(entry, speed);
      const step = entry.spec?.step ?? 0;
      if (step <= 0) {
        entry.mixer.update(dt);
      } else {
        entry.acc += dt;
        const q = 1 / step;
        while (entry.acc >= q) {
          entry.mixer.update(q);
          entry.acc -= q;
        }
      }
    }
  }

  isAttachedToScene(obj) {
    for (let o = obj; o; o = o.parent) if (o === this.scene) return true;
    return false;
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
        // Under a camera rig the lens is meters away from the protagonist —
        // the light rides the BODY instead, in the body's flat frame.
        const [ox, oy, oz] = c.spec.offset ?? [0, 0, 0];
        if (this.showOwnBody && this.player) {
          _lightDir.set(-Math.sin(this.player.bodyYaw), 0, -Math.cos(this.player.bodyYaw));
          slot.light.position.copy(this.player.position).addScaledVector(_lightDir, -oz);
        } else {
          this.camera.getWorldDirection(_lightDir);
          _lightDir.y = 0;
          _lightDir.normalize();
          slot.light.position.copy(this.camera.position).addScaledVector(_lightDir, -oz);
        }
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
    this.motion.delete(id);
    const group = this.groups.get(id);
    if (!group) return;
    this.sounds.get(id)?.dispose();
    this.sounds.delete(id);
    this.lights.delete(id);
    this.lightSpecs.delete(id);
    this.releaseSlot(id);
    this.particleSystems.delete(id);
    unregisterTerrain(group);
    // Holders are registered outside the entity map. Purge them before their
    // entity graph is disposed: otherwise rebuildAll leaves dead source graphs
    // in the sprite pass and silently doubles both instances and draw calls.
    let removedImpostor = false;
    group.traverse((node) => {
      if (this.impostorHolders.delete(node)) removedImpostor = true;
    });
    if (removedImpostor) {
      this.impostorViewKey = null;
      this.disposeImpostorBatches();
    }
    disposeObject(group);
    this.scene.remove(group);
    this.groups.delete(id);
    if (this.instancedModels) this.instancedModels.markDirty();
  }

  // analytic walkable boxes from `collider` components — the reliable path
  // for decks, bridges, floors (no raycast, no gaps). Returns the highest
  // {top, id} under (x, z) no higher than maxTop, or null — feet-aware so
  // stacked floors work (a switchback above you is not your ground). The id
  // lets the player ride a moving platform. Boxes are entity-relative and
  // yaw-aware.
  // Ground-query eligibility → identity/lifecycle, never render visibility.
  // Invisible authored floors remain solid; streamed/dead/detached groups do not.
  groundEntityEligible(id, group, excludeIds, exclude = this.ownPresence) {
    const comps = this.store.get(id);
    return id !== exclude && !excludeIds?.has(id) && !!comps &&
      !!group && group.parent === this.scene && !group.userData.hidden &&
      !group.userData.groundTransient && this.isActive(comps);
  }

  walkableAt(x, z, maxTop = Infinity, { excludeIds } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || Number.isNaN(maxTop)) return null;
    let best = null;
    for (const id of this.colliderIds) {
      const boxes = this.store.get(id)?.collider?.boxes;
      if (!boxes) continue;
      const group = this.groups.get(id);
      if (!this.groundEntityEligible(id, group, excludeIds)) continue;
      const yaw = planarYaw(group.rotation);
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
        const boxYaw = planarYaw(box.rotation);
        const c = Math.cos(boxYaw), s = Math.sin(boxYaw);
        const dx = lx - bx, dz = lz - bz;
        if (Math.abs(dx * c - dz * s) > sx / 2 || Math.abs(dx * s + dz * c) > sz / 2) continue;
        const top = group.position.y + by + sy / 2;
        if (!Number.isFinite(top) || top > maxTop) continue;
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
  resolveBlockers(position, eyeHeight, velocity = null) {
    const feet = position.y - eyeHeight;
    const head = position.y + 0.2;
    const r = 0.35;
    for (const id of this.colliderIds) {
      const boxes = this.store.get(id)?.collider?.boxes;
      if (!boxes) continue;
      const group = this.groups.get(id);
      if (!group) continue;
      const groupYaw = planarYaw(group.rotation);
      const groupCos = Math.cos(groupYaw);
      const groupSin = Math.sin(groupYaw);
      // Collider boxes live in entity-local coordinates. Mirror/non-uniform
      // transform scale must affect both their bounds and the push-out vector.
      const scaleX = group.scale.x;
      const scaleY = group.scale.y;
      const scaleZ = group.scale.z;
      if (Math.abs(scaleX) < 1e-9 || Math.abs(scaleY) < 1e-9 || Math.abs(scaleZ) < 1e-9) continue;
      const absX = Math.abs(scaleX);
      const absY = Math.abs(scaleY);
      const absZ = Math.abs(scaleZ);
      for (const box of boxes) {
        if (!box.blocker) continue;
        const [bx, by, bz] = box.position ?? [0, 0, 0];
        const [sx, sy, sz] = box.size ?? [1, 1, 1];
        const boxYaw = planarYaw(box.rotation);
        const boxCos = Math.cos(boxYaw);
        const boxSin = Math.sin(boxYaw);
        const top = group.position.y + by * scaleY + sy * absY / 2;
        const bottom = group.position.y + by * scaleY - sy * absY / 2;
        if (feet >= top - 0.05 || head <= bottom) continue;
        const pxWorld = position.x - group.position.x;
        const pzWorld = position.z - group.position.z;
        const gx = (pxWorld * groupCos - pzWorld * groupSin) / scaleX;
        const gz = (pxWorld * groupSin + pzWorld * groupCos) / scaleZ;
        const dx = gx - bx;
        const dz = gz - bz;
        const lx = dx * boxCos - dz * boxSin;
        const lz = dx * boxSin + dz * boxCos;
        const px = sx / 2 + r / absX - Math.abs(lx);
        const pz = sz / 2 + r / absZ - Math.abs(lz);
        if (px <= 0 || pz <= 0) continue;
        let ox = 0;
        let oz = 0;
        if (px * absX < pz * absZ) ox = lx > 0 ? px : -px;
        else oz = lz > 0 ? pz : -pz;
        const groupX = ox * boxCos + oz * boxSin;
        const groupZ = -ox * boxSin + oz * boxCos;
        const wx = groupX * scaleX * groupCos + groupZ * scaleZ * groupSin;
        const wz = -groupX * scaleX * groupSin + groupZ * scaleZ * groupCos;
        position.x += wx;
        position.z += wz;
        if (velocity) {
          const len = Math.hypot(wx, wz);
          if (len >= 1e-9) {
            const nx = wx / len;
            const nz = wz / len;
            const dot = velocity.x * nx + velocity.z * nz;
            if (dot < 0) {
              velocity.x -= nx * dot;
              velocity.z -= nz * dot;
            }
          }
        }
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
  surfaceAt(x, z, fromY, { exclude = this.ownPresence, excludeIds, maxTop = fromY, maxDistance = 60, maxDrop = 80 } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(fromY) || Number.isNaN(maxTop)) return null;
    this._down ??= new THREE.Vector3(0, -1, 0);
    this._rayOrigin ??= new THREE.Vector3();
    this._surfaceRay ??= new THREE.Raycaster();
    const candidates = [];
    for (const [id, group] of this.groups) {
      const comps = this.store.get(id);
      if (id === exclude || !comps?.mesh || comps.terrain || !this.groundEntityEligible(id, group, excludeIds, exclude)) continue;
      if (Math.hypot(group.position.x - x, group.position.z - z) > maxDistance) continue;
      group.updateWorldMatrix(true, true); // motion → current matrices before render
      // solid surfaces only ever come from mesh parts — direct children, so
      // this per-frame hot path never pays a recursive traverse
      for (const child of group.children) {
        if (child.userData.kind === 'mesh-part' && child.userData.solid) candidates.push(child);
      }
    }
    if (!candidates.length) return null;
    this._rayOrigin.set(x, fromY, z);
    this._surfaceRay.set(this._rayOrigin, this._down);
    this._surfaceRay.far = maxDrop;
    // primitive parts are direct Meshes; model parts are direct Groups whose
    // loaded GLB meshes sit below them, so recurse only across this already
    // filtered candidate set.
    const hits = this._surfaceRay.intersectObjects(candidates, true);
    for (const hit of hits) {
      // Loading/failure boxes describe presentation, not authored support.
      if (hit.object.userData.kind === 'model-placeholder' || hit.object.userData.solid === false) continue;
      const y = hit.point.y;
      if (Number.isFinite(y) && y <= maxTop) return y;
    }
    return null;
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
