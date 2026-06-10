import * as THREE from 'three/webgpu';
import { mulberry32 } from '../../shared/noise.js';
import { heightAt } from './terrain.js';

// Animated instanced motes: fireflies, drifting souls, rain. Positions are
// pure functions of (time, phase) so every client computes the same motion.
export function buildParticles(spec) {
  const count = Math.min(spec.count ?? 100, 5000);
  const rng = mulberry32((spec.seed ?? 1) * 7919 + 3);
  const area = spec.area ?? { center: [0, 0], radius: 20 };

  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(spec.size ?? 0.07, 6, 4),
    new THREE.MeshBasicMaterial({ color: spec.color ?? '#ffe066' }),
    count,
  );
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

export function updateParticles(state, time) {
  const { mesh, anchors, phases, spec, count } = state;
  const motion = spec.motion ?? { type: 'drift' };
  const speed = motion.speed ?? 1;
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
      y = heightAt(x, z) + h - fall;
    } else {
      const r = motion.radius ?? 2.5;
      x = ax + Math.sin(time * 0.37 * speed + ph * 6.283) * r + Math.sin(time * 0.11 * speed + ph * 13) * r * 0.6;
      z = az + Math.cos(time * 0.29 * speed + ph * 6.283) * r + Math.cos(time * 0.07 * speed + ph * 17) * r * 0.6;
      y = heightAt(x, z) + (motion.height ?? 1.8) + Math.sin(time * 0.8 * speed + ph * 9) * (motion.bob ?? 0.6);
    }
    m.makeTranslation(x, y, z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
}
