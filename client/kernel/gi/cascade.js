// v2 open-world probe cascades (docs/GI-PROBES.md §v2 open-world). Pure JS, GPU-free.
// N camera-following 3D cascades (Y scrolls too). Per cascade: spacing, dims,
// snapped window. TOROIDAL slot addressing: probe slot = worldCell mod dims, so a
// scroll keeps every probe that stays in-window at the same slot (atlas data kept);
// only probes whose world cell entered the window are 'fresh'.
// RTS mode (probe-grid.js) is untouched.

export const CASCADE_DEFAULTS = {
  count: 3,
  spacings: [2, 6, 18], // PLACEHOLDER m — finest..coarsest; see docs UNVERIFIED
  dims: [{ x: 16, y: 8, z: 16 }, { x: 16, y: 8, z: 16 }, { x: 16, y: 8, z: 16 }], // probes/axis per cascade
  updateFractions: [1 / 4, 1 / 8, 1 / 16], // PLACEHOLDER per-cascade round-robin budget (fraction of cascade probes / update())
  blendCells: 1.5, // PLACEHOLDER border blend width, in FINER-cascade cells
};

export const posMod = (a, n) => ((a % n) + n) % n;

/** static layout: baseIndex = offset of the cascade's slot 0 in the shared flat atlas */
export function buildCascades(cfg = {}) {
  const count = cfg.count ?? CASCADE_DEFAULTS.count;
  const spacings = cfg.spacings ?? CASCADE_DEFAULTS.spacings;
  const dimsArr = cfg.dims ?? CASCADE_DEFAULTS.dims;
  const fr = cfg.updateFractions ?? CASCADE_DEFAULTS.updateFractions;
  const out = [];
  let base = 0;
  for (let k = 0; k < count; k++) {
    const dims = dimsArr[k] ?? dimsArr[dimsArr.length - 1];
    const spacing = spacings[k] ?? spacings[spacings.length - 1] * 3 ** (k - spacings.length + 1);
    const n = dims.x * dims.y * dims.z;
    out.push({ index: k, spacing, dims: { ...dims }, count: n, baseIndex: base, updateFraction: fr[k] ?? fr[fr.length - 1] });
    base += n;
  }
  return out;
}
export const totalProbes = (cascades) => cascades.reduce((s, c) => s + c.count, 0);

/** window base CELL (integer min cell per axis) centred on camera, snapped to spacing */
export function cascadeBaseCell(cascade, cameraPos) {
  const { spacing, dims } = cascade;
  return [
    Math.floor(cameraPos[0] / spacing) - Math.floor(dims.x / 2),
    Math.floor(cameraPos[1] / spacing) - Math.floor(dims.y / 2),
    Math.floor(cameraPos[2] / spacing) - Math.floor(dims.z / 2),
  ];
}
export const cellToWorld = (cell, spacing) => [cell[0] * spacing, cell[1] * spacing, cell[2] * spacing];

/** world origin (min-corner probe position) of the window */
export const cascadeOrigin = (cascade, baseCell) => cellToWorld(baseCell, cascade.spacing);

/** toroidal slot (flat, within cascade) of an absolute world cell */
export function slotOfCell(cascade, cx, cy, cz) {
  const { x, y, z } = cascade.dims;
  return posMod(cx, x) + x * (posMod(cy, y) + y * posMod(cz, z));
}
/** flat global atlas probe index of an absolute cell */
export const globalIndexOfCell = (cascade, cx, cy, cz) => cascade.baseIndex + slotOfCell(cascade, cx, cy, cz);

/** inverse: absolute world cell the given slot currently represents, for a window baseCell */
export function cellOfSlot(cascade, slot, baseCell) {
  const { x, y, z } = cascade.dims;
  const sx = slot % x, sy = Math.floor(slot / x) % y, sz = Math.floor(slot / (x * y));
  return [baseCell[0] + posMod(sx - baseCell[0], x), baseCell[1] + posMod(sy - baseCell[1], y), baseCell[2] + posMod(sz - baseCell[2], z)];
}
export const slotWorldPos = (cascade, slot, baseCell) => cellToWorld(cellOfSlot(cascade, slot, baseCell), cascade.spacing);

/** scroll: new base cell + which slots are FRESH (their world cell was outside prev window) */
export function scrollCascade(cascade, prevBase, cameraPos) {
  const base = cascadeBaseCell(cascade, cameraPos);
  const shift = [base[0] - prevBase[0], base[1] - prevBase[1], base[2] - prevBase[2]];
  const fresh = [];
  if (shift[0] !== 0 || shift[1] !== 0 || shift[2] !== 0) {
    const { x, y, z } = cascade.dims;
    const inPrev = (cx, cy, cz) => cx >= prevBase[0] && cx < prevBase[0] + x && cy >= prevBase[1] && cy < prevBase[1] + y && cz >= prevBase[2] && cz < prevBase[2] + z;
    for (let iz = 0; iz < z; iz++) for (let iy = 0; iy < y; iy++) for (let ix = 0; ix < x; ix++) {
      if (!inPrev(base[0] + ix, base[1] + iy, base[2] + iz)) fresh.push(slotOfCell(cascade, base[0] + ix, base[1] + iy, base[2] + iz));
    }
  }
  return { baseCell: base, shift, shifted: fresh.length > 0, freshSlots: fresh };
}

/** inside the trilinear-interpolable region [origin, origin+(dims-1)*spacing]? */
export function cascadeContains(cascade, baseCell, p) {
  const o = cellToWorld(baseCell, cascade.spacing);
  const e = [(cascade.dims.x - 1) * cascade.spacing, (cascade.dims.y - 1) * cascade.spacing, (cascade.dims.z - 1) * cascade.spacing];
  return p[0] >= o[0] && p[0] <= o[0] + e[0] && p[1] >= o[1] && p[1] <= o[1] + e[1] && p[2] >= o[2] && p[2] <= o[2] + e[2];
}
/** distance (in cascade cells) from p to nearest window border; <0 outside */
export function borderDistanceCells(cascade, baseCell, p) {
  const o = cellToWorld(baseCell, cascade.spacing);
  const ext = [cascade.dims.x - 1, cascade.dims.y - 1, cascade.dims.z - 1];
  let m = Infinity;
  for (let a = 0; a < 3; a++) {
    const r = (p[a] - o[a]) / cascade.spacing;
    m = Math.min(m, r, ext[a] - r);
  }
  return m;
}
const smooth01 = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };

/**
 * Pick finest cascade containing p; blend toward the next-coarser one across the
 * finer window's last `blendCells`. @returns [{index, weight}] (1 or 2 entries, sum=1; [] if none contains p)
 */
export function selectCascades(cascades, baseCells, p, blendCells = CASCADE_DEFAULTS.blendCells) {
  for (let k = 0; k < cascades.length; k++) {
    if (!cascadeContains(cascades[k], baseCells[k], p)) continue;
    const next = k + 1 < cascades.length && cascadeContains(cascades[k + 1], baseCells[k + 1], p);
    if (!next) return [{ index: k, weight: 1 }];
    const wFine = smooth01(borderDistanceCells(cascades[k], baseCells[k], p) / blendCells);
    if (wFine >= 1) return [{ index: k, weight: 1 }];
    return wFine <= 0 ? [{ index: k + 1, weight: 1 }] : [{ index: k, weight: wFine }, { index: k + 1, weight: 1 - wFine }];
  }
  return [];
}

/**
 * Round-robin per-cascade budget. cursors[k] = next slot. @returns {batches:[{cascade,start,count}], cursors}
 * Batches are slot ranges (may wrap -> two entries) in cascade-local slot space.
 */
export function planCascadeUpdate(cascades, cursors) {
  const batches = [];
  const next = cursors.slice();
  for (const c of cascades) {
    const n = Math.max(1, Math.round(c.count * c.updateFraction));
    const start = cursors[c.index] ?? 0;
    const first = Math.min(n, c.count - start);
    batches.push({ cascade: c.index, start, count: first });
    if (first < n) batches.push({ cascade: c.index, start: 0, count: n - first });
    next[c.index] = (start + n) % c.count;
  }
  return { batches, cursors: next };
}
