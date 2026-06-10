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
    };
  }

  apply(params) {
    const p = { ...this.defaults, ...(params ?? {}) };
    this.scene.background = new THREE.Color(p.background);
    const fog = { ...this.defaults.fog, ...(p.fog ?? {}) };
    if (fog.density) this.scene.fog = new THREE.FogExp2(fog.color, fog.density);
    else this.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
    this.renderer.toneMappingExposure = p.exposure;
    const hemi = { ...this.defaults.hemisphere, ...(p.hemisphere ?? {}) };
    this.hemi.color.set(hemi.sky);
    this.hemi.groundColor.set(hemi.ground);
    this.hemi.intensity = hemi.intensity;
    const sun = { ...this.defaults.sun, ...(p.sun ?? {}) };
    this.sun.color.set(sun.color);
    this.sun.intensity = sun.intensity;
    this.sun.position.set(...sun.position);
    this.post?.setBloom({ ...this.defaults.bloom, ...(p.bloom ?? {}) });
    if (p.audio) this.audio?.applyBus(p.audio);
    this.current = {
      sunIntensity: sun.intensity,
      hemiIntensity: hemi.intensity,
      background: new THREE.Color(p.background),
      fogColor: new THREE.Color(fog.color),
    };
  }

  flash(intensity = 0.8) {
    this.flashLevel = Math.max(this.flashLevel, intensity * 1.6);
  }

  update(dt) {
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
