// r6 S3: gi-bridge — param packing from the REAL cascade layout (cascade.js) + async non-blocking readback scheduling (fake renderer/backend).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCascades, cascadeBaseCell, totalProbes } from '../client/kernel/gi/cascade.js';
import { packGiParams, createGiBridge, mirrorAtlas, GI_PARAM_HEADER, GI_PARAM_CASCADE } from '../client/kernel/render-api/gi-bridge.js';

function fakeOpen(ambientMode = 'replace') {
  const cascades = buildCascades({ count: 3, spacings: [2, 6, 18], dims: [{ x: 16, y: 8, z: 16 }, { x: 16, y: 8, z: 16 }, { x: 16, y: 8, z: 16 }] });
  const cam = [100.5, 3, -40.2];
  const total = totalProbes(cascades);
  return {
    cascades, blendCells: 1.5, ambientMode, baseCells: cascades.map((c) => cascadeBaseCell(c, cam)),
    atlases: { irradianceRes: 8, depthRes: 16, irradiance: { value: { n: total * 64 * 4 } }, depth: { value: { n: total * 256 * 2 } } },
  };
}

test('packGiParams: header + per-cascade [baseCell.xyz, spacing, dims.xyz, baseIndex] from the real layout', () => {
  const o = fakeOpen(); const p = packGiParams(o);
  assert.equal(p.length, GI_PARAM_HEADER + 3 * GI_PARAM_CASCADE);
  assert.deepEqual([...p.slice(0, 5)], [3, 1.5, 8, 16, 1]);
  const c1 = [...p.slice(GI_PARAM_HEADER + GI_PARAM_CASCADE, GI_PARAM_HEADER + 2 * GI_PARAM_CASCADE)];
  assert.deepEqual(c1, [...o.baseCells[1], 6, 16, 8, 16, 2048]); // baseIndex of cascade 1 = 16*8*16
  assert.equal(packGiParams(fakeOpen('add'))[4], 0);
  assert.equal(packGiParams({ cascades: o.cascades, baseCells: null, atlases: o.atlases }), null, 'no baseCells yet (GI not updated) → null');
});

test('bridge: reads both atlases async, ONE in flight, every N frames, forwards to backend.setGiProbes', async () => {
  const open = fakeOpen(); const reads = []; const sets = [];
  let release; const gate = new Promise((r) => (release = r));
  const renderer = { getArrayBufferAsync: async (attr) => { reads.push(attr); await gate; return new Float32Array(attr.n).buffer; } };
  const backend = { setGiProbes: (i, d, p) => sets.push([i.length, d.length, p.length]), clearGiProbes() { sets.push('clear'); } };
  let ctl = { resources: { open } };
  const br = createGiBridge({ backend, renderer, getController: () => ctl, everyFrames: 5 });
  const first = br.tick();                         // frame 1 → read starts
  assert.ok(first && br.stats.inFlight);
  for (let i = 0; i < 12; i++) assert.equal(br.tick(), null); // frames 2..13: in flight → never a second read
  assert.equal(reads.length, 2, 'irradiance + depth only');
  release(); await first;
  assert.equal(br.stats.inFlight, false); assert.equal(br.stats.reads, 1);
  const total = 3 * 2048;
  assert.deepEqual(sets[0], [total * 64 * 4, total * 256 * 2, GI_PARAM_HEADER + 24], 'irradiance 4 f32/texel, depth 2 f32/texel');
  let started = 0; for (let i = 0; i < 10; i++) if (br.tick()) started++;
  assert.ok(started >= 1 && started <= 2, `periodic (every 5 frames): ${started}`);
  await new Promise((r) => setTimeout(r, 0));
  ctl = null; for (let i = 0; i < 6; i++) br.tick(); assert.ok(sets.includes('clear'), 'GI gone → clearGiProbes');
});

test('bridge: readback failure is counted, never throws, in-flight released', async () => {
  const backend = { setGiProbes() {} };
  const br = createGiBridge({ backend, renderer: { getArrayBufferAsync: async () => { throw new Error('boom'); } }, getController: () => ({ resources: { open: fakeOpen() } }), everyFrames: 1 });
  await br.tick(); assert.equal(br.stats.errors, 1); assert.equal(br.stats.inFlight, false); assert.match(br.stats.lastError, /boom/);
});

test('bridge: backend without setGiProbes → inert (mock/three backends)', () => {
  const br = createGiBridge({ backend: {}, renderer: { getArrayBufferAsync() {} }, getController: () => ({ resources: { open: fakeOpen() } }) });
  assert.equal(br.tick(), null);
});

// r10-shadow-6: exported TSL packages bind the same GPU-only atlas attribute three computes into; the readback is mirrored into its CPU array and versioned OUTSIDE attr.version.
test('mirrorAtlas: copies readback into the attribute CPU array, bumps userData.gpuMirrorVersion, never attr.version; size mismatch refused', () => {
  const attr = { array: new Float32Array(8), version: 7 };
  const src = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(mirrorAtlas(attr, src.buffer), true);
  assert.deepEqual([...attr.array], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(attr.userData.gpuMirrorVersion, 1); assert.equal(attr.version, 7);
  mirrorAtlas(attr, src.buffer); assert.equal(attr.userData.gpuMirrorVersion, 2);
  assert.equal(mirrorAtlas(attr, new ArrayBuffer(4)), false); assert.equal(attr.userData.gpuMirrorVersion, 2);
  assert.equal(mirrorAtlas(null, src.buffer), false);
});
