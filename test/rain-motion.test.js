import { test, expect } from 'bun:test';
import * as THREE from 'three/webgpu';
import { makeRain } from '../client/kernel/rain.js';

function fixture({ meshYaw = 0, withPlayer = true } = {}) {
  const scene = new THREE.Scene();
  const groups = new Map();
  const view = { groups, getGroup: (id) => groups.get(id), ownPresence: 'me', animatedModels: new Map() };
  const car = new THREE.Group();
  car.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4)));
  car.rotation.y = meshYaw;
  scene.add(car);
  groups.set('me', car);
  const player = withPlayer ? { position: new THREE.Vector3(), bodyYaw: 0, velocity: new THREE.Vector3(0, 0, -5), driveState: { accelerationInput: 1 } } : null;
  const store = { entities: new Map([['me', { presence: {} }]]) };
  return { view, store, player, car };
}
// fixture clock: exactly 5ms per tick (hz 200) unless a tick says otherwise
function fx(step, { stallAt = -1, stallMs = 0 } = {}) {
  let t = 0;
  return { hz: 200, clock: () => t, onTick: (i) => { t += i === stallAt ? stallMs : 5; step?.(i); } };
}
const driveNegZ = (car, player) => () => { car.position.z -= 0.5; if (player) player.position.z -= 0.5; };
const cells = (line) => line.trim().split(/\s+/);

test('motion: nose-first drive along −Z is OK; spd from the measured clock; controller columns filled', async () => {
  const { view, store, player, car } = fixture();
  const rain = makeRain({ store, view, player, hooks: true });
  const out = await rain.motion('me', { ticks: 6, forwardAxis: '-z', ...fx(driveNegZ(car, player)) });
  const [head, chans, ...rows] = out.split('\n');
  expect(head).toContain('#rain motion me hz=200 ctrl=player axis=-z');
  expect(head).toMatch(/ OK$/);
  expect(cells(chans)).toEqual(['t', 'ms', 'px', 'pz', 'spd', 'hdg', 'mesh', 'yaw', 'eH', 'eY', 'in', 'fwd']);
  expect(cells(rows[0])[1]).toBe('·'); expect(cells(rows[0])[4]).toBe('·');
  const r = cells(rows.at(-1));
  expect(Number(r[1])).toBe(5);
  expect(Number(r[4])).toBe(10000); // 0.5m / 5ms
  expect(Math.abs(Number(r[5]))).toBe(180);
  expect(r[8]).toBe('0'); expect(r[9]).toBe('0'); expect(r[10]).toBe('+'); expect(Number(r[11])).toBe(500);
});

test('motion: speed uses ACTUAL elapsed — a 500ms stall reads as low spd + !STALL, not fast physics', async () => {
  const { view, store, player, car } = fixture();
  const rain = makeRain({ store, view, player, hooks: true });
  const out = await rain.motion('me', { ticks: 4, forwardAxis: '-z', ...fx(driveNegZ(car, player), { stallAt: 2, stallMs: 500 }) });
  const [head, , ...rows] = out.split('\n');
  expect(head).toContain('!STALL max=500ms');
  expect(Number(cells(rows[2])[1])).toBe(500);
  expect(Number(cells(rows[2])[4])).toBe(100); // 0.5m / 0.5s
  expect(Number(cells(rows[3])[4])).toBe(10000);
});

test('motion: model rotated π while driving forward → !REVERSED (+ !PIVOT vs controller)', async () => {
  const { view, store, player, car } = fixture({ meshYaw: Math.PI });
  const head = (await makeRain({ store, view, player, hooks: true }).motion('me', { ticks: 6, forwardAxis: '-z', ...fx(driveNegZ(car, player)) })).split('\n')[0];
  expect(head).toContain('!REVERSED eH=180');
  expect(head).toContain('!PIVOT');
});

test('motion: model yawed 90° → !PIVOT eY=90, no !REVERSED', async () => {
  const { view, store, player, car } = fixture({ meshYaw: Math.PI / 2 });
  const head = (await makeRain({ store, view, player, hooks: true }).motion('me', { ticks: 6, forwardAxis: '-z', ...fx(driveNegZ(car, player)) })).split('\n')[0];
  expect(head).toContain('!PIVOT eY=90');
  expect(head).not.toContain('!REVERSED');
});

test('motion: reversing on purpose (input −) is not !REVERSED', async () => {
  const { view, store, player, car } = fixture({ meshYaw: Math.PI });
  player.driveState.accelerationInput = -1;
  const head = (await makeRain({ store, view, player, hooks: true }).motion('me', { ticks: 6, forwardAxis: '-z', ...fx(driveNegZ(car, player)) })).split('\n')[0];
  expect(head).not.toContain('!REVERSED');
});

test('motion: non-local entity → controller columns ·, ctrl=none, eH still measured', async () => {
  const { view, store, car } = fixture({ withPlayer: false });
  view.groups.set('npc-car', car);
  const out = await makeRain({ store, view, player: null, hooks: true }).motion('npc-car', { ticks: 4, forwardAxis: '-z', ...fx(driveNegZ(car, null)) });
  const [head, , ...rows] = out.split('\n');
  expect(head).toContain('ctrl=none');
  const r = cells(rows.at(-1));
  expect(r[7]).toBe('·'); expect(r[9]).toBe('·'); expect(r[10]).toBe('·'); expect(r[11]).toBe('·');
  expect(r[8]).toBe('0');
});

test('motion: no forward axis → mesh ?, eH/eY ·, !NOFORWARD, NEVER !REVERSED (model rotated π)', async () => {
  const { view, store, player, car } = fixture({ meshYaw: Math.PI });
  const out = await makeRain({ store, view, player, hooks: true }).motion('me', { ticks: 4, ...fx(driveNegZ(car, player)) });
  const [head, , ...rows] = out.split('\n');
  expect(head).toContain('axis=? ');
  expect(head).toContain('!NOFORWARD');
  expect(head).not.toContain('!REVERSED'); expect(head).not.toContain('!PIVOT');
  const r = cells(rows.at(-1));
  expect(r[6]).toBe('?'); expect(r[8]).toBe('·'); expect(r[9]).toBe('·');
});

test('motion: entity mesh.forward is the contract, case-insensitive ("+Z" ped, "-Z" car)', async () => {
  const { view, store, car } = fixture({ withPlayer: false });
  store.entities.set('ped', { mesh: { forward: '+Z' } });
  view.groups.set('ped', car);
  const rain = makeRain({ store, view, player: null, hooks: true });
  const ok = (await rain.motion('ped', { ticks: 4, ...fx(() => { car.position.z += 0.5; }) })).split('\n')[0];
  expect(ok).toContain('axis=+Z'); expect(ok).toMatch(/ OK$/);
  const bad = (await rain.motion('ped', { ticks: 4, forwardAxis: '-Z', ...fx(() => { car.position.z += 0.5; }) })).split('\n')[0];
  expect(bad).toContain('axis=-Z'); expect(bad).toContain('!REVERSED');
  const junk = (await rain.motion('ped', { ticks: 2, forwardAxis: 'north', ...fx(() => { car.position.z += 0.5; }) })).split('\n')[0];
  expect(junk).toContain('!BADAXIS'); expect(junk).toContain('!NOFORWARD'); expect(junk).toContain('axis=north'); expect(junk).not.toContain('OK');
});

test('motion: onTick/clock are fixture hooks — ignored without hooks:true (real clock, real ms); non-finite hz/ticks fall back', async () => {
  const { view, store, player, car } = fixture();
  let calls = 0;
  const rain = makeRain({ store, view, player, maxTicks: 4 });
  const out = await rain.motion('me', { ticks: 3, hz: 200, forwardAxis: '-z', clock: () => { calls++; return 0; }, onTick: () => { calls++; car.position.z -= 0.5; } });
  expect(calls).toBe(0);
  const [head, , ...rows] = out.split('\n');
  expect(head).toContain('!STATIC');
  expect(Number(cells(rows[1])[1])).toBeGreaterThan(0); // real elapsed ms, monotonic
  const weird = await rain.motion('me', { ticks: NaN, hz: Infinity, forwardAxis: '-z' });
  expect(weird.split('\n')[0]).toContain('hz=10');
  expect(weird.split('\n').length - 2).toBe(4);
  const neg = await rain.motion('me', { ticks: -5, hz: -3, forwardAxis: '-z' });
  expect(neg.split('\n')[0]).toContain('hz=10');
  expect(neg.split('\n').length - 2).toBe(1);
});

test('motion: unmoving → !STATIC; unknown id → !NOBODY', async () => {
  const { view, store, player } = fixture();
  const rain = makeRain({ store, view, player, hooks: true });
  expect((await rain.motion('me', { ticks: 3, forwardAxis: '-z', ...fx() })).split('\n')[0]).toContain('!STATIC');
  expect(await rain.motion('ghost', { ticks: 2 })).toBe('#rain motion ghost !NOBODY');
});
