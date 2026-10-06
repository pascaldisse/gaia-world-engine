// Open-world lighting rig (L-SUN). Default OFF → constructing this allocates
// nothing and touches no scene object. docs/LIGHTING-OPENWORLD.md
import { SunShadows, SHADOW_DEFAULTS, markShadows } from './shadows.js';
import { sunPosition, sunFromDirection, sunLight, daylight, SUN_DEFAULTS } from './sun.js';
import { LightingPost, POST_DEFAULTS, resolvePost, TONEMAPS } from './post.js';
import { SKY_DEFAULTS, skyRadiance, skyRadianceTSL, skySummary, createSkyMesh, applySkyParams } from './sky.js';

export { LightingPost, POST_DEFAULTS, TONEMAPS, markShadows, SHADOW_DEFAULTS, SKY_DEFAULTS, SUN_DEFAULTS, skyRadiance, skyRadianceTSL, skySummary, sunPosition, sunLight };

export const LIGHTING_DEFAULTS = {
  enabled: false,
  shadows: { ...SHADOW_DEFAULTS },
  // sun: {timeOfDay,latitude,dayOfYear} (solar hours) OR {direction:[x,y,z]} explicit.
  // speed = in-game hours per real second (0 = frozen).
  time: { timeOfDay: 14, latitude: 40, dayOfYear: 172, direction: null, speed: 0 },
  sky: { ...SKY_DEFAULTS, visible: true },
  sun: { ...SUN_DEFAULTS },
  hemi: { day: 0.9, night: 0.12 }, // hemisphere light peak / floor — ASSUMED
  fog: { near: 80, far: 900, follow: true }, // fog colour tracks sky horizon — near/far ASSUMED
  post: { ...POST_DEFAULTS }, // GTAO / TRAA / tonemap / exposure (post.js)
  // per-concern ownership: false = the game keeps that concern (authored sky/fog/background/hemi); the rest (sun, CSM, AO, tonemap, GI feed) still runs. Defaults true = historic behaviour.
  owns: { fog: true, background: true, hemi: true, sky: true },
};

const merge = (d, c) => ({ ...d, ...(c ?? {}) });

export class LightingController {
  constructor({ renderer, scene, sun, hemi, camera = null, post = null } = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    this.camera = camera;
    this.post = post;
    this.enabled = false;
    this.config = this._resolve({});
    this.sunShadows = sun ? new SunShadows(sun) : null;
    this.skyMesh = null;
    this.skySummary = null;       // {zenith,horizon,ground} — GI interface; null while disabled
    this._extSky = null; // external {zenith,horizon,ground} (setSkySummary), used only while owns.sky === false
    this.skyVersion = 0;          // bumps whenever skySummary is recomputed
    this.sunState = null;         // {dir,elevation,azimuth,light}
    this.timeOfDay = this.config.time.timeOfDay;
    this._listeners = new Set();
    this._lastSunDir = null;
    this._paramsKey = '';
    this._saved = null;
    this.lightingPost = post ? new LightingPost({ post, scene, camera, renderer }) : null;
    this.exposure = 1;            // Environment reads this while enabled
    this.bloomParams = undefined; // Environment hands its bloom params here before configure()
  }

  _resolve(cfg) {
    return {
      ...LIGHTING_DEFAULTS,
      ...cfg,
      shadows: merge(SHADOW_DEFAULTS, cfg.shadows),
      time: merge(LIGHTING_DEFAULTS.time, cfg.time),
      sky: merge(LIGHTING_DEFAULTS.sky, cfg.sky),
      sun: merge(LIGHTING_DEFAULTS.sun, cfg.sun),
      hemi: merge(LIGHTING_DEFAULTS.hemi, cfg.hemi),
      fog: merge(LIGHTING_DEFAULTS.fog, cfg.fog),
      post: resolvePost(cfg.post ?? {}),
    owns: merge(LIGHTING_DEFAULTS.owns, cfg.owns),
  };
  }

  // debug: {ev,target,lum,meter,mul,reads,lag,...} or null when post.autoExposure is off
  get autoExposureState() { return this.lightingPost?.autoExposure?.state ?? null; }
  setCamera(camera) {
    this.camera = camera;
    this.sunShadows?.syncCamera(camera);
  }

  // GI lane subscribes: cb(skySummary, sunState) fires on every recompute
  onSkyChange(cb) { this._listeners.add(cb); return () => this._listeners.delete(cb); }

  setTimeOfDay(h) { this.timeOfDay = ((h % 24) + 24) % 24; this.config.time.direction = null; }

  // configure({enabled, shadows, time, sky, sun, hemi, fog}) — missing keys fall
  // back to defaults (same re-derive contract as Environment.apply).
  // opts.restoreLights=false: on disable, leave sun/hemi/fog as the caller (Environment.apply) set them
  configure(cfg = {}, { restoreLights = true } = {}) {
    const c = this._resolve(cfg);
    this.config = c;
    if (!c.enabled) {
      if (this.enabled) this._disable(restoreLights);
      return this;
    }
    if (!this.enabled) this._enable();
    this.timeOfDay = c.time.timeOfDay;
    if (c.shadows && c.shadows.enabled !== false && this.sunShadows) this.sunShadows.enable(c.shadows, this.renderer);
    else this.sunShadows?.disable();
    this._applySkyVisibility();
    this._applyPost();
    this._paramsKey = ''; // force a recompute
    this._lastSunDir = null;
    this.update(0);
    return this;
  }

  _enable() {
    this.enabled = true;
    // remember what we override so disable restores it
    this._saved = {
      toneMapping: this.renderer?.toneMapping,
      sunColor: this.sun?.color.clone(), sunIntensity: this.sun?.intensity,
      sunPos: this.sun?.position.clone(),
      hemiColor: this.hemi?.color.clone(), hemiGround: this.hemi?.groundColor.clone(),
      hemiIntensity: this.hemi?.intensity,
    };
  }

  _applyPost() {
    const c = this.config.post;
    this.exposure = c.exposure;
    if (!this.lightingPost) {
      if (this.renderer) this.renderer.toneMapping = TONEMAPS[c.tonemap] ?? TONEMAPS.aces;
      return;
    }
    this.lightingPost.camera = this.camera ?? this.lightingPost.camera;
    const b = this.bloomParams; // Environment sets this from its bloom params
    this.lightingPost.install(c, b);
  }

  _applySkyVisibility() {
    const want = this.config.sky.visible !== false && this.config.owns.sky !== false; // owns.sky:false -> no dome, the game keeps its own
    if (want && !this.skyMesh) {
      this.skyMesh = createSkyMesh(this.config.sky);
      this.scene?.add(this.skyMesh);
    } else if (!want && this.skyMesh) {
      this.scene?.remove(this.skyMesh);
      this.skyMesh = null;
    }
  }

  _disable(restoreLights = true) {
    this.sunShadows?.disable();
    if (this.skyMesh) { this.scene?.remove(this.skyMesh); this.skyMesh = null; }
    const s = this._saved;
    if (s && this.sun && restoreLights) {
      this.sun.color.copy(s.sunColor); this.sun.intensity = s.sunIntensity; this.sun.position.copy(s.sunPos);
      this.hemi.color.copy(s.hemiColor); this.hemi.groundColor.copy(s.hemiGround); this.hemi.intensity = s.hemiIntensity;
    }
    this.lightingPost?.uninstall();
    if (s && this.renderer && s.toneMapping !== undefined) this.renderer.toneMapping = s.toneMapping;
    this.exposure = 1;
    this._saved = null;
    this.skySummary = null;
    this.sunState = null;
    this.enabled = false;
  }

  update(dt, camera = this.camera) {
    if (!this.enabled) return;
    const c = this.config;
    if (c.time.speed && !c.time.direction && dt > 0) this.timeOfDay = (this.timeOfDay + c.time.speed * dt) % 24;
    const pos = c.time.direction
      ? sunFromDirection(c.time.direction)
      : sunPosition({ timeOfDay: this.timeOfDay, latitude: c.time.latitude, dayOfYear: c.time.dayOfYear });
    const L = sunLight(pos.dir, c.sun);
    this.sunState = { ...pos, light: L };
    const key = JSON.stringify(c.sky);
    const moved = !this._lastSunDir || pos.dir.some((v, i) => Math.abs(v - this._lastSunDir[i]) > 1e-5);
    if (moved || key !== this._paramsKey) {
      this._lastSunDir = pos.dir;
      this._paramsKey = key;
      this._recompute(pos, L);
    }
    // sky dome: unit sun vector, camera-centred so the box never clips
    if (this.skyMesh) {
      this.skyMesh.sunPosition.value.set(...pos.dir);
      const cam = camera ?? this.camera;
      if (cam) {
        this.skyMesh.position.copy(cam.position);
        this.skyMesh.scale.setScalar((cam.far ?? 4000) * (c.sky.size ?? 0.7));
      }
    }
    this.sunShadows?.syncCamera(camera ?? this.camera);
    this.sunShadows?.tick();
    this.lightingPost?.autoExposure?.update(dt); // eye adaptation step (CPU, framerate-independent) -> exposure uniform
  }

  _recompute(pos, L) {
    const c = this.config;
    const day = daylight(pos.dir);
    const sum = this._summary(pos, c);
    this.skySummary = sum;
    this.skyVersion++;
    applySkyParams(this.skyMesh ?? { turbidity: {}, rayleigh: {}, mieCoefficient: {}, mieDirectionalG: {} }, c.sky);
    // key light
    if (this.sun) {
      this.sun.color.setRGB(L.color[0], L.color[1], L.color[2]);
      this.sun.intensity = L.intensity;
      this.sun.position.set(L.direction[0] * 200, L.direction[1] * 200, L.direction[2] * 200);
    }
    // hemisphere: sky/ground tint from the summary, level from daylight
    if (this.hemi && c.owns.hemi !== false) {
    const nrm = (v) => { const m = Math.max(v[0], v[1], v[2], 1e-6); return [v[0] / m, v[1] / m, v[2] / m]; };
      const sky = nrm(sum.zenith);
      const gnd = nrm(sum.ground);
      this.hemi.color.setRGB(sky[0], sky[1], sky[2]);
      this.hemi.groundColor.setRGB(gnd[0] * 0.5, gnd[1] * 0.5, gnd[2] * 0.5);
      this.hemi.intensity = c.hemi.night + (c.hemi.day - c.hemi.night) * day;
    }
    // fog + clear colour follow the sky horizon (kept a Color: Environment's
    // fade/flash code assumes scene.background is one)
    if (c.fog.follow && this.scene) {
    const ownFog = c.owns.fog !== false, ownBg = c.owns.background !== false;
      const h = sum.horizon;
      if (this.scene.fog && ownFog) { this.scene.fog.color.setRGB(h[0], h[1], h[2]);
        if (!this.scene.fog.isFogExp2) { this.scene.fog.near = c.fog.near; this.scene.fog.far = c.fog.far; }
      }
      if (ownBg && this.scene.background?.isColor) this.scene.background.setRGB(h[0], h[1], h[2]);
    }
    for (const cb of this._listeners) cb(sum, this.sunState);
  }

  // summary the system publishes: Preetham by default; the external one while owns.sky === false and one was given
  _summary(pos, c) {
    if (c.owns.sky === false && this._extSky) return this._extSky;
    return skySummary(pos.dir, c.sky);
  }
  // External sky summary {zenith,horizon,ground} (each [r,g,b]) for a game with an authored sky (owns.sky:false):
  // replaces the Preetham summary -> hemi (if owned), fog-follow (if owned), onSkyChange listeners (GI feed). null clears.
  // Ignored while owns.sky !== false (the analytic dome is then the truth).
  setSkySummary(s) {
    this._extSky = s ? { zenith: [...s.zenith], horizon: [...s.horizon], ground: [...s.ground] } : null;
    if (this.enabled && this.config.owns.sky === false) { this._paramsKey = ''; this.update(0); }
  }
  // shorthand: mark a loaded subtree as shadow caster+receiver
  markShadows(root, opts) { return markShadows(root, opts); }

  dispose() { this._disable(); this._listeners.clear(); }
}
