// GIController is the single gate deciding whether ANY GI resource gets
// created (§GI-PROBES.md Fallbacks/default). These tests prove the default
// (disabled) path allocates literally nothing, and that enabling it builds
// real three r180 node-graph resources sized from the configured grid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIController, GI_DEFAULTS } from '../client/kernel/gi/gi-controller.js';

test('GI_DEFAULTS.enabled is false', () => {
  assert.equal(GI_DEFAULTS.enabled, false);
});

test('configure() with no args (all defaults) allocates nothing', () => {
  const gi = new GIController({});
  const built = gi.configure();
  assert.equal(built, false);
  assert.equal(gi.enabled, false);
  assert.equal(gi.resources, null);
});

test('configure({enabled:false, ...anything else}) still allocates nothing', () => {
  const gi = new GIController({});
  const built = gi.configure({ enabled: false, spacing: 4, raysPerProbe: 999 });
  assert.equal(built, false);
  assert.equal(gi.resources, null);
});

test('configure({enabled:true}) builds a real probe grid + storage atlases + compute kernel', () => {
  const gi = new GIController({});
  const built = gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 16, layersY: 2, heightRange: [0, 4], raysPerProbe: 16 });
  assert.equal(built, true);
  assert.ok(gi.resources);
  assert.equal(gi.resources.atlases.probeCount, gi.resources.grid.count);
  assert.equal(gi.resources.irr.kernel.isComputeNode, true);
  assert.equal(gi.resources.dep.kernel.isComputeNode, true);
});

test('disabling after having been enabled tears the resources back down (no stale GPU handles)', () => {
  const gi = new GIController({});
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 16 });
  assert.ok(gi.resources);
  gi.configure({ enabled: false });
  assert.equal(gi.resources, null);
});

test('dispose() clears resources and enabled flag', () => {
  const gi = new GIController({});
  gi.configure({ enabled: true, spacing: 8, halfExtentXZ: 16 });
  gi.dispose();
  assert.equal(gi.enabled, false);
  assert.equal(gi.resources, null);
});

// removal-style mutation check: a controller that builds resources
// UNCONDITIONALLY (ignoring p.enabled) would still pass the "enabled:true"
// test above but must fail the default-off test
test('mutant: unconditional configure (ignores enabled) fails the default-off law', () => {
  class UnconditionalMutant extends GIController {
    configure(params = {}) {
      const p = { ...GI_DEFAULTS, ...params }; // BUG: never checks p.enabled
      this.enabled = true;
      const built = super.configure({ ...p, enabled: true });
      return built;
    }
  }
  const gi = new UnconditionalMutant({});
  gi.configure(); // caller passed nothing -> should stay off, mutant turns it on
  assert.notEqual(gi.resources, null, 'sanity: mutant really does allocate');
});
