// r10-shadow-16: writes to a data-less rgba8 array texture that precede the first arrayMirror(t) ask must not be lost.
import { test, expect } from 'bun:test';
import { installGpuMirror, arrayMirror } from '../client/kernel/render-api/gpu-mirror.js';
test('layers written before the first arrayMirror ask are adopted', () => {
  const gtex = { width: 4, height: 2, depthOrArrayLayers: 3, format: 'rgba8unorm', dimension: '2d' };
  const q = { writeTexture() {} };
  const tex = { image: { width: 4, height: 2, depth: 3 } };
  const renderer = { backend: { device: { queue: q }, get: (t) => (t === tex ? { texture: gtex } : undefined) } };
  expect(installGpuMirror(renderer)).toBe(true);
  const px = new Uint8Array(4 * 2 * 4).fill(7);
  q.writeTexture({ texture: gtex, mipLevel: 0, origin: { x: 0, y: 0, z: 2 } }, px, { offset: 0, bytesPerRow: 16 }, { width: 4, height: 2, depthOrArrayLayers: 1 });
  const m = arrayMirror(tex);
  expect(m).toBeTruthy();
  expect(m.data.subarray(2 * 32, 3 * 32).every((v) => v === 7)).toBe(true);
  expect(m.data.subarray(0, 32).every((v) => v === 0)).toBe(true);
  expect([...m.dirty]).toEqual([2]);
});
