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
    // skylight: a true global light (the zone hemisphere is often nearly
    // black on purpose — multiplying it does nothing, so this adds instead)
    this.ambient = new THREE.AmbientLight('#b8c6e6', 0);
    scene.add(this.ambient);
    // the ~ debug panel's live knobs
    this.debugMul = 1;
    this.debugAmbient = 0;
    this.debugFog = 1;
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
    };
    this.current.ambientIntensity = 0;
  }

  apply(params) {
    const p = { ...this.defaults, ...(params ?? {}) };
    this.scene.background = new THREE.Color(p.background);
    const fog = { ...this.defaults.fog, ...(p.fog ?? {}) };
    if (fog.density) this.scene.fog = new THREE.FogExp2(fog.color, fog.density);
    else this.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
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
    this.post?.setBloom({ ...this.defaults.bloom, ...(p.bloom ?? {}) });
    if (p.audio) this.audio?.applyBus(p.audio);
    this.current = {
      sunIntensity: sun.intensity,
      hemiIntensity: hemi.intensity,
      ambientIntensity: ambient.intensity,
      background: new THREE.Color(p.background),
      fogColor: new THREE.Color(fog.color),
    };
  }

  // crossfade into another mood — zone seams use this so a boundary is a
  // slow change of air, never a cut. Snaps anything that can't interpolate.
  applyFaded(params, seconds = 2.5) {
    const from = {
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
    };
    this.apply(params); // snap to target (sets bloom, buses, fog type)
    const to = {
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
    };
    this.fadeState = { from, to, t: 0, seconds };
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
      this.scene.background.copy(fade.from.background).lerp(fade.to.background, k);
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
      // keep the flash baseline tracking the fade
      this.current.background.copy(this.scene.background);
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
      this.dipT += dt;
      const p = Math.min(1, this.dipT / this.dipDur);
      exposure *= 1 - 0.96 * Math.sin(p * Math.PI);
      if (p >= 1) this.dipDur = 0;
    }
    this.renderer.toneMappingExposure = exposure * this.debugMul;
    this.ambient.intensity = this.current.ambientIntensity + this.debugAmbient;
    if (this.scene.fog.isFogExp2 && this.fogDensity !== null) {
      this.scene.fog.density = this.fogDensity * this.debugFog;
    }

    if (this.flashLevel <= 0) return;
    this.flashLevel *= Math.exp(-dt * 4.5);
    if (this.flashLevel < 0.01) this.flashLevel = 0;
    const k = Math.min(1, this.flashLevel);
    // lightning lifts the whole frame: sun, sky light, background, fog
    this.sun.intensity = this.current.sunIntensity + this.flashLevel * 6;
    this.hemi.intensity = this.current.hemiIntensity + this.flashLevel * 1.4;
    this.scene.background.copy(this.current.background).lerp(this.flashColor, k * 0.55);
    this.scene.fog.color.copy(this.current.fogColor).lerp(this.flashColor, k * 0.5);
  }
}
