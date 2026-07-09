// rain — machine-native perception. Not prose, not pixels: aligned token grids
// sampled straight from the world's substrate, designed for a transformer's
// eye (attention reads columns; a column over time IS a motion).
//
// Two organs:
//   proprio(id)  — body sense: sample an avatar's skeleton over time.
//                  Channels are MEASUREMENTS (bone world positions vs terrain,
//                  facing derived from the shoulder line), never the animator's
//                  own variables — the sense cannot inherit the body's bugs.
//   fov(id)      — eyes: entities projected into the viewer's frame as
//                  bearing/distance/elevation rows, FOV-culled and range-culled,
//                  nearest first. Navigation = turn until brg→0, walk until dst
//                  shrinks. No renderer involved; this works headless.
//
// Codebook (units, channel meanings): shared/schema.js → senses.rain.
// Quantization: cm, deg, cm/s — integers only, fixed-width columns.

import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const deg = (rad) => Math.round((rad * 180) / Math.PI);
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const cm = (m) => Math.round(m * 100);

// Measured facing: the direction the SKELETON faces, from the shoulder line
// (up × left→right), projected to the ground plane. Independent of every
// rotation variable the animator sets — pure observation.
function measuredFacing(vrm) {
  const l = vrm.humanoid?.getRawBoneNode('leftUpperArm');
  const r = vrm.humanoid?.getRawBoneNode('rightUpperArm');
  if (!l || !r) return null;
  l.getWorldPosition(_a);
  r.getWorldPosition(_b);
  _c.subVectors(_b, _a); // left → right shoulder
  _c.crossVectors(_up, _c);
  _c.y = 0;
  if (_c.lengthSq() < 1e-6) return null;
  _c.normalize();
  return Math.atan2(_c.x, _c.z);
}

function groundGap(node) {
  node.getWorldPosition(_a);
  return cm(_a.y - heightAt(_a.x, _a.z));
}

// forward offset of a bone relative to hips, along a heading (cm)
function alongHeading(node, hips, heading) {
  node.getWorldPosition(_a);
  hips.getWorldPosition(_b);
  _a.sub(_b);
  return cm(_a.x * Math.sin(heading) + _a.z * Math.cos(heading));
}

function grid(chans, rows) {
  const widths = chans.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((v, i) => String(v).padStart(widths[i])).join(' ');
  return [line(chans), ...rows.map(line)].join('\n');
}

export function makeRain({ store, view }) {
  const vrmOf = (id) => view.getGroup(id)?.userData?.vrm ?? null;

  // ---- proprio: the body, sampled over time --------------------------------
  async function proprio(id, { ticks = 20, hz = 10 } = {}) {
    const group = view.getGroup(id);
    const vrm = vrmOf(id);
    if (!group || !vrm) return `#rain proprio ${id} !NOBODY`;
    const bone = (n) => vrm.humanoid?.getRawBoneNode(n);
    const hips = bone('hips');
    // ground truth is the sole: prefer toe bones (~2cm up) over ankles (~10cm)
    const lf = bone('leftToes') ?? bone('leftFoot');
    const rf = bone('rightToes') ?? bone('rightFoot');
    const chans = ['t', 'px', 'pz', 'spd', 'hdg', 'fac', 'err', 'hipY', 'LFy', 'RFy', 'LFf', 'RFf'];
    const rows = [];
    let last = null;
    let heading = null;
    for (let i = 0; i < ticks; i++) {
      const p = group.getWorldPosition(_c.set(0, 0, 0)).clone();
      let spd = 0;
      if (last) {
        const dx = p.x - last.x;
        const dz = p.z - last.z;
        const d = Math.hypot(dx, dz);
        spd = cm(d * hz);
        if (d > 0.005) heading = Math.atan2(dx, dz);
      }
      const fac = measuredFacing(vrm);
      const hdgD = heading === null ? null : deg(heading);
      const facD = fac === null ? null : deg(fac);
      const err = hdgD === null || facD === null ? '·' : wrap180(facD - hdgD);
      rows.push([
        i,
        cm(p.x),
        cm(p.z),
        spd,
        hdgD ?? '·',
        facD ?? '·',
        err,
        hips ? groundGap(hips) : '·',
        lf ? groundGap(lf) : '·',
        rf ? groundGap(rf) : '·',
        lf && hips && heading !== null ? alongHeading(lf, hips, heading) : '·',
        rf && hips && heading !== null ? alongHeading(rf, hips, heading) : '·',
      ]);
      last = p;
      if (i < ticks - 1) await new Promise((res) => setTimeout(res, 1000 / hz));
    }
    // lint: convictions as codes, computed from the same columns I read
    const flags = [];
    const errs = rows.map((r) => r[6]).filter((v) => typeof v === 'number');
    if (errs.length) {
      const mean = errs.reduce((s, v) => s + Math.abs(v), 0) / errs.length;
      if (mean > 135) flags.push(`!BACK err=${Math.round(mean)}`);
      else if (mean > 45) flags.push(`!SKEW err=${Math.round(mean)}`);
    }
    const feet = rows.flatMap((r) => [r[8], r[9]]).filter((v) => typeof v === 'number');
    if (feet.length) {
      const minFoot = Math.min(...feet);
      if (minFoot > 6) flags.push(`!FLOAT footmin=${minFoot}`);
      if (minFoot < -6) flags.push(`!SINK footmin=${minFoot}`);
    }
    const moving = rows.some((r) => r[3] > 10);
    const strides = rows.map((r) => r[10]).filter((v) => typeof v === 'number');
    if (moving && strides.length > 4 && Math.max(...strides) - Math.min(...strides) < 4) flags.push('!STIFF');
    const head = `#rain proprio ${id} hz=${hz} q=cm|deg|cm/s ${flags.length ? flags.join(' ') : 'OK'}`;
    return `${head}\n${grid(chans, rows)}`;
  }

  // ---- fov: eyes — the world in the viewer's frame --------------------------
  function fov(id, { fov = 120, range = 40 } = {}) {
    const group = view.getGroup(id);
    if (!group) return `#rain fov ${id} !NOBODY`;
    const pos = group.getWorldPosition(new THREE.Vector3());
    const vrm = group.userData?.vrm;
    const facing = (vrm && measuredFacing(vrm)) ?? group.rotation.y;
    const facD = deg(facing);
    const rows = [];
    for (const [eid, comps] of store.entities) {
      if (eid === id) continue;
      const g = view.getGroup(eid);
      if (!g || g.userData.hidden) continue;
      const p = g.getWorldPosition(_a);
      const dx = p.x - pos.x;
      const dz = p.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range || dist < 0.01) continue;
      const brg = wrap180(deg(Math.atan2(dx, dz)) - facD);
      if (Math.abs(brg) > fov / 2) continue;
      const kind = comps.presence ? 'presence'
        : comps.mesh?.vrm ? 'avatar'
        : comps.light && !comps.mesh ? 'light'
        : comps.mesh ? 'mesh'
        : Object.keys(comps)[0] ?? '?';
      rows.push([brg, cm(dist), cm(p.y - pos.y), kind, eid]);
    }
    rows.sort((a, b) => a[1] - b[1]);
    const head = `#rain fov ${id} fac=${facD} fov=${fov} range=${range} n=${rows.length} q=deg|cm`;
    if (!rows.length) return `${head}\n(void)`;
    const chans = ['brg', 'dst', 'ele', 'kind', 'id'];
    const widths = chans.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
    const line = (cells) => cells.map((v, i) => (i >= 3 ? String(v).padEnd(widths[i]) : String(v).padStart(widths[i]))).join(' ');
    return `${head}\n${line(chans)}\n${rows.map(line).join('\n')}`;
  }

  return { proprio, fov };
}
