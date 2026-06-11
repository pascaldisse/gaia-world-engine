import * as THREE from 'three/webgpu';
import { Brush, Evaluator, SUBTRACTION, HOLLOW_SUBTRACTION } from 'three-bvh-csg';
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
  'path', 'radii', 'tubularSegments', 'closed', 'inside', 'wobble', 'wobbleScale',
  'carve',
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

// `carve`: boolean subtraction as data — the Dreams lesson made portable.
// Author the part as CSG (`carve: [{shape, position, rotation, …}]`, shapes
// in PART-LOCAL space), evaluate ONCE at geometry-build time with
// three-bvh-csg, cache by recipe: real holes, zero per-frame cost. Inward-
// wound tubes are carved while still outward (the evaluator classifies
// solids by winding) and flipped after — so a cave wall gets a real window.
function buildGeometry(part) {
  if (!Array.isArray(part.carve) || !part.carve.length) return buildBaseGeometry(part);
  const flip = part.shape === 'tube' && (part.inside ?? false);
  let geometry = buildBaseGeometry(flip ? { ...part, inside: false } : part);
  // a tube is a SHELL, not a solid: plain subtraction would wall the cut
  // off with the tool's own faces (CSG sees the enclosed volume as rock).
  // HOLLOW_SUBTRACTION clips shell faces and adds none — a true hole.
  geometry = carveGeometry(geometry, part.carve, part.shape === 'tube');
  if (flip) {
    flipWinding(geometry);
    geometry.computeVertexNormals();
  }
  return geometry;
}

let evaluator = null;
function carveGeometry(base, carves, hollow = false) {
  if (!evaluator) {
    evaluator = new Evaluator();
    evaluator.useGroups = false; // one material per part — no group splits
    evaluator.attributes = ['position', 'normal', 'uv'];
  }
  if (!base.attributes.uv) {
    // CSG interpolates the attribute set across both operands — give
    // primitives without uvs a zero channel rather than dropping uvs
    base.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(base.attributes.position.count * 2), 2));
  }
  let target = new Brush(base);
  target.updateMatrixWorld();
  for (const c of carves) {
    const tool = new Brush(buildBaseGeometry(c));
    tool.position.set(...(c.position ?? [0, 0, 0]));
    if (c.rotation) tool.rotation.set(...c.rotation);
    tool.updateMatrixWorld();
    const next = evaluator.evaluate(target, tool, hollow ? HOLLOW_SUBTRACTION : SUBTRACTION);
    tool.geometry.dispose();
    target.geometry.dispose();
    target = next;
  }
  return target.geometry;
}

function flipWinding(geometry) {
  if (geometry.index) {
    const idx = geometry.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = t;
    }
    geometry.index.needsUpdate = true;
    return;
  }
  for (const name of Object.keys(geometry.attributes)) {
    const attr = geometry.attributes[name];
    const arr = attr.array;
    const sz = attr.itemSize;
    for (let t = 0; t + 2 < attr.count; t += 3) {
      for (let k = 0; k < sz; k++) {
        const a = (t + 1) * sz + k;
        const b = (t + 2) * sz + k;
        const tmp = arr[a];
        arr[a] = arr[b];
        arr[b] = tmp;
      }
    }
    attr.needsUpdate = true;
  }
}

function buildBaseGeometry(part) {
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
    case 'tube':
      return buildTubeGeometry(part);
    default:
      return new THREE.BoxGeometry(...(part.size ?? [1, 1, 1]));
  }
}

// 'tube': a cave or tunnel as pure data — a Catmull-Rom spline (`path`) with
// a radius per control point (`radii`). Rings are placed by ARC LENGTH (even
// spacing no matter how control points cluster) and oriented by parallel
// transport (no twist, none of Frenet's flips at inflections). The radius
// eases between control points on its own Catmull-Rom, so thick chambers
// flow into narrow squeezes. `inside: true` winds the faces inward: a space
// you walk THROUGH — the floor is walkable via the solid-mesh raycast, and
// from outside the shell is invisible (cull), as buried rock should be.
// `wobble` adds deterministic lumpiness (no Math.random — the recipe cache
// and every client must agree) so rock reads as rock under flatShading.
function buildTubeGeometry(part) {
  const pts = (part.path ?? [[0, 0, 0], [10, 0, 0]]).map((p) => new THREE.Vector3(...p));
  const closed = part.closed ?? false;
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
  const segs = Math.max(2, part.tubularSegments ?? pts.length * 12);
  const radial = Math.max(3, part.radialSegments ?? 14);
  const radii = Array.isArray(part.radii) ? part.radii : [part.radii ?? part.radius ?? 3];
  const n = pts.length;
  const rOf = (i) => radii[Math.min(radii.length - 1, ((i % n) + n) % n)];
  // scalar Catmull-Rom over the control radii — same uniform-per-segment
  // parameterization as the position spline, so radius i lands at point i
  const radiusAt = (t) => {
    const f = Math.min(0.99999, Math.max(0, t)) * (closed ? n : n - 1);
    const k = Math.floor(f);
    const s = f - k;
    const [r0, r1, r2, r3] = [rOf(k - 1), rOf(k), rOf(k + 1), rOf(k + 2)];
    const v0 = (r2 - r0) * 0.5;
    const v1 = (r3 - r1) * 0.5;
    return Math.max(0.15, (2 * r1 - 2 * r2 + v0 + v1) * s * s * s + (-3 * r1 + 3 * r2 - 2 * v0 - v1) * s * s + v0 * s + r1);
  };

  const wobble = part.wobble ?? 0;
  const ws = part.wobbleScale ?? 1;
  const inside = part.inside ?? false;
  const positions = [];
  const uvs = [];
  const indices = [];
  const tangent = new THREE.Vector3();
  const prevTangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const vertex = new THREE.Vector3();

  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    const point = curve.getPointAt(u);
    curve.getTangentAt(u, tangent);
    if (i === 0) {
      const seed = Math.abs(tangent.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      normal.crossVectors(tangent, seed).normalize();
    } else {
      // parallel transport: carry the previous frame through the bend
      turn.setFromUnitVectors(prevTangent, tangent);
      normal.applyQuaternion(turn).normalize();
    }
    prevTangent.copy(tangent);
    binormal.crossVectors(tangent, normal).normalize();
    const r = radiusAt(curve.getUtoTmapping(u));
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      let rr = r;
      if (wobble) {
        const lump =
          Math.sin(a * 3 + u * segs * 0.37 * ws) * 0.5 +
          Math.sin(a * 5 - u * segs * 0.61 * ws + 1.7) * 0.3 +
          Math.sin(a * 9 + u * segs * 1.13 * ws + 4.2) * 0.2;
        rr = r * (1 + wobble * lump);
      }
      vertex
        .copy(normal)
        .multiplyScalar(Math.cos(a) * rr)
        .addScaledVector(binormal, Math.sin(a) * rr)
        .add(point);
      positions.push(vertex.x, vertex.y, vertex.z);
      uvs.push(u, j / radial);
    }
  }
  const stride = radial + 1;
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * stride + j;
      const b = a + stride;
      if (inside) indices.push(a, b, a + 1, a + 1, b, b + 1);
      else indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
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
