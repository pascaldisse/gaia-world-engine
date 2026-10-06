// GAIA-World-Engine motion extension · rig template + role resolution. No game logic.
import { v3, qt, clamp } from './math.js';

// canonical rig frame C: local X = left (up × forward), Y = up, Z = forward
export function rigFrame(rig) {
  const up = v3.norm(rig.up || [0, 1, 0]);
  const fwd = v3.norm(v3.flat(rig.forward || [0, 0, 1], up), [0, 0, 1]);
  const left = v3.cross(up, fwd);
  return { up, fwd, left, C: qt.fromBasis(left, up, fwd) };
}

// humanoidRig({bounds:{min,max}, up, forward, scale, mass, pelvis, forearms, shins, feet}) → rig in bounds' space.
// Proportions = fractions of height H (PLACEHOLDER anthropometry, not measured).
export function humanoidRig(o = {}) {
  const up = v3.norm(o.up || [0, 1, 0]);
  const fwd = v3.norm(v3.flat(o.forward || [0, 0, 1], up), [0, 0, 1]);
  const left = v3.cross(up, fwd);
  const scale = o.scale ?? 1;
  const b = o.bounds || { min: [-0.25, 0, -0.15], max: [0.25, 1.75, 0.15] };
  const ext = v3.sub(b.max, b.min);
  const H = Math.abs(v3.dot(ext, up)) * scale || 1.75;
  const W = Math.abs(v3.dot(ext, left)) * scale, D = Math.abs(v3.dot(ext, fwd)) * scale;
  const sx = clamp(W / (0.28 * H), 0.6, 1.8) || 1, sz = clamp(D / (0.16 * H), 0.6, 1.8) || 1;
  const c = v3.scale(v3.add(b.min, b.max), 0.5);
  const g0 = v3.sub(c, v3.scale(up, v3.dot(v3.sub(c, b.min), up)));      // ground point under bounds centre
  const P = (l, u, f = 0) => v3.add(g0, v3.add(v3.scale(left, l * H * sx), v3.add(v3.scale(up, u * H), v3.scale(fwd, f * H * sz))));
  const E = (hl, hu, hd) => [hl * H * sx, hu * H, hd * H * sz];
  const { C } = rigFrame({ up, forward: fwd });
  const rot = C;
  const pelvis = o.pelvis !== false, fore = o.forearms !== false, shins = o.shins !== false, feet = !!o.feet;
  const M = o.mass ?? 70;
  const bodies = [], joints = [], mass = {};
  const B = (name, parent, lu, hu, l, hl, hd, f = 0, m) => { bodies.push({ name, parent, center: P(l, (lu + hu) / 2, f), halfExtents: E(hl, (hu - lu) / 2, hd), rotation: rot, mass: m * M }); };
  const J = (name, a, bb, l, u, type, limits, strength, f = 0) => joints.push({ name, a, b: bb, anchor: P(l, u, f), type, axis: left, limits, strength });
  const root = pelvis ? 'pelvis' : 'torso';
  if (pelvis) B('pelvis', null, 0.49, 0.585, 0, 0.085, 0.06, 0, 0.14);
  B('torso', pelvis ? 'pelvis' : null, pelvis ? 0.595 : 0.49, 0.82, 0, 0.095, 0.065, 0, pelvis ? 0.30 : 0.44);
  B('head', 'torso', 0.855, 1.0, 0, 0.055, 0.06, 0.005, 0.08);
  if (pelvis) J('spine', 'pelvis', 'torso', 0, 0.59, 'spherical', { x: [-0.4, 0.9], y: [-0.5, 0.5], z: [-0.4, 0.4] }, 1.0);
  J('neck', 'torso', 'head', 0, 0.84, 'spherical', { x: [-0.6, 0.8], y: [-1.0, 1.0], z: [-0.5, 0.5] }, 0.35);
  for (const [s, sg] of [['L', 1], ['R', -1]]) {
    const armX = sg * 0.135;
    B('arm' + s, 'torso', fore ? 0.635 : 0.45, 0.81, armX, 0.03, 0.03, 0, fore ? 0.03 : 0.055);
    J('shoulder' + s, 'torso', 'arm' + s, sg * 0.125, 0.805, 'spherical', { x: [-2.8, 0.9], y: [-1.2, 1.2], z: sg > 0 ? [-0.3, 2.6] : [-2.6, 0.3] }, 0.4);
    if (fore) { B('foreArm' + s, 'arm' + s, 0.45, 0.625, armX, 0.028, 0.028, 0, 0.025); J('elbow' + s, 'arm' + s, 'foreArm' + s, armX, 0.63, 'revolute', [-2.5, 0], 0.3); }
    const legX = sg * 0.05, legLo = shins ? 0.28 : (feet ? 0.04 : 0);
    B('leg' + s, root, legLo, 0.48, legX, 0.045, shins ? 0.05 : 0.065, 0, shins ? 0.10 : 0.16);
    J('hip' + s, root, 'leg' + s, legX, 0.485, 'spherical', { x: [-1.8, 0.4], y: [-0.5, 0.5], z: sg > 0 ? [-0.3, 0.8] : [-0.8, 0.3] }, 1.0);
    if (shins) {
      B('shin' + s, 'leg' + s, feet ? 0.04 : 0, 0.27, legX, 0.04, feet ? 0.045 : 0.065, 0, 0.06);
      J('knee' + s, 'leg' + s, 'shin' + s, legX, 0.275, 'revolute', [0, 2.3], 1.0);
    }
    if (feet) {
      const par = shins ? 'shin' + s : 'leg' + s;
      B('foot' + s, par, 0, 0.035, legX, 0.04, 0.075, 0.03, 0.015);
      J('ankle' + s, par, 'foot' + s, legX, 0.037, 'revolute', [-0.6, 0.6], 0.8);
    }
  }
  // normalise masses to M
  const tot = bodies.reduce((a, x) => a + x.mass, 0);
  for (const x of bodies) x.mass *= M / tot;
  const roles = { pelvis: root, chest: 'torso', head: 'head' };
  for (const s of ['L', 'R']) {
    roles['upperArm' + s] = 'arm' + s; if (fore) roles['foreArm' + s] = 'foreArm' + s;
    roles['thigh' + s] = 'leg' + s; if (shins) roles['shin' + s] = 'shin' + s; if (feet) roles['foot' + s] = 'foot' + s;
  }
  return { bodies, joints, roles, up, forward: fwd, height: H };
}

// ---- role resolution: explicit rig.roles first, then name heuristics ----
const PARTS = [
  ['foreArm', ['forearm', 'lowerarm', 'hand', 'wrist']],
  ['upperArm', ['upperarm', 'arm', 'shoulder']],
  ['shin', ['shin', 'lowerleg', 'calf', 'knee']],
  ['foot', ['foot', 'toe', 'ankle']],
  ['thigh', ['thigh', 'upperleg', 'leg']],
];
function parseName(name) {
  const n = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/^(pelvis|hips?|root|waist)$/.test(n)) return { role: 'pelvis' };
  if (/^(torso|chest|spine\d*|body|upperbody|trunk|abdomen)$/.test(n)) return { role: 'chest' };
  if (/^(head|skull)$/.test(n)) return { role: 'head' };
  let side = null, core = n;
  const m1 = n.match(/^(left|l)(.+)$/), m2 = n.match(/^(.+?)(left|l)$/), m3 = n.match(/^(right|r)(.+)$/), m4 = n.match(/^(.+?)(right|r)$/);
  for (const [m, s, i] of [[m2, 'L', 1], [m4, 'R', 1], [m1, 'L', 2], [m3, 'R', 2]]) { if (m && !side) { const c = m[i]; if (PARTS.some(([, ks]) => ks.includes(c))) { side = s; core = c; } } }
  if (!side) return null;
  for (const [role, keys] of PARTS) if (keys.includes(core)) return { role: role + side };
  return null;
}

export function resolveRoles(rig) {
  const names = new Set(rig.bodies.map((b) => b.name));
  const roles = {};
  for (const [k, v] of Object.entries(rig.roles || {})) if (names.has(v)) roles[k] = v;
  for (const b of rig.bodies) { const p = parseName(b.name); if (p && !roles[p.role]) roles[p.role] = b.name; }
  // tolerate contract aliases (handL → foreArm/upperArm end, pelvis ↔ chest)
  for (const s of ['L', 'R']) {
    const h = rig.roles?.['hand' + s]; if (h && names.has(h) && !roles['foreArm' + s] && h !== roles['upperArm' + s]) roles['foreArm' + s] = h;
  }
  if (!roles.pelvis && roles.chest) roles.pelvis = roles.chest;
  if (!roles.chest && roles.pelvis) roles.chest = roles.pelvis;
  if (!roles.pelvis) roles.pelvis = (rig.bodies.find((b) => !b.parent) || rig.bodies[0]).name;
  if (!roles.chest) roles.chest = roles.pelvis;
  return roles;
}
