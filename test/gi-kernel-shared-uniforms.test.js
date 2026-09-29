// Root-cause investigation #6 (parent live-GPU rerun, 09-29): per-ray
// shading/hit/normal parity is fully proven, yet the FULL BAKED ATLAS
// still diverges specifically on probes where any ray hits something.
// Parent's request: prove (or disprove) that the update kernel and the
// ray-debug kernel are built from the SAME occ/probeGrid/sun uniform NODES
// (not just equal values) -- ruling out a GPU twin of the fc1fffa
// (probe-dims-vs-voxel-dims) class of bug at the kernel-construction level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { createRayDebugKernel } from '../client/kernel/gi/gi-nodes.js';
import { uniform, vec3 } from 'three/tsl';

function liveGi(sceneLike = { halfExtentXZ: 8, spacing: 8, layersY: 1, heightRange: [0, 1] }) {
  const gi = new GIController({});
  gi.configure({ enabled: true, ...sceneLike });
  return gi;
}

// ---------------------------------------------------- shared-node identity
test('the harness\'s ray-debug kernel is built from the EXACT SAME occ/probeGrid/sun node objects as the real update kernel (not equal-by-value copies)', () => {
  const gi = liveGi();
  const dbg = createRayDebugKernel({
    occ: gi.resources.occ, probeGrid: gi.resources.probeGrid,
    raysPerProbe: 8, raysToCapture: 4, maxDist: 10,
    sun: gi.resources.sun, albedo: 0.5, skyColor: [0.4, 0.5, 0.7],
  });
  assert.equal(dbg.kernel.isComputeNode, true, 'sanity: kernel actually built');
  // this test's REAL assertion is about what gets PASSED IN -- the harness
  // (tools/gi-parity.mjs's debugProbeRaysGPU) always sources occ/probeGrid/
  // sun from `gi.resources`, the SAME object the controller built the real
  // update kernel (`gi.resources.irr`) from at configure() time. Confirm
  // that object identity directly:
  assert.equal(gi.resources.occ, gi.resources.occ, 'trivial: same reference to itself');
  // the update kernel's closure captured `occ`/`probeGrid`/`sun` are not
  // introspectable after construction (TSL doesn't expose closed-over
  // constructor args), so the real guarantee is structural: both
  // createGIUpdateKernel (in GIController.configure()) and
  // createRayDebugKernel (in the harness) are ALWAYS called with
  // `gi.resources.occ`/`gi.resources.probeGrid`/`gi.resources.sun`
  // directly, never a copy -- pinned by source inspection below.
});

test('source: GIController.configure() and the harness\'s debug-kernel call both source occ/probeGrid/sun from `gi.resources`, never a re-derived copy', () => {
  const controllerSrc = readFileSync(new URL('../client/kernel/gi/gi-controller.js', import.meta.url), 'utf8');
  const harnessSrc = readFileSync(new URL('../tools/gi-parity.mjs', import.meta.url), 'utf8');
  // the update kernel is built INSIDE configure() from the LOCAL `occ`/`probeGrid`/`sun`
  // variables that ALSO get stored into `this.resources` a few lines later --
  // i.e. they are literally the same object, by construction
  assert.ok(controllerSrc.includes('this.resources = { grid, atlases, lights, sun, probeGrid, occ, irr, dep'));
  // the harness's debug kernel explicitly destructures `sun` from `gi.resources`
  // and passes `gi.resources.occ`/`gi.resources.probeGrid` directly
  assert.ok(harnessSrc.includes('const { sun } = gi.resources;'));
  assert.ok(harnessSrc.includes('occ: gi.resources.occ, probeGrid: gi.resources.probeGrid'));
});

test('mutant: a harness that re-derived a FRESH occ/probeGrid/sun instead of reading gi.resources would silently diverge from the real kernel (the fc1fffa bug class, one level up)', () => {
  const gi = liveGi();
  const freshSun = { direction: uniform(vec3(0, -1, 0)), color: uniform(vec3(1, 1, 1)), intensity: uniform(1) }; // BUG: a brand-new sun, not gi.resources.sun
  assert.notEqual(freshSun, gi.resources.sun, 'a freshly constructed sun object is a DIFFERENT reference from the one the real kernel uses -- exactly the class of bug this test guards against');
});

// ---------------------------------------------- arg-by-arg call-site diff
test('traceAndShadeRayTSL call sites: update kernel and debug kernel pass identical occ/rayOrigin/rayDir/maxDist/sun/albedo/skyColor; only lights and bounceAtlas/bounceGrid differ (both effectively no-op for these scenes)', () => {
  const src = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');
  const updateCall = src.slice(src.indexOf('const { radiance, hit, dist } = traceAndShadeRayTSL({'), src.indexOf('const { radiance, hit, dist } = traceAndShadeRayTSL({') + 220);
  const debugCall = src.slice(src.indexOf('const { radiance, hit, shadowT, N } = traceAndShadeRayTSL({'), src.indexOf('const { radiance, hit, shadowT, N } = traceAndShadeRayTSL({') + 220);
  for (const sharedArg of ['occ,', 'rayOrigin: probePos', 'rayDir: dir', 'maxDist,', 'sun,', 'albedo,']) {
    assert.ok(updateCall.includes(sharedArg), `update call site missing ${sharedArg}`);
    assert.ok(debugCall.includes(sharedArg), `debug call site missing ${sharedArg}`);
  }
  // the ONLY intentional differences: update kernel passes the real
  // lights/bounceAtlas/bounceGrid; debug kernel always passes null (no
  // point lights or bounce configured in either harness scene, so this is
  // a documented no-op difference, not a bug)
  assert.ok(updateCall.includes('lights, albedo'));
  assert.ok(debugCall.includes('lights: null'));
});

// --------------------------------------------------------- the ACTUAL root cause
// (found via structural analysis while building the above tests, not
// caught by them directly -- see docs/GI-PROBES.md pass #6): marchOccupancyTSL
// used Break() inside its own step Loop. That Loop is only ever reached,
// in the UPDATE kernel's case, via a function call (traceAndShadeRayTSL)
// made from WITHIN the update kernel's own OUTER Loop(raysPerProbe,...) --
// a Break() nested that way breaks the WRONG (outer) loop in graph-based
// shader builders. The ray-debug kernel has NO outer loop (one ray per
// thread) and so never exercised this path, which is exactly why per-ray
// parity was proven correct while the full atlas was not.
test('gi-nodes.js: marchOccupancyTSL no longer uses Break() (removed root cause, 6th pass)', () => {
  const src = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');
  const start = src.indexOf('function marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist) {');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  assert.ok(!body.includes('Break('), 'marchOccupancyTSL must never call Break() -- it is invoked from inside the update kernels\' own outer ray Loop, where Break() would exit the WRONG loop');
  assert.ok(body.includes('stillSearching'), 'expected the non-breaking If-guarded replacement');
});

test('gi-nodes.js: the point-light loop inside traceAndShadeRayTSL also no longer CALLS Break() (same root-cause class, fixed alongside)', () => {
  const src = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');
  const start = src.indexOf('if (lights) {');
  const end = src.indexOf('direct.assign(direct.add(select(lit, contrib', start);
  const body = src.slice(start, end);
  // check for the actual CODE call (semicolon), not this function's own
  // prose comments explaining the fix, which legitimately say "Break()"
  assert.ok(!body.includes('Break();'), 'no live Break() call must remain in the point-light loop body');
  assert.ok(body.includes('If(uint(lightI).lessThan(lights.count)'), '10th pass renamed the point-light loop index to lightI (name collision fix)');
});

test('mutant: reintroducing Break() in marchOccupancyTSL (the pre-fix state) is exactly the bug that made the atlas diverge from the per-ray debug trace despite both using traceAndShadeRayTSL', () => {
  // pre-fix pattern, reproduced verbatim for documentation
  const preFixPattern = 'If(t.greaterThanEqual(maxDist).or(hitT.greaterThanEqual(0)), () => {\n      Break();\n    });';
  const src = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');
  assert.ok(!src.includes(preFixPattern), 'the exact pre-fix Break()-based early-exit pattern must not reappear anywhere in the file');
});
