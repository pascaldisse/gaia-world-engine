import * as THREE from 'three/webgpu';
import { terrainHeight } from '../../shared/noise.js';

// Multi-terrain registry: every built terrain claims the square around its
// entity group. heightAt routes by containment, extrapolating the nearest
// terrain outside all squares — single-terrain worlds behave exactly as
// before. Mirrors shared/terrainmap.js routeHeight, but reads live group
// positions so a dragged terrain stays truthful.
const registry = new Map(); // entity group → terrain params

export function registerTerrain(group, params) {
  registry.set(group, params);
}

export function unregisterTerrain(group) {
  registry.delete(group);
}

export function heightAt(x, z) {
  let nearest = null;
  let nearestD = Infinity;
  for (const [group, params] of registry) {
    const half = (params.size ?? 400) / 2;
    const lx = x - group.position.x;
    const lz = z - group.position.z;
    if (Math.abs(lx) <= half && Math.abs(lz) <= half) {
      return terrainHeight(lx, lz, params) + group.position.y;
    }
    const d = lx * lx + lz * lz;
    if (d < nearestD) {
      nearestD = d;
      nearest = { lx, lz, params, y: group.position.y };
    }
  }
  if (!nearest) return 0;
  return terrainHeight(nearest.lx, nearest.lz, nearest.params) + nearest.y;
}

// heightfields are deterministic from their params, and big (160²+ verts) —
// cache them so a scene streaming back in costs nothing to re-bake
const geometryCache = new Map();

export function buildTerrainMesh(params) {
  const { size = 400, segments = 160, color = '#4a7d3b' } = params;
  const key = JSON.stringify({ ...params, color: undefined });
  let geometry = geometryCache.get(key);
  if (!geometry) {
    geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    geometry.rotateX(-Math.PI / 2);
    const positions = geometry.attributes.position;
    // sample in terrain-local coords; the entity group places it in the world
    for (let i = 0; i < positions.count; i++) {
      positions.setY(i, terrainHeight(positions.getX(i), positions.getZ(i), params));
    }
    geometry.computeVertexNormals();
    geometry.userData.shared = true;
    geometryCache.set(key, geometry);
    // live terrain edits churn params — evicted entries lose their shared
    // tag, so the next rebuild/removal of their mesh disposes them normally
    if (geometryCache.size > 8) {
      const oldest = geometryCache.keys().next().value;
      geometryCache.get(oldest).userData.shared = false;
      geometryCache.delete(oldest);
    }
  }
  const material = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}
