import * as THREE from 'three/webgpu';
import { mulberry32, fbm } from '../../shared/noise.js';
import { heightAt } from './terrain.js';
import { makeGeometry, makePartMaterial } from './geometry.js';

// One entity, hundreds of things: a scatter document becomes a few
// InstancedMesh draw calls. Deterministic from its seed, terrain-following,
// with optional fbm clustering (the Tomb candle-lake pattern).
export function buildScatter(spec) {
  const group = new THREE.Group();
  const rng = mulberry32((spec.seed ?? 1) * 1000 + 17);
  const area = spec.area ?? { shape: 'circle', center: [0, 0], radius: 60 };
  const count = Math.min(spec.count ?? 100, 5000);

  const positions = [];
  const maxTries = count * 12;
  for (let i = 0; i < maxTries && positions.length < count; i++) {
    let x;
    let z;
    if (area.shape === 'rect') {
      x = (area.center?.[0] ?? 0) + (rng() - 0.5) * (area.size?.[0] ?? 100);
      z = (area.center?.[1] ?? 0) + (rng() - 0.5) * (area.size?.[1] ?? 100);
    } else {
      const r = (area.radius ?? 60) * Math.sqrt(rng());
      const a = rng() * Math.PI * 2;
      x = (area.center?.[0] ?? 0) + Math.cos(a) * r;
      z = (area.center?.[1] ?? 0) + Math.sin(a) * r;
    }
    if (spec.density) {
      const cluster = fbm(x * (spec.density.noise ?? 0.02), z * (spec.density.noise ?? 0.02), (spec.seed ?? 1) + 99);
      if (rng() > cluster * 0.85 + (spec.density.bias ?? 0.15)) continue;
    }
    const h = heightAt(x, z);
    if (spec.minHeight !== undefined && h < spec.minHeight) continue;
    if (spec.maxHeight !== undefined && h > spec.maxHeight) continue;
    const y = spec.ground === false ? spec.y ?? 0 : h + (spec.offsetY ?? 0);
    positions.push([x, y, z]);
  }

  const n = positions.length;
  const bases = [];
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scaleVec = new THREE.Vector3();
  const [smin, smax] = spec.scale ?? [1, 1];
  for (let i = 0; i < n; i++) {
    const s = smin + rng() * (smax - smin);
    euler.set(
      (rng() - 0.5) * (spec.tilt ?? 0),
      spec.rotateY === false ? 0 : rng() * Math.PI * 2,
      (rng() - 0.5) * (spec.tilt ?? 0),
    );
    q.setFromEuler(euler);
    scaleVec.setScalar(s);
    bases.push(new THREE.Matrix4().compose(new THREE.Vector3(...positions[i]), q, scaleVec));
  }

  const m = new THREE.Matrix4();
  for (const part of spec.instance?.parts ?? []) {
    const mesh = new THREE.InstancedMesh(makeGeometry(part), makePartMaterial(part), n);
    const partScale = part.scale ?? 1;
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...(part.position ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(part.rotation ?? [0, 0, 0]))),
      Array.isArray(partScale) ? new THREE.Vector3(...partScale) : new THREE.Vector3(partScale, partScale, partScale),
    );
    for (let i = 0; i < n; i++) {
      m.multiplyMatrices(bases[i], local);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = part.castShadow ?? true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.userData.count = n;
  return group;
}
