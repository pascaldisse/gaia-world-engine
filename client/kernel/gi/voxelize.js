// Scene representation for software ray marching (§GI-PROBES.md
// Representation): a conservative voxel occupancy grid built from scene
// triangles. Marks a voxel occupied if the TRIANGLE'S AABB overlaps the
// voxel's AABB — a deliberate simplification of the exact triangle/box SAT
// test (Akenine-Moller): a conservative superset (never under-marks, may
// over-mark a few cells near a triangle's diagonal). PLACEHOLDER — see docs.

/**
 * @param {Array<[number,number,number,number,number,number,number,number,number]>} triangles
 *   flat [ax,ay,az,bx,by,bz,cx,cy,cz] per triangle
 * @param {[number,number,number]} originWorld voxel grid's min corner
 * @param {number} cellSize world units per voxel (cubic cells)
 * @param {{x:number,y:number,z:number}} dims voxel counts per axis
 * @returns {Uint8Array} occupancy, flat index = ix + dims.x*(iy + dims.y*iz)
 */
export function voxelizeTriangles(triangles, originWorld, cellSize, dims) {
  const occ = new Uint8Array(dims.x * dims.y * dims.z);
  const [ox, oy, oz] = originWorld;
  for (const tri of triangles) {
    const xs = [tri[0], tri[3], tri[6]];
    const ys = [tri[1], tri[4], tri[7]];
    const zs = [tri[2], tri[5], tri[8]];
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    let ix0 = Math.floor((minX - ox) / cellSize);
    let ix1 = Math.floor((maxX - ox) / cellSize);
    let iy0 = Math.floor((minY - oy) / cellSize);
    let iy1 = Math.floor((maxY - oy) / cellSize);
    let iz0 = Math.floor((minZ - oz) / cellSize);
    let iz1 = Math.floor((maxZ - oz) / cellSize);
    // fully outside on any axis (checked BEFORE clamping, or clamping would
    // collapse an out-of-range span onto a false edge voxel) -> skip
    if (ix1 < 0 || ix0 >= dims.x || iy1 < 0 || iy0 >= dims.y || iz1 < 0 || iz0 >= dims.z) continue;
    ix0 = clamp(ix0, 0, dims.x - 1); ix1 = clamp(ix1, 0, dims.x - 1);
    iy0 = clamp(iy0, 0, dims.y - 1); iy1 = clamp(iy1, 0, dims.y - 1);
    iz0 = clamp(iz0, 0, dims.z - 1); iz1 = clamp(iz1, 0, dims.z - 1);
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          occ[ix + dims.x * (iy + dims.y * iz)] = 1;
        }
      }
    }
  }
  return occ;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** DDA ray march against the occupancy grid; returns hit distance or null. */
export function marchOccupancy(occ, dims, originWorld, cellSize, rayOrigin, rayDir, maxDist) {
  const [ox, oy, oz] = originWorld;
  let t = 0;
  const step = cellSize * 0.5; // PLACEHOLDER fixed-step DDA (see docs GPU side note)
  while (t < maxDist) {
    const px = rayOrigin[0] + rayDir[0] * t;
    const py = rayOrigin[1] + rayDir[1] * t;
    const pz = rayOrigin[2] + rayDir[2] * t;
    const ix = Math.floor((px - ox) / cellSize);
    const iy = Math.floor((py - oy) / cellSize);
    const iz = Math.floor((pz - oz) / cellSize);
    if (ix >= 0 && ix < dims.x && iy >= 0 && iy < dims.y && iz >= 0 && iz < dims.z) {
      if (occ[ix + dims.x * (iy + dims.y * iz)]) return t;
    }
    t += step;
  }
  return null;
}
