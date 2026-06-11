import * as THREE from 'three/webgpu';
import { makePresetMaterial } from './presets.js';

// Shared mesh-recipe builders: entity meshes, scatter instances, palette ghosts.
//
// Geometries and materials are CACHED by their recipe values and shared across
// every mesh that asks for the same thing. World content repeats constantly
// (the same stone palette, the same lantern, five hundred identical candles),
// so sharing collapses thousands of GPU objects into dozens — fewer pipelines
// to compile (less streaming stutter), less memory, less GC. Shared resources
// carry userData.shared and must never be disposed by their users.

const geometryCache = new Map();
const materialCache = new Map();

const GEOMETRY_FIELDS = [
  'shape', 'size', 'radius', 'radiusTop', 'radiusBottom', 'height', 'open', 'tube', 'segments',
  'thetaStart', 'thetaLength', 'radialSegments',
];
const MATERIAL_FIELDS = [
  'preset', 'color', 'roughness', 'metalness', 'flatShading', 'emissive', 'emissiveIntensity',
  'opacity', 'fog', 'tip', 'speed', 'glowStrength', 'beamStrength', 'sparkle', 'sky', 'glint', 'lines',
  'fadeAbove', 'flicker',
  'horizon', 'bands', 'bright', 'sunPos', 'sunColor', 'sunGlow', 'sunRadius', 'noiseScale', 'cover',
  'waveHeight', 'waveScale', 'crest', 'haze', 'blockSize', 'grout', 'grain', 'doubleSide',
];

function recipeKey(part, fields) {
  let key = '';
  for (const field of fields) {
    const v = part[field];
    key += v === undefined ? '|' : `|${JSON.stringify(v)}`;
  }
  return key;
}

export function makeGeometry(part) {
  const key = recipeKey(part, GEOMETRY_FIELDS);
  let geometry = geometryCache.get(key);
  if (!geometry) {
    geometry = buildGeometry(part);
    geometry.userData.shared = true;
    geometryCache.set(key, geometry);
  }
  return geometry;
}

function buildGeometry(part) {
  switch (part.shape) {
    case 'sphere':
      return new THREE.SphereGeometry(part.radius ?? 0.5, 24, 16);
    case 'cylinder':
      // thetaStart/thetaLength: partial arcs — how a shell gets a carved
      // opening (the crater's mouth) without CSG. Stacked bands only meet
      // crack-free when their rings share one angular lattice: same
      // thetaStart, radialSegments chosen so every band's step is equal.
      return new THREE.CylinderGeometry(
        part.radiusTop ?? part.radius ?? 0.5,
        part.radiusBottom ?? part.radius ?? 0.5,
        part.height ?? 1,
        part.radialSegments ?? 16,
        1,
        part.open ?? false,
        part.thetaStart ?? 0,
        part.thetaLength ?? Math.PI * 2,
      );
    case 'cone':
      return new THREE.ConeGeometry(part.radius ?? 0.5, part.height ?? 1, 16);
    case 'torus':
      return new THREE.TorusGeometry(part.radius ?? 1, part.tube ?? 0.3, 12, 32);
    case 'octahedron':
      return new THREE.OctahedronGeometry(part.radius ?? 0.5, 0);
    case 'icosahedron':
      return new THREE.IcosahedronGeometry(part.radius ?? 0.5, 0);
    case 'plane': {
      // segments: tessellation for vertex-displaced presets (the abyss swell)
      const seg = part.segments;
      const [sx, sy] = Array.isArray(seg) ? seg : [seg ?? 1, seg ?? 1];
      return new THREE.PlaneGeometry(part.size?.[0] ?? 1, part.size?.[1] ?? 1, sx, sy);
    }
    default:
      return new THREE.BoxGeometry(...(part.size ?? [1, 1, 1]));
  }
}

export function makePartMaterial(part) {
  const key = recipeKey(part, MATERIAL_FIELDS);
  let material = materialCache.get(key);
  if (!material) {
    material = buildPartMaterial(part);
    material.userData.shared = true;
    materialCache.set(key, material);
  }
  return material;
}

function buildPartMaterial(part) {
  if (part.preset) {
    const preset = makePresetMaterial(part);
    if (preset) {
      if (part.fog === false) preset.fog = false;
      return preset;
    }
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
  // fog: false — for backdrop scenery whose colors already ARE the
  // atmosphere (skybox content); zone fog would erase it at distance
  if (part.fog === false) material.fog = false;
  // doubleSide: shells seen from both worlds (the crater: pale rock outside,
  // near-black inside — the ZONE lighting does the painting, not the part)
  if (part.doubleSide) material.side = THREE.DoubleSide;
  return material;
}

// dispose a built object's own GPU resources, leaving cache-shared ones alone
export function disposeOwn(node) {
  if (node.geometry && !node.geometry.userData?.shared) node.geometry.dispose();
  if (node.material) {
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material.userData?.shared) material.dispose();
    }
  }
}
