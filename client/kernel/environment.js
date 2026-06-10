import * as THREE from 'three/webgpu';

// World mood as data: fog, sky, sun, exposure, bloom — all patchable live.
// Falls back to the kernel defaults when the component is removed.
export class Environment {
  constructor({ renderer, scene, hemi, sun, post }) {
    this.renderer = renderer;
    this.scene = scene;
    this.hemi = hemi;
    this.sun = sun;
    this.post = post;
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
  }
}
