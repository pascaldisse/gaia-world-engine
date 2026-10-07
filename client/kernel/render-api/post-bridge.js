// render-api/post-bridge.js — r10: mirror three's POST state onto the core's post chain (generic, no game names).
// Reads, every frame, what the game already set on three: renderer.toneMapping / renderer.toneMappingExposure and the BloomNode of the
// PostProcessing output graph (its own strength/radius/threshold uniforms). Pushes ONLY changes to the optional backend methods
// setToneMapping(mode) · setExposure(e) · setBloom({strength,radius,threshold,smoothWidth}|null). Core order = three's: scene(HDR) + bloom -> exposure/tone map -> upscale.
// EYE ADAPTATION (r10-shadow-18): when the game's post chain owns an AutoExposureRig (post.autoExposure), three's own GPU meter never runs under the wgpu presenter
// (post.render() is not called) -> the core meters the HDR scene itself (backend.setAutoExposure(on, mul) + autoExposureGrid() = 8x8 mean log2 luma, raw HDR) and the
// rig's own state machine (ae.ingest -> ae.update(dt) from lighting.update) adapts; the live multiplier (ae.expMul) is pushed per change, applied before bloom/tone map.
// Unsupported three tone-mapping constants (CustomToneMapping 5) are reported in stats.unsupported, never silently remapped.
import { gridWeights, trimmedMean, GRID } from '../lighting/autoexposure.js';
export const SUPPORTED_TONE_MAPPING = Object.freeze([0, 1, 2, 3, 4, 6, 7]); // No Linear Reinhard Cineon ACESFilmic AgX Neutral (three r180 constants)
const isBloom = (n) => n && (n.constructor?.type === 'BloomNode' || n.isBloomNode === true) && n.strength?.value !== undefined;
// BFS over the node graph (OperatorNode.aNode/bNode, pass nodes, …); bounded + cycle-safe. Returns the first BloomNode or null.
export function findBloomNode(root, limit = 400) {
  if (!root || typeof root !== 'object') return null;
  const seen = new Set([root]);
  const q = [root];
  while (q.length && seen.size <= limit) {
    const n = q.shift();
    if (isBloom(n)) return n;
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === 'object' && v.isNode && !seen.has(v)) { seen.add(v); q.push(v); }
    }
  }
  return null;
}
export function readPostState({ renderer, post }) {
  const b = findBloomNode(post?.postProcessing?.outputNode);
  return {
    toneMapping: renderer?.toneMapping ?? 0,
    exposure: renderer?.toneMappingExposure ?? 1,
    bloom: b ? { strength: b.strength.value, radius: b.radius.value, threshold: b.threshold.value, smoothWidth: b.smoothWidth?.value ?? 0.01 } : null,
  };
}
export function createPostBridge({ backend, renderer, getPost = () => null, getAutoExposure = null }) {
  const stats = { pushes: 0, toneMapping: null, exposure: null, bloom: null, unsupported: new Set(), error: null, ae: { on: false, mul: 1, grids: 0, pushes: 0 } };
  let sig = '';
const tickAE = () => {
const rig = getAutoExposure?.() ?? getPost()?.autoExposure, ae = rig?.ae; // LightingPost owns the rig; the raw game `post` has none
if (!ae?.expMul || typeof backend.setAutoExposure !== 'function' || typeof backend.autoExposureGrid !== 'function') return false;
let pushed = false;
if (!stats.ae.on) { backend.setAutoExposure(true, ae.expMul.value); stats.ae.on = true; stats.ae.mul = ae.expMul.value; pushed = true; }
const g = backend.autoExposureGrid();
if (g && g.length >= GRID * GRID) {
const c = ae.cfg;
ae.ingest(trimmedMean(Array.from(g).slice(0, GRID * GRID), gridWeights(c.centerWeight, GRID), c.lowPct, c.highPct));
stats.ae.grids++;
}
const mul = ae.expMul.value;
if (mul !== stats.ae.mul) { backend.setAutoExposure(true, mul); stats.ae.mul = mul; stats.ae.pushes++; pushed = true; }
return pushed;
};
  return {
    stats,
    tick() {
let aeChanged = false;
try { aeChanged = tickAE(); } catch (e) { stats.error = String(e?.message ?? e); }
      const s = readPostState({ renderer, post: getPost() });
      const bsig = s.bloom ? `${s.bloom.strength},${s.bloom.radius},${s.bloom.threshold},${s.bloom.smoothWidth}` : 'off';
      const next = `${s.toneMapping}|${s.exposure}|${bsig}`;
      if (next === sig) return aeChanged;
      try {
        if (SUPPORTED_TONE_MAPPING.includes(s.toneMapping)) backend.setToneMapping?.(s.toneMapping);
        else stats.unsupported.add(`toneMapping:${s.toneMapping}`);
        backend.setExposure?.(s.exposure);
        backend.setBloom?.(s.bloom);
        stats.toneMapping = s.toneMapping; stats.exposure = s.exposure; stats.bloom = s.bloom;
        stats.pushes++;
        sig = next;
      } catch (e) { stats.error = String(e?.message ?? e); sig = next; }
      return true;
    },
  };
}
