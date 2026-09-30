// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// §7 demolition orchestration: fracture core + per-fragment bookkeeping for the structural layer.
import { fractureCells } from './fracture.js';
import { boundsOfFaces, facesVolume } from './geometry.js';
import { mixSeed } from './prng.js';

export const DEMOLITION_DEFAULTS = Object.freeze({ am: 15, var: 0, dpf: 0.5, bias: 0, sd: 1 });
const MIN_CHILD_AMOUNT = 3;
const VOLUME_FLOOR = 1e-9; // fragment volume is used as a mass/size divisor: never 0

// Depth-fade: a re-shattered fragment breaks into fewer pieces than its parent, never fewer than 3.
export function nextFragmentAmount(am, dpf) {
  return Math.max(MIN_CHILD_AMOUNT, Math.trunc(am * dpf + 1e-9));
}

function meanOfVertices(faces) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const f of faces) for (const p of f.verts) { x += p.x; y += p.y; z += p.z; n++; }
  return { x: x / n, y: y / n, z: z / n };
}

export function demolishMesh(triangles, opts = {}) {
  const o = { ...DEMOLITION_DEFAULTS, ...opts };
  const depth = opts.depth ?? 0;
  const cells = fractureCells(triangles, { amount: o.am, seed: o.sd, variation: o.var, bias: o.bias, biasPoint: opts.biasPoint });
  const childAm = nextFragmentAmount(o.am, o.dpf);
  return cells.map(cell => ({
    index: cell.index,
    seedPoint: cell.seedPoint,
    faces: cell.faces,
    volume: Math.max(Math.abs(facesVolume(cell.faces)), VOLUME_FLOOR),
    centroid: meanOfVertices(cell.faces),
    aabb: boundsOfFaces(cell.faces),
    depth,
    demolition: { am: childAm, var: o.var, dpf: o.dpf, bias: o.bias, sd: mixSeed(o.sd, cell.index + 1), depth: depth + 1 },
    uncappedLoops: cell.uncappedLoops,
    hullFallback: cell.hullFallback,
  }));
}
