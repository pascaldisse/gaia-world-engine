// Live-GPU harness for GI v2 open mode (Pascal runs it; this lane had no browser). Checks, in order:
//  (1) NO WebGPU validation/uncaptured errors compiling+dispatching the open kernels (the #1 unknown),
//  (2) single-dispatch GPU == CPU reference (gi-reference.js §v2) with bounceScale 0 (race-free: sky + sun only),
//  (3) converged qualitative: tunnel probe darker than open-sky probe; red wall bleeds red; solid-embedded probe disabled (depth sentinel),
//  (4) partial brick upload: moving the camera uploads only dirty bricks.
import * as THREE from 'three/webgpu';
import { GIController } from '../client/kernel/gi/gi-controller.js';
import { openUpdateProbe } from '../client/kernel/gi/gi-reference.js';
import { cellOfSlot, cellToWorld } from '../client/kernel/gi/cascade.js';
import { encodeOct } from '../client/kernel/gi/octahedral.js';
import { withGpuValidation, captureComputeWGSL } from './gi-parity.mjs';

const IRR = 8, DEP = 16;
const layers = (axis, a0, a1, lo0, hi0, lo1, hi1) => { // stacked 1 m planes => SOLID slab (surface-only boxes are hollow in a 1 m grid)
  const t = []; for (let a = a0 + 0.5; a < a1; a += 1) for (const [p, q] of [[0, 0]]) { void p; void q;
    if (axis === 'y') t.push(lo0, a, lo1, hi0, a, lo1, hi0, a, hi1, lo0, a, lo1, hi0, a, hi1, lo0, a, hi1);
    if (axis === 'x') t.push(a, lo0, lo1, a, hi0, lo1, a, hi0, hi1, a, lo0, lo1, a, hi0, hi1, a, lo0, hi1); }
  return t;
};
const texel = (dir) => { const [u, v] = encodeOct(dir); const c = (x) => Math.min(IRR - 1, Math.max(0, Math.floor(((x + 1) / 2) * IRR))); return c(u) + IRR * c(v); };
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
// readback: vec3 storage is padded to 4 floats/texel in WGSL
const rd3 = (buf, i) => [buf[i * 4], buf[i * 4 + 1], buf[i * 4 + 2]];

export async function runOpenParity({ rendererFactory } = {}) {
  const renderer = rendererFactory ? await rendererFactory() : new THREE.WebGPURenderer({ antialias: false });
  await renderer.init?.();
  const out = { pass: true, checks: {}, notes: [] };
  const SKY = { zenith: [0.3, 0.5, 1], horizon: [0.6, 0.7, 0.9], ground: [0.1, 0.1, 0.1] };
  const cfg = { enabled: true, mode: 'open', raysPerProbe: 32, bounceScale: 0, irradianceAlpha: 0, sky: SKY,
    sun: { direction: [1, -0.4, 0.2], color: [1, 1, 1], intensity: 3 },
    voxel: { bricks: { x: 8, y: 4, z: 8 } },
    cascades: { count: 2, spacings: [2, 6], dims: [{ x: 8, y: 4, z: 8 }, { x: 8, y: 4, z: 8 }], updateFractions: [1, 1] } };
  const gi = new GIController({ renderer, scene: new THREE.Scene() });
  const res = await withGpuValidation(renderer, async () => {
    gi.configure(cfg); const o = gi.resources.open;
    gi.addMesh('ground', { triangles: layers('y', 0, 2, 0, 64, 0, 64), color: [0.4, 0.4, 0.4] });
    gi.addMesh('redwall', { triangles: layers('x', 40, 42, 0, 12, 0, 64), color: [0.9, 0.05, 0.05] }); // wall slab x 40..42
    gi.addMesh('roof', { triangles: layers('y', 8, 10, 0, 30, 0, 64), color: [0.4, 0.4, 0.4] }); // roof over x 0..30 (tunnel mouth at x=30)
    const cam = [32, 6, 32];
    for (let i = 0; i < 40; i++) gi.update(0.016, cam); // settle bricks (16/frame), cascades fresh
    const stats = { ...o.stats };
    // (2) single dispatch, bounceScale 0, alpha 0: GPU vs CPU
    gi.update(0.016, cam);
    const irrBuf = new Float32Array(await renderer.getArrayBufferAsync(o.atlases.irradiance.value));
    const depBuf = new Float32Array(await renderer.getArrayBufferAsync(o.atlases.depth.value));
    out.wgsl = (captureComputeWGSL(renderer, o.irr.kernel) ?? '').length;
    const maxDist = 48; let worst = 0, compared = 0, mismatches = [];
    for (const c of o.cascades) for (const slot of [0, 77, 150, 211, 300, 450]) {
      if (slot >= c.count) continue;
      const cell = cellOfSlot(c, slot, o.baseCells[c.index]); const pos = cellToWorld(cell, c.spacing);
      const ref = openUpdateProbe({ probePos: pos, vox: o.win, maxDist, raysPerProbe: 32, sun: { direction: cfg.sun.direction, color: [1, 1, 1], intensity: 3 }, sky: SKY, irradianceRes: IRR, depthRes: DEP, relocateMax: o.cascades[0].spacing * 0.5 });
      const gIdx = c.baseIndex + slot;
      const gpuDisabled = depBuf[gIdx * DEP * DEP * 2] < 0;
      if ((ref.state === 'disabled') !== gpuDisabled) { mismatches.push({ cascade: c.index, slot, ref: ref.state, gpuDisabled }); continue; }
      if (ref.state === 'disabled') { compared++; continue; }
      for (let t = 0; t < IRR * IRR; t++) { const g = rd3(irrBuf, gIdx * IRR * IRR + t), r = ref.irradianceTexels[t];
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(g[k] - r[k]) / (Math.abs(r[k]) + 0.05)); }
      compared++;
    }
    out.checks.gpuVsCpu = { compared, worstRelErr: worst, mismatches, pass: mismatches.length === 0 && worst < 0.05 };
    // (3) converged: bounce on, alpha 0.9
    o.setBounceScale(1); o.irr.alpha.value = 0.9;
    for (let i = 0; i < 60; i++) gi.update(0.016, cam);
    const irr2 = new Float32Array(await renderer.getArrayBufferAsync(o.atlases.irradiance.value));
    const up = (pos) => { // nearest finest probe, +Y irradiance
      const c = o.cascades[0]; const cell = pos.map((v) => Math.round(v / c.spacing)); const slot = ((cell[0] % 8 + 8) % 8) + 8 * (((cell[1] % 4 + 4) % 4) + 4 * ((cell[2] % 8 + 8) % 8));
      return rd3(irr2, (c.baseIndex + slot) * IRR * IRR + texel([0, 1, 0])); };
    const tunnel = lum(up([16, 5, 32])), open = lum(up([48, 5, 32]));
    out.checks.tunnelDarker = { tunnel, open, pass: tunnel < open * 0.6 };
    const c0 = o.cascades[0]; const cellW = [38, 5, 32].map((v) => Math.round(v / 2)); const slotW = ((cellW[0] % 8 + 8) % 8) + 8 * (((cellW[1] % 4 + 4) % 4) + 4 * ((cellW[2] % 8 + 8) % 8));
    const e = rd3(irr2, (c0.baseIndex + slotW) * IRR * IRR + texel([1, 0, 0]));
    out.checks.redBleed = { e, pass: e[0] > 1.5 * e[1] && e[0] > 0.01 };
    // (4) incremental upload
    gi.update(0.016, cam); const before = o.stats.bricksUploaded; gi.addMesh('car', { triangles: layers('y', 3, 4, 20, 22, 20, 22), color: [1, 1, 1] }); gi.update(0.016, cam);
    out.checks.partialUpload = { bricksUploadedDelta: o.stats.bricksUploaded - before, ranges: o.vs.attr.updateRanges.length, pass: o.stats.bricksUploaded - before >= 1 && o.stats.bricksUploaded - before <= 8 };
    out.stats = stats;
  });
  out.gpuErrors = res.errors ?? res.gpuErrors ?? [];
  for (const c of Object.values(out.checks)) if (!c.pass) out.pass = false;
  if (out.gpuErrors.length) out.pass = false;
  if (res.thrown) { out.pass = false; out.thrown = String(res.thrown?.stack ?? res.thrown); }
  return out;
}
