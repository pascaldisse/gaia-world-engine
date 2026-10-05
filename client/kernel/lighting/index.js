// Open-world lighting rig (L-SUN). Default OFF → constructing this allocates
// nothing and touches no scene object. docs/LIGHTING-OPENWORLD.md
import { SunShadows, SHADOW_DEFAULTS, markShadows } from './shadows.js';

export { markShadows, SHADOW_DEFAULTS };

export const LIGHTING_DEFAULTS = {
  enabled: false,
  shadows: { ...SHADOW_DEFAULTS },
};

export class LightingController {
  constructor({ renderer, scene, sun, hemi, camera = null, post = null } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    this.camera = camera;
    this.post = post;
    this.enabled = false;
    this.config = { ...LIGHTING_DEFAULTS, shadows: { ...SHADOW_DEFAULTS } };
    this.sunShadows = sun ? new SunShadows(sun) : null;
  }

  setCamera(camera) {
    this.camera = camera;
    this.sunShadows?.syncCamera(camera);
  }

  // configure({enabled, shadows:{cascades,maxFar,mapSize,bias,normalBias,fade,lightMargin}})
  // Missing keys fall back to defaults (same re-derive contract as Environment.apply).
  configure(cfg = {}) {
    const c = {
      ...LIGHTING_DEFAULTS,
      ...cfg,
      shadows: { ...SHADOW_DEFAULTS, ...(cfg.shadows ?? {}) },
    };
    this.config = c;
    if (!c.enabled) {
      if (this.enabled) this._disable();
      return this;
    }
    this.enabled = true;
    if (c.shadows && c.shadows.enabled !== false && this.sunShadows) this.sunShadows.enable(c.shadows);
    else this.sunShadows?.disable();
    return this;
  }

  _disable() {
    this.sunShadows?.disable();
    this.enabled = false;
  }

  update(_dt, camera = this.camera) {
    if (!this.enabled) return;
    this.sunShadows?.syncCamera(camera);
  }

  // shorthand: mark a loaded subtree as shadow caster+receiver
  markShadows(root, opts) { return markShadows(root, opts); }

  dispose() { this._disable(); }
}
