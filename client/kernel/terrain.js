import * as THREE from 'three/webgpu';

// Deterministic value noise — same function shapes the mesh and answers
// height queries for the player and grounded entities.
let active = null;

function hash2(x, z, seed) {
  const s = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const ux = smooth(fx);
  const uz = smooth(fz);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x, z, seed, octaves = 4) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * valueNoise(x * frequency, z * frequency, seed + i * 13);
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value;
}

export function setActiveTerrain(params) {
  active = params;
}

export function heightAt(x, z) {
  if (!active) return 0;
  const { seed = 1, amplitude = 6, frequency = 0.015 } = active;
  return (fbm(x * frequency, z * frequency, seed) - 0.5) * 2 * amplitude;
}

export function buildTerrainMesh(params) {
  setActiveTerrain(params);
  const { size = 400, segments = 160, color = '#4a7d3b' } = params;
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    positions.setY(i, heightAt(positions.getX(i), positions.getZ(i)));
  }
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}
