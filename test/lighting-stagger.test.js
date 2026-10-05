import test from 'node:test';
import assert from 'node:assert/strict';
import { SunShadows } from '../client/kernel/lighting/shadows.js';
const rig = (n, stagger) => { const s = new SunShadows({}); s.node = { lights: Array.from({ length: n }, () => ({ shadow: { autoUpdate: true, needsUpdate: false } })) }; s.config = { stagger }; return s; };
test('stagger 1: cascade 0 every frame, far cascades round-robin one per frame', () => {
  const s = rig(4, 1); const hits = [];
  for (let f = 0; f < 6; f++) { s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; }); s.tick(); assert.equal(s.node.lights[0].shadow.autoUpdate, true); hits.push(s.node.lights.findIndex((l, i) => i > 0 && l.shadow.needsUpdate)); assert.ok(s.node.lights.slice(1).every((l) => l.shadow.autoUpdate === false)); }
  assert.deepEqual(hits, [1, 2, 3, 1, 2, 3]);
});
test('stagger 2: one far cascade every 2nd frame', () => {
  const s = rig(3, 2); const hits = [];
  for (let f = 0; f < 6; f++) { s.node.lights.forEach((l) => { l.shadow.needsUpdate = false; }); s.tick(); hits.push(s.node.lights.findIndex((l, i) => i > 0 && l.shadow.needsUpdate)); }
  assert.deepEqual(hits, [-1, 1, -1, 2, -1, 1]);
});
test('stagger false restores autoUpdate on all cascades', () => {
  const s = rig(3, 1); s.tick(); s.config.stagger = false; s.tick();
  assert.ok(s.node.lights.every((l) => l.shadow.autoUpdate === true));
});
