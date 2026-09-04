import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineComponent,
  EcsWorld,
  EntityCommandBuffer,
  Scheduler,
  ROOT_GROUPS,
  GaiaEcsBridge,
  LocalTransform,
  SimpleRouteElement,
  SimpleRouteFollowerComponent,
  SimpleRouteFollowerSettingsComponent,
  installSimpleRouteFollower,
} from '../shared/ecs/index.js';

const Position = defineComponent('TestPosition', { fields: { value: 'vec3' } });
const Velocity = defineComponent('TestVelocity', { fields: { value: 'vec3' } });
const Active = defineComponent('TestActive', { enableable: true, fields: { value: 'i32' } });

test('archetype moves retain typed component data and update swapped locations', () => {
  const world = new EcsWorld({ initialCapacity: 2 });
  const first = world.createEntity([[Position, { value: [1, 2, 3] }]]);
  const second = world.createEntity([[Position, { value: [4, 5, 6] }]]);
  const source = world.locations.get(first).archetype;
  assert.ok(source.columns.get(Position).fields.get('value').data instanceof Float32Array);

  world.addComponent(first, Velocity, { value: [7, 8, 9] });
  assert.deepEqual(world.getComponent(first, Position), { value: [1, 2, 3] });
  assert.deepEqual(world.getComponent(first, Velocity), { value: [7, 8, 9] });
  assert.deepEqual(world.getComponent(second, Position), { value: [4, 5, 6] });
  assert.equal(world.locations.get(second).row, 0);

  world.removeComponent(first, Velocity);
  assert.equal(world.hasComponent(first, Velocity), false);
  assert.deepEqual(world.getComponent(first, Position), { value: [1, 2, 3] });
});

test('queries implement all/any/none and writable typed refs', () => {
  const world = new EcsWorld();
  const moving = world.createEntity([[Position, { value: [0, 0, 0] }], [Velocity, { value: [2, 0, 0] }]]);
  world.createEntity([[Position, { value: [9, 0, 0] }]]);
  for (const row of world.query({ all: [Position, Velocity], none: [Active] })) {
    const position = row.refRW(Position);
    position.valueRW.value = [position.valueRO.value[0] + 1, 0, 0];
  }
  assert.deepEqual(world.getComponent(moving, Position).value, [1, 0, 0]);
  assert.equal([...world.query({ any: [Velocity, Active] })].length, 1);
});

test('UpdateAfter/UpdateBefore plus OrderFirst/OrderLast topologically order a group', () => {
  const world = new EcsWorld();
  const scheduler = new Scheduler(world);
  const seen = [];
  scheduler.addSystem('Middle', () => seen.push('Middle'), { group: ROOT_GROUPS.INITIALIZATION });
  scheduler.addSystem('After', () => seen.push('After'), { group: ROOT_GROUPS.INITIALIZATION, after: 'Middle' });
  scheduler.addSystem('Before', () => seen.push('Before'), { group: ROOT_GROUPS.INITIALIZATION, before: 'Middle' });
  scheduler.addSystem('First', () => seen.push('First'), { group: ROOT_GROUPS.INITIALIZATION, orderFirst: true });
  scheduler.addSystem('Last', () => seen.push('Last'), { group: ROOT_GROUPS.INITIALIZATION, orderLast: true });
  scheduler.tick(0.016);
  assert.deepEqual(seen, ['First', 'Before', 'Middle', 'After', 'Last']);
});

test('ordering cycles are rejected instead of silently choosing an order', () => {
  const scheduler = new Scheduler(new EcsWorld());
  scheduler.addSystem('A', () => {}, { after: 'B' });
  scheduler.addSystem('B', () => {}, { after: 'A' });
  assert.throws(() => scheduler.compile(), /cycle/);
});

test('fixed-step group accumulates render time and carries the remainder', () => {
  const scheduler = new Scheduler(new EcsWorld(), { fixedDelta: 0.1, maxFixedSteps: 4 });
  const deltas = [];
  scheduler.addSystem('FixedProbe', ({ deltaTime, fixed }) => deltas.push([deltaTime, fixed]), { group: ROOT_GROUPS.FIXED });
  scheduler.tick(0.25);
  assert.deepEqual(deltas, [[0.1, true], [0.1, true]]);
  assert.ok(Math.abs(scheduler.groups.get(ROOT_GROUPS.FIXED).accumulator - 0.05) < 1e-9);
  scheduler.tick(0.05);
  assert.equal(deltas.length, 3);
});

test('EntityCommandBuffer defers structural changes and resolves temporary entities', () => {
  const world = new EcsWorld();
  const ecb = new EntityCommandBuffer();
  const deferred = ecb.createEntity([[Position, { value: [1, 0, 0] }]]);
  ecb.addComponent(deferred, Velocity, { value: [3, 0, 0] });
  ecb.setComponent(deferred, Position, { value: [2, 0, 0] });
  const resolved = ecb.playback(world).get(deferred);
  assert.equal(world.exists(resolved), true);
  assert.deepEqual(world.getComponent(resolved, Position).value, [2, 0, 0]);
  assert.deepEqual(world.getComponent(resolved, Velocity).value, [3, 0, 0]);
});

test('enableable components filter required-query matches without archetype moves', () => {
  const world = new EcsWorld();
  const entity = world.createEntity([[Position, { value: [0, 0, 0] }], [Active, { value: 1 }]]);
  const archetype = world.locations.get(entity).archetype;
  world.setComponentEnabled(entity, Active, false);
  assert.equal(world.locations.get(entity).archetype, archetype);
  assert.equal([...world.query({ all: [Position, Active] })].length, 0);
  assert.equal([...world.query({ all: [Position, Active], includeDisabled: true })].length, 1);
  world.setComponentEnabled(entity, Active, true);
  assert.equal([...world.query({ all: [Position, Active] })].length, 1);
});

test('singleton access requires exactly one matching entity', () => {
  const Config = defineComponent('TestConfig', { fields: { speed: 'f32' } });
  const world = new EcsWorld();
  world.createEntity([[Config, { speed: 3.5 }]]);
  assert.equal(world.getSingleton(Config).speed, 3.5);
  world.createEntity([[Config, { speed: 7 }]]);
  assert.throws(() => world.getSingleton(Config), /expected one/);
});

test('real SimpleRouteFollowerSystem transcription advances LocalTransform in FixedStepGroup', () => {
  const world = new EcsWorld();
  const scheduler = new Scheduler(world, { fixedDelta: 0.02 });
  installSimpleRouteFollower(scheduler);
  const entity = world.createEntity([
    [LocalTransform, { Position: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: 1 }],
    [SimpleRouteFollowerComponent, { NodeIndex: 0 }],
    [SimpleRouteFollowerSettingsComponent, { MovementSpeed: 4, AchieveDistance: 0.1 }],
    [SimpleRouteElement, [{ Position: [10, 0, 0] }, { Position: [10, 0, 10] }]],
  ]);
  scheduler.tick(0.02);
  assert.ok(Math.abs(world.getComponent(entity, LocalTransform).Position[0] - 0.08) < 1e-6);
  assert.equal(world.getComponent(entity, SimpleRouteFollowerComponent).NodeIndex, 0);
});

test('GAIA bridge imports opt-in documents before simulation and exports presentation without ops', () => {
  const documents = new Map([['ecs-proof', {
    transform: { position: [0, 0, 0] },
    ecs: { components: {
      SimpleRouteFollowerComponent: { NodeIndex: 0 },
      SimpleRouteFollowerSettingsComponent: { MovementSpeed: 2, AchieveDistance: 0.1 },
      SimpleRouteElement: [{ Position: [5, 0, 0] }, { Position: [5, 0, 5] }],
    } },
  }]]);
  const exported = [];
  const bridge = new GaiaEcsBridge({ documents, fixedDelta: 0.02, applyTransform: (id, position) => exported.push([id, position]) });
  bridge.markAll();
  bridge.update(0.02);
  assert.deepEqual(bridge.phaseTrace, ['GaiaDocumentImportSystem', 'GaiaTransformExportSystem']);
  assert.equal(exported.at(-1)[0], 'ecs-proof');
  assert.ok(Math.abs(exported.at(-1)[1][0] - 0.04) < 1e-6);
  assert.deepEqual(documents.get('ecs-proof').transform.position, [0, 0, 0], 'bridge does not flood/mutate GAIA documents by itself');
});
