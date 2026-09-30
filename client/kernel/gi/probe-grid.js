// World-space probe grid math (§GI-PROBES.md Probe layout). Pure, GPU-free —
// same functions run CPU-side to place probes and (mirrored) GPU-side to
// index the storage atlas.

/** probe counts per axis for a half-extent (world units) at a given spacing */
export function gridDims(halfExtent, spacing) {
  const n = Math.max(1, Math.round((2 * halfExtent) / spacing) + 1);
  return n;
}

/** flat index for a 3D probe grid, x fastest, then y, then z */
export function probeIndex(ix, iy, iz, dims) {
  const { x, y } = dims;
  return ix + x * (iy + y * iz);
}

export function probeCount(dims) {
  return dims.x * dims.y * dims.z;
}

/** grid cell (ix,iy,iz) -> world position, given the grid's snapped origin */
export function gridToWorld(ix, iy, iz, origin, spacing) {
  return [origin[0] + ix * spacing, origin[1] + iy * spacing, origin[2] + iz * spacing];
}

/**
 * Camera-relative recenter, X/Z only (§GI-PROBES.md: top-down RTS camera —
 * Y is a fixed small layer stack, never scrolls). Origin only moves in whole
 * multiples of `spacing` so probes that stay inside the window keep their
 * world position and atlas data (no full-grid relight on every camera pan).
 *
 * @returns {{origin:[number,number,number], shifted:boolean, shiftCellsX:number, shiftCellsZ:number}}
 */
export function recenterGrid(prevOrigin, cameraPos, spacing, halfExtentXZ, fixedY = 0) {
  const snap = (v) => Math.floor(v / spacing) * spacing;
  const nx = snap(cameraPos[0]) - halfExtentXZ;
  const nz = snap(cameraPos[2]) - halfExtentXZ;
  const shiftCellsX = Math.round((nx - prevOrigin[0]) / spacing);
  const shiftCellsZ = Math.round((nz - prevOrigin[2]) / spacing);
  return {
    origin: [nx, fixedY, nz],
    shifted: shiftCellsX !== 0 || shiftCellsZ !== 0,
    shiftCellsX,
    shiftCellsZ,
  };
}

/**
 * Build the layout for a camera-relative cascade: fixed Y layer stack
 * (default 3: ground/mid/roof), scrolling X/Z window.
 */
export function buildProbeGrid({ spacing, halfExtentXZ, layersY = 3, heightRange = [0, 12] }) {
  const dimsXZ = gridDims(halfExtentXZ, spacing);
  const dims = { x: dimsXZ, y: Math.max(1, layersY), z: dimsXZ };
  const ySpacing = layersY > 1 ? (heightRange[1] - heightRange[0]) / (layersY - 1) : 0;
  return { dims, spacing, ySpacing, baseY: heightRange[0], count: probeCount(dims) };
}
