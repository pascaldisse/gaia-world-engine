// r10-5: setShaderUniformsBatch = ONE wasm call/frame; shared values deduped by (key, exact value); batch.on=false = legacy per-material calls with identical payloads. Run: bun test test/render-api-uniform-batch.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_API_OPTIONAL_METHODS } from '../client/kernel/render-api/interface.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';

async function fake() {
  const log = [];
  const gpu = new Proxy({ hasTimestamps: () => false, setThreeUniforms: (id, j) => log.push(['one', id, JSON.parse(j)]), setThreeUniformsBatch: (j) => log.push(['batch', JSON.parse(j)]) }, { get: (t, k) => (k === 'then' ? undefined : k in t ? t[k] : () => 1) });
  const wasm = { default: async () => {}, GaiaRender: { create: async () => gpu } };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  try { return { log, backend: await createWgpuBackend({ canvas: {}, wasm }) }; }
  finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}
const V = [1, 2, 3], W = [1, 2, 4];
const list = () => [[1, [{ key: 'cam', value: V.slice() }, { key: 'a', value: 0.5 }]], [2, [{ key: 'cam', value: V.slice() }]], [3, [{ key: 'cam', value: W.slice() }, { key: 'a', value: 0.5 }]]];

test('interface lists the batch method as optional', () => assert.ok(RENDER_API_OPTIONAL_METHODS.includes('setShaderUniformsBatch')));

test('batch: one call, shared (key,value) shipped once, differing value stays per-material, resolved payload == legacy', async () => {
  const { log, backend } = await fake();
  backend.setShaderUniformsBatch(list());
  assert.equal(log.length, 1); assert.equal(log[0][0], 'batch');
  const { s, m } = log[0][1];
  assert.deepEqual(s.map((x) => x.key), ['cam', 'a']);
  assert.deepEqual(m, [[1, [0, 1]], [2, [0]], [3, [1], [{ key: 'cam', value: W }]]]);
  const resolved = m.map(([id, idx, own = []]) => [id, [...idx.map((i) => s[i]), ...own]]);
  backend.uniBatch.on = false; log.length = 0;
  backend.setShaderUniformsBatch(list());
  const legacy = log.map(([, id, ch]) => [id, ch]);
  assert.equal(log.every((c) => c[0] === 'one'), true);
  const norm = (r) => r.map(([id, ch]) => [id, ch.map((c) => c.key + '=' + JSON.stringify(c.value)).sort()]);
  assert.deepEqual(norm(resolved), norm(legacy));
});

test('batch: empty list = no wasm call', async () => {
  const { log, backend } = await fake();
  backend.setShaderUniformsBatch([]);
  assert.equal(log.length, 0);
});
