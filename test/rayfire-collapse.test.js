// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Spec §11 staged collapse, §16 #30-34.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeByArea, removeBySize, removeRandom, collapseStep, runCollapseSteps, CollapseType, COLLAPSE_DEFAULTS } from '../client/extensions/rayfire/collapse.js';
import { V } from './helpers/rayfire-fixtures.js';

const frag = (i, volume = 1, unyielding = false) => ({ volume, centroid: V(i, 0, 0), aabb: { min: V(i, 0, 0), max: V(i + 1, 1, 1) }, unyielding });
const mk = n => Array.from({ length: n }, (_, i) => frag(i));
const J = (i, j, area) => ({ i, j, broken: false, ...(area === undefined ? {} : { area }) });
const grid = (n, area) => { const js = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) js.push(J(i, j, area)); return js; };
const brokenSet = js => js.map((j, k) => (j.broken ? k : -1)).filter(k => k >= 0).join(',');

test('CollapseType + defaults frozen and exact', () => {
  assert.deepEqual({ ...CollapseType }, { BY_AREA: 'byArea', BY_SIZE: 'bySize', RANDOM: 'random' });
  assert.deepEqual({ ...COLLAPSE_DEFAULTS }, { type: 'byArea', start: 0, end: 75, steps: 10, duration: 15, var: 0, seed: 0 });
  assert.ok(Object.isFrozen(CollapseType) && Object.isFrozen(COLLAPSE_DEFAULTS));
});

test('#30 removeByArea: threshold between joint areas -> ONLY sub-threshold joints break; missing area defaults to 1', () => {
  const fs = mk(4), js = [J(0, 1, 0.2), J(1, 2, 0.9), J(2, 3, 1.5), J(0, 3)]; // last has no area -> 1
  assert.equal(removeByArea(js, fs, 1.0, {}), 2);
  assert.deepEqual(js.map(j => j.broken), [true, true, false, false]);
  const js2 = [J(0, 1, 0.2), J(1, 2, 0.9), J(2, 3, 1.5), J(0, 3)];
  assert.equal(removeByArea(js2, fs, 0.5, {}), 1);
  assert.deepEqual(js2.map(j => j.broken), [true, false, false, false]);
  assert.equal(removeByArea(js2, fs, 0.5, {}), 0, 'already-broken not recounted');
  assert.equal(removeByArea([J(0, 1)], fs, 1, {}), 0, 'area 1 is not < 1');
});

test('removeByArea var: jitter is seeded per pair (deterministic) and only nudges borderline joints', () => {
  const fs = mk(10), mkj = () => grid(10, 1);
  const a = mkj(), b = mkj(), c = mkj();
  removeByArea(a, fs, 1, { var: 50, seed: 3 }); removeByArea(b, fs, 1, { var: 50, seed: 3 }); removeByArea(c, fs, 1, { var: 50, seed: 4 });
  assert.equal(brokenSet(a), brokenSet(b));
  assert.notEqual(brokenSet(a), brokenSet(c));
  const n = a.filter(j => j.broken).length;
  assert.ok(n > 5 && n < a.length - 5, `jitter around the threshold should split ~half, got ${n}/${a.length}`);
  const d = mkj(); assert.equal(removeByArea(d, fs, 1, { var: 0, seed: 3 }), 0);
  const rev = mkj().reverse(); removeByArea(rev, fs, 1, { var: 50, seed: 3 });
  const key = j => `${j.i}-${j.j}`;
  assert.deepEqual(a.filter(j => j.broken).map(key).sort(), rev.filter(j => j.broken).map(key).sort(), 'iteration-order independent');
});

test('#31 protection: a joint touching an unyielding fragment is NEVER removed by any rule', () => {
  const mkf = () => { const fs = mk(4); fs[0].unyielding = true; fs[1].volume = 0.001; return fs; };
  const mkj = () => [J(0, 1, 0.001), J(1, 2, 0.001), J(2, 3, 0.001), J(0, 3, 0.001)];
  const js1 = mkj(); removeByArea(js1, mkf(), 100, {});
  assert.deepEqual(js1.map(j => j.broken), [false, true, true, false]);
  const js2 = mkj(); removeBySize(js2, mkf(), 100, {});
  assert.deepEqual(js2.map(j => j.broken), [false, true, true, false]);
  const js3 = mkj(); removeRandom(js3, mkf(), 100, { seed: 1 });
  assert.deepEqual(js3.map(j => j.broken), [false, true, true, false]);
  for (const type of Object.values(CollapseType)) {
    const js = mkj(); collapseStep(js, mkf(), 100, { type, seed: 2 });
    assert.equal(js[0].broken || js[3].broken, false, `${type} broke a protected joint`);
  }
  const all = mkj(); runCollapseSteps(all, mkf(), { start: 0, end: 100, steps: 4 });
  assert.equal(all[0].broken || all[3].broken, false);
});

test('#32 removeBySize: a too-small fragment loses ALL its joints at once; big fragments keep theirs', () => {
  const fs = mk(5); fs[2].volume = 0.1;
  const js = [J(0, 1), J(1, 2), J(2, 3), J(2, 4), J(3, 4), J(0, 4)];
  assert.equal(removeBySize(js, fs, 0.5, {}), 3);
  assert.deepEqual(js.map(j => j.broken), [false, true, true, true, false, false]);
  assert.equal(removeBySize(js, fs, 0.5, {}), 0);
  const big = [J(0, 1)]; assert.equal(removeBySize(big, mk(2), 0.5, {}), 0);
});

test('removeBySize var: per-fragment seeded jitter, deterministic', () => {
  const fs = mk(12), mkj = () => grid(12);
  const a = mkj(), b = mkj(); removeBySize(a, fs, 1, { var: 50, seed: 9 }); removeBySize(b, fs, 1, { var: 50, seed: 9 });
  assert.equal(brokenSet(a), brokenSet(b));
  const c = mkj(); removeBySize(c, fs, 1, { var: 50, seed: 10 });
  assert.notEqual(brokenSet(a), brokenSet(c));
});

test('#33 removeRandom: same seed -> identical pattern; percent 0 none, 100 all; seed-sensitive; monotone in percent; order independent', () => {
  const fs = mk(12);
  const run = (percent, seed, js = grid(12)) => { removeRandom(js, fs, percent, { seed }); return js; };
  assert.equal(brokenSet(run(40, 5)), brokenSet(run(40, 5)));
  assert.notEqual(brokenSet(run(40, 5)), brokenSet(run(40, 6)));
  assert.equal(run(0, 5).filter(j => j.broken).length, 0);
  assert.equal(run(100, 5).filter(j => j.broken).length, 66);
  const lo = new Set(brokenSet(run(30, 5)).split(',')), hi = new Set(brokenSet(run(60, 5)).split(','));
  for (const k of lo) assert.ok(hi.has(k), 'the same joints always break first for a given seed');
  const n = run(50, 5).filter(j => j.broken).length;
  assert.ok(n > 20 && n < 46, `~50% of 66, got ${n}`);
  const rev = run(50, 5, grid(12).reverse());
  const key = j => `${j.i}-${j.j}`;
  assert.deepEqual(run(50, 5).filter(j => j.broken).map(key).sort(), rev.filter(j => j.broken).map(key).sort());
  assert.equal(removeRandom(grid(12), fs, 100, { seed: 1 }), 66, 'returns count');
});

test('collapseStep lerps the rule threshold between min/max by percentage/100', () => {
  const fs = mk(4);
  const at = pct => { const js = [J(0, 1, 1), J(1, 2, 2), J(2, 3, 3)]; return { n: collapseStep(js, fs, pct, { type: CollapseType.BY_AREA, min: 0, max: 4 }), js }; };
  assert.equal(at(0).n, 0);
  assert.equal(at(25).n, 0);           // thr 1 : area 1 not < 1
  assert.equal(at(50).n, 1);           // thr 2
  assert.equal(at(75).n, 2);           // thr 3
  assert.equal(at(100).n, 3);          // thr 4
  const sz = pct => { const f = mk(4); f.forEach((x, i) => { x.volume = i + 1; }); const js = grid(4); collapseStep(js, f, pct, { type: CollapseType.BY_SIZE, min: 0, max: 5 }); return js.filter(j => j.broken).length; };
  assert.ok(sz(0) === 0 && sz(30) <= sz(60) && sz(60) <= sz(100) && sz(100) === 6);
  const rnd = pct => { const js = grid(12); collapseStep(js, mk(12), pct, { type: CollapseType.RANDOM, seed: 3 }); return js.filter(j => j.broken).length; };
  assert.equal(rnd(0), 0); assert.equal(rnd(100), 66); assert.ok(rnd(40) > 10 && rnd(40) < 45);
  const dflt = js => collapseStep(js, fs, 100, {});
  assert.equal(dflt([J(0, 1)]), 1, 'default type byArea, data-derived max => 100% removes everything');
  assert.equal(collapseStep([J(0, 1)], fs, 0, {}), 0);
  assert.doesNotThrow(() => collapseStep([J(0, 1)], fs, 50, { type: CollapseType.RANDOM, seed: 7 }), 'consumer call shape: RANDOM, seed only, records without area');
});

test('#34 runCollapseSteps steps=4 start=0 end=100 -> 5 samples ramping 0..100; last step every joint is broken; removed counts sum to total', () => {
  const fs = mk(6), js = grid(6, undefined).map((j, k) => ({ ...j, area: 1 + (k % 5) }));
  const hist = runCollapseSteps(js, fs, { start: 0, end: 100, steps: 4 });
  assert.equal(hist.length, 5);
  assert.deepEqual(hist.map(h => h.step), [0, 1, 2, 3, 4]);
  assert.deepEqual(hist.map(h => h.percentage), [0, 25, 50, 75, 100]);
  assert.ok(js.every(j => j.broken));
  assert.equal(hist.reduce((s, h) => s + h.removed, 0), js.length);
  assert.equal(hist[0].removed, 0);
  assert.ok(hist.every(h => Number.isInteger(h.removed) && h.removed >= 0));
  for (const type of [CollapseType.RANDOM, CollapseType.BY_SIZE]) {
    const j2 = grid(6); runCollapseSteps(j2, mk(6), { type, start: 0, end: 100, steps: 4, seed: 2 });
    assert.ok(j2.every(j => j.broken), `${type}: all broken at 100%`);
  }
});

test('runCollapseSteps defaults: type byArea start 0 end 75 steps 10 -> 11 samples, pure (no timers), deterministic', () => {
  const mkj = () => grid(8).map((j, k) => ({ ...j, area: 0.1 + k * 0.05 }));
  const a = mkj(), b = mkj();
  const ha = runCollapseSteps(a, mk(8), {}), hb = runCollapseSteps(b, mk(8), {});
  assert.equal(ha.length, 11);
  assert.equal(ha.at(-1).percentage, 75);
  assert.deepEqual(ha, hb);
  assert.deepEqual(runCollapseSteps([], [], {}).map(h => h.removed), new Array(11).fill(0));
});
