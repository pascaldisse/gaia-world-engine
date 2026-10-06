// S3 — post chain: GTAO (+ optional TRAA) + bloom, tonemap/exposure choice.
// Opt-in: install() swaps postProcessing.outputNode for a lighting chain,
// uninstall() puts the ORIGINAL outputNode + post.render/setBloom back, so a
// disabled rig leaves the kernel's own bloom chain byte-identical.
//
// Fallback ladder (each rung tried on construction error): MRT normals →
// depth-only (GTAO reconstructs normals from depth) → no AO. A render-time
// throw on the lighting chain reverts to the original chain once.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, velocity, float, mix, uniform, screenUV, vec3, vec4, smoothstep, reference, perspectiveDepthToViewZ } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { AE_DEFAULTS, resolveAE, AutoExposureRig } from './autoexposure.js';
export { AE_DEFAULTS };

export const TONEMAPS = {
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
};

export const POST_DEFAULTS = {
  tonemap: 'aces',   // engine continuity; 'agx' = better saturated sunsets (UNVERIFIED look)
  exposure: 1,        // multiplies renderer.toneMappingExposure — ASSUMED
  ao: {
    enabled: true,
    intensity: 0.85,  // 0..1 blend of GTAO into the frame — ASSUMED
    radius: 1.2,      // m — ASSUMED (GTAONode ctor default 0.25 is for unit-scale demo scenes)
    thickness: 1,     // PORT: GTAONode default
    samples: 16,      // PORT: GTAONode default
    resolutionScale: 0.5, // PORT: GTAONode docs "0.5 sufficient for most scenes"
    normals: 'mrt',   // 'mrt' | 'depth' (skip the normal MRT target)
    // lane ds-ao3: AO distance fade in METRES (replaces ds-ao2 NDC-depth skyDepthEps; near/far-independent). dist = -viewZ from the
    // full-res scene depth sampled at screenUV. weight = 1 - smoothstep(fadeStart, fadeEnd, dist); aoTerm = mix(1, aoTerm, weight).
    // WHY: far translucent layers (DS cloud-sea, depthWrite:false) sit inside the far plane; one depth step at range z is z^2*2^-24/near
    // (0.86 m @1.2 km, near 0.1) >= GTAO thickness -> terraced occlusion = vertical streaks. ASSUMED defaults: AO radius 1.2 m spans
    // ~14 px @80 m, ~7 px @150 m (1080p, fov 60) -> beyond that it is sub-detail anyway; depth step @80 m = 3.8 mm (near AO untouched).
    fadeStart: 80,   // m, weight 1 at/below
    fadeEnd: 150,    // m, weight 0 at/above (sky/cleared depth => dist=far => 0)
    // null | 'mask' — 'mask' outputs (1-weight) as colour (RED = faded out/no-AO, grey = raw GTAO term), bypassing bloom: PROOF view.
    debug: null,
  },
  traa: { enabled: false },
  // opt-in eye adaptation (autoexposure.js, docs/AUTO-EXPOSURE.md); multiplies INTO the chain before bloom/tonemap, on top of static `exposure` + env dips
  autoExposure: { ...AE_DEFAULTS },
  bloom: null,        // null = inherit post.setBloom values (Environment owns them)
};

const merge = (d, c) => ({ ...d, ...(c ?? {}) });
export const resolvePost = (cfg = {}) => ({
  ...POST_DEFAULTS, ...cfg,
  ao: merge(POST_DEFAULTS.ao, cfg.ao),
  traa: merge(POST_DEFAULTS.traa, cfg.traa),
  autoExposure: resolveAE(cfg.autoExposure),
});

// CPU twins of the shader (tests + docs). Standard perspective NDC depth (renderer is NOT log/reversed: client/kernel/renderer.js
// `new THREE.WebGPURenderer({ antialias: true })`; three 0.180 has no reversed-depth option) -> view distance in metres.
export const ndcDepthToDist = (depth, near, far) => (near * far) / (far - (far - near) * depth);
export function aoDistanceWeight(dist, start, end) {
  const t = Math.min(1, Math.max(0, (dist - start) / Math.max(1e-6, end - start)));
  return 1 - t * t * (3 - 2 * t);
}
// Pure graph builder (no GPU needed): returns {outputNode, mode, nodes}.
// mode ∈ 'ao+mrt' | 'ao+depth' | 'bloom-only'; throws never — degrades.
export function buildChain({ scene, camera, cfg, renderer = null, bloomParams = { strength: 0.35, radius: 0.4, threshold: 0.85 } }) {
  const C = resolvePost(cfg);
  const wantAO = C.ao.enabled;
  const wantTRAA = C.traa.enabled;
  const rungs = wantAO ? (C.ao.normals === 'depth' ? ['depth', 'none'] : ['mrt', 'depth', 'none']) : ['none'];
  let lastErr = null;
  for (const rung of rungs) {
    try {
      const scenePass = pass(scene, camera);
      const outs = { output };
      if (rung === 'mrt') outs.normal = normalView;
      if (wantTRAA) outs.velocity = velocity;
      if (Object.keys(outs).length > 1) scenePass.setMRT(mrt(outs));
      const color = scenePass.getTextureNode('output');
      const depth = scenePass.getTextureNode('depth');
      let lit = color;
      let aoPass = null;
      let aoFade = null;
      let debug = null;
      if (rung !== 'none') {
        aoPass = ao(depth, rung === 'mrt' ? scenePass.getTextureNode('normal') : null, camera);
        aoPass.resolutionScale = C.ao.resolutionScale;
        aoPass.radius.value = C.ao.radius;
        aoPass.thickness.value = C.ao.thickness;
        aoPass.samples.value = C.ao.samples;
        // ASSUMED approximation: GTAO has no direct/indirect split here, so it
        // attenuates the whole scene colour, softened by `intensity`.
        const rawAo = aoPass.getTextureNode().r;
        // Explicit .sample(screenUV): a distinct per-pixel sample of the FULL-RES scene depth (not the default-uv node GTAO holds).
        const depthSample = depth.sample(screenUV);
        const fadeStart = uniform(C.ao.fadeStart);
const fadeEnd = uniform(C.ao.fadeEnd);
// near/far bound to the SCENE camera (as GTAONode does): the global cameraNear/cameraFar nodes follow the camera of the CURRENT render,
// which inside the post quad pass is the quad camera, not the scene camera (cause of ds-ao 1481f44 failing live).
const near = reference('near', 'float', camera);
const far = reference('far', 'float', camera);
const dist = perspectiveDepthToViewZ(depthSample.r, near, far).negate();
const weight = float(1).sub(smoothstep(fadeStart, fadeEnd, dist));
aoFade = { fadeStart, fadeEnd, near, far, dist, weight, depthSample };
const aoTerm = mix(float(1), mix(float(1), rawAo, float(C.ao.intensity)), weight);
lit = color.mul(aoTerm);
        if (C.ao.debug === 'mask') {
          debug = 'mask';
          lit = vec4(mix(vec3(rawAo), vec3(1, 0, 0), float(1).sub(weight)), 1);
        }
      }
      let resolved = lit;
      let traaPass = null;
      if (wantTRAA) {
        traaPass = traa(lit, depth, scenePass.getTextureNode('velocity'), camera);
        resolved = traaPass;
      }
      // AUTO-EXPOSURE: meter = HDR scene colour (pre-AO/bloom/tonemap); the exposure uniform multiplies BEFORE bloom so bloom threshold sees exposed light
      let autoExposure = null;
      if (C.autoExposure.enabled && !debug) {
        try {
          autoExposure = new AutoExposureRig({ renderer, colorTex: scenePass.getTexture('output'), cfg: C.autoExposure });
          resolved = vec4(resolved.rgb.mul(autoExposure.expMul).add(autoExposure.meter.keepAlive), resolved.a);
        } catch (aeErr) { console.warn('[gaia] auto-exposure unavailable:', aeErr); autoExposure = null; }
      }
      if (debug) return { outputNode: resolved, mode: rung === 'mrt' ? 'ao+mrt' : 'ao+depth', debug, nodes: { scenePass, aoPass, aoFade, traaPass, bloomPass: null, autoExposure: null }, error: lastErr };
      const bloomPass = bloom(resolved, bloomParams.strength, bloomParams.radius, bloomParams.threshold);
      return {
        outputNode: resolved.add(bloomPass),
        mode: rung === 'mrt' ? 'ao+mrt' : rung === 'depth' ? 'ao+depth' : 'bloom-only',
        debug,
        nodes: { scenePass, aoPass, aoFade, traaPass, bloomPass, autoExposure },
        error: lastErr,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('lighting post chain unbuildable');
}

// Owns the swap on one kernel `post` object ({postProcessing, render, setBloom}).
export class LightingPost {
  constructor({ post, scene, camera, renderer }) {
    this.post = post;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    this.active = false;
    this.chain = null;
    this.failed = false;
    this._orig = null;
  }
  get supported() { return !!this.post?.postProcessing; }
  get mode() { return this.chain?.mode ?? 'off'; }
  get autoExposure() { return this.chain?.nodes?.autoExposure ?? null; }

  install(cfg = {}, bloomParams) {
    const C = resolvePost(cfg);
    this.applyTonemap(C);
    if (!this.supported || this.failed) return false;
    if (this.active) this._restore(false);
    let chain;
    try { chain = buildChain({ scene: this.scene, camera: this.camera, cfg: C, renderer: this.renderer, bloomParams }); } catch (err) {
      console.warn('[gaia] lighting post chain unavailable, keeping kernel chain:', err);
      this.failed = true;
      return false;
    }
    const pp = this.post.postProcessing;
    this._orig = { outputNode: pp.outputNode, render: this.post.render, setBloom: this.post.setBloom };
    pp.outputNode = chain.outputNode;
    pp.needsUpdate = true;
    const origSetBloom = this._orig.setBloom;
    this.post.setBloom = (o = {}) => {
      origSetBloom?.(o);
      const b = chain.nodes.bloomPass;
      if (!b) return; // debug mask view has no bloom
      if (o.strength !== undefined) b.strength.value = o.strength;
      if (o.radius !== undefined) b.radius.value = o.radius;
      if (o.threshold !== undefined) b.threshold.value = o.threshold;
    };
    const origRender = this._orig.render;
    this.post.render = () => {
      try { origRender(); chain.nodes.autoExposure?.afterRender(); } catch (err) {
        console.warn('[gaia] lighting post chain threw at render, reverting to kernel chain:', err);
        this.failed = true;
        this._restore(true);
        this.post.render();
      }
    };
    this.chain = chain;
    this.active = true;
    return true;
  }

  applyTonemap(C) {
    if (!this.renderer) return;
    this.renderer.toneMapping = TONEMAPS[C.tonemap] ?? TONEMAPS.aces;
  }

  _restore(dispose) {
    if (!this.active) return;
    const pp = this.post.postProcessing;
    pp.outputNode = this._orig.outputNode;
    pp.needsUpdate = true;
    this.post.render = this._orig.render;
    this.post.setBloom = this._orig.setBloom;
    this.active = false;
    if (dispose) this.chain = null;
  }

  uninstall() {
    this._restore(true);
    this._orig = null;
  }
}
