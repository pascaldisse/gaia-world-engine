import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMPOSTOR_DEFAULTS, impostorSpec, bucketOf, bucketKey, ImpostorCache } from '../client/kernel/impostors.js';

test('impostors are opt-in engine surface: off until a world declares them', () => {
  assert.equal(IMPOSTOR_DEFAULTS.enabled, false);
  assert.equal(impostorSpec().enabled, false);
  assert.equal(impostorSpec({ enabled: true }).enabled, true);
  // every knob is a parameter, and a world's value wins over the default
  const tuned = impostorSpec({ enabled: true, angleBuckets: 32, tile: 64, animBuckets: 8, maxTextures: 40, alphaTest: 0.15 });
  assert.equal(tuned.angleBuckets, 32);
  assert.equal(tuned.tile, 64);
  assert.equal(tuned.animBuckets, 8);
  assert.equal(tuned.maxTextures, 40);
  assert.equal(tuned.alphaTest, 0.15);
  assert.equal(impostorSpec({ alphaTest: 8 }).alphaTest, 0.5, 'invalid declaration falls back to default');
  // garbage falls back to the default rather than poisoning the cache
  assert.equal(impostorSpec({ tile: -3 }).tile, IMPOSTOR_DEFAULTS.tile);
  assert.equal(impostorSpec({ angleBuckets: 'many' }).angleBuckets, IMPOSTOR_DEFAULTS.angleBuckets);
});

test('view direction maps onto angle buckets, wrapping at the seam', () => {
  const spec = impostorSpec({ enabled: true, angleBuckets: 8 });
  assert.equal(bucketOf(spec, { yaw: 0 }).yawBucket, 0);
  assert.equal(bucketOf(spec, { yaw: Math.PI }).yawBucket, 4);
  assert.equal(bucketOf(spec, { yaw: 2 * Math.PI }).yawBucket, 0); // wrap
  assert.equal(bucketOf(spec, { yaw: -Math.PI / 4 }).yawBucket, 7); // negative wraps
  // a nudge inside one bucket is NOT a new cell -- that is the whole economy
  assert.equal(bucketOf(spec, { yaw: 0.01 }).yawBucket, bucketOf(spec, { yaw: 0.2 }).yawBucket);
  assert.notEqual(bucketKey('m', bucketOf(spec, { yaw: 0 })), bucketKey('m', bucketOf(spec, { yaw: Math.PI })));
});

test('a cold cell renders once; every later look inside that cell is a hit', () => {
  const cache = new ImpostorCache({ spec: { enabled: true, angleBuckets: 8, animBuckets: 0 } });
  const first = cache.acquire('building-a', null, { yaw: 0 });
  assert.equal(first.rendered, true);
  for (let i = 0; i < 20; i++) cache.acquire('building-a', null, { yaw: 0.05 * (i / 20) });
  assert.equal(cache.stats.misses, 1, 're-rendered inside a single angle bucket');
  assert.equal(cache.stats.hits, 20);
  // crossing into the next bucket IS a delta -> exactly one more render
  assert.equal(cache.acquire('building-a', null, { yaw: Math.PI / 2 }).rendered, true);
  assert.equal(cache.stats.misses, 2);
  // and a different model never shares a cell
  assert.equal(cache.acquire('building-b', null, { yaw: 0 }).rendered, true);
  assert.equal(cache.textures.size, 3);
});

test('animation frames are a cache axis, so a walking sprite re-renders per frame bucket', () => {
  const cache = new ImpostorCache({ spec: { enabled: true, angleBuckets: 8, animBuckets: 4 } });
  const phases = [0, 0.1, 0.3, 0.6, 0.9, 0.05];
  for (const animPhase of phases) cache.acquire('ped', null, { yaw: 0, animPhase });
  assert.equal(cache.textures.size, 4, 'one tile per animation bucket, not per frame');
});

test('instrumentation resets counters without clearing a hot GPU cache', () => {
  const cache = new ImpostorCache({ spec: { enabled: true } });
  cache.acquire('building', null, { yaw: 0 });
  cache.resetStats();
  assert.equal(cache.textures.size, 1);
  assert.deepEqual(cache.stats, { renders: 0, hits: 0, misses: 0, evictions: 0, diskWrites: 0 });
});

test('the GPU cache is bounded: least-recently-used tiles are evicted', () => {
  const cache = new ImpostorCache({ spec: { enabled: true, angleBuckets: 16, maxTextures: 4 } });
  for (let i = 0; i < 16; i++) cache.acquire('b', null, { yaw: (i / 16) * Math.PI * 2 });
  assert.equal(cache.textures.size, 4);
  assert.equal(cache.stats.evictions, 12);
});

test('impostors NEVER touch disk: the module has no filesystem or download path', () => {
  const src = readFileSync(new URL('../client/kernel/impostors.js', import.meta.url), 'utf8');
  for (const forbidden of ['node:fs', 'require(\'fs\')', 'localStorage', 'indexedDB', 'showSaveFilePicker', 'toDataURL', 'toBlob', 'createObjectURL', 'download', 'writeFile']) {
    assert.ok(!src.includes(forbidden), `impostor cache reaches for persistence: ${forbidden}`);
  }
  // and the cache itself only ever holds render targets
  const cache = new ImpostorCache({ spec: { enabled: true } });
  cache.acquire('x', null, { yaw: 0 });
  assert.equal(cache.stats.diskWrites, 0);
  for (const entry of cache.textures.values()) {
    assert.equal(typeof entry.target, 'object');
    assert.ok(!('path' in entry.target), 'a cached tile carries a path');
  }
});

// --- sizing law: the quad is the silhouette, not the sphere -------------------
import { viewBasis, projectedExtents } from '../client/kernel/impostors.js';

test('view basis is orthonormal and matches the offscreen camera convention', () => {
  for (const view of [{ yaw: 0, pitch: 0 }, { yaw: 1.1, pitch: -0.4 }, { yaw: -2.3, pitch: 0.9 }]) {
    const { dir, right, up } = viewBasis(view);
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    const len = (a) => Math.hypot(a.x, a.y, a.z);
    assert.ok(Math.abs(len(dir) - 1) < 1e-9);
    assert.ok(Math.abs(len(right) - 1) < 1e-9);
    assert.ok(Math.abs(len(up) - 1) < 1e-9);
    assert.ok(Math.abs(dot(dir, right)) < 1e-9);
    assert.ok(Math.abs(dot(dir, up)) < 1e-9);
    assert.ok(Math.abs(dot(right, up)) < 1e-9);
  }
  // yaw 0 / pitch 0: the lens sits on +Z looking back, so up is world up
  const b = viewBasis({ yaw: 0, pitch: 0 });
  assert.ok(Math.abs(b.up.y - 1) < 1e-9);
});

test('a tall thin tower gets a tall thin quad, NOT a sphere-sized slab', () => {
  // 8 x 40 x 8 building -> half extents 4,20,4
  const half = { x: 4, y: 20, z: 4 };
  const ext = projectedExtents(half, { yaw: 0, pitch: 0 });
  assert.ok(Math.abs(ext.halfWidth - 4) < 1e-9, 'width is the footprint, not the diagonal');
  assert.ok(Math.abs(ext.halfHeight - 20) < 1e-9);
  // the bounding sphere would have made a square quad of this radius:
  const sphereRadius = Math.hypot(half.x, half.y, half.z); // ~20.8
  assert.ok(ext.halfWidth < sphereRadius / 5, 'sphere sizing inflated width >5x');
});

test('silhouette widens on the diagonal and padding scales both axes', () => {
  const half = { x: 4, y: 20, z: 4 };
  const straight = projectedExtents(half, { yaw: 0, pitch: 0 });
  const diagonal = projectedExtents(half, { yaw: Math.PI / 4, pitch: 0 });
  assert.ok(diagonal.halfWidth > straight.halfWidth, 'corner-on is wider');
  assert.ok(Math.abs(diagonal.halfWidth - Math.SQRT2 * 4) < 1e-9);
  assert.ok(Math.abs(diagonal.halfHeight - 20) < 1e-9, 'height is untouched by yaw');
  const padded = projectedExtents(half, { yaw: 0, pitch: 0 }, 1.5);
  assert.ok(Math.abs(padded.halfWidth - 6) < 1e-9);
  assert.ok(Math.abs(padded.halfHeight - 30) < 1e-9);
});

test('a top-down lens sees the footprint, and depth stays finite there', () => {
  const half = { x: 4, y: 20, z: 6 };
  const top = projectedExtents(half, { yaw: 0, pitch: Math.PI / 2 });
  assert.ok(Math.abs(top.halfDepth - 20) < 1e-9, 'depth along the lens is the height');
  assert.ok(Math.abs(top.halfWidth - 4) < 1e-9);
  assert.ok(Math.abs(top.halfHeight - 6) < 1e-9);
});
