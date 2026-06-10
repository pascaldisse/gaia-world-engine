import * as THREE from 'three/webgpu';
import { makePresetMaterial } from './presets.js';

// Shared mesh-recipe builders: entity meshes, scatter instances, palette ghosts.

export function makeGeometry(part) {
  switch (part.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(part.radius ?? 0.5, 24, 16);
    case 'cylinder':
      return new THREE.CylinderGeometry(
        part.radiusTop ?? part.radius ?? 0.5,
        part.radiusBottom ?? part.radius ?? 0.5,
        part.height ?? 1,
        16,
        1,
        part.open ?? false,
      );
    case 'cone':
      return new THREE.ConeGeometry(part.radius ?? 0.5, part.height ?? 1, 16);
    case 'torus':
      return new THREE.TorusGeometry(part.radius ?? 1, part.tube ?? 0.3, 12, 32);
    case 'octahedron':
      return new THREE.OctahedronGeometry(part.radius ?? 0.5, 0);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(part.radius ?? 0.5, 0);
    case 'plane':
      return new THREE.PlaneGeometry(part.size?.[0] ?? 1, part.size?.[1] ?? 1);
    default:
      return new THREE.BoxGeometry(...(part.size ?? [1, 1, 1]));
  }
}

export function makePartMaterial(part) {
  if (part.preset) {
    const preset = makePresetMaterial(part);
    if (preset) return preset;
  }
  const material = new THREE.MeshStandardMaterial({
    color: part.color ?? '#9aa0a6',
    roughness: part.roughness ?? 0.8,
    metalness: part.metalness ?? 0,
    flatShading: part.flatShading ?? false,
  });
  if (part.emissive) {
    material.emissive = new THREE.Color(part.emissive);
    material.emissiveIntensity = part.emissiveIntensity ?? 1;
  }
  if (part.opacity !== undefined && part.opacity < 1) {
    material.transparent = true;
    material.opacity = part.opacity;
  }
  return material;
}
