// Root-cause investigation #9 (parent live-GPU rerun, 09-29): FIRST
// DIVERGENCE FOUND via the pass-#8 instrumented kernel (now that it
// actually runs): march `dist` is CONSTANT per probe across EVERY ray,
// established by ray 0 and never changing regardless of `dir`. dir+weight
// match the CPU trace exactly; only the march RESULT is wrong. The
// ray-debug kernel (one ray per GPU thread, no outer loop) never showed
// this because "once per shader invocation" initialization was already
// correct there by construction.
//
// Root cause: marchOccupancyTSL/traceAndShadeRayTSL are PLAIN JS functions
// (not TSL's own Fn()) called once per ray from WITHIN the update kernels'
// outer Loop(raysPerProbe,...). Their `.toVar()` locals (t, hitT in
// marchOccupancyTSL; shadowTOut, direct in traceAndShadeRayTSL) apparently
// do not get their DECLARATION-TIME initial value reliably re-applied each
// time the outer loop reaches that code -- so after ray 0 sets a value,
// every later ray inherits it unchanged. Fix: explicit `.assign()` resets
// right after each `.toVar()`, which (being mutation nodes, not
// declarations) get placed at the actual control-flow point reached once
// per ray, forcing a real reset regardless of where the declaration itself
// ended up.
//
// This file cannot execute WGSL/observe the actual hoisting bug (no GPU
// device in node --test, and TSL Fn bodies do not expand into a walkable
// graph without a builder, established in earlier passes) -- it pins the
// FIX at the source level: every `.toVar()` local that is (a) declared
// inside a plain-JS helper function and (b) that helper is called from
// within an outer Loop, must be followed by an explicit `.assign()` reset
// using the SAME initial value, before any conditional logic that might
// read or mutate it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');

function bodyOf(fnSignature) {
  const start = SRC.indexOf(fnSignature);
  assert.ok(start !== -1, `could not find "${fnSignature}" in gi-nodes.js`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end);
}

// -------------------------------------------------- marchOccupancyTSL (t, hitT)
test('marchOccupancyTSL: t.assign(0) and hitT.assign(-1) appear IMMEDIATELY after their .toVar() declarations, before the step Loop', () => {
  const body = bodyOf('function marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist) {');
  const declIdx = body.indexOf('const hitT = float(-1).toVar();');
  const resetIdx = body.indexOf('t.assign(0);');
  const resetIdx2 = body.indexOf('hitT.assign(-1);');
  const loopIdx = body.indexOf("Loop({ start: 0, end: MAX_MARCH_STEPS, type: 'int', name: 'stepI' }");
  assert.ok(declIdx !== -1 && resetIdx !== -1 && resetIdx2 !== -1 && loopIdx !== -1);
  assert.ok(resetIdx > declIdx, 't.assign(0) must come after the .toVar() declarations');
  assert.ok(resetIdx2 > declIdx, 'hitT.assign(-1) must come after the .toVar() declarations');
  assert.ok(resetIdx < loopIdx && resetIdx2 < loopIdx, 'both resets must happen BEFORE the step Loop starts (once per march call, i.e. once per ray)');
});

test('mutant: relying on .toVar()\'s own initial value alone (no explicit .assign() reset) is exactly the pre-fix state that produced a constant dist across every ray', () => {
  const preFixMarch = `function marchOccupancyTSL(occ, rayOrigin, rayDir, maxDist) {
  const { occupancy, dims, voxelOrigin, cellSize } = occ;
  const step = float(cellSize * 0.5);
  const t = float(0).toVar();
  const hitT = float(-1).toVar();
  Loop(MAX_MARCH_STEPS, () => {`;
  assert.ok(!SRC.includes(preFixMarch), 'the exact pre-fix (no explicit reset, default-named loop) source pattern must not reappear');
  assert.ok(!SRC.includes("Loop(MAX_MARCH_STEPS, () =>"), '10th pass: the march loop must never use the default (unnamed, collision-prone) Loop(count, cb) form again');
});

// -------------------------------------------------- traceAndShadeRayTSL (shadowTOut, direct)
test('traceAndShadeRayTSL: shadowTOut.assign(-2) and direct.assign(vec3(0,0,0)) appear right after their .toVar() declarations, before any conditional shading logic', () => {
  const body = bodyOf('function traceAndShadeRayTSL({ occ, rayOrigin, rayDir, maxDist, sun, lights, albedo, skyColor, bounceAtlas, bounceGrid }) {');
  const shadowDeclIdx = body.indexOf('const shadowTOut = float(-2).toVar();');
  const shadowResetIdx = body.indexOf('shadowTOut.assign(-2);');
  const directDeclIdx = body.indexOf('const direct = vec3(0, 0, 0).toVar();');
  const directResetIdx = body.indexOf('direct.assign(vec3(0, 0, 0));');
  const sunIfIdx = body.indexOf('if (sun) {');
  assert.ok(shadowDeclIdx !== -1 && shadowResetIdx !== -1 && directDeclIdx !== -1 && directResetIdx !== -1 && sunIfIdx !== -1);
  assert.ok(shadowResetIdx > shadowDeclIdx && shadowResetIdx < sunIfIdx, 'shadowTOut reset must be between its declaration and the first conditional that might use it');
  assert.ok(directResetIdx > directDeclIdx && directResetIdx < sunIfIdx, 'direct reset must be between its declaration and the first conditional that mutates it');
});

test('mutant: NOT resetting `direct` would make it accumulate ACROSS rays instead of starting fresh each ray -- an ever-growing wrong sum, not just a stuck value', () => {
  // simulate: 3 rays, each SHOULD independently contribute their own sun
  // term to `direct`, but without a reset each ray's contribution stacks
  // on top of the previous ray's leftover value
  let direct = 0; // starts at 0 for ray 0, correctly
  const perRayContribution = [0.5, 0.3, 0.7];
  const buggyResults = [];
  for (const c of perRayContribution) {
    direct += c; // BUG: never reset to 0 between rays
    buggyResults.push(direct);
  }
  const correctResults = perRayContribution.map((c) => 0 + c); // each ray resets first
  assert.notDeepEqual(buggyResults, correctResults, 'the unreset accumulation diverges from the correct per-ray-fresh result after the first ray');
  assert.equal(buggyResults[2], 1.5, 'ray 2 wrongly carries rays 0+1\'s leftover contribution too');
  assert.equal(correctResults[2], 0.7, 'the correct per-ray value is just its own contribution');
});

// ----------------------------------------------------- variables that must NOT be reset
// (sanity: this fix must not accidentally break the REAL accumulators,
// which are declared OUTSIDE the ray loop specifically so they DO carry
// across rays -- resetting THOSE would be a different, opposite bug)
test('sampleEstimate (createGIUpdateKernel) and wSum/dSum/d2Sum (createGIDepthUpdateKernel) are NOT touched by this fix -- they are declared OUTSIDE the ray loop and must keep accumulating across rays', () => {
  const updateBody = bodyOf('export function createGIUpdateKernel({ atlases, occ, probeGrid, raysPerProbe, sun, lights, hysteresis, albedo = 0.5, skyColor = [0.4, 0.5, 0.7], maxDist = 64, rotation = null, bounceAtlas = null, bounceGrid = null, touched = null, skyHits = null }) {');
  assert.ok(!updateBody.includes('sampleEstimate.assign(vec3(0, 0, 0));\n'), 'sampleEstimate must never be force-reset mid-kernel -- accumulation across raysPerProbe is its entire purpose');
  const depthBody = bodyOf('export function createGIDepthUpdateKernel({ atlases, occ, probeGrid, raysPerProbe, sun, lights, hysteresis, albedo = 0.5, skyColor = [0.4, 0.5, 0.7], maxDist = 64, rotation = null }) {');
  for (const acc of ['wSum', 'dSum', 'd2Sum']) {
    assert.ok(!depthBody.includes(`${acc}.assign(float(0));`), `${acc} must never be force-reset mid-kernel -- it accumulates across raysPerProbe too`);
  }
});
