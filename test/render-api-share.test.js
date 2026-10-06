// r10-4: shared frame-scope updates + shared LightsNode — values identical to the legacy per-package path, frame-scope work runs once per frame token.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { exportNodeMaterial, structCache } from '../client/kernel/render-api/tsl-export.js';
const build = (share) => {
  structCache.share = share;
  const sc = new THREE.Scene(); const d = new THREE.DirectionalLight(0xffffff, 2); d.position.set(3, 5, 1); sc.add(d, d.target);
  for (let i = 0; i < 3; i++) { const p = new THREE.PointLight(0xffaa88, 5, 40); p.position.set(i * 6, 2, -4); sc.add(p); }
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500); cam.position.set(0, 2, 10); cam.updateMatrixWorld();
  const pk = []; for (let i = 0; i < 4; i++) { const m = new THREE.MeshStandardNodeMaterial({ color: 0x336699 + i * 0x101010, roughness: 0.3 + i * 0.1 }); const o = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m); sc.add(o); sc.updateMatrixWorld(true); pk.push({ o, p: exportNodeMaterial(m, { THREE, cache: 'off', scene: sc, camera: cam, object: o }) }); }
  return { sc, cam, pk };
};
test('shared path == legacy path (values per frame) and frame-scope work is deduped', () => {
  structCache.lightsBuilt = structCache.lightsReused = structCache.updSkipped = 0;
  const A = build(true), B = build(false); // same lights/materials, B = legacy
  assert.equal(structCache.lightsBuilt, 1); assert.equal(structCache.lightsReused, 3, 'one LightsNode per (scene, light set)');
  for (let f = 1; f <= 4; f++) {
    for (const S of [A, B]) { S.cam.position.set(f * 0.7, 2 + f * 0.1, 10 - f); S.cam.updateMatrixWorld(); }
    structCache.share = true; const ra = A.pk.map(({ p }) => p.live.update({ scene: A.sc, camera: A.cam, frameToken: f }));
    structCache.share = false; const rb = B.pk.map(({ p }) => p.live.update({ scene: B.sc, camera: B.cam, frameToken: f }));
    for (let i = 0; i < ra.length; i++) { assert.equal(ra[i].length, rb[i].length, `frame ${f} mat ${i}: changed count`); for (let j = 0; j < ra[i].length; j++) assert.deepEqual(ra[i][j].value, rb[i][j].value, `frame ${f} mat ${i} #${j}`); }
    assert.ok(ra[0].length > 0, 'light/camera uniforms change with the camera');
  }
  assert.ok(structCache.updSkipped > 0, 'later materials skip already-run frame-scope nodes');
  structCache.share = true;
});
