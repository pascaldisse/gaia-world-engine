import * as THREE from 'three/webgpu';
import { terrainHeight } from '../../shared/noise.js';

let active = null;

export function setActiveTerrain(params) {
  active = params;
}

export function heightAt(x, z) {
  return terrainHeight(x, z, active);
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
