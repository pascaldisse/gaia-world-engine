// resolveBlockers: a blocker whose top is within step reach AND carries a walkable surface is a step (live bug:
// bloodborne chalice lift/ladder-top lips 0.06-0.1 m tall were invisible walls; player.js climbs 0.65 m on meshes).
import { expect, test } from 'bun:test';
import { View } from '../client/kernel/view.js';

function fake(surfaceTop) {
  const box = { blocker: true, position: [0, 0.5, 0], size: [0.5, 1, 0.5] }; // top y=1
  return {
    colliderIds: ['b'],
    store: { get: () => ({ collider: { boxes: [box] } }) },
    groups: new Map([['b', { position: { x: 0, y: 0, z: 0 }, rotation: { y: 0 } }]]),
    surfaceAt: () => surfaceTop,
  };
}
const run = (ctx, feet) => { const p = { x: -0.5, y: feet + 1.6, z: 0 }; View.prototype.resolveBlockers.call(ctx, p, 1.6); return p.x; };

test('lip within step reach with a floor on top: passable', () => {
  expect(run(fake(1.0), 0.9)).toBe(-0.5);
  expect(run(fake(1.0), 0.36)).toBe(-0.5); // 0.64 rise
});
test('no floor on top (rail over a drop): still a wall', () => {
  expect(run(fake(null), 0.9)).toBeLessThan(-0.5);
  expect(run(fake(0.2), 0.9)).toBeLessThan(-0.5); // surface far below the top = not on it
});
test('rise beyond step reach: still a wall even with a floor on top', () => {
  expect(run(fake(1.0), 0.3)).toBeLessThan(-0.5);
});
test('plain fixture `this` (only colliderIds/store/groups, no surfaceAt) keeps the old contract: blocker = wall', () => {
  // bloodborne chalice tests call View.prototype.resolveBlockers with such a fixture; 115440d threw
  // 'this.blockerIsStep is not a function' there.
  const ctx = fake(1.0); delete ctx.surfaceAt;
  expect(run(ctx, 0.9)).toBeLessThan(-0.5);
});
