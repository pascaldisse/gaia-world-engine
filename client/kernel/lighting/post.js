// S3 — post chain: GTAO (+ optional TRAA) + bloom, tonemap/exposure choice.
// Opt-in: install() swaps postProcessing.outputNode for a lighting chain,
// uninstall() puts the ORIGINAL outputNode + post.render/setBloom back, so a
// disabled rig leaves the kernel's own bloom chain byte-identical.
//
// Fallback ladder (each rung tried on construction error): MRT normals →
// depth-only (GTAO reconstructs normals from depth) → no AO. A render-time
// throw on the lighting chain reverts to the original chain once.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, velocity, float, mix, uniform, screenUV, vec3, vec4, select } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';

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
    // lane ds-ao2: no opaque geometry => no occlusion. Where the full-res scenePass depth is >= 1-skyDepthEps (buffer still
    // CLEAR: sky / beyond far plane / far translucent layers with depthWrite:false) aoTerm is forced to 1. NDC depth ~ 1-near/z,
    // so eps ≈ near/maxAoDist: 1e-3 ≈ 100 m @ near 0.1. LIVE FINDING (DS cliff): far sky/cloud meshes sit INSIDE the far plane (~1.2 km → 1-depth ≈ 8e-5), so depth is NOT exactly 1 there; eps 1e-5 masked nothing, 3e-4 most, 1e-3 all streaks. ASSUMED default.
    skyDepthEps: 1e-3,
    // null | 'mask' — 'mask' outputs the mask as colour (RED = masked/no-AO, grey = raw GTAO term), bypassing bloom: PROOF view.
    debug: null,
  },
  traa: { enabled: false },
  bloom: null,        // null = inherit post.setBloom values (Environment owns them)
};

const merge = (d, c) => ({ ...d, ...(c ?? {}) });
export const resolvePost = (cfg = {}) => ({
  ...POST_DEFAULTS, ...cfg,
  ao: merge(POST_DEFAULTS.ao, cfg.ao),
  traa: merge(POST_DEFAULTS.traa, cfg.traa),
});

// CPU twin of the shader mask (tests + docs): 1 = no opaque geometry here (depth buffer cleared) ⇒ AO must not apply.
export const aoSkyMask = (depth, eps) => (depth >= 1 - Math.max(0, eps) ? 1 : 0);
// Pure graph builder (no GPU needed): returns {outputNode, mode, nodes}.
// mode ∈ 'ao+mrt' | 'ao+depth' | 'bloom-only'; throws never — degrades.
export function buildChain({ scene, camera, cfg, bloomParams = { strength: 0.35, radius: 0.4, threshold: 0.85 } }) {
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
      let aoSky = null;
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
        const eps = uniform(C.ao.skyDepthEps);
        const mask = depthSample.r.greaterThanEqual(float(1).sub(eps)).select(float(1), float(0));
        aoSky = { eps, mask, depthSample };
        const aoTerm = select(mask.greaterThan(0.5), float(1), mix(float(1), rawAo, float(C.ao.intensity)));
        lit = color.mul(aoTerm);
        if (C.ao.debug === 'mask') {
          debug = 'mask';
          lit = vec4(mix(vec3(rawAo), vec3(1, 0, 0), mask), 1);
        }
      }
      let resolved = lit;
      let traaPass = null;
      if (wantTRAA) {
        traaPass = traa(lit, depth, scenePass.getTextureNode('velocity'), camera);
        resolved = traaPass;
      }
      if (debug) return { outputNode: resolved, mode: rung === 'mrt' ? 'ao+mrt' : 'ao+depth', debug, nodes: { scenePass, aoPass, aoSky, traaPass, bloomPass: null }, error: lastErr };
      const bloomPass = bloom(resolved, bloomParams.strength, bloomParams.radius, bloomParams.threshold);
      return {
        outputNode: resolved.add(bloomPass),
        mode: rung === 'mrt' ? 'ao+mrt' : rung === 'depth' ? 'ao+depth' : 'bloom-only',
        debug,
        nodes: { scenePass, aoPass, aoSky, traaPass, bloomPass },
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

  install(cfg = {}, bloomParams) {
    const C = resolvePost(cfg);
    this.applyTonemap(C);
    if (!this.supported || this.failed) return false;
    if (this.active) this._restore(false);
    let chain;
    try { chain = buildChain({ scene: this.scene, camera: this.camera, cfg: C, bloomParams }); } catch (err) {
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
      try { origRender(); } catch (err) {
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
