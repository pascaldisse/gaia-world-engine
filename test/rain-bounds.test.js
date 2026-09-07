import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { makeRain } from '../client/kernel/rain.js';
import { SENSES } from '../shared/schema.js';

function fixture() {
  const scene = new THREE.Scene();
  const groups = new Map();
  const view = { groups, getGroup: (id) => groups.get(id), ownPresence: 'me', animatedModels: new Map() };
  const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))); scene.add(g); groups.set('me', g);
  const store = { entities: new Map([['me', { presence: {} }]]) };
  const player = { position: new THREE.Vector3(), bodyYaw: 0, velocity: new THREE.Vector3(), driveState: { accelerationInput: 0 } };
  let t = 0;
  const fx = { hz: 500, clock: () => t, onTick: () => { t += 2; g.position.x += 12.34; player.position.x += 12.34; } };
  return { view, store, player, fx };
}

test('bounds: ticks clamp to maxTicks; default motion window stays under 4000 chars', async () => {
  const { view, store, player, fx } = fixture();
  const out = await makeRain({ store, view, player, hooks: true, maxTicks: 8 }).motion('me', { ticks: 500, forwardAxis: '-z', ...fx });
  expect(out.split('\n').length - 2).toBe(8);
  const full = await makeRain({ store, view, player, hooks: true }).motion('me', { forwardAxis: '-z', ...fx });
  expect(full.split('\n').length - 2).toBe(20);
  expect(full.length).toBeLessThan(4000);
});

test('bounds: schema codebook declares every emitted channel + conviction for the new organs', () => {
  expect(Object.keys(SENSES.rain.motion.chans)).toEqual(['t', 'ms', 'px', 'pz', 'spd', 'hdg', 'mesh', 'yaw', 'eH', 'eY', 'in', 'fwd']);
  expect(Object.keys(SENSES.rain.pose.chans)).toEqual(['t', 'ms', 'px', 'pz', 'spd', 'skel', 'maxB']);
  expect(Object.keys(SENSES.rain.colliders.chans)).toEqual(['i', 'cx', 'cy', 'cz', 'sx', 'sy', 'sz', 'blk', 'gap']);
  expect(Object.keys(SENSES.rain.colliders.convictions)).toEqual(['!BOUNDS_UNAVAILABLE', '!BOX_ROTATION_UNSUPPORTED', '!NOCOLLIDER', '!OFFSET', '!BADSPACE']);
  expect(Object.keys(SENSES.rain.frame.convictions)).toEqual(['!NO_PIXEL_TARGET', '!READ_FAILED', '!BAD_DIMENSIONS', '!BAD_BUFFER', '!BAD_ORIGIN', '!BAD_CROP']);
  for (const organ of ['motion', 'pose', 'colliders']) expect(SENSES.rain[organ].doc).toMatch(/MEASURED/);
  expect(SENSES.rain.frame.doc).toMatch(/readPixels/);
  expect(JSON.stringify(SENSES.rain.colliders)).not.toMatch(/contact-approx|source correct/);
});

test('bounds: legacy organs unchanged — fov header shape, proprio !NOBODY', async () => {
  const { view, store, player } = fixture();
  const rain = makeRain({ store, view, player });
  expect(rain.fov('me').split('\n')[0]).toMatch(/^#rain fov me fac=-?\d+ fov=120 range=40 n=0 q=deg\|cm$/);
  expect(await rain.proprio('me', { ticks: 1 })).toBe('#rain proprio me !NOBODY');
});
