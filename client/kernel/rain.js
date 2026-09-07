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
//   motion(id)   — vehicle/body travel diagnostics: MEASURED heading (Δ world
//                  position) vs the model's VISUAL forward (scene-graph quaternion)
//                  vs the controller's own yaw/input (tagged CONTROLLER-VAR).
//                  eH≈±180 = the car drives backwards; eY≠0 = pivot offset.
//   pose(id)     — skeletal energy, binding-free: Σ|Δ bone world pos| per tick.
//                  A body translating with skel≈0 is a HELD pose.
//   colliders(id)— collider boxes (data, world-space) vs the MEASURED mesh
//                  bounds (Box3). Text geometry — not the rendered gizmo.
//
// Sources are explicit per channel: MEASURED (Δ world position, scene-graph
// transform, Box3) vs CONTROLLER-VAR (player.bodyYaw, driveState inputs,
// mixer time). Nothing here sees pixels, lighting, materials or occlusion.
//
// Codebook (units, channel meanings): shared/schema.js → senses.rain.
// Quantization: cm, deg, cm/s — integers only, fixed-width columns.

import * as THREE from 'three/webgpu';
import { heightAt } from './terrain.js';
import { planarYaw } from '../../shared/collider.js';

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
function bodyBone(body, semantic) {
  return body.vrm ? body.vrm.humanoid?.getRawBoneNode(semantic) : body.bones?.[semantic];
}
function measuredFacing(body) {
  const l = bodyBone(body, body.vrm ? 'leftUpperArm' : 'leftShoulder');
  const r = bodyBone(body, body.vrm ? 'rightUpperArm' : 'rightShoulder');
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

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
// finite-number guard: NaN/Infinity/strings → default, then clamped
const fin = (v, def, lo, hi) => {
  const n = Number(v);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : def));
};
// model forward axis: DECLARED, never guessed. '-z' | '+z' | '-x' | '+x'.
// Boomtown peds face +Z, the narrowed cars −Z — an assumed basis produces
// false !REVERSED verdicts, so unknown stays unknown ('?').
const AXES = { '-z': [0, 0, -1], '+z': [0, 0, 1], '-x': [-1, 0, 0], '+x': [1, 0, 0] };
function parseAxis(v) {
  if (Array.isArray(v) && v.length === 3 && [0, 1, 2].every(i => Object.hasOwn(v, i) && Number.isFinite(v[i]))) {
    const length = Math.hypot(...v);
    return Number.isFinite(length) && length > 0 ? v.map(n => n / length) : null;
  }
  const key = typeof v === 'string' ? v.trim().toLowerCase().replace(/^([xz])$/, '+$1') : null;
  return key && AXES[key] ? AXES[key] : null;
}
// visual forward of a scene-graph node: the DECLARED local axis through its
// world rotation, ground-projected → deg. MEASURED from the transform, not
// from any yaw variable — but only as good as the declared axis.
function visualForward(node, axis) {
  node.getWorldQuaternion(_q);
  _a.fromArray(axis).applyQuaternion(_q);
  _a.y = 0;
  if (_a.lengthSq() < 1e-6) return null;
  return deg(Math.atan2(_a.x, _a.z));
}
function meanAbs(vals) {
  const nums = vals.filter((v) => typeof v === 'number');
  return nums.length ? nums.reduce((s, v) => s + Math.abs(v), 0) / nums.length : null;
}
function collectBones(root) {
  const seen = new Set();
  root?.traverse?.((node) => {
    if (node.isBone) seen.add(node);
    if (node.isSkinnedMesh) for (const b of node.skeleton?.bones ?? []) seen.add(b);
  });
  return [...seen];
}
// ---- frame symbols: pure RGBA quantization, no vision model ----------------
// gray ramp by luminance (space = black); hue letters when saturated:
// lowercase = dim (lum < 0.45), UPPERCASE = bright. r g b y c m.
const GRAY = ' .:-=+*#';
const HUES = ['r', 'y', 'g', 'c', 'b', 'm'];
export const FRAME_LEGEND = `gray="${GRAY.slice(1)}"(space=black) hue=rgbycm(dim)/RGBYCM(bright)`;
export function frameSymbol(r, g, b) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max > 0 ? (max - min) / max : 0;
  if (max > 0.1 && sat > 0.3) {
    let h = (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
    if (h < 0) h += 360;
    const letter = HUES[Math.round(h / 60) % 6];
    return lum < 0.45 ? letter : letter.toUpperCase();
  }
  return GRAY[Math.min(GRAY.length - 1, Math.floor(lum * GRAY.length))];
}
// makeRain options:
//   player      local controller (else globalThis.gaia?.player) — CONTROLLER-VAR source
//   readPixels  async () => { width, height, rgba: Uint8Array, source, origin? } | null
//               (parent-owned GPU readback; origin 'bottom-left' (GL default) | 'top-left')
//   hooks       true = honor onTick fixture hooks (tests only; production ignores them)
export function makeRain({ store, view, player = null, readPixels = null, hooks = false, maxTicks = 60, maxRows = 64, maxCols = 120, maxCells = 2000 }) {
  const playerOf = () => player ?? globalThis.gaia?.player ?? null;
  const clampTicks = (n) => Math.floor(fin(n, 20, 1, maxTicks));
  const clampHz = (n) => { const h = Number(n); return Number.isFinite(h) && h > 0 ? Math.min(h, 1000) : 10; };
  const hookOf = (fn) => (hooks && typeof fn === 'function' ? fn : null);
  // actual elapsed time between samples — a monotonic clock, never the nominal
  // period: a hidden tab or a stall must show up as a long `ms`, not as a
  // fake speed. Fixture clocks are honored only with hooks:true.
  const clockOf = (fn) => (hooks && typeof fn === 'function' ? fn : () => performance.now());
  const stallFlag = (rows, hz, stallX) => {
    const ms = rows.map((r) => r[1]).filter((v) => typeof v === 'number');
    const worst = ms.length ? Math.max(...ms) : 0;
    return worst > (stallX * 1000) / hz ? `!STALL max=${worst}ms` : null;
  };
  // ---- motion: travel vs visual forward vs controller ------------------------
  async function motion(id, { ticks = 20, hz = 10, onTick = null, clock = null, forwardAxis = null, reverseDeg = 135, pivotDeg = 45, moveCms = 10, stallX = 3 } = {}) {
    ticks = clampTicks(ticks);
    hz = clampHz(hz);
    const hook = hookOf(onTick);
    const now = clockOf(clock);
    const pl = playerOf();
    const isSelf = id === view.ownPresence || (id === 'player' && pl);
    const group = view.getGroup(id) ?? null;
    if (!group && !(isSelf && pl)) return `#rain motion ${id} !NOBODY`;
    const ctrl = isSelf ? pl : null;
    // forward axis: caller's forwardAxis if given (invalid = !BADAXIS, never a
    // silent fallback), else the entity's declared mesh.forward, else unknown
    const declared = store.entities?.get?.(id)?.mesh?.forward;
    const callerGiven = forwardAxis !== null && forwardAxis !== undefined;
    const axis = callerGiven ? parseAxis(forwardAxis) : parseAxis(declared);
    const badAxis = callerGiven && !axis;
    const axisLabel = callerGiven ? String(forwardAxis) : declared !== undefined && declared !== null ? String(declared) : '?';
    const chans = ['t', 'ms', 'px', 'pz', 'spd', 'hdg', 'mesh', 'yaw', 'eH', 'eY', 'in', 'fwd'];
    const rows = [];
    let last = null;
    let lastT = null;
    let heading = null;
    for (let i = 0; i < ticks; i++) {
      if (hook) await hook(i);
      const tNow = now();
      const p = ctrl ? ctrl.position.clone() : group.getWorldPosition(_c.set(0, 0, 0)).clone();
      let spd = '·';
      let ms = '·';
      if (last) {
        const dx = p.x - last.x;
        const dz = p.z - last.z;
        const d = Math.hypot(dx, dz);
        const dt = (tNow - lastT) / 1000;
        ms = Math.round(tNow - lastT);
        spd = dt > 0 ? cm(d / dt) : '·';
        if (d > 0.005) heading = Math.atan2(dx, dz);
      }
      const hdgD = heading === null ? null : deg(heading);
      const meshD = group && axis ? visualForward(group, axis) : null;
      // CONTROLLER-VAR: the controller's forward is (−sin yaw, 0, −cos yaw) → same
      // deg convention as visualForward (atan2(x, z) of that vector).
      const yawD = ctrl && typeof ctrl.bodyYaw === 'number' ? deg(Math.atan2(-Math.sin(ctrl.bodyYaw), -Math.cos(ctrl.bodyYaw))) : null;
      const eH = meshD === null || hdgD === null ? '·' : wrap180(meshD - hdgD);
      const eY = meshD === null || yawD === null ? '·' : wrap180(meshD - yawD);
      const accel = ctrl?.driveState?.accelerationInput;
      const inS = typeof accel === 'number' ? (accel > 0 ? '+' : accel < 0 ? '-' : '0') : '·';
      let fwd = '·';
      if (ctrl?.velocity && typeof ctrl.bodyYaw === 'number') {
        _b.set(-Math.sin(ctrl.bodyYaw), 0, -Math.cos(ctrl.bodyYaw));
        fwd = cm(ctrl.velocity.dot(_b));
      }
      rows.push([i, ms, cm(p.x), cm(p.z), spd, hdgD ?? '·', meshD ?? (axis ? '·' : '?'), yawD ?? '·', eH, eY, inS, fwd]);
      last = p;
      lastT = tNow;
      if (i < ticks - 1) await sleep(1000 / hz);
    }
    const flags = [];
    const moving = rows.some((r) => typeof r[4] === 'number' && r[4] > moveCms);
    const mH = meanAbs(rows.map((r) => r[8]));
    const mY = meanAbs(rows.map((r) => r[9]));
    const reversing = rows.some((r) => r[10] === '-');
    const stall = stallFlag(rows, hz, stallX);
    if (stall) flags.push(stall);
    if (!moving) flags.push('!STATIC');
    if (badAxis) flags.push('!BADAXIS');
    if (!axis) flags.push('!NOFORWARD');
    if (moving && !reversing && mH !== null && mH > reverseDeg) flags.push(`!REVERSED eH=${Math.round(mH)}`);
    if (mY !== null && mY > pivotDeg) flags.push(`!PIVOT eY=${Math.round(mY)}`);
    const src = ctrl ? 'ctrl=player' : 'ctrl=none';
    const head = `#rain motion ${id} hz=${hz} ${src} axis=${axisLabel} q=cm|deg|cm/s ${flags.length ? flags.join(' ') : 'OK'}`;
    return `${head}\n${grid(chans, rows)}`;
  }
  // ---- pose: skeletal energy, no binding required ---------------------------
  async function pose(id, { ticks = 20, hz = 10, onTick = null, clock = null, heldCms = 2, moveCms = 10, stallX = 3 } = {}) {
    ticks = clampTicks(ticks);
    hz = clampHz(hz);
    const hook = hookOf(onTick);
    const now = clockOf(clock);
    const group = view.getGroup(id);
    if (!group) return `#rain pose ${id} !NOBODY`;
    const bones = collectBones(group);
    if (!bones.length) return `#rain pose ${id} !NOBONES`;
    const chans = ['t', 'ms', 'px', 'pz', 'spd', 'skel', 'maxB'];
    const rows = [];
    let last = null;
    let lastT = null;
    let lastBones = null;
    for (let i = 0; i < ticks; i++) {
      if (hook) await hook(i);
      const tNow = now();
      const p = group.getWorldPosition(_c.set(0, 0, 0)).clone();
      // bones in ROOT-LOCAL space: the body's own translation/turn is not
      // skeletal energy — a held pose on a moving root must read as 0.
      group.updateWorldMatrix(true, true);
      _m.copy(group.matrixWorld).invert();
      const cur = bones.map((b) => b.getWorldPosition(new THREE.Vector3()).applyMatrix4(_m));
      const dt = last ? (tNow - lastT) / 1000 : 0;
      const ms = last ? Math.round(tNow - lastT) : '·';
      const spd = last && dt > 0 ? cm(Math.hypot(p.x - last.x, p.z - last.z) / dt) : '·';
      let skel = '·';
      let maxB = '·';
      if (lastBones && dt > 0) {
        let best = -1;
        let sum = 0;
        cur.forEach((v, k) => {
          const d = v.distanceTo(lastBones[k]);
          sum += d;
          if (d > best) { best = d; maxB = bones[k].name || `#${k}`; }
        });
        skel = cm(sum / dt);
      }
      rows.push([i, ms, cm(p.x), cm(p.z), spd, skel, maxB]);
      last = p;
      lastT = tNow;
      lastBones = cur;
      if (i < ticks - 1) await sleep(1000 / hz);
    }
    const flags = [];
    const stall = stallFlag(rows, hz, stallX);
    if (stall) flags.push(stall);
    const skels = rows.map((r) => r[5]).filter((v) => typeof v === 'number');
    const moving = rows.some((r) => typeof r[4] === 'number' && r[4] > moveCms);
    // precedence: a moving root with a dead skeleton is the HELD pose (the
    // diagnostic that matters); FROZEN is reserved for nothing-moves-at-all.
    if (moving && skels.length && skels.every((v) => v < heldCms)) flags.push('!HELD');
    else if (!moving && skels.length && skels.every((v) => v === 0)) flags.push('!FROZEN');
    const anim = view.animatedModels?.get?.(id);
    const clip = anim ? ` clip=${anim.spec?.clip ?? '?'} mixer=${anim.mixer?.time?.toFixed?.(2) ?? '·'}` : '';
    const head = `#rain pose ${id} hz=${hz} bones=${bones.length}${clip} q=cm|cm/s ${flags.length ? flags.join(' ') : 'OK'}`;
    const widths = chans.map((c, i) => Math.max(c.length, ...rows.map((r) => String(r[i]).length)));
    const line = (cells) => cells.map((v, i) => (i === 6 ? String(v).padEnd(widths[i]) : String(v).padStart(widths[i]))).join(' ');
    return `${head}\n${line(chans)}\n${rows.map(line).join('\n')}`;
  }
  // ---- colliders: collider data vs measured mesh bounds ---------------------
  // space: 'planar' = world position + yaw-only rotation + scale (the client's
  //        contact solver basis, as declared by the parent — an APPROXIMATION of
  //        contact space, not a contact test); 'full' = full matrixWorld
  //        (geometric authoring view). Both are data geometry: nothing here
  //        proves what touches what or what renders.
  // Every box is reported as the world AABB of its 8 transformed corners —
  // exact for any rotation, never a wrong cm. Mesh bounds: Box3 of the group,
  // else the instanced-model templates the group holds, else
  // !BOUNDS_UNAVAILABLE and NO mesh-relative verdict.
  function meshBounds(group) {
    const bbox = new THREE.Box3().setFromObject(group);
    const hadGroup = !bbox.isEmpty();
    const entries = view.instancedModels?.entries;
    if (!entries) return hadGroup ? { bbox, from: 'group' } : null;
    const under = (node) => { for (let n = node; n; n = n.parent) if (n === group) return true; return false; };
    let any = false;
    for (const entry of entries) {
      if (!entry?.holder || !under(entry.holder)) continue;
      entry.holder.updateWorldMatrix(true, false);
      for (const t of entry.spec?.templates ?? []) {
        const geo = t.geometry;
        if (!geo) continue;
        if (!geo.boundingBox) geo.computeBoundingBox();
        if (!geo.boundingBox) continue;
        const m = entry.holder.matrixWorld.clone().multiply(t.matrix ?? new THREE.Matrix4());
        bbox.union(geo.boundingBox.clone().applyMatrix4(m));
        any = true;
      }
    }
    return !bbox.isEmpty() ? { bbox, from: any ? (hadGroup ? 'group+instanced' : 'instanced') : 'group' } : null;
  }
  function boxRotation(rot, space) {
    if (rot === undefined || rot === null) return { m: new THREE.Matrix4(), kind: 'none' };
    if (typeof rot === 'number' && Number.isFinite(rot) && space === 'full') return { m: new THREE.Matrix4().makeRotationY(rot), kind: 'yaw' };
    if (Array.isArray(rot) && rot.length === 3 && [0, 1, 2].every(i => Object.hasOwn(rot, i) && Number.isFinite(rot[i]))) return {
      m: space === 'planar' ? new THREE.Matrix4().makeRotationY(planarYaw(rot)) : new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])), kind: 'euler' };
    return null;
  }
  function colliders(id, { offsetCm = 50, space = 'planar' } = {}) {
    const group = view.getGroup(id);
    const comps = store.entities.get(id);
    if (!group || !comps) return `#rain colliders ${id} !NOBODY`;
    if (space !== 'planar' && space !== 'full') return `#rain colliders ${id} !BADSPACE ${space}`;
    const boxes = (comps.collider?.boxes ?? []).slice(0, maxRows);
    group.updateWorldMatrix(true, true);
    // entity → world: 'full' = matrixWorld; 'planar' = group.position +
    // planarYaw(group.rotation) + SIGNED group.scale (the collider convention in
    // player.js) — authored transform components, no decomposition.
    const M = space === 'full'
      ? group.matrixWorld.clone()
      : new THREE.Matrix4().compose(group.position.clone(), new THREE.Quaternion().setFromAxisAngle(_up, planarYaw(group.rotation)), group.scale.clone());
    const bounds = meshBounds(group);
    const bbox = bounds?.bbox ?? null;
    const mc = bbox ? bbox.getCenter(new THREE.Vector3()) : null;
    const msz = bbox ? bbox.getSize(new THREE.Vector3()) : null;
    const chans = ['i', 'cx', 'cy', 'cz', 'sx', 'sy', 'sz', 'blk', 'gap'];
    const rows = [];
    const flags = [];
    let offset = false;
    let badRot = false;
    const corner = new THREE.Vector3();
    boxes.forEach((box, i) => {
      const rot = boxRotation(box.rotation, space);
      if (!rot) { badRot = true; rows.push([i, '?', '?', '?', '?', '?', '?', box.blocker ? 'B' : box.step ? 'S' : 'T', '?']); return; }
      const [sx, sy, sz] = box.size ?? [1, 1, 1];
      const local = new THREE.Matrix4().makeTranslation(...(box.position ?? [0, 0, 0])).multiply(rot.m);
      const world = M.clone().multiply(local);
      const aabb = new THREE.Box3();
      for (let k = 0; k < 8; k++) {
        corner.set((k & 1 ? 0.5 : -0.5) * sx, (k & 2 ? 0.5 : -0.5) * sy, (k & 4 ? 0.5 : -0.5) * sz).applyMatrix4(world);
        aabb.expandByPoint(corner);
      }
      const c = aabb.getCenter(new THREE.Vector3());
      const s = aabb.getSize(new THREE.Vector3());
      const gap = bbox ? cm(aabb.max.y - bbox.min.y) : '·';
      rows.push([i, cm(c.x), cm(c.y), cm(c.z), cm(s.x), cm(s.y), cm(s.z), box.blocker ? 'B' : box.step ? 'S' : 'T', gap]);
      if (bbox && Math.hypot(c.x - mc.x, c.z - mc.z) * 100 > offsetCm) offset = true;
    });
    if (bbox) rows.push(['mesh', cm(mc.x), cm(mc.y), cm(mc.z), cm(msz.x), cm(msz.y), cm(msz.z), '·', '·']);
    if (!bbox) flags.push('!BOUNDS_UNAVAILABLE');
    if (bbox && !boxes.length) flags.push('!NOCOLLIDER');
    if (offset) flags.push('!OFFSET');
    if (badRot) flags.push('!BOX_ROTATION_UNSUPPORTED');
    const label = space === 'full' ? 'space=full-matrix' : 'space=planar-yaw+scale';
    const head = `#rain colliders ${id} n=${boxes.length} ${label} box=world-aabb bounds=${bounds?.from ?? 'none'} q=cm ${flags.length ? flags.join(' ') : 'OK'}`;
    if (!rows.length) return head;
    return `${head}\n${grid(chans, rows)}`;
  }
  // ---- frame: the ACTUAL rendered pixels, quantized to symbols --------------
  // The only organ with a pixel source. One readPixels() per call, one buffer,
  // box-filtered into cols×rows cells (rows = y-down, canonical image order).
  // No PNG, no OCR, no vision model — pure RGBA → legend. Source is whatever
  // the parent's callback reads (world render target, pre-display, no HUD).
  async function frame({ cols = 40, rows = 20, crop = null } = {}) {
    cols = Math.floor(fin(cols, 40, 1, maxCols));
    rows = Math.floor(fin(rows, 20, 1, maxRows));
    if (cols * rows > maxCells) {
      const k = Math.sqrt(maxCells / (cols * rows));
      cols = Math.max(1, Math.floor(cols * k));
      rows = Math.max(1, Math.floor(rows * k));
    }
    if (typeof readPixels !== 'function') return '#rain frame !NO_PIXEL_TARGET no readPixels callback';
    let px;
    try {
      px = await readPixels();
    } catch (err) {
      return `#rain frame !READ_FAILED ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 80)}`;
    }
    if (px === null || px === undefined) return '#rain frame !NO_PIXEL_TARGET';
    const { width, height, rgba, source = '?', origin } = px;
    const posInt = (n) => Number.isInteger(n) && n > 0;
    if (!posInt(width) || !posInt(height)) return `#rain frame !BAD_DIMENSIONS ${width}x${height}`;
    if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) return `#rain frame !BAD_BUFFER type=${rgba?.constructor?.name ?? typeof rgba} need=Uint8Array`;
    if (rgba.length !== width * height * 4) return `#rain frame !BAD_BUFFER len=${rgba.length} need=${width * height * 4}`;
    // origin is a strict enum — an unknown origin must never silently flip
    if (origin !== 'top-left' && origin !== 'bottom-left') return `#rain frame !BAD_ORIGIN ${origin} need=top-left|bottom-left`;
    const region = crop ?? { x: 0, y: 0, width, height };
    if (['x', 'y', 'width', 'height'].some(k => !Number.isInteger(region[k])) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > width || region.y + region.height > height) return '#rain frame !BAD_CROP expected in-bounds integer top-left x,y,width,height';
    cols = Math.min(cols, region.width);
    rows = Math.min(rows, region.height);
    const lines = [];
    for (let r = 0; r < rows; r++) {
      const y0 = region.y + Math.floor((r * region.height) / rows);
      const y1 = region.y + Math.floor(((r + 1) * region.height) / rows);
      let line = '';
      for (let c = 0; c < cols; c++) {
        const x0 = region.x + Math.floor((c * region.width) / cols);
        const x1 = region.x + Math.floor(((c + 1) * region.width) / cols);
        let R = 0, G = 0, B = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          const sy = origin === 'top-left' ? y : height - 1 - y;
          for (let x = x0; x < x1; x++) {
            const k = (sy * width + x) * 4;
            R += rgba[k]; G += rgba[k + 1]; B += rgba[k + 2]; n++;
          }
        }
        line += frameSymbol(R / n / 255, G / n / 255, B / n / 255);
      }
      lines.push(line);
    }
    const head = `#rain frame src=${source} frame=${Number.isInteger(px.frame) ? px.frame : '?'} px=${width}x${height} grid=${cols}x${rows} cell=${(region.width / cols).toFixed(1)}x${(region.height / rows).toFixed(1)} aspect=${(region.width / region.height).toFixed(2)} rows=y-down${crop ? ` crop=${region.x},${region.y},${region.width},${region.height}` : ''} ${FRAME_LEGEND}`;
    return [head, ...lines].join('\n');
  }
  const bodyOf = (id) => {
    const group = view.getGroup(id);
    const vrm = group?.userData?.vrm;
    const body = vrm ? { vrm } : group?.userData?.rainBody;
    return group && body ? { group, body } : null;
  };

  // ---- proprio: the body, sampled over time --------------------------------
  async function proprio(id, { ticks = 20, hz = 10 } = {}) {
    const found = bodyOf(id);
    if (!found) return `#rain proprio ${id} !NOBODY`;
    const { group, body } = found;
    const hips = bodyBone(body, 'hips');
    // VRM has normalized toe/foot semantics; generic GLBs bind world-declared soles.
    const lf = body.vrm ? bodyBone(body, 'leftToes') ?? bodyBone(body, 'leftFoot') : bodyBone(body, 'leftFoot');
    const rf = body.vrm ? bodyBone(body, 'rightToes') ?? bodyBone(body, 'rightFoot') : bodyBone(body, 'rightFoot');
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
      const fac = measuredFacing(body);
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
    const rainBody = group.userData?.rainBody;
    const facing = (vrm && measuredFacing({ vrm })) ?? (rainBody && measuredFacing(rainBody)) ?? group.rotation.y;
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

  return { proprio, fov, motion, pose, colliders, frame };
}
