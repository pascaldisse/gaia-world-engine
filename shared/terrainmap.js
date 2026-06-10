import { terrainHeight } from './noise.js';

// One ground function over many terrains. A point inside a terrain's square
// samples that terrain; a point outside every terrain extrapolates the
// nearest one — so single-terrain worlds behave exactly as they always have,
// and multi-zone worlds route to the right ground. Interiors that need NO
// ground (caverns over a void) are an M8 concern (blocking volumes), not a
// height concern.
// NOTE: client/kernel/terrain.js duplicates this routing against live
// three.js groups — keep the two in agreement.

export function routeHeight(entries, x, z) {
  let nearest = null;
  let nearestD = Infinity;
  for (const entry of entries) {
    const half = (entry.params.size ?? 400) / 2;
    const lx = x - entry.cx;
    const lz = z - entry.cz;
    if (Math.abs(lx) <= half && Math.abs(lz) <= half) {
      return terrainHeight(lx, lz, entry.params) + entry.cy;
    }
    const d = lx * lx + lz * lz;
    if (d < nearestD) {
      nearestD = d;
      nearest = entry;
    }
  }
  if (!nearest) return 0;
  return terrainHeight(x - nearest.cx, z - nearest.cz, nearest.params) + nearest.cy;
}

// build routing entries from a world entity map (server side)
export function terrainEntries(entities) {
  const entries = [];
  for (const comps of entities.values()) {
    if (!comps?.terrain) continue;
    const [cx, cy, cz] = comps.transform?.position ?? [0, 0, 0];
    entries.push({ cx, cy, cz, params: comps.terrain });
  }
  return entries;
}
