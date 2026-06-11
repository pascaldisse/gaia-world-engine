import * as THREE from 'three/webgpu';

// The scene-view effects toggles, Unity-style: skybox, fog, particles,
// post fx, lights, audio — flippable one by one from the viewbar's `view ▾`
// dropdown, with per-draw-mode defaults (the user rule: all vfx off in
// unlit and wireframe; the skybox off in wireframe too, so stepping outside
// a mountain doesn't flood the wires with daylight).
//
// update() runs LAST in the frame, after environment/view/shading, so it
// always has the final word — and because it re-asserts per frame, builds
// that stream in mid-session obey immediately. Everything is self-restoring:
// the environment rewrites fog density and the light pool rewrites slot
// intensities every frame, so switching a toggle back on simply stops the
// override.
const EDITOR_BG = new THREE.Color('#15181d');

export class ViewFx {
  constructor({ scene, view, environment, post }) {
    this.scene = scene;
    this.view = view;
    this.environment = environment;
    this.post = post;
    this.on = { skybox: true, fog: true, particles: true, post: true, lights: true, audio: true };
    this.skyHidden = false; // sky sweep ran — restore needed on re-enable
    this.bloomZeroed = false;
    this.linearFog = null; // saved {near, far} while linear fog is gated
  }

  // what each draw mode means for the toggles. Audio is the player's
  // business, never the mode's.
  modeDefaults(mode) {
    const base = { skybox: true, fog: true, particles: true, post: true, lights: true, audio: this.on.audio };
    if (mode === 'unlit') return { ...base, fog: false, particles: false, post: false };
    if (mode === 'wireframe') return { ...base, fog: false, particles: false, post: false, skybox: false };
    return base;
  }

  applyDefaults(mode) {
    this.on = this.modeDefaults(mode);
  }

  update() {
    const on = this.on;
    this.environment.effectsEnabled = on.post;

    // skybox: the background color AND the sky-as-geometry sheets
    if (!on.skybox) {
      if (this.scene.background?.isColor) this.scene.background.copy(EDITOR_BG);
      for (const group of this.view.groups.values()) {
        group.traverse((node) => {
          if (node.userData?.sky && node.visible) node.visible = false;
        });
      }
      this.skyHidden = true;
    } else if (this.skyHidden) {
      this.skyHidden = false;
      if (this.scene.background?.isColor) this.scene.background.copy(this.environment.current.background);
      for (const group of this.view.groups.values()) {
        group.traverse((node) => {
          if (node.userData?.sky) node.visible = true;
        });
      }
    }

    // fog: exp fog restores itself (environment rewrites density per frame);
    // linear fog keeps its authored near/far here while gated
    const fog = this.scene.fog;
    if (!on.fog && fog) {
      if (fog.isFogExp2) fog.density = 0;
      else {
        this.linearFog = this.linearFog ?? { near: fog.near, far: fog.far };
        fog.near = 1e7;
        fog.far = 1e8;
      }
    } else if (this.linearFog && fog && !fog.isFogExp2) {
      fog.near = this.linearFog.near;
      fog.far = this.linearFog.far;
      this.linearFog = null;
    }

    // particles: hide the instanced systems (their sim keeps its clock)
    for (const state of this.view.particleSystems.values()) {
      state.mesh.visible = on.particles;
    }

    // post: bloom to zero while gated; handed back at the env's authored value
    if (this.post) {
      if (!on.post) {
        this.post.setBloom({ strength: 0 });
        this.bloomZeroed = true;
      } else if (this.bloomZeroed) {
        this.bloomZeroed = false;
        this.post.setBloom(this.environment.currentBloom ?? {});
      }
    }

    // lights: zero the pool after updateLights ran — it re-asserts when on
    if (!on.lights) {
      for (const slot of this.view.lightPool) slot.light.intensity = 0;
    }
  }
}
