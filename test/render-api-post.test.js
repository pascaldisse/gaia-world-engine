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
// r10-shadow-18: eye adaptation. wgpu never runs three's GPU meter (post.render() not called) -> the bridge feeds the rig from the core's 8x8 log2-luma grid and mirrors ae.expMul.
test('auto-exposure: grid -> trimmed mean -> ae.ingest; live multiplier pushed only on change', () => {
  const g = graph(); const calls = []; const grids = [];
  const backend = { ...mock(), setAutoExposure: (on, mul) => calls.push(['ae', on, mul]), autoExposureGrid: () => grids.shift() ?? new Float32Array(0) };
  const ae = { cfg: { centerWeight: 0, lowPct: 0, highPct: 1 }, expMul: { value: 1 }, got: [], ingest(m) { this.got.push(m); this.expMul.value = 2 ** (Math.log2(0.18) - m); } };
  const br = createPostBridge({ backend, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => ({ postProcessing: { outputNode: g.outputNode }, autoExposure: { ae } }) });
  br.tick(); assert.deepEqual(calls[0], ['ae', true, 1]); assert.equal(br.stats.ae.on, true);
  const n = calls.length; assert.equal(br.tick(), false); assert.equal(calls.length, n); // no grid, same mul -> nothing
  grids.push(new Float32Array(64).fill(Math.log2(0.045))); // uniform scene luma 0.045 -> mean log2 = log2(0.045)
  assert.equal(br.tick(), true); assert.ok(Math.abs(ae.got[0] - Math.log2(0.045)) < 1e-5); assert.equal(br.stats.ae.grids, 1);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['ae', true]); assert.ok(Math.abs(calls.at(-1)[2] - 4) < 1e-3); // 0.18/0.045 = 4x
  assert.equal(br.tick(), false); // stable mul -> no re-push
});
test('auto-exposure: no rig / backend without the methods -> bridge untouched (no ae pushes, old behaviour)', () => {
  const g = graph(); const b = mock();
  const a = createPostBridge({ backend: { ...b, setAutoExposure() { throw new Error('no'); }, autoExposureGrid: () => null }, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => ({ postProcessing: { outputNode: g.outputNode } }) });
  a.tick(); assert.equal(a.stats.error, null); assert.equal(a.stats.ae.on, false);
  const c = createPostBridge({ backend: b, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => ({ postProcessing: { outputNode: g.outputNode }, autoExposure: { ae: { cfg: {}, expMul: { value: 1 }, ingest() {} } } }) });
  c.tick(); assert.equal(c.stats.ae.on, false);
});
test('auto-exposure methods are declared optional', () => { for (const m of ['setAutoExposure', 'autoExposureGrid']) assert.ok(RENDER_API_OPTIONAL_METHODS.includes(m)); });
test('auto-exposure: rig comes from getAutoExposure (LightingPost owns it; the raw game post has none)', () => {
  const g = graph(); const calls = [];
  const backend = { ...mock(), setAutoExposure: (on, mul) => calls.push([on, mul]), autoExposureGrid: () => new Float32Array(0) };
  const rig = { ae: { cfg: {}, expMul: { value: 1.5 }, ingest() {} } };
  const br = createPostBridge({ backend, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => ({ postProcessing: { outputNode: g.outputNode } }), getAutoExposure: () => rig });
  br.tick(); assert.deepEqual(calls[0], [true, 1.5]);
});
test('auto-exposure kill switch (?wgpuAE=0 / bridge.autoExposure=false, live): meter off + mul 1, never re-armed; back on re-arms', () => {
  const g = graph(); const calls = [];
  const backend = { ...mock(), setAutoExposure: (on, mul) => calls.push([on, mul]), autoExposureGrid: () => new Float32Array(0) };
  const rig = { ae: { cfg: {}, expMul: { value: 1.5 }, ingest() {} } };
  const mk = (autoExposure) => createPostBridge({ backend, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => ({ postProcessing: { outputNode: g.outputNode } }), getAutoExposure: () => rig, autoExposure });
  const off = mk(false); off.tick(); assert.equal(calls.length, 0); assert.equal(off.stats.ae.on, false);
  const br = mk(true); br.tick(); assert.deepEqual(calls.at(-1), [true, 1.5]);
  br.autoExposure = false; br.tick(); assert.deepEqual(calls.at(-1), [false, 1]); assert.equal(br.stats.ae.on, false);
  const n = calls.length; br.tick(); assert.equal(calls.length, n);
  br.autoExposure = true; br.tick(); assert.deepEqual(calls.at(-1), [true, 1.5]);
});
