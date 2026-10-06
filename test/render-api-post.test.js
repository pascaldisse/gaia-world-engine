// r10: post-bridge mirrors three's tone mapping / exposure / BloomNode values onto the backend, pushing only changes.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { findBloomNode, readPostState, createPostBridge } from '../client/kernel/render-api/post-bridge.js';
import { RENDER_API_OPTIONAL_METHODS } from '../client/kernel/render-api/interface.js';
class BloomNode { static get type() { return 'BloomNode'; } constructor() { this.isNode = true; this.strength = { value: 0.35 }; this.radius = { value: 0.4 }; this.threshold = { value: 0.85 }; this.smoothWidth = { value: 0.01 }; } }
const graph = () => { const bloom = new BloomNode(); const color = { isNode: true }; return { bloom, outputNode: { isNode: true, aNode: color, bNode: bloom } }; };
const mock = () => { const calls = []; return { calls, setToneMapping: (m) => calls.push(['tm', m]), setExposure: (e) => calls.push(['ex', e]), setBloom: (b) => calls.push(['bloom', b]) }; };
test('optional methods are declared', () => { for (const m of ['setToneMapping', 'setExposure', 'setBloom']) assert.ok(RENDER_API_OPTIONAL_METHODS.includes(m)); });
test('findBloomNode walks color.add(bloom) and returns the BloomNode; none -> null', () => {
  const g = graph(); assert.equal(findBloomNode(g.outputNode), g.bloom); assert.equal(findBloomNode({ isNode: true }), null); assert.equal(findBloomNode(null), null);
});
test('readPostState takes the game\'s own values', () => {
  const g = graph(); g.bloom.strength.value = 0.9;
  const s = readPostState({ renderer: { toneMapping: 4, toneMappingExposure: 0.6 }, post: { postProcessing: { outputNode: g.outputNode } } });
  assert.deepEqual(s, { toneMapping: 4, exposure: 0.6, bloom: { strength: 0.9, radius: 0.4, threshold: 0.85, smoothWidth: 0.01 } });
});
test('bridge pushes once, then only on change; unsupported constant is reported not remapped', () => {
  const g = graph(); const b = mock(); const r = { toneMapping: 4, toneMappingExposure: 1 };
  const br = createPostBridge({ backend: b, renderer: r, getPost: () => ({ postProcessing: { outputNode: g.outputNode } }) });
  assert.equal(br.tick(), true); assert.equal(b.calls.length, 3); assert.equal(br.tick(), false); assert.equal(b.calls.length, 3);
  g.bloom.threshold.value = 0.5; assert.equal(br.tick(), true); assert.deepEqual(b.calls.at(-1)[1].threshold, 0.5);
  r.toneMapping = 5; const n = b.calls.length; br.tick(); assert.ok(br.stats.unsupported.has('toneMapping:5')); assert.ok(!b.calls.slice(n).some((c) => c[0] === 'tm'));
  const off = createPostBridge({ backend: b, renderer: r, getPost: () => null }); b.calls.length = 0; off.tick(); assert.deepEqual(b.calls.find((c) => c[0] === 'bloom'), ['bloom', null]);
});
