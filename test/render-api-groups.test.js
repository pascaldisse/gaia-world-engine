// visibility groups through render-api: helpers + wgpu-backend → wasm calls (fake gpu). Run: bun test test/render-api-groups.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bitsToWords, normalizeGroups, RENDER_API_OPTIONAL_METHODS } from '../client/kernel/render-api/interface.js';
import { createWgpuBackend } from '../client/kernel/render-api/wgpu-backend.js';
import { createMockBackend } from '../client/kernel/render-api/mock-backend.js';

async function fakeWgpu() {
  const log = []; let id = 0;
  const rec = (n, ret) => (...a) => { log.push([n, ...a.map((x) => (ArrayBuffer.isView(x) ? Array.from(x) : x))]); return ret ? ++id : undefined; };
  const gpu = new Proxy({ hasTimestamps: () => false, createMesh: rec('createMesh', true), createMaterial: rec('createMaterial', true), createInstance: rec('createInstance', true) }, { get: (t, k) => (k === 'then' ? undefined : k in t ? t[k] : rec(String(k))) });
  const wasm = { default: async () => {}, GaiaRender: { create: async () => gpu } };
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  try { return { log, backend: await createWgpuBackend({ canvas: {}, wasm }) }; }
  finally { if (prev) Object.defineProperty(globalThis, 'navigator', prev); else delete globalThis.navigator; }
}
const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const calls = (log, n) => log.filter((c) => c[0] === n);

test('bitsToWords / normalizeGroups: 128+ bits, OR of bits+words, loud on junk', () => {
  assert.deepEqual(Array.from(bitsToWords([0, 31, 32, 130])), [0x80000001, 1, 0, 0, 4]);
  assert.deepEqual(Array.from(normalizeGroups({ bits: [1], words: [4, 8] }).words), [6, 8]);
  assert.deepEqual(Array.from(normalizeGroups([50]).words), [0, 0x40000]);
  assert.equal(normalizeGroups({ bits: [3], parent: 9 }).parent, 9);
  assert.throws(() => bitsToWords([-1]), /non-negative/); assert.throws(() => bitsToWords([1.5]));
  assert.ok(RENDER_API_OPTIONAL_METHODS.includes('setActiveGroups'));
  assert.equal(typeof createMockBackend({ optional: ['setActiveGroups'] }).setActiveGroups, 'function');
});

test('wgpu-backend: instance groups → setInstanceGroups on the core instance; setActiveGroups / null', async () => {
  const { log, backend } = await fakeWgpu();
  const mesh = backend.createMesh({ positions: new Float32Array(9) }), mat = backend.createMaterial({});
  const a = backend.createInstance(mesh, mat, M, { groups: { bits: [50] } });
  const coreId = calls(log, 'createInstance').length; // fake ids are sequential; first createInstance returned a fresh id
  const g = calls(log, 'setInstanceGroups'); assert.equal(g.length, 1);
  assert.deepEqual(g[0][2], [0, 0x40000]);
  assert.equal(calls(log, 'setInstanceGroupParent')[0][2], 0xffffffff, 'no parent → detach sentinel');
  backend.setActiveGroups([50, 51]); assert.deepEqual(calls(log, 'setActiveGroups')[0][1], [0, 0xc0000]);
  backend.setActiveGroups(null); assert.equal(calls(log, 'clearActiveGroups').length, 1);
  backend.updateNode(a, { groups: { bits: [3] } });
  assert.deepEqual(calls(log, 'setInstanceGroups')[1][2], [8]);
  backend.updateNode(a, { mat4: M });
  assert.equal(calls(log, 'setInstanceGroups').length, 2, 'plain transform update does not re-send groups');
  assert.equal(coreId, 1);
});

test('wgpu-backend: group parent = parent node core instance; relinked when the parent gets its core instance later', async () => {
  const { log, backend } = await fakeWgpu();
  const mesh = backend.createMesh({ positions: new Float32Array(9) }), mat = backend.createMaterial({});
  const p = backend.createInstance(mesh, mat, M, { visible: false, groups: { bits: [50] } }); // hidden → no core instance yet
  backend.createInstance(mesh, mat, M, { groups: { bits: [1], parent: p } });
  assert.equal(calls(log, 'setInstanceGroupParent').at(-1)[2], 0xffffffff, 'parent has no core instance → unresolved');
  backend.updateNode(p, { visible: true });
  const parentCore = log.filter((x) => x[0] === 'createInstance').length; assert.equal(parentCore, 2);
  const last = calls(log, 'setInstanceGroupParent').at(-1);
  assert.notEqual(last[2], 0xffffffff, 'child relinked to the parent core instance');
});
