// gaia-motion/web · createMotion: Rapier active-ragdoll runtime. Engine-agnostic, no game logic.
import { v3, qt, clamp, rng } from './math.js';
import { rigFrame, resolveRoles } from './rig.js';
import { DEFAULTS, BEHAVIOURS, think, startPhase } from './behaviours.js';

const AX = [3, 4, 5]; // JointAxis.AngX/Y/Z
const MASK_SPH = 1 | 2 | 4, MASK_REV = 1 | 2 | 4 | 16 | 32;
const now = () => (globalThis.performance ? performance.now() : Date.now());

function normLimits(type, lim) {
  const R = (v, d) => (v == null ? d : typeof v === 'number' ? [-Math.abs(v), Math.abs(v)] : v);
  const big = [-Math.PI, Math.PI];
  if (!lim) return { x: big, y: type === 'revolute' ? [0, 0] : big, z: type === 'revolute' ? [0, 0] : big };
  if (Array.isArray(lim)) return { x: lim, y: [0, 0], z: [0, 0] };
  if ('twist' in lim || 'swing' in lim) { const sw = R(lim.swing, big); return { x: sw, y: R(lim.twist, big), z: sw }; }
  return { x: R(lim.x, big), y: R(lim.y, big), z: R(lim.z, big) };
}
const roleOfJoint = (n) => { const m = String(n).toLowerCase().match(/spine|neck|shoulder|elbow|hip|knee|ankle/); return m ? m[0] : 'other'; };

export function createMotion(opts = {}) {
  const R = opts.rapier; if (!R) throw new Error('gaia-motion: createMotion needs { rapier }');
  const ownsWorld = !opts.world;
  const g = opts.gravity || (opts.world ? [opts.world.gravity.x, opts.world.gravity.y, opts.world.gravity.z] : [0, -9.81, 0]);
  const world = opts.world || new R.World({ x: g[0], y: g[1], z: g[2] });
  const gMag = v3.len(g) || 9.81, up = v3.norm(v3.scale(g, -1));
  const cfg = {
    dt: opts.dt ?? 1 / 60, substeps: opts.substeps ?? 2, maxActive: opts.maxActive ?? 16, maxStepsPerCall: opts.maxStepsPerCall ?? 4,
    stepWorld: opts.stepWorld ?? true, solverIterations: opts.solverIterations ?? null, lodRadius: opts.lodRadius ?? Infinity,
    friction: opts.friction ?? 0.9, linearDamping: opts.linearDamping ?? 0.05, angularDamping: opts.angularDamping ?? 0.4,
    motorModel: opts.motorModel ?? 'force', groundRay: opts.groundRay ?? 4, sleepFreeze: opts.sleepFreeze ?? true,
    params: { ...DEFAULTS, ...(opts.params || {}) },
  };
  if (ownsWorld && cfg.solverIterations) world.numSolverIterations = cfg.solverIterations;
  const h_ = cfg.dt / cfg.substeps;
  const handles = new Set();
  let acc = 0, spawnSeq = 0, viewer = null;
  const stats = { steps: 0, lastMs: 0, sumMs: 0, maxMs: 0, ctrlMs: 0, n: 0 };

  function spawn(rig, o = {}) {
    const { C } = rigFrame(rig);
    const Ci = qt.inv(C);
    const pos0 = o.position || [0, 0, 0], q0 = o.quaternion || [0, 0, 0, 1];
    const qRB = qt.mul(q0, C);
    const params = { ...cfg.params, ...(o.params || {}) };
    const rnd = rng(o.seed ?? 1);
    const byName = new Map();
    const B = rig.bodies.map((b, i) => {
      const bindRot = b.rotation || [0, 0, 0, 1];
      const colRot = qt.mul(Ci, bindRot);
      const wp = v3.add(pos0, qt.rot(q0, b.center));
      const desc = R.RigidBodyDesc.dynamic().setTranslation(wp[0], wp[1], wp[2]).setRotation({ x: qRB[0], y: qRB[1], z: qRB[2], w: qRB[3] })
        .setLinearDamping(cfg.linearDamping).setAngularDamping(cfg.angularDamping).setCanSleep(true);
      if (o.velocity) desc.setLinvel(o.velocity[0], o.velocity[1], o.velocity[2]);
      const rb = world.createRigidBody(desc);
      const he = b.halfExtents;
      const vol = 8 * he[0] * he[1] * he[2];
      const cd = R.ColliderDesc.cuboid(he[0], he[1], he[2]).setRotation({ x: colRot[0], y: colRot[1], z: colRot[2], w: colRot[3] })
        .setFriction(cfg.friction).setRestitution(0);
      if (b.mass) cd.setMass(b.mass); else cd.setDensity(1000);
      const col = world.createCollider(cd, rb);
      byName.set(b.name, i);
      return { name: b.name, parent: b.parent ?? null, rb, col, center: b.center, he, colRot, outRot: colRot, mass: b.mass || vol * 1000, detached: false };
    });
    const own = new Set(B.map((b) => b.col.handle));
    const J = rig.joints.map((jd) => {
      const a = byName.get(jd.a), b = byName.get(jd.b);
      if (a == null || b == null) throw new Error(`gaia-motion: joint ${jd.name} refs unknown body`);
      const type = jd.type === 'revolute' ? 'revolute' : 'spherical';
      const la = qt.rot(Ci, v3.sub(jd.anchor, B[a].center)), lb = qt.rot(Ci, v3.sub(jd.anchor, B[b].center));
      const axisL = v3.norm(qt.rot(Ci, jd.axis || rigFrame(rig).left));
      const F = qt.fromTo([1, 0, 0], axisL);
      const data = R.JointData.generic({ x: la[0], y: la[1], z: la[2] }, { x: lb[0], y: lb[1], z: lb[2] }, { x: axisL[0], y: axisL[1], z: axisL[2] }, type === 'revolute' ? MASK_REV : MASK_SPH);
      const j = world.createImpulseJoint(data, B[a].rb, B[b].rb, true);
      j.setContactsEnabled(false);
      const lim = normLimits(type, jd.limits);
      const axes = type === 'revolute' ? [0] : [0, 1, 2];
      const model = cfg.motorModel === 'acceleration' ? R.MotorModel.AccelerationBased : R.MotorModel.ForceBased;
      for (const k of axes) {
        j.rawSet.jointConfigureMotorModel(j.handle, AX[k], model);
        const L = [lim.x, lim.y, lim.z][k];
        if (L[0] > -Math.PI || L[1] < Math.PI) j.rawSet.jointSetLimits(j.handle, AX[k], L[0], L[1]);
      }
      return { name: jd.name, a, b, j, type, axes, F, Fi: qt.inv(F), la, lb, axisL, lim, strength: jd.strength ?? 1, role: roleOfJoint(jd.name), broken: false, flex: 1 };
    });
    const jointOf = new Array(B.length).fill(-1);
    J.forEach((j, i) => { jointOf[j.b] = i; });
    // bones: rb-local direction + end point (for IK / feet)
    for (let i = 0; i < B.length; i++) {
      const pj = jointOf[i];
      const start = pj >= 0 ? J[pj].lb : [0, 0, 0];
      const cj = J.find((j) => j.a === i && (!rig.bodies[j.b] || true) && B[j.b].parent === B[i].name) || J.find((j) => j.a === i);
      // exit point of the ray centre→dir on the box surface (collider frame), in rb-local
      const exitPt = (dir) => { const dc = qt.rot(qt.inv(B[i].colRot), dir); let t = Infinity; for (let k = 0; k < 3; k++) if (Math.abs(dc[k]) > 1e-9) t = Math.min(t, B[i].he[k] / Math.abs(dc[k])); return v3.scale(dir, t); };
      const outDir = pj >= 0 ? v3.norm(v3.scale(start, -1), [0, -1, 0]) : [0, 1, 0];
      const end = cj && pj >= 0 ? cj.la : exitPt(outDir);
      B[i].start = start; B[i].end = end; B[i].bone = v3.norm(v3.sub(end, start), [0, -1, 0]); B[i].boneLen = v3.len(v3.sub(end, start));
      B[i].tip = cj && pj >= 0 ? exitPt(v3.norm(v3.sub(end, [0, 0, 0]), outDir)) : end;
    }
    for (const j of J) { const s = v3.dot(v3.cross(j.axisL, B[j.b].bone), [0, 0, 1]); j.flex = s < -1e-3 ? -1 : 1; }
    const roles = resolveRoles(rig);
    const idx = {}; for (const [k, v] of Object.entries(roles)) idx[k] = byName.get(v);
    // measured bind quantities
    let M = 0; const comB = [0, 0, 0];
    for (const b of B) { M += b.mass; const c = qt.rot(q0, b.center); comB[0] += c[0] * b.mass; comB[1] += c[1] * b.mass; comB[2] += c[2] * b.mass; }
    let lo = Infinity, hi = -Infinity;
    for (const b of rig.bodies) for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const cr = v3.add(b.center, qt.rot(b.rotation || [0, 0, 0, 1], [sx * b.halfExtents[0], sy * b.halfExtents[1], sz * b.halfExtents[2]]));
      const u = v3.dot(qt.rot(q0, cr), up); lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
    const height = rig.height || (hi - lo);
    const groundH0 = v3.dot(pos0, up) + lo;
    const standComHeight = v3.dot(comB, up) / M + v3.dot(pos0, up) - groundH0;
    // per-joint gravity load G (N·m) + inertia I (kg·m²) about the anchor → gains are mass/size independent
    const legBodies = new Set(['thighL', 'thighR', 'shinL', 'shinR', 'footL', 'footR'].map((r) => idx[r]).filter((x) => x != null));
    for (const j of J) {
      const anc = v3.add(B[j.b].center, qt.rot(C, j.lb));
      const sub = []; const walk = (bi) => { sub.push(bi); for (const k of J) if (k.a === bi) walk(k.b); }; walk(j.b);
      let G = 0, I = 0;
      for (const bi of sub) { const r = v3.len(v3.flat(v3.sub(B[bi].center, anc), rigFrame(rig).up)); const rr = v3.len(v3.sub(B[bi].center, anc)); G += B[bi].mass * r; I += B[bi].mass * (rr * rr + (B[bi].he[0] ** 2 + B[bi].he[1] ** 2 + B[bi].he[2] ** 2) / 3); G += B[bi].mass * rr * 0.5; }
      if (legBodies.has(j.b)) { G = Math.max(G, M * 0.25 * (rig.height || 1.75)); I = Math.max(I, M * (0.25 * (rig.height || 1.75)) ** 2); }
      j.G = G * gMag; j.I = I; j.leg = legBodies.has(j.b);
    }
    const hipJ = J.find((j) => j.b === idx.thighL) || J.find((j) => j.b === idx.thighR);
    const hipH0 = hipJ ? v3.dot(qt.rot(q0, v3.add(B[hipJ.b].center, qt.rot(C, hipJ.lb))), up) + v3.dot(pos0, up) - groundH0 : 0.5 * height;
    const nJ = J.length;
    const tx = new Float64Array(nJ * 3), ks = new Float64Array(nJ);
    const phases = new Float64Array(nJ * 3); for (let i = 0; i < phases.length; i++) phases[i] = rnd();

    const h = {
      id: ++spawnSeq, hipH0, rig, B, J, jointOf, roles, idx, params, totalMass: M, height, standComHeight, groundH: groundH0, g: gMag, up,
      behaviour: 'balance', phase: 'stand', t: 0, bt: 0, pt: 0, strength: 1, support: 0, settle: 0, falling: 0, downFrom: 1, step: null, lastStepEnd: -1, steps: 0,
      reflex: null, lastReflex: null, jitter: rnd() * 2 - 1, phases, passive: false, asleep: false, motorsStatic: false, disposed: false,
      leftW: [1, 0, 0], fwdW: [0, 0, 1], lastImpulse: 0,
      enter(ph) { if (ph === 'down') h.downFrom = h.strength; h.phase = ph; h.pt = 0; h.motorsStatic = false; },
      applyTorque(i, tau) { const s = h_; B[i].rb.applyTorqueImpulse({ x: tau[0] * s, y: tau[1] * s, z: tau[2] * s }, true); },
    };
    // ---- pose buffer API used by behaviours ----
    const jAngles = (ji, qDes, S) => {
      const j = J[ji]; const qa = S.q[j.a];
      let q = qt.mul(j.Fi, qt.mul(qt.mul(qt.inv(qa), qDes), j.F));
      if (q[3] < 0) q = q.map((x) => -x);
      return [2 * Math.asin(clamp(q[0], -1, 1)), 2 * Math.asin(clamp(q[1], -1, 1)), 2 * Math.asin(clamp(q[2], -1, 1))];
    };
    const blend = (ji, ang, w, k) => {
      if (ji < 0 || J[ji].broken || w <= 0) return;
      w = Math.min(1, w);
      for (let a = 0; a < 3; a++) tx[ji * 3 + a] += (ang[a] - tx[ji * 3 + a]) * w;
      if (k != null) ks[ji] += (k - ks[ji]) * w;
    };
    const jointOfRole = (r) => (idx[r] == null ? -1 : jointOf[idx[r]]);
    let S = null;
    const aimBody = (bi, dirW, w) => { // rotate body bi (minimal) so its bone points along dirW
      const ji = jointOf[bi]; if (ji < 0) return;
      const cur = qt.rot(S.q[bi], B[bi].bone);
      blend(ji, jAngles(ji, qt.mul(qt.fromTo(cur, dirW), S.q[bi]), S), w);
    };
    h.pose = {
      reset(k) { tx.fill(0); ks.fill(k); },
      orient(role, upDes, w) {
        const bi = idx[role]; if (bi == null || (role === 'chest' && idx.chest === idx.pelvis)) return;
        const ji = jointOf[bi]; if (ji < 0) return;
        const cur = qt.rot(S.q[bi], [0, 1, 0]);
        blend(ji, jAngles(ji, qt.mul(qt.fromTo(cur, upDes), S.q[bi]), S), w);
      },
      arm(side, dirW, elbow, w, abduct) {
        const u = idx['upperArm' + side]; if (u == null) return;
        const ju = jointOf[u];
        if (dirW) aimBody(u, dirW, w);
        else if (abduct) blend(ju, [0, 0, (side === 'L' ? 1 : -1) * abduct], w);
        const f = idx['foreArm' + side];
        if (f != null && elbow) { const jf = jointOf[f]; if (jf >= 0) blend(jf, [J[jf].flex * elbow, 0, 0], w); }
      },
      leg(side, footW, w, stance) { // 2-link IK in bind-relative terms: knee angle solves |A + R(θ)·Bv| = d, then aim leg line
        const t = idx['thigh' + side]; if (t == null) return;
        const jt = jointOf[t]; if (jt < 0 || J[jt].broken) return;
        const hip = v3.add(S.x[t], qt.rot(S.q[t], J[jt].lb));
        const toF = v3.sub(footW, hip); const dir = v3.norm(toF, v3.scale(h.up, -1));
        const d = v3.len(toF);
        const sh = idx['shin' + side]; const js = sh != null ? jointOf[sh] : -1;
        if (js >= 0 && !J[js].broken) {
          const A = v3.sub(J[js].la, J[jt].lb);
          const fo = idx['foot' + side]; const tipSh = fo != null ? v3.add(B[fo].center, v3.sub(qt.rot(C, B[fo].tip), B[sh].center)) : null;
          const Bv = v3.sub(tipSh ? qt.rot(Ci, tipSh) : B[sh].tip, J[js].lb);
          const ax = J[js].axisL, lim = J[js].lim.x;
          const len = (th) => v3.len(v3.add(A, qt.rot(qt.axisAngle(ax, th), Bv)));
          // flex direction = the limit side that shortens the leg
          const hiSide = len(lim[1]) < len(lim[0]) ? lim[1] : lim[0];
          // stance: straight-ish knee (standKnee) — IK length near full extension is singular; swing: solve θ
          let th = stance ? Math.sign(hiSide) * h.params.standKnee : 0;
          if (!stance && d < len(0)) { let lo = 0, hi = hiSide; for (let it = 0; it < 14; it++) { const m = (lo + hi) / 2; if (len(m) > d) lo = m; else hi = m; } th = (lo + hi) / 2; }
          const Lloc = v3.add(A, qt.rot(qt.axisAngle(ax, th), Bv));
          const cur = qt.rot(S.q[t], Lloc);
          blend(jt, jAngles(jt, qt.mul(qt.fromTo(v3.norm(cur), dir), S.q[t]), S), w);
          blend(js, [th, 0, 0], w);
        } else {
          const cur = qt.rot(S.q[t], v3.sub(B[t].tip, J[jt].lb));
          blend(jt, jAngles(jt, qt.mul(qt.fromTo(v3.norm(cur), dir), S.q[t]), S), w);
        }
      },
      // SIMBICON-style stance hip: the hip motor holds the PELVIS upright in world (thigh = current), reaction goes into the leg/ground
      stanceHip(side, w, knee) {
        const t = idx['thigh' + side]; if (t == null) return;
        const jt = jointOf[t]; if (jt < 0 || J[jt].broken || J[jt].a !== idx.pelvis) return;
        const qp = S.q[idx.pelvis]; const upc = qt.rot(qp, [0, 1, 0]);
        const qpd = qt.mul(qt.fromTo(upc, h.upDes || h.up), qp);
        const j = J[jt];
        let q = qt.mul(j.Fi, qt.mul(qt.mul(qt.inv(qpd), S.q[t]), j.F)); if (q[3] < 0) q = q.map((x) => -x);
        blend(jt, [2 * Math.asin(clamp(q[0], -1, 1)), 2 * Math.asin(clamp(q[1], -1, 1)), 2 * Math.asin(clamp(q[2], -1, 1))], w);
        const js = jointOfRole('shin' + side); if (js >= 0) blend(js, [-J[js].flex * knee, 0, 0], w);
      },
      scaleLeg(side, k) { for (const r of ['thigh', 'shin', 'foot']) { const bi = idx[r + side]; if (bi != null && jointOf[bi] >= 0) ks[jointOf[bi]] *= k; } },
      flexLeg(side, hip, knee) {
        const jt = jointOfRole('thigh' + side); if (jt >= 0) tx[jt * 3] += J[jt].flex * hip;
        const js = jointOfRole('shin' + side); if (js >= 0) tx[js * 3] += -J[js].flex * knee;
      },
      flexSpine(a) { if (idx.chest !== idx.pelvis) { const j = jointOfRole('chest'); if (j >= 0) tx[j * 3] += J[j].flex * a; } },
      flexNeck(a) { const j = jointOfRole('head'); if (j >= 0) tx[j * 3] += J[j].flex * a; },
      noise(fn) { for (let j = 0; j < nJ; j++) for (const a of J[j].axes) tx[j * 3 + a] += fn(j, a); },
    };
    h._setS = (s) => { S = s; };
    h._tx = tx; h._ks = ks;
    // ---- public handle ----
    const api = {
      id: h.id,
      get asleep() { return h.asleep; },
      get behaviour() { return h.behaviour; },
      get phase() { return h.phase; },
      get passive() { return h.passive; },
      transforms(out = new Map()) {
        for (const b of B) {
          const t = b.rb.translation(), r = b.rb.rotation();
          const q = qt.mul([r.x, r.y, r.z, r.w], b.outRot);
          out.set(b.name, { p: [t.x, t.y, t.z], q });
        }
        return out;
      },
      setBehaviour(name, prm = {}) { setBehaviour(h, name, prm); },
      applyImpulse(imp) { applyImpulse(h, imp); },
      breakJoint(name) {
        const j = J.find((x) => x.name === name) || J.find((x) => B[x.b].name === name);
        if (!j || j.broken) return null;
        world.removeImpulseJoint(j.j, true); j.broken = true;
        const mark = (bi) => { B[bi].detached = true; for (const k of J) if (k.a === bi && !k.broken) mark(k.b); };
        mark(j.b);
        const v = B[j.b].rb.linvel();
        h.motorsStatic = false;
        return { body: B[j.b].name, velocity: [v.x, v.y, v.z] };
      },
      state() { return { behaviour: h.behaviour, phase: h.phase, strength: h.strength, support: h.support, steps: h.steps, reflex: h.lastReflex, asleep: h.asleep, passive: h.passive, t: h.t }; },
      dispose() { if (h.disposed) return; h.disposed = true; for (const j of J) if (!j.broken) world.removeImpulseJoint(j.j, false); for (const b of B) world.removeRigidBody(b.rb); handles.delete(h); },
      _h: h,
    };
    h.api = api; h.own = own;
    setBehaviour(h, o.behaviour || 'balance', o.params || {});
    if (o.impulse) applyImpulse(h, o.impulse);
    handles.add(h);
    return api;
  }

  function setBehaviour(h, name, prm) {
    if (!BEHAVIOURS[name]) throw new Error(`gaia-motion: unknown behaviour ${name}`);
    Object.assign(h.params, prm || {});
    const ph = startPhase(name);
    // a standing behaviour requested while already down/falling keeps the physical phase
    const keep = ph === 'stand' && (h.phase === 'fall' || h.phase === 'down');
    h.behaviour = name; h.bt = 0; h.reflex = null;
    if (!keep) h.enter(ph);
    if (name === 'death' || name === 'bodyWrithe') h.behaviour = 'death';
    if (prm && prm.impulse) applyImpulse(h, prm.impulse);
    if (name === 'shot' && prm && prm.body && prm.magnitude) applyImpulse(h, prm);
    h.asleep = false; h.motorsStatic = false;
    for (const b of h.B) b.rb.wakeUp();
  }

  function applyImpulse(h, imp) {
    const dir = v3.norm(imp.dir || [1, 0, 0]), mag = imp.magnitude ?? 0;
    h.lastImpulse = mag;
    if (!imp.body || imp.body === 'all') {
      for (const b of h.B) { const s = mag * b.mass / h.totalMass; b.rb.applyImpulse({ x: dir[0] * s, y: dir[1] * s, z: dir[2] * s }, true); }
    } else {
      const i = h.B.findIndex((b) => b.name === imp.body || b.name === h.roles[imp.body]);
      const b = h.B[i < 0 ? h.idx.chest : i];
      const t = b.rb.translation(); const pt = imp.point ? { x: imp.point[0], y: imp.point[1], z: imp.point[2] } : t;
      b.rb.applyImpulseAtPoint({ x: dir[0] * mag, y: dir[1] * mag, z: dir[2] * mag }, pt, true);
      if (h.behaviour === 'shot') { h.hit = b; }
    }
    h.asleep = false; h.motorsStatic = false;
  }

  // ---- sensors ----
  function sense(h) {
    const { B, idx } = h; const n = B.length;
    const S = h.S || (h.S = { x: new Array(n), q: new Array(n), v: new Array(n), w: new Array(n) });
    const com = [0, 0, 0], cv = [0, 0, 0]; let M = 0;
    for (let i = 0; i < n; i++) {
      const rb = B[i].rb; const t = rb.translation(), r = rb.rotation(), lv = rb.linvel(), av = rb.angvel();
      S.x[i] = [t.x, t.y, t.z]; S.q[i] = [r.x, r.y, r.z, r.w]; S.v[i] = [lv.x, lv.y, lv.z]; S.w[i] = [av.x, av.y, av.z];
      if (B[i].detached) continue;
      const m = B[i].mass; M += m;
      com[0] += t.x * m; com[1] += t.y * m; com[2] += t.z * m; cv[0] += lv.x * m; cv[1] += lv.y * m; cv[2] += lv.z * m;
    }
    for (let k = 0; k < 3; k++) { com[k] /= M; cv[k] /= M; }
    const up = h.up;
    // ground under COM (ray, excluding own colliders)
    if (cfg.groundRay > 0) {
      const ray = new R.Ray({ x: com[0], y: com[1], z: com[2] }, { x: -up[0], y: -up[1], z: -up[2] });
      const hit = world.castRay(ray, cfg.groundRay, true, undefined, undefined, undefined, undefined, (c) => !h.own.has(c.handle));
      if (hit) h.groundH = v3.dot(com, up) - (hit.timeOfImpact ?? hit.toi);
    }
    const comHeight = v3.dot(com, up) - h.groundH;
    const comGround = v3.sub(com, v3.scale(up, comHeight));
    const velH = v3.flat(cv, up);
    const rootUp = qt.rot(S.q[idx.pelvis], [0, 1, 0]);
    h.leftW = v3.norm(v3.flat(qt.rot(S.q[idx.pelvis], [1, 0, 0]), up), [1, 0, 0]);
    h.fwdW = v3.cross(h.leftW, up);
    const feet = [];
    for (const s of ['L', 'R']) {
      const e = idx['foot' + s] ?? idx['shin' + s] ?? idx['thigh' + s];
      if (e == null || B[e].detached) continue;
      const tip = v3.add(S.x[e], qt.rot(S.q[e], B[e].tip));
      feet.push(v3.sub(tip, v3.scale(up, v3.dot(tip, up) - h.groundH)));
    }
    const support = feet.length ? v3.scale(feet.reduce((a, f) => v3.add(a, f), [0, 0, 0]), 1 / feet.length) : comGround;
    const w0 = Math.sqrt(h.g / Math.max(comHeight, 0.1));
    const cp = v3.add(comGround, v3.scale(velH, 1 / w0));
    const sp = v3.len(velH);
    let fallDir = sp > 0.3 ? v3.scale(velH, 1 / sp) : v3.norm(v3.flat(rootUp, up), h.fwdW);
    Object.assign(S, {
      com, comVel: cv, comHeight, comGround, comSpeed: v3.len(cv), rootUp, tilt: Math.acos(clamp(v3.dot(rootUp, up), -1, 1)),
      feet, support, cp, cpErr: v3.sub(cp, support), fallDir,
    });
    return S;
  }

  // ---- effectors: write motor targets ----
  function drive(h) {
    const { J, params: p } = h;
    const s = h.strength;
    for (let ji = 0; ji < J.length; ji++) {
      const j = J[ji]; if (j.broken) continue;
      const detached = h.B[j.a].detached;
      const rs = (p.roleStrength[j.role] ?? p.roleStrength.other) * j.strength;
      const e = detached || h.passive ? 0 : Math.max(0, h._ks[ji] * s);
      const kFull = p.stiffness * rs * j.G;
      const k = kFull * e, d = 2 * p.damping * Math.sqrt(k * 0.5 * j.I) + p.limpDamping * Math.sqrt(j.G * j.I);
      const f = p.torqueRatio * rs * j.G * Math.max(e, p.limpForce);
      for (const a of j.axes) {
        const L = a === 0 ? j.lim.x : a === 1 ? j.lim.y : j.lim.z;
        const tgt = clamp(h._tx[ji * 3 + a], L[0], L[1]);
        j.j.rawSet.jointConfigureMotorPosition(j.j.handle, AX[a], tgt, k, d);
        j.j.rawSet.jointSetMotorMaxForce(j.j.handle, AX[a], f);
      }
    }
  }

  function control(h, dt) {
    if (h.disposed) return;
    if (h.passive || h.phase === 'limp' || h.phase === 'dead') {
      if (!h.motorsStatic) { h.strength = 0; h._ks.fill(0); drive(h); h.motorsStatic = true; }
      h.asleep = h.B.every((b) => b.rb.isSleeping());
      h.t += dt; h.bt += dt; h.pt += dt;
      return;
    }
    const S = sense(h); h._setS(S);
    think(h, S, dt);
    drive(h);
    h.t += dt; h.bt += dt; h.pt += dt;
    h.asleep = false;
  }

  function lod() {
    const act = [];
    for (const h of handles) {
      const alive = !(h.phase === 'limp' || h.phase === 'dead');
      let far = false;
      if (viewer && cfg.lodRadius < Infinity) { const t = h.B[h.idx.pelvis].rb.translation(); far = Math.hypot(t.x - viewer[0], t.y - viewer[1], t.z - viewer[2]) > cfg.lodRadius; }
      if (far) { if (!h.passive) { h.passive = true; h.motorsStatic = false; } continue; }
      if (alive) act.push(h);
    }
    act.sort((a, b) => b.id - a.id); // newest keep brains
    act.forEach((h, i) => { const pas = i >= cfg.maxActive; if (pas !== h.passive) { h.passive = pas; h.motorsStatic = false; } });
  }

  function stepFixed() {
    lod();
    const c0 = now();
    for (let s = 0; s < cfg.substeps; s++) {
      for (const h of handles) control(h, h_);
      if (cfg.stepWorld) { world.timestep = h_; world.step(); }
    }
    stats.ctrlMs = now() - c0;
  }

  return {
    world, rapier: R, config: cfg,
    spawn,
    step(dtSeconds) {
      const t0 = now();
      acc += dtSeconds ?? cfg.dt; let n = 0;
      while (acc >= cfg.dt - 1e-9 && n < cfg.maxStepsPerCall) { stepFixed(); acc -= cfg.dt; n++; stats.steps++; }
      if (n >= cfg.maxStepsPerCall) acc = 0;
      const ms = now() - t0; stats.lastMs = ms; if (n) { stats.sumMs += ms; stats.n += n; stats.maxMs = Math.max(stats.maxMs, ms / n); }
      return n;
    },
    // stepWorld:false mode — run controllers only; caller steps the world at h = dt/substeps
    control(dt = h_) { for (const h of handles) control(h, dt); },
    setViewer(p) { viewer = p; },
    diagnostics() {
      let active = 0, passive = 0, asleep = 0, bodies = 0;
      for (const h of handles) { bodies += h.B.length; if (h.asleep) asleep++; else if (h.passive || h.phase === 'dead' || h.phase === 'limp') passive++; else active++; }
      return { handles: handles.size, active, passive, asleep, bodies, dt: cfg.dt, substeps: cfg.substeps, steps: stats.steps, lastStepMs: stats.lastMs, avgStepMs: stats.n ? stats.sumMs / stats.n : 0, maxStepMs: stats.maxMs };
    },
    handles() { return [...handles].map((h) => h.api); },
    dispose() { for (const h of [...handles]) h.api.dispose(); if (ownsWorld) world.free(); },
  };
}
