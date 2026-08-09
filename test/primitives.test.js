import test from 'node:test';
import assert from 'node:assert/strict';
import { PrimitiveRuntime } from '../client/kernel/primitives.js';

function vector() { return { set(...value) { this.value = value; }, setScalar(value) { this.value = [value, value, value]; } }; }
function group(parent = null) { return { parent, position: vector(), rotation: vector(), scale: vector(), children: [], userData: {} }; }

test('TTL emits one despawn at its authored world-clock deadline', () => {
  const entity = { lifecycle: { bornAt: 10, ttl: 2 } };
  const sent = [];
  const runtime = new PrimitiveRuntime({ store: { entities: new Map([['drop', entity]]) }, view: { groups: new Map(), getGroup(id) { return this.groups.get(id); }, scene: {} }, clock: { now: () => 12 }, send: (ops) => sent.push(ops) });
  runtime.setWorld({ features: { primitives: true } });
  runtime.update();
  runtime.update();
  assert.deepEqual(sent, [[{ op: 'despawn', id: 'drop' }]]);
});

test('per-part phase retains the authored local baseline', () => {
  const part = group();
  part.userData.kind = 'mesh-part';
  const entity = { mesh: { parts: [{ position: [0, 3, 0], phase: { axis: 'position', amplitude: 2, speed: 0, offset: Math.PI / 2 } }] } };
  const scene = { attach() {} };
  const runtime = new PrimitiveRuntime({ store: { entities: new Map([['lamp', entity]]) }, view: { groups: new Map([['lamp', { children: [part], parent: scene, userData: {} }]]), getGroup(id) { return this.groups.get(id); }, scene }, clock: { now: () => 0 }, send: () => {} });
  runtime.setWorld({ features: { primitives: true } });
  runtime.update();
  assert.equal(part.position.y, 5);
});
