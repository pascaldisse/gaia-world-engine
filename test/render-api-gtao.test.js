// r12-post: post-bridge mirrors three's GTAONode (+ engine rig composite) onto backend.setGtao; refuses TRAA / debug-mask loudly; ?wgpuGtao=0 kill switch.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildChain } from '../client/kernel/lighting/post.js';
import { findGtaoNode, readGtaoState, createPostBridge } from '../client/kernel/render-api/post-bridge.js';
import { RENDER_API_OPTIONAL_METHODS } from '../client/kernel/render-api/interface.js';
const cam = () => new THREE.PerspectiveCamera(70, 1.6, 0.1, 4000);
const mk = () => { const calls = []; return { calls, setToneMapping() {}, setExposure() {}, setBloom() {}, setGtao: (g) => calls.push(g) }; };
const chain = (cfg) => buildChain({ scene: new THREE.Scene(), camera: cam(), cfg });
const post = (c) => ({ postProcessing: { outputNode: c.outputNode } });
test('setGtao is a declared optional backend method', () => assert.ok(RENDER_API_OPTIONAL_METHODS.includes('setGtao')));
test('REAL three graph: GTAONode is discovered and its params + rig composite read back', () => {
  const c = chain({ ao: { radius: 2.5, thickness: 1.7, samples: 24, resolutionScale: 0.75, intensity: 0.6, fadeStart: 40, fadeEnd: 90 } });
  assert.equal(findGtaoNode(c.outputNode), c.nodes.aoPass);
  const g = readGtaoState({ post: post(c) });
  assert.deepEqual(g, { radius: 2.5, thickness: 1.7, samples: 24, distanceExponent: 1, distanceFallOff: 1, scale: 1, resolutionScale: 0.75, intensity: 0.6, fadeStart: 40, fadeEnd: 90, debug: null });
});
test('no AO in graph -> null (nothing pushed, no refusal)', () => {
  const c = chain({ ao: { enabled: false } }); assert.equal(readGtaoState({ post: post(c) }), null);
  const b = mk(); const br = createPostBridge({ backend: b, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => post(c), warn() {} });
  br.tick(); assert.equal(b.calls.length, 0); assert.equal(br.stats.unsupported.size, 0);
});
test('bridge forwards GTAO params once, re-pushes on change (live uniform edit), nothing on idle ticks', () => {
  const c = chain({ ao: { radius: 1.2 } }); const b = mk();
  const br = createPostBridge({ backend: b, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => post(c), warn() {} });
  br.tick(); assert.equal(b.calls.length, 1); assert.equal(b.calls[0].radius, 1.2); assert.equal(b.calls[0].intensity, 0.85); assert.equal(b.calls[0].fadeEnd, 150); assert.equal(b.calls[0].resolutionScale, 0.5);
  assert.equal(br.tick(), false); assert.equal(b.calls.length, 1);
  c.nodes.aoPass.radius.value = 3; br.tick(); assert.equal(b.calls.length, 2); assert.equal(b.calls[1].radius, 3);
});
test('?wgpuGtao=0 kill switch (live-togglable): pushes null, then back', () => {
  const c = chain({}); const b = mk();
  const br = createPostBridge({ backend: b, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => post(c), gtao: false, warn() {} });
  br.tick(); assert.equal(b.calls.length, 0, 'off from the start -> never pushed');
  br.gtao = true; br.tick(); assert.equal(b.calls.length, 1); assert.ok(b.calls[0]);
  br.gtao = false; br.tick(); assert.equal(b.calls.at(-1), null);
});
test('TRAA is refused LOUDLY (stats.unsupported + warn once), GTAO still mirrored', () => {
  const c = chain({ traa: { enabled: true } }); assert.ok(c.nodes.traaPass); const b = mk(); const w = [];
  const br = createPostBridge({ backend: b, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => post(c), warn: (m) => w.push(m) });
  br.tick(); br.tick(); assert.ok(br.stats.unsupported.has('traa')); assert.equal(w.length, 1); assert.match(w[0], /traa/); assert.equal(b.calls.length, 1);
});
test('debug mask view + backend without setGtao are refused loudly, never silently dropped', () => {
  const c = chain({ ao: { debug: 'mask' } }); const b = mk(); const w = [];
  const br = createPostBridge({ backend: b, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => post(c), warn: (m) => w.push(m) });
  br.tick(); assert.ok(br.stats.unsupported.has('gtao:debug-mask')); assert.equal(b.calls.length, 0); assert.equal(w.length, 1);
  const c2 = chain({}); const b2 = { setToneMapping() {}, setExposure() {}, setBloom() {} }; const w2 = [];
  const br2 = createPostBridge({ backend: b2, renderer: { toneMapping: 4, toneMappingExposure: 1 }, getPost: () => post(c2), warn: (m) => w2.push(m) });
  br2.tick(); assert.ok(br2.stats.unsupported.has('gtao:backend')); assert.equal(w2.length, 1);
});
