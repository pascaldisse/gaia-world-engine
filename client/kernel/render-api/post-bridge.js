// render-api/post-bridge.js — r10: mirror three's POST state onto the core's post chain (generic, no game names).
// Reads, every frame, what the game already set on three: renderer.toneMapping / renderer.toneMappingExposure and the BloomNode of the
// PostProcessing output graph (its own strength/radius/threshold uniforms). Pushes ONLY changes to the optional backend methods
// setToneMapping(mode) · setExposure(e) · setBloom({strength,radius,threshold,smoothWidth}|null). Core order = three's: scene(HDR) + bloom -> exposure/tone map -> upscale.
// Unsupported three tone-mapping constants (CustomToneMapping 5) are reported in stats.unsupported, never silently remapped.
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
export function createPostBridge({ backend, renderer, getPost = () => null }) {
  const stats = { pushes: 0, toneMapping: null, exposure: null, bloom: null, unsupported: new Set(), error: null };
  let sig = '';
  return {
    stats,
    tick() {
      const s = readPostState({ renderer, post: getPost() });
      const bsig = s.bloom ? `${s.bloom.strength},${s.bloom.radius},${s.bloom.threshold},${s.bloom.smoothWidth}` : 'off';
      const next = `${s.toneMapping}|${s.exposure}|${bsig}`;
      if (next === sig) return false;
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
