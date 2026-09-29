// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §11 staged collapse: three removal rules (contact area / fragment size / random probability), all seeded and
// iteration-order-independent (PRNG keyed by pair/fragment identity + seed), none ever touching a joint that has an
// unyielding endpoint. Pure step functions; the caller owns the clock.
import { rand01 } from './prng.js';

export const CollapseType = Object.freeze({ BY_AREA: 'byArea', BY_SIZE: 'bySize', RANDOM: 'random' });
export const COLLAPSE_DEFAULTS = Object.freeze({ type: CollapseType.BY_AREA, start: 0, end: 75, steps: 10, duration: 15, var: 0, seed: 0 });

const protectedJoint = (j, fragments) => !!(fragments[j.i]?.unyielding || fragments[j.j]?.unyielding);
const jitter = (value, varPct, r) => (varPct > 0 ? value * (1 + (2 * r - 1) * (varPct / 100)) : value);
const pairKey = j => [Math.min(j.i, j.j), Math.max(j.i, j.j)];

export function removeByArea(joints, fragments, minArea, { var: v = 0, seed = 0 } = {}) {
  let n = 0;
  for (const j of joints) {
    if (j.broken || protectedJoint(j, fragments)) continue;
    const [a, b] = pairKey(j);
    if (jitter(j.area ?? 1, v, rand01(seed, a, b)) < minArea) { j.broken = true; n++; }
  }
  return n;
}

export function removeBySize(joints, fragments, minSize, { var: v = 0, seed = 0 } = {}) {
  const small = new Set();
  fragments.forEach((f, i) => { if (jitter(f.volume ?? 1, v, rand01(seed, i)) < minSize) small.add(i); });
  let n = 0;
  for (const j of joints) {
    if (j.broken || protectedJoint(j, fragments)) continue;
    if (small.has(j.i) || small.has(j.j)) { j.broken = true; n++; }
  }
  return n;
}

export function removeRandom(joints, fragments, percent, { seed = 0 } = {}) {
  let n = 0;
  for (const j of joints) {
    if (j.broken || protectedJoint(j, fragments)) continue;
    const [a, b] = pairKey(j);
    if (rand01(seed, a, b) * 100 < percent) { j.broken = true; n++; }
  }
  return n;
}

const EPS_ABOVE_MAX = 1.0001; // default upper bound sits just above the data max so 100% removes everything

export function collapseStep(joints, fragments, percentage, opts = {}) {
  const type = opts.type ?? COLLAPSE_DEFAULTS.type;
  const f = Math.min(1, Math.max(0, (Number(percentage) || 0) / 100));
  const ro = { var: opts.var ?? COLLAPSE_DEFAULTS.var, seed: opts.seed ?? COLLAPSE_DEFAULTS.seed };
  const lerp = (lo, hi) => lo + (hi - lo) * f;
  if (type === CollapseType.RANDOM) return removeRandom(joints, fragments, lerp(opts.min ?? 0, opts.max ?? 100), ro);
  if (type === CollapseType.BY_SIZE) {
    const max = opts.max ?? EPS_ABOVE_MAX * fragments.reduce((m, x) => Math.max(m, x.volume ?? 1), 0);
    return removeBySize(joints, fragments, lerp(opts.min ?? 0, max), ro);
  }
  const max = opts.max ?? EPS_ABOVE_MAX * joints.reduce((m, j) => Math.max(m, j.area ?? 1), 0);
  return removeByArea(joints, fragments, lerp(opts.min ?? 0, max), ro);
}

export function runCollapseSteps(joints, fragments, opts = {}) {
  const o = { ...COLLAPSE_DEFAULTS, ...opts };
  const steps = Math.max(0, Math.floor(o.steps));
  const history = [];
  for (let k = 0; k <= steps; k++) {
    const percentage = steps === 0 ? o.end : o.start + ((o.end - o.start) * k) / steps;
    history.push({ step: k, percentage, removed: collapseStep(joints, fragments, percentage, o) });
  }
  return history;
}
