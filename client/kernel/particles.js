import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, materialOpacity, vec3 } from 'three/tsl';
import { mulberry32, fbm } from '../../shared/noise.js';
import { heightAt } from './terrain.js';

// §IRON SPACE — the star field as a POPULATION, not a colour.
//
// The defect this fixes (measured, proof/beauty/universe/before): every
// `starfield:` entity was `count` spheres of ONE colour at ONE size, so a
// galaxy's ambient stars were a flat sprinkle of #bfe0ff — and in space the
// per-frame `heightAt` lookup below (4-octave terrain fbm, the hottest call in
// a storm) was being spent on 3061 instances to produce meaningless noise as
// their vertical scatter.
//
// Opt-in via `spec.space`. Every default here is a named value with the reason
// it is that value; the non-space path is untouched.
export const SPACE_IRON = {
  // COLOUR TEMPERATURE. share / hex / relative brightness. Blue stars are
  // bright and rare, red stars dim and rarer — a flat distribution reads as
  // confetti, and all-white reads as the sprinkle we started from.
  temperature: [
    [0.12, '#cfe4ff', 1.00], // blue-white, young
    [0.24, '#ffffff', 0.86],
    [0.40, '#ffe9c0', 0.72], // gold, main sequence
    [0.18, '#ffbe7a', 0.58], // amber
    [0.06, '#ff8a6a', 0.44], // red, old
  ],
  hueJitter: 0.06,   // per-star drift so no two stars are the same value; at 0
                     // the field banded into five visible colour groups
  accentShare: 0.2,  // fraction biased toward THIS galaxy's own accents, so a
                     // galaxy has 2-3 temperatures of its own and never one hue
  accentMix: 0.7,
  // SIZE, long tail: most stars sub-pixel, a few near-stars carrying the depth
  // read. A uniform size is the other half of why the field read as a sprinkle.
  sizeMin: 0.55,
  sizeTail: 3.4,     // multiplier reached by the rare tail
  tailShare: 0.06,   // how many stars are in that tail
  // SHAPE: a flattened cloud sculpted by fbm so it has filaments and a denser
  // core. `warp` is the Mensis asymmetry — at 0 the cloud is a tidy ellipsoid.
  flatten: 0.42,
  fill: 0.72,        // radial bias: 1 = uniform disc, <1 crowds the core
  filament: 0.55,    // how strongly the fbm mask culls placements
  filamentScale: 0.9,
  warp: 0.3,
};

const hexToRgb = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

// Animated instanced motes: fireflies, drifting souls, rain. Positions are
// pure functions of (time, phase) so every client computes the same motion.
export function buildParticles(spec) {
  const count = Math.min(spec.count ?? 100, 5000);
  const rng = mulberry32((spec.seed ?? 1) * 7919 + 3);
  const area = spec.area ?? { center: [0, 0], radius: 20 };
  if (spec.space) return buildSpaceField(spec, count, rng, area);

  // streak: the real-time rain idiom — a drop is a velocity-stretched
  // billboard (here a thin vertical sliver), not a ball. Fireflies and
  // souls stay spheres; rain authored without streak looks like snow.
  const size = spec.size ?? 0.07;
  const geometry = spec.streak
    ? new THREE.BoxGeometry(size, spec.streak, size)
    : new THREE.SphereGeometry(size, 6, 4);
  const material = new THREE.MeshBasicMaterial({ color: spec.color ?? '#ffe066' });
  if (spec.opacity !== undefined && spec.opacity < 1) {
    material.transparent = true;
    material.opacity = spec.opacity;
    material.depthWrite = false;
  }
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;

  const anchors = new Float32Array(count * 2);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = (area.radius ?? 20) * Math.sqrt(rng());
    const a = rng() * Math.PI * 2;
    anchors[i * 2] = (area.center?.[0] ?? 0) + Math.cos(a) * r;
    anchors[i * 2 + 1] = (area.center?.[1] ?? 0) + Math.sin(a) * r;
    phases[i] = rng();
  }
  return { mesh, anchors, phases, spec, count };
}

// ── space mode ─────────────────────────────────────────────────────────────
// One InstancedMesh, one draw call, per-instance colour AND size, positions in
// real 3D, and no terrain anywhere. Placement is CPU work done ONCE at build
// time (fbm rejection); nothing here runs per frame.
function buildSpaceField(spec, count, rng, area) {
  const O = { ...SPACE_IRON, ...(spec.iron ?? {}) };
  const radius = area.radius ?? 20;
  const size = spec.size ?? 0.07;
  const seed = spec.seed ?? 1;

  // the temperature population, as a cumulative table
  const table = O.temperature;
  const total = table.reduce((s, t) => s + t[0], 0) || 1;
  const cum = [];
  let acc = 0;
  for (const [share, hex, bright] of table) {
    acc += share / total;
    cum.push([acc, hexToRgb(hex), bright]);
  }
  // this galaxy's own accents (world-build passes 2-3 per cluster)
  const accents = (spec.accents ?? []).map(hexToRgb);

  const positions = new Float32Array(count * 3);
  const tint = new Float32Array(count * 3);
  const scale = new Float32Array(count);
  const phases = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // FILAMENTS, NOT A BALL. Rejection-sample against a 2-octave fbm mask, so
    // the cloud is dense where the noise is and thin where it is not; a plain
    // random disc is the uniform puff this pass exists to kill. Bounded tries:
    // a starved mask must never hang the build.
    let x = 0; let y = 0; let z = 0;
    for (let tries = 0; tries < 6; tries++) {
      const u = rng();
      const r = radius * Math.pow(u, O.fill);
      const a = rng() * Math.PI * 2;
      const h = (rng() * 2 - 1) * radius * O.flatten * (1 - 0.6 * (r / radius));
      x = Math.cos(a) * r;
      z = Math.sin(a) * r;
      y = h;
      // Mensis: the cloud leans and is sheared, never axis-aligned
      x += y * O.warp;
      z -= y * O.warp * 0.6;
      const mask = fbm(x * O.filamentScale * 0.06, z * O.filamentScale * 0.06, seed, 2) * 0.5 + 0.5;
      if (mask > O.filament * rng()) break;
    }
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // temperature draw
    const p = rng();
    let rgb = cum[cum.length - 1][1];
    let bright = cum[cum.length - 1][2];
    for (const [edge, c, b] of cum) { if (p <= edge) { rgb = c; bright = b; break; } }
    let [cr, cg, cb] = rgb;
    if (accents.length && rng() < O.accentShare) {
      const [ar, ag, ab] = accents[Math.floor(rng() * accents.length) % accents.length];
      const k = O.accentMix;
      cr += (ar - cr) * k; cg += (ag - cg) * k; cb += (ab - cb) * k;
    }
    const j = O.hueJitter;
    tint[i * 3] = Math.max(0, cr * bright * (1 + (rng() * 2 - 1) * j));
    tint[i * 3 + 1] = Math.max(0, cg * bright * (1 + (rng() * 2 - 1) * j));
    tint[i * 3 + 2] = Math.max(0, cb * bright * (1 + (rng() * 2 - 1) * j));

    // size: long tail
    scale[i] = rng() < O.tailShare
      ? O.sizeMin + (O.sizeTail - O.sizeMin) * rng() ** 0.4
      : O.sizeMin + (1 - O.sizeMin) * rng();
    phases[i] = rng();
  }

  // 5x3 segments = 30 triangles: at 24x16 (the default sphere) 3061 stars cost
  // 100k triangles for a body that is 2 px across at galaxy range.
  const geometry = new THREE.SphereGeometry(size, spec.spaceSegments ?? 5, 3);
  const material = new THREE.MeshBasicNodeMaterial({ toneMapped: false });
  // PER-INSTANCE COLOUR, still ONE draw call. instanceColor is not used: on the
  // WebGPU node path an explicit instanced attribute is the only form that is
  // guaranteed to reach colorNode.
  const tintAttr = new THREE.InstancedBufferAttribute(tint, 3);
  material.colorNode = instancedBufferAttribute(tintAttr, 'vec3');
  // materialOpacity is NOT decoration: the film's rites layer writes
  // `state.mesh.material.opacity` every frame to light and dim these clouds
  // (atlas-fx-rites condense()/breathe()/releaseCloud()), and a NodeMaterial
  // ignores .opacity unless the graph reads it.
  material.opacityNode = materialOpacity;
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  if (spec.opacity !== undefined) material.opacity = spec.opacity;

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const one = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    pos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    sc.setScalar(scale[i]);
    mesh.setMatrixAt(i, m4.compose(pos, one, sc));
  }
  mesh.instanceMatrix.needsUpdate = true;
  // `space: true` on the state is what makes updateParticles a no-op for this
  // system: the field is static geometry, so the per-frame cost is zero. The
  // rites layer only ever writes mesh.count / material.opacity / spec.motion,
  // and the first two still work exactly as before.
  return { mesh, anchors: positions, phases, spec, count, space: true, scale };
}

const m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _down = new THREE.Vector3(0, -1, 0);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

// live look-dev multipliers for STREAKED rain only (the debug panel's rain
// submenu writes these) — souls and fireflies ride the same motion type but
// never the knobs. angle is the slant in radians, applied along world x.
export const rainDebug = { speed: 1, angle: 0 };

export function updateParticles(state, time) {
  // space fields are static: analytic drift is not worth 3061 matrix writes a
  // frame for stars that subtend 2 px, and the terrain lookup the drift path
  // does is meaningless off-planet.
  if (state.space) return;
  const { mesh, anchors, phases, spec, count } = state;
  const motion = spec.motion ?? { type: 'drift' };
  const dbg = spec.streak ? rainDebug : null;
  const speed = (motion.speed ?? 1) * (dbg?.speed ?? 1);
  // wind: horizontal drift per meter fallen — authored motion.tilt [tx, tz]
  // plus the debug slant; the streak itself leans to match the velocity
  const tx = (motion.tilt?.[0] ?? 0) + (dbg ? Math.tan(dbg.angle) : 0);
  const tz = motion.tilt?.[1] ?? 0;
  let quat = null;
  if (spec.streak && (tx || tz)) {
    quat = _quat.setFromUnitVectors(_down, _dir.set(tx, -1, tz).normalize());
  }
  // the ground under a mote moves slowly (terrain is smooth, motes wander
  // meters) but heightAt is 4-octave fbm — the single hottest call in a
  // storm. Cache per particle, refreshed staggered every 10 frames: fresh
  // enough to follow terrain streaming in, 10× fewer noise evaluations.
  const grounds = (state.grounds ??= new Float32Array(count).fill(NaN));
  const frame = (state.frame = (state.frame ?? 0) + 1);
  for (let i = 0; i < count; i++) {
    const ax = anchors[i * 2];
    const az = anchors[i * 2 + 1];
    const ph = phases[i];
    let x = ax;
    let z = az;
    let y;
    if (motion.type === 'rain') {
      const h = motion.height ?? 30;
      const fall = (time * speed * 10 + ph * h * 7) % h;
      x += tx * fall;
      z += tz * fall;
      if (Number.isNaN(grounds[i]) || (frame + i) % 10 === 0) grounds[i] = heightAt(x, z);
      y = grounds[i] + h - fall;
    } else {
      const r = motion.radius ?? 2.5;
      x = ax + Math.sin(time * 0.37 * speed + ph * 6.283) * r + Math.sin(time * 0.11 * speed + ph * 13) * r * 0.6;
      z = az + Math.cos(time * 0.29 * speed + ph * 6.283) * r + Math.cos(time * 0.07 * speed + ph * 17) * r * 0.6;
      if (Number.isNaN(grounds[i]) || (frame + i) % 10 === 0) grounds[i] = heightAt(x, z);
      y = grounds[i] + (motion.height ?? 1.8) + Math.sin(time * 0.8 * speed + ph * 9) * (motion.bob ?? 0.6);
      if (motion.floor !== undefined) y = Math.max(y, motion.floor);
    }
    if (quat) m.compose(_pos.set(x, y, z), quat, _one);
    else m.makeTranslation(x, y, z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
}
