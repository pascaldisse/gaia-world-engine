import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../shared/noise.js';
import { heightAt } from './terrain.js';

// Animated instanced motes: fireflies, drifting souls, rain. Positions are
// pure functions of (time, phase) so every client computes the same motion.
export function buildParticles(spec) {
  const count = Math.min(spec.count ?? 100, 5000);
  const rng = mulberry32((spec.seed ?? 1) * 7919 + 3);
  const area = spec.area ?? { center: [0, 0], radius: 20 };

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
      y = heightAt(x, z) + h - fall;
    } else {
      const r = motion.radius ?? 2.5;
      x = ax + Math.sin(time * 0.37 * speed + ph * 6.283) * r + Math.sin(time * 0.11 * speed + ph * 13) * r * 0.6;
      z = az + Math.cos(time * 0.29 * speed + ph * 6.283) * r + Math.cos(time * 0.07 * speed + ph * 17) * r * 0.6;
      y = heightAt(x, z) + (motion.height ?? 1.8) + Math.sin(time * 0.8 * speed + ph * 9) * (motion.bob ?? 0.6);
      if (motion.floor !== undefined) y = Math.max(y, motion.floor);
    }
    m.makeTranslation(x, y, z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
}
