import { normalizeScenes, sceneAt, activeScenes } from '../../shared/scenes.js';
import { mergeIntoLibrary } from '../../shared/ops.js';

// Client-side streaming policy: track which scene the player is in, keep that
// scene + its neighbors + the always-scenes (backdrops) resident — and scenes
// with explicit `load` volumes only while the player stands inside one.
// Streaming is invisible — scenes are built before they can be seen or
// entered, and builds are time-sliced in the view.
export class Scenes {
  constructor({ store, view, environment, onCamera }) {
    this.store = store;
    this.view = view;
    this.environment = environment;
    this.onCamera = onCamera;
    this.raw = null; // the world file as authored — what the editor edits
    this.index = null;
    this.current = null;
    this.currentVoidY = -120;
    this.activeSet = null;
    this.activeKey = null;
  }

  setWorld(raw) {
    this.raw = raw;
    this.index = normalizeScenes(raw);
    this.current = null;
    this.activeSet = null;
    this.activeKey = null;
    if (!this.index) {
      this.view.currentScene = null;
      this.view.setActiveScenes(null);
    }
  }

  // the `scene` op: a scene's world.json entry edited live (bounds, load
  // volumes, neighbors…) — the same merge rule the server applies, then
  // re-derive everything
  applySceneOp(op) {
    if (!this.raw?.scenes) return;
    mergeIntoLibrary(this.raw.scenes, op.name, op.value ?? {});
    this.index = normalizeScenes(this.raw);
    this.activeKey = null; // force a streaming re-evaluation next update
  }

  rawScene(name) {
    return this.raw?.scenes?.[name] ?? null;
  }

  update(position) {
    if (!this.index) return;
    const scene =
      sceneAt(this.index, position.x, position.z) ??
      this.current ??
      this.index.scenes.find((s) => s.bounds)?.name ??
      this.index.scenes[0]?.name ??
      null;
    const changed = scene !== this.current;
    const first = this.current === null;
    if (changed) {
      this.currentVoidY = this.index.scenes.find((s) => s.name === scene)?.voidY ?? this.index.voidY;
      this.current = scene;
      this.view.currentScene = scene;
    }
    // the active set can change WITHOUT a scene change — load volumes gate on
    // the player's position (crossing a height, entering an approach)
    const active = activeScenes(this.index, scene, [position.x, position.y, position.z], this.activeSet);
    const key = [...active].sort().join('|');
    if (key !== this.activeKey) {
      this.activeKey = key;
      this.activeSet = active;
      this.view.setActiveScenes(active);
    }
    if (changed) {
      this.applyEnvironment(first);
      this.applyCamera();
      this.view.updateAmbience();
    }
  }

  // crossing into a scene adopts its camera rig too — a scene with a `camera`
  // component (usually on its environment entity) declares HOW it is seen;
  // scenes without one hand the frame back to first person
  applyCamera() {
    let spec = null;
    for (const comps of this.store.entities.values()) {
      if (comps.camera && comps.scene?.name === this.current) {
        spec = comps.camera;
        break;
      }
    }
    this.onCamera?.(spec && spec.mode !== 'first' ? spec : null);
  }

  // crossing into a scene adopts its mood — crossfaded, so a seam is a slow
  // change of air, never a cut; a scene without an environment keeps the old
  applyEnvironment(snap = false) {
    for (const comps of this.store.entities.values()) {
      if (comps.environment && comps.scene?.name === this.current) {
        if (snap) this.environment.apply(comps.environment);
        else this.environment.applyFaded(comps.environment, 3);
        return;
      }
    }
  }
}
