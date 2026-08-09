import * as THREE from 'three/webgpu';

// World mood as data: fog, sky, sun, exposure, bloom — all patchable live.
// Falls back to the kernel defaults when the component is removed.
export class Environment {
  constructor({ renderer, scene, hemi, sun, post, audio }) {
    this.renderer = renderer;
    this.scene = scene;
    this.hemi = hemi;
    this.sun = sun;
    this.post = post;
    this.audio = audio;
    this.flashLevel = 0;
    this.flashColor = new THREE.Color('#b9c4ee');
    this.exposure = renderer.toneMappingExposure;
    this.fogDensity = scene.fog.isFogExp2 ? scene.fog.density : null;
    // pooled point lights × this — a flame authored for the dark (intensity
    // 48) must wash out in a daylight scene, not paint it orange
    this.lightScale = 1;
    // skylight: a true global light (the scene hemisphere is often nearly
    // black on purpose — multiplying it does nothing, so this adds instead)
    this.ambient = new THREE.AmbientLight('#b8c6e6', 0);
    scene.add(this.ambient);
    // the ~ debug panel's live knobs
    this.debugMul = 1;
    this.debugAmbient = 0;
    this.debugFog = 1;
    // the editor's post-fx gate: false suppresses lightning flashes and
    // exposure dips (the view-options dropdown owns it)
    this.effectsEnabled = true;
    this.current = {
      sunIntensity: sun.intensity,
      hemiIntensity: hemi.intensity,
      background: scene.background.clone(),
      fogColor: scene.fog.color.clone(),
    };
    this.defaults = {
      background: `#${scene.background.getHexString()}`,
      fog: { color: `#${scene.fog.color.getHexString()}`, near: scene.fog.near, far: scene.fog.far },
      exposure: renderer.toneMappingExposure,
      hemisphere: {
        sky: `#${hemi.color.getHexString()}`,
        ground: `#${hemi.groundColor.getHexString()}`,
        intensity: hemi.intensity,
      },
      sun: {
        color: `#${sun.color.getHexString()}`,
        intensity: sun.intensity,
        position: [sun.position.x, sun.position.y, sun.position.z],
      },
      bloom: { strength: 0.35, radius: 0.4, threshold: 0.85 },
      ambient: { color: '#b8c6e6', intensity: 0 },
      lightScale: 1,
    };
    this.current.ambientIntensity = 0;
  }

  apply(params) {
    const p = { ...this.defaults, ...(params ?? {}) };
    if (this.scene.background?.isColor) this.scene.background.set(p.background);
    else this.scene.background = new THREE.Color(p.background);
    const fog = { ...this.defaults.fog, ...(p.fog ?? {}) };
    // mutate the existing fog in place — the fog OBJECT is part of every
    // pipeline's cache key, so replacing it recompiles the whole scene.
    // Only a fog-type change (linear ↔ exp) pays that price.
    if (fog.density) {
      if (this.scene.fog?.isFogExp2) {
        this.scene.fog.color.set(fog.color);
        this.scene.fog.density = fog.density;
      } else {
        this.scene.fog = new THREE.FogExp2(fog.color, fog.density);
      }
    } else if (this.scene.fog && !this.scene.fog.isFogExp2) {
      this.scene.fog.color.set(fog.color);
      this.scene.fog.near = fog.near;
      this.scene.fog.far = fog.far;
    } else {
      this.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
    }
    this.fogDensity = fog.density ?? null;
    this.exposure = p.exposure;
    const hemi = { ...this.defaults.hemisphere, ...(p.hemisphere ?? {}) };
    this.hemi.color.set(hemi.sky);
    this.hemi.groundColor.set(hemi.ground);
    this.hemi.intensity = hemi.intensity;
    const sun = { ...this.defaults.sun, ...(p.sun ?? {}) };
    this.sun.color.set(sun.color);
    this.sun.intensity = sun.intensity;
    this.sun.position.set(...sun.position);
    const ambient = { ...this.defaults.ambient, ...(p.ambient ?? {}) };
    this.ambient.color.set(ambient.color);
    this.lightScale = p.lightScale ?? 1;
    // remembered so the editor's post toggle can hand bloom back exactly
    this.currentBloom = { ...this.defaults.bloom, ...(p.bloom ?? {}) };
    this.post?.setBloom(this.currentBloom);
    if (p.audio) this.audio?.applyBus(p.audio);
    this.current = {
      sunIntensity: sun.intensity,
      hemiIntensity: hemi.intensity,
      ambientIntensity: ambient.intensity,
      background: new THREE.Color(p.background),
      fogColor: new THREE.Color(fog.color),
    };
  }

  // everything a crossfade interpolates, snapshotted from the live scene
  captureState() {
    return {
      background: this.scene.background.clone(),
      fogColor: this.scene.fog.color.clone(),
      fogDensity: this.scene.fog.isFogExp2 ? this.scene.fog.density : null,
      exposure: this.exposure,
      hemiSky: this.hemi.color.clone(),
      hemiGround: this.hemi.groundColor.clone(),
      hemiIntensity: this.hemi.intensity,
      sunColor: this.sun.color.clone(),
      sunIntensity: this.sun.intensity,
      ambientIntensity: this.current.ambientIntensity,
      lightScale: this.lightScale,
    };
  }

  // crossfade into another mood — scene seams use this so a boundary is a
  // slow change of air, never a cut. Snaps anything that can't interpolate.
  applyFaded(params, seconds = 2.5) {
    const from = this.captureState();
    this.apply(params); // snap to target (sets bloom, buses, fog type)
    this.fadeState = { from, to: this.captureState(), t: 0, seconds };
  }

  flash(intensity = 0.8) {
    this.flashLevel = Math.max(this.flashLevel, intensity * 1.6);
  }

  // dip to dark and back — drowning, dying, hard transitions
  dip(seconds = 1.6) {
    this.dipT = 0;
    this.dipDur = seconds;
  }

  update(dt) {
    const fade = this.fadeState;
    if (fade) {
      fade.t = Math.min(1, fade.t + dt / fade.seconds);
      const k = fade.t * fade.t * (3 - 2 * fade.t);
      // a veiled scene (film4/seg1: "the deep is judged on black") sets
      // scene.background to null on purpose — that is a legitimate state,
      // not damage to repair, so every touch below skips it instead of
      // crashing. It comes back exactly as it was (exit() restores the same
      // Color instance) since nothing here mutates a null background.
      if (this.scene.background) this.scene.background.copy(fade.from.background).lerp(fade.to.background, k);
      this.scene.fog.color.copy(fade.from.fogColor).lerp(fade.to.fogColor, k);
      if (fade.from.fogDensity !== null && fade.to.fogDensity !== null && this.scene.fog.isFogExp2) {
        this.fogDensity = fade.from.fogDensity + (fade.to.fogDensity - fade.from.fogDensity) * k;
      }
      this.exposure = fade.from.exposure + (fade.to.exposure - fade.from.exposure) * k;
      this.hemi.color.copy(fade.from.hemiSky).lerp(fade.to.hemiSky, k);
      this.hemi.groundColor.copy(fade.from.hemiGround).lerp(fade.to.hemiGround, k);
      this.hemi.intensity = fade.from.hemiIntensity + (fade.to.hemiIntensity - fade.from.hemiIntensity) * k;
      this.sun.color.copy(fade.from.sunColor).lerp(fade.to.sunColor, k);
      this.sun.intensity = fade.from.sunIntensity + (fade.to.sunIntensity - fade.from.sunIntensity) * k;
      this.lightScale = fade.from.lightScale + (fade.to.lightScale - fade.from.lightScale) * k;
      // keep the flash baseline tracking the fade (skipped while veiled —
      // current.background stays stale-but-harmless until background returns)
      if (this.scene.background) this.current.background.copy(this.scene.background);
      this.current.fogColor.copy(this.scene.fog.color);
      this.current.sunIntensity = this.sun.intensity;
      this.current.hemiIntensity = this.hemi.intensity;
      this.current.ambientIntensity =
        fade.from.ambientIntensity + (fade.to.ambientIntensity - fade.from.ambientIntensity) * k;
      if (fade.t >= 1) this.fadeState = null;
    }

    // final pipeline: logical values × dip × the ~ debug knobs
    let exposure = this.exposure;
    if (this.dipDur) {
      // the timer always advances — a dip queued while effects are gated
      // must not wait, frozen, for them to come back
      this.dipT += dt;
      const p = Math.min(1, this.dipT / this.dipDur);
      if (this.effectsEnabled) exposure *= 1 - 0.96 * Math.sin(p * Math.PI);
      if (p >= 1) this.dipDur = 0;
    }
    this.renderer.toneMappingExposure = exposure * this.debugMul;
    this.ambient.intensity = this.current.ambientIntensity + this.debugAmbient;
    if (this.scene.fog.isFogExp2 && this.fogDensity !== null) {
      this.scene.fog.density = this.fogDensity * this.debugFog;
    }

    if (this.flashLevel <= 0) return;
    if (!this.effectsEnabled) {
      // gated mid-flash: settle everything the flash lifted, right now
      this.flashLevel = 0;
      this.sun.intensity = this.current.sunIntensity;
      this.hemi.intensity = this.current.hemiIntensity;
      if (this.scene.background) this.scene.background.copy(this.current.background);
      this.scene.fog.color.copy(this.current.fogColor);
      return;
    }
    this.flashLevel *= Math.exp(-dt * 4.5);
    if (this.flashLevel < 0.01) this.flashLevel = 0;
    const k = Math.min(1, this.flashLevel);
    // lightning lifts the whole frame: sun, sky light, background, fog
    this.sun.intensity = this.current.sunIntensity + this.flashLevel * 6;
    this.hemi.intensity = this.current.hemiIntensity + this.flashLevel * 1.4;
    if (this.scene.background) this.scene.background.copy(this.current.background).lerp(this.flashColor, k * 0.55);
    this.scene.fog.color.copy(this.current.fogColor).lerp(this.flashColor, k * 0.5);
  }
}
