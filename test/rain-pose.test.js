import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { makeRain } from '../client/kernel/rain.js';

function rig() {
  const scene = new THREE.Scene();
  const groups = new Map();
  const animatedModels = new Map();
  const view = { groups, getGroup: (id) => groups.get(id), ownPresence: null, animatedModels };
  const ped = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'Hips';
  const leg = new THREE.Bone(); leg.name = 'LeftLeg'; leg.position.y = -0.5;
  const foot = new THREE.Bone(); foot.name = 'LeftFoot'; foot.position.y = -0.5;
  leg.add(foot); hips.add(leg); ped.add(hips);
  scene.add(ped);
  groups.set('ped', ped);
  const store = { entities: new Map([['ped', { mesh: {} }]]) };
  return { view, store, ped, leg, animatedModels };
}
function fx(step, { stallAt = -1, stallMs = 0 } = {}) {
  let t = 0;
  return { hz: 200, clock: () => t, onTick: (i) => { t += i === stallAt ? stallMs : 5; step?.(i); } };
}
const cells = (line) => line.trim().split(/\s+/);

test('pose: swinging leg while walking → OK, maxB = the foot, header carries clip/mixer', async () => {
  const { view, store, ped, leg, animatedModels } = rig();
  animatedModels.set('ped', { spec: { clip: 'Walk' }, mixer: { time: 1.234 } });
  const out = await makeRain({ store, view, hooks: true }).pose('ped', { ticks: 6, ...fx((i) => { ped.position.z -= 0.3; leg.rotation.x = Math.sin(i) * 0.8; }) });
  const [head, chans, ...rows] = out.split('\n');
  expect(head).toContain('bones=3');
  expect(head).toContain('clip=Walk mixer=1.23');
  expect(head).toMatch(/ OK$/);
  expect(cells(chans)).toEqual(['t', 'ms', 'px', 'pz', 'spd', 'skel', 'maxB']);
  const r = cells(rows.at(-1));
  expect(Number(r[1])).toBe(5);
  expect(Number(r[4])).toBe(6000); // 0.3m / 5ms
  expect(Number(r[5])).toBeGreaterThan(0);
  expect(r[6]).toBe('LeftFoot');
});

test('pose: body translates (and turns), skeleton never moves → !HELD, never !FROZEN, skel stays 0', async () => {
  const { view, store, ped } = rig();
  const out = await makeRain({ store, view, hooks: true }).pose('ped', { ticks: 5, ...fx(() => { ped.position.x += 0.3; ped.rotation.y += 0.2; }) });
  const head = out.split('\n')[0];
  expect(head).toContain('!HELD');
  expect(head).not.toContain('!FROZEN');
  expect(out.split('\n').slice(3).every((l) => cells(l)[5] === '0')).toBe(true);
});

test('pose: nothing moves → !FROZEN; stall shows as !STALL; no bones → !NOBONES', async () => {
  const { view, store } = rig();
  const rain = makeRain({ store, view, hooks: true });
  expect((await rain.pose('ped', { ticks: 4, ...fx() })).split('\n')[0]).toContain('!FROZEN');
  expect((await rain.pose('ped', { ticks: 4, ...fx(null, { stallAt: 1, stallMs: 300 }) })).split('\n')[0]).toContain('!STALL max=300ms');
  view.groups.set('crate', new THREE.Group());
  expect(await rain.pose('crate', { ticks: 2 })).toBe('#rain pose crate !NOBONES');
});
