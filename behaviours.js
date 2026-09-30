// gaia-motion/web · behaviour controllers (Euphoria-style: procedural, every physics substep, NOT ML).
// Every gain/rate/time = param with default. Lengths marked [H] scale with rig height/1.75.
import { v3, qt, clamp, smooth01 } from './math.js';

export const DEFAULTS = {
  // effectors: Rapier ForceBased joint motors; k = stiffness·G_j (G_j = gravity load of joint j, N·m) → rig-size independent
  stiffness: 16, damping: 1.0, torqueRatio: 3, limpDamping: 0.08, limpForce: 0.05,
  roleStrength: { spine: 1.0, neck: 1.0, shoulder: 0.8, elbow: 0.8, hip: 1.0, knee: 1.0, ankle: 1.0, other: 1.0 },
  // support (virtual CoP torque on pelvis, capped by support polygon; see README 'support')
  support: 1.0, supportK: 60, supportD: 14, footHalfLength: 0.08, // [H]
  // balance / stepping
  fallTilt: 0.6, fallHeightFrac: 0.65, leanGain: 1.2, armsOutGain: 0.6,
  stepThreshold: 0.02, stepWidth: 0.09, stepGain: 1.15, maxStep: 0.5, stepMs: 260, stepHeight: 0.1, stepCooldownMs: 90, stanceHold: 1.0, swingStiffness: 1.5, shuffleMs: 400, standKnee: 0.05, fallConfirmMs: 100, // lengths [H]
  // fall reactions
  reactionDelayMs: 80, reactionJitterMs: 40, armBlendMs: 140,
  catchReach: 0.75, catchElbow: 0.25, catchStrength: 0.8,
  protectSpeed: 3.2, protectElbow: 2.3, protectStrength: 0.9, protectNeck: 0.5, protectSpine: 0.35,
  fallLegStrength: 0.35, fallKnee: 0.5, fallHip: 0.35, headUp: 0.6,
  downHeightFrac: 0.4, settleSpeed: 0.4, settleMs: 350, downStrength: 0.1, downDecayMs: 900,
  // death / bodyWrithe
  deathStrength: 0.8, decayMs: 1600, decayPow: 1.5, writheMs: 800, writheAmp: 0.35, writheHz: 3.0,
  buckleKnee: 1.2, buckleHip: 0.7, buckleSpine: 0.4, crumpleMs: 350, crumpleSupport: 0.6,
  // shot reaction
  flinchMs: 260, flinchSpine: 0.45, flinchReach: 1.0, lethal: false,
  // stagger
  staggerMs: 1500, staggerSupport: 0.8, staggerStepScale: 0.8,
};

const D = (desc, extra = {}) => ({ description: desc, params: extra });
export const BEHAVIOURS = {
  balance: D('stand: CoP-capped support torque + hip lean against capture-point error + reactive stepping; falls → catchFall/protectHead → down'),
  stagger: D('balance with weaker support + eager stepping for staggerMs, then balance', { staggerMs: 1500 }),
  catchFall: D('falling now: no support, legs soft, arms reach toward ground along fall direction, head up'),
  protectHead: D('falling now: forearms fold over head, chin tucked, spine curled'),
  death: D('bodyWrithe → motors decay to limp over decayMs; knees buckle, arms still catch while strength lasts', { decayMs: 1600 }),
  bodyWrithe: D('alias of death'),
  shot: D('local impulse at hit body + flinch (hunch, hand to wound) for flinchMs → stagger (or death if lethal)', { lethal: false }),
  limp: D('pure passive: joint limits + limpDamping only'),
};

const SIG = { balance: 'stand', stagger: 'stand', shot: 'stand', catchFall: 'fall', protectHead: 'fall', death: 'dying', bodyWrithe: 'dying', limp: 'limp' };
export const startPhase = (name) => SIG[name] || 'stand';

// ---- the per-substep brain. h = handle internals (see motion.js), s = sensors ----
export function think(h, s, dt) {
  const p = h.params, now = h.t;
  const Hs = h.height / 1.75;
  h.support = 0;
  h.pose.reset(1);
  const behaviour = h.behaviour;

  // ---------- phase transitions ----------
  if (h.phase === 'stand' && (s.tilt > p.fallTilt || s.comHeight < p.fallHeightFrac * h.standComHeight)) { h.falling += dt; if (h.falling * 1000 >= p.fallConfirmMs) h.enter('fall'); } else h.falling = 0;
  if ((h.phase === 'fall') && s.comHeight < p.downHeightFrac * h.standComHeight && s.comSpeed < p.settleSpeed) {
    h.settle += dt; if (h.settle * 1000 > p.settleMs) h.enter('down');
  } else h.settle = 0;
  if (behaviour === 'stagger' && h.phase === 'stand' && h.bt * 1000 > p.staggerMs) { h.behaviour = 'balance'; }
  if (behaviour === 'shot' && h.bt * 1000 > p.flinchMs) { if (p.lethal) { h.behaviour = 'death'; h.enter('dying'); } else h.behaviour = 'stagger'; h.bt = 0; }

  const pt = h.pt; // time in phase
  switch (h.phase) {
    case 'limp': case 'dead': h.strength = 0; return;
    case 'stand': return stand(h, s, dt, p, Hs);
    case 'fall': return fall(h, s, dt, p, 1);
    case 'down': {
      const a = smooth01(pt * 1000 / p.downDecayMs);
      h.strength = h.downFrom + (p.downStrength - h.downFrom) * a;
      fall(h, s, dt, p, 1 - a);
      return;
    }
    case 'dying': {
      const k = Math.max(0, 1 - pt * 1000 / p.decayMs);
      h.strength = p.deathStrength * Math.pow(k, p.decayPow);
      if (h.strength <= 1e-3) { h.enter('dead'); h.strength = 0; return; }
      // crumple: support fades so knees buckle under an upright trunk before it topples
      const cr = Math.max(0, 1 - pt * 1000 / p.crumpleMs);
      if (cr > 0) supportTorque(h, s, p, p.crumpleSupport * cr, Hs);
      buckle(h, p, 1);
      armReaction(h, s, p, 1, dt);
      writhe(h, p, pt);
      return;
    }
  }
}

function stand(h, s, dt, p, Hs) {
  const P = h.pose, stagger = h.behaviour === 'stagger' || h.behaviour === 'shot';
  const supScale = stagger ? p.staggerSupport : 1;
  const thr = p.stepThreshold * Hs * (stagger ? p.staggerStepScale : 1);
  h.strength = 1;
  const err = s.cpErr, e = v3.len(err), eDir = v3.norm(err, h.fwdW);
  // stepping trigger = capture point outside the support polygon (feet segment inflated by footHalfLength)
  const st = h.step;
  if (st && h.t - st.t0 > p.stepMs / 1000) h.step = null;
  const out = s.feet.length === 2 ? segDist(s.cp, s.feet[0], s.feet[1], h.up) - p.footHalfLength * Hs : 0;
  h.cpOut = out;
  if (!h.step && out > thr && h.t - h.lastStepEnd > p.stepCooldownMs / 1000 && s.feet.length === 2) {
    const sideDir = [h.leftW, v3.scale(h.leftW, -1)];
    let pick = -1;
    for (let i = 0; i < 2; i++) if (v3.dot(sideDir[i], eDir) > 0.5) pick = i;
    if (pick >= 0 && h.lastSwing === pick && h.t - h.lastStepEnd < p.shuffleMs / 1000) pick = 1 - pick; // lateral shuffle: follow with the other leg
    if (pick < 0) pick = v3.dot(v3.sub(s.feet[0], s.cp), eDir) < v3.dot(v3.sub(s.feet[1], s.cp), eDir) ? 0 : 1; // trailing foot steps
    h.step = { side: pick ? 'R' : 'L', i: pick, t0: h.t, from: s.feet[pick], to: s.feet[pick] };
    h.lastStepEnd = h.t + p.stepMs / 1000; h.steps++; h.lastSwing = pick;
  }
  // swing target re-aimed every substep at the live capture point (+ overshoot), half hip-width lateral offset
  if (h.step) {
    const sd = h.step.i ? v3.scale(h.leftW, -1) : h.leftW;
    let to = v3.add(v3.add(s.cp, v3.scale(v3.sub(s.cp, s.comGround), p.stepGain - 1)), v3.scale(sd, p.stepWidth * Hs));
    const d = v3.sub(to, h.step.from); const L = v3.len(d), mx = p.maxStep * h.height;
    if (L > mx) to = v3.add(h.step.from, v3.scale(d, mx / L));
    h.step.to = to;
  }
  // support (CoP torque, capped by polygon; swing foot excluded)
  supportTorque(h, s, p, p.support * supScale, Hs);
  // hip strategy: lean chest against the error
  const upDes = v3.norm(v3.sub(h.up, v3.scale(err, p.leanGain)));
  P.orient('chest', upDes, 1);
  P.orient('head', h.up, 0.8);
  // arms out for balance, proportional to error
  const ao = clamp(e / thr, 0, 1) * p.armsOutGain;
  P.arm('L', null, 0, 1, ao); P.arm('R', null, 0, 1, ao);
  for (let i = 0; i < s.feet.length; i++) if (!h.step || h.step.i !== i) P.stanceHip(i ? 'R' : 'L', p.stanceHold, p.standKnee);
  if (h.step) {
    const ph = clamp((h.t - h.step.t0) / (p.stepMs / 1000), 0, 1);
    const tgt = v3.add(v3.lerp(h.step.from, h.step.to, smooth01(ph)), v3.scale(h.up, p.stepHeight * Hs * Math.pow(Math.sin(Math.PI * ph), 0.5)));
    P.leg(h.step.side, tgt, 1);
    P.scaleLeg(h.step.side, p.swingStiffness);
  }
}

function fall(h, s, dt, p, w) {
  const P = h.pose;
  if (h.phase === 'fall') h.strength = 1;
  // legs soften + flex (no support torque)
  for (const side of ['L', 'R']) { P.scaleLeg(side, p.fallLegStrength); P.flexLeg(side, p.fallHip, p.fallKnee); }
  armReaction(h, s, p, w, dt);
}

// crumple for death: knees + hips + spine flex
function buckle(h, p, w) {
  for (const side of ['L', 'R']) h.pose.flexLeg(side, p.buckleHip * w, p.buckleKnee * w);
  h.pose.flexSpine(p.buckleSpine * w);
}

// Euphoria-style reflex choice: catch the fall with the arms, or protect the head on high-energy falls
function armReaction(h, s, p, w, dt) {
  const P = h.pose;
  const since = h.pt * 1000 - (p.reactionDelayMs + h.jitter * p.reactionJitterMs);
  if (since < 0) return;
  const ramp = smooth01(since / p.armBlendMs) * w;
  let mode = h.behaviour === 'protectHead' ? 'protect' : h.behaviour === 'catchFall' ? 'catch' : null;
  if (!mode) { if (!h.reflex) h.reflex = s.comSpeed > p.protectSpeed ? 'protect' : 'catch'; mode = h.reflex; }
  h.lastReflex = mode;
  if (mode === 'catch') {
    const f = s.fallDir;
    const dir = v3.norm(v3.sub(v3.scale(f, Math.cos(p.catchReach)), v3.scale(h.up, Math.sin(p.catchReach))));
    P.arm('L', dir, p.catchElbow, ramp * p.catchStrength / 0.8, 0);
    P.arm('R', dir, p.catchElbow, ramp * p.catchStrength / 0.8, 0);
    P.orient('head', h.up, p.headUp * ramp);
  } else {
    const qc = s.q[h.idx.chest];
    for (const [side, sg] of [['L', 1], ['R', -1]]) {
      const dir = v3.norm(qt.rot(qc, [sg * 0.35, 0.75, 0.55]));
      P.arm(side, dir, p.protectElbow, ramp * p.protectStrength / 0.8, 0);
    }
    P.flexNeck(p.protectNeck * ramp);
    P.flexSpine(p.protectSpine * ramp);
  }
}

function writhe(h, p, t) {
  const a = p.writheAmp * Math.max(0, 1 - t * 1000 / p.writheMs);
  if (a <= 0) return;
  const w = 2 * Math.PI * p.writheHz;
  h.pose.noise((j, ax) => a * Math.sin(w * t * (0.7 + 0.6 * h.phases[j * 3 + ax]) + 6.283 * h.phases[j * 3 + ax]));
}

// Virtual centre-of-pressure torque on the root: what an ankle/foot could deliver, capped by
// m·g·(distance from COM ground point to the planted support edge along the needed direction).
// COM outside the feet → cap 0 → must step or fall. HEURISTIC (no reaction on the ground body).
export function supportTorque(h, s, p, scale, Hs) {
  if (scale <= 0 || !s.feet.length) return;
  const r = h.idx.pelvis;
  const upR = s.rootUp; const axis = v3.cross(upR, h.up); const sn = v3.len(axis);
  const ang = Math.atan2(sn, v3.dot(upR, h.up));
  const I = h.totalMass * s.comHeight * s.comHeight;
  const w = s.w[r];
  let tau = v3.sub(v3.scale(sn > 1e-9 ? v3.scale(axis, 1 / sn) : [0, 0, 0], p.supportK * ang * I), v3.scale(w, p.supportD * I));
  // needed CoP direction = where COM is heading relative to support (capture point)
  const need = v3.norm(s.cpErr, [0, 0, 0]);
  let reach = 0;
  const half = p.footHalfLength * Hs;
  for (let i = 0; i < s.feet.length; i++) {
    if (h.step && h.step.side === (i ? 'R' : 'L')) continue;
    reach = Math.max(reach, v3.dot(v3.sub(s.feet[i], s.comGround), need) + half);
  }
  const cap = scale * h.totalMass * h.g * Math.max(0, reach);
  const m = v3.len(tau); if (m > cap) tau = v3.scale(tau, cap / m);
  h.support = v3.len(tau);
  h.applyTorque(r, tau);
}

// horizontal distance from p to segment ab
function segDist(p, a, b, up) {
  const ab = v3.flat(v3.sub(b, a), up), ap = v3.flat(v3.sub(p, a), up);
  const L2 = v3.dot(ab, ab); const t = L2 > 1e-12 ? clamp(v3.dot(ap, ab) / L2, 0, 1) : 0;
  return v3.len(v3.sub(ap, v3.scale(ab, t)));
}
