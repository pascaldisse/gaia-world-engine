// Root-cause investigation (parent live-GPU report, 09-29): a CPU mirror of
// the update kernel's thread -> atlas-slot index math, checked against
// what the OLD kernel source actually computed. Node has no GPU, so this
// cannot reproduce the live failure directly, but it DOES prove a real,
// independently-demonstrable bug in the write-target formula whenever
// `probeOffset != 0` (round-robin dispatch, updateFraction < 1) — the
// live-failing harness runs used updateFraction:1 (offset always 0, see
// docs), so this specific bug is NOT the live failure's cause, but it is a
// real latent correctness bug found while mirroring the math, fixed here
// regardless (see gi-nodes.js's `atlasIndex`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../client/kernel/gi/gi-nodes.js', import.meta.url), 'utf8');

// -------- pure CPU mirror of the thread -> (probeLocal, localTexel, probeIdx) decomposition
function decomposeThread(texelIndex, texelsPerProbe) {
  const probeLocal = Math.floor(texelIndex / texelsPerProbe);
  const localTexel = texelIndex % texelsPerProbe;
  return { probeLocal, localTexel };
}

function probeIdxOf(probeOffset, probeLocal, probeCount) {
  return (probeOffset + probeLocal) % probeCount;
}

// the CORRECT atlas slot a thread must write to: the GLOBAL probe's own
// region, not the thread's LOCAL dispatch-relative slot
function correctAtlasIndex(texelIndex, texelsPerProbe, probeOffset, probeCount) {
  const { probeLocal, localTexel } = decomposeThread(texelIndex, texelsPerProbe);
  const probeIdx = probeIdxOf(probeOffset, probeLocal, probeCount);
  return probeIdx * texelsPerProbe + localTexel;
}

test('at probeOffset=0 (the config both live-tested scenes actually use, updateFraction:1), the old texelIndex-as-write-target formula happens to be correct', () => {
  const texelsPerProbe = 16;
  const probeCount = 25;
  for (let texelIndex = 0; texelIndex < probeCount * texelsPerProbe; texelIndex += 7) {
    const oldFormula = texelIndex; // what the pre-fix kernel wrote to
    const correct = correctAtlasIndex(texelIndex, texelsPerProbe, 0, probeCount);
    assert.equal(oldFormula, correct, `mismatch at texelIndex=${texelIndex}`);
  }
});

test('at a nonzero probeOffset (round-robin dispatch, updateFraction<1), the old formula writes to the WRONG atlas slot', () => {
  const texelsPerProbe = 16;
  const probeCount = 25;
  const probeOffset = 10; // e.g. the 2nd batch of a 4-batch round-robin (updateFraction=1/4, batch=6ish -> use 10 for a clean example)
  let mismatches = 0;
  for (let texelIndex = 0; texelIndex < 6 * texelsPerProbe; texelIndex++) { // a 6-probe batch
    const oldFormula = texelIndex;
    const correct = correctAtlasIndex(texelIndex, texelsPerProbe, probeOffset, probeCount);
    if (oldFormula !== correct) mismatches++;
  }
  assert.ok(mismatches > 0, 'the old formula must diverge from the correct one once offset != 0');
  // and it should diverge for EVERY thread in a nonzero-offset batch, not just some
  assert.equal(mismatches, 6 * texelsPerProbe);
});

test('correctAtlasIndex wraps the probe id around probeCount when a batch straddles the end of the grid', () => {
  const texelsPerProbe = 4;
  const probeCount = 10;
  const probeOffset = 8; // batch of 4 probes starting at 8 -> probes 8,9,0,1 (wraps)
  const idxForProbeLocal2 = correctAtlasIndex(2 * texelsPerProbe, texelsPerProbe, probeOffset, probeCount);
  // probeLocal=2 -> probeIdx = (8+2) % 10 = 0 -> atlas slot 0*4+0 = 0
  assert.equal(idxForProbeLocal2, 0);
});

test('mutant: a probeIdx computed WITHOUT the % probeCount wraparound would index past the atlas entirely for a straddling batch', () => {
  const texelsPerProbe = 4;
  const probeCount = 10;
  const probeOffset = 8;
  const probeLocal = 2;
  const noWrap = probeOffset + probeLocal; // BUG: 10, one past the last valid probe (0..9)
  const wrapped = (probeOffset + probeLocal) % probeCount; // 0
  assert.notEqual(noWrap, wrapped);
  assert.ok(noWrap >= probeCount, 'the unwrapped mutant produces an out-of-range probe id');
});

// -------- source-level confirmation the FIX landed in gi-nodes.js (both kernels)
test('gi-nodes.js: the irradiance kernel writes/reads via a computed atlasIndex, not the raw thread texelIndex', () => {
  assert.ok(SRC.includes('atlasIndex'), 'expected a named atlasIndex computation in the fixed kernel');
  // the pre-fix bug pattern, must not reappear
  assert.ok(!SRC.includes('irradiance.element(texelIndex).assign('), 'must not write using the raw thread-local texelIndex');
});

test('gi-nodes.js: the depth kernel is fixed the same way (shares the bug class, not just the irradiance kernel)', () => {
  assert.ok(!SRC.includes('depth.element(texelIndex).assign('), 'must not write using the raw thread-local texelIndex');
});

test('mutant: fixing only the irradiance kernel and leaving depth.element(texelIndex) would leave the depth atlas silently corrupted under round-robin dispatch', () => {
  const stillBuggyDepthWrite = 'depth.element(texelIndex).assign(mix(vec2(newMean, newMean2), old, alpha))';
  assert.ok(!SRC.includes(stillBuggyDepthWrite), 'confirms the real file does not still contain this exact buggy line');
});
