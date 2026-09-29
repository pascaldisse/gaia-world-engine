// Wiring (§GI-PROBES.md Fallbacks/default). `environment` component gains
// `gi: {...}`, default `enabled:false`. GIController is the single place
// that decides whether ANY probe/storage/compute/IrradianceNode resource
// ever gets created — the off path (default) must touch nothing, proven by
// test/gi-controller.test.js.

import { buildProbeGrid } from './probe-grid.js';
import { createProbeAtlases, createGIUpdateKernel } from './gi-nodes.js';

export const GI_DEFAULTS = {
  enabled: false,
  spacing: 8,
  halfExtentXZ: 40,
  layersY: 3,
  heightRange: [0, 12],
  raysPerProbe: 64, // PLACEHOLDER — see docs/GI-PROBES.md Ray budget
  updateFraction: 1 / 8, // PLACEHOLDER
  irradianceRes: 8,
  depthRes: 16,
  irradianceAlpha: 0.97, // PLACEHOLDER
  depthAlpha: 0.9, // PLACEHOLDER
};

export class GIController {
  constructor({ renderer } = {}) {
    this.renderer = renderer;
    this.enabled = false;
    this.resources = null;
    this.params = { ...GI_DEFAULTS };
  }

  /** @returns {boolean} whether any GPU resource now exists (false = off path, nothing allocated) */
  configure(params = {}) {
    const p = { ...GI_DEFAULTS, ...params };
    this.params = p;
    if (!p.enabled) {
      // LAW: default/disabled path allocates zero storage buffers, zero
      // compute kernels, zero probe grid — not "disabled but built".
      this.enabled = false;
      this.resources = null;
      return false;
    }
    this.enabled = true;
    const grid = buildProbeGrid(p);
    const atlases = createProbeAtlases({
      probeCount: grid.count,
      irradianceRes: p.irradianceRes,
      depthRes: p.depthRes,
    });
    const { kernel, totalTexels } = createGIUpdateKernel({
      atlases,
      raysPerProbe: p.raysPerProbe,
      hysteresis: p,
    });
    this.resources = { grid, atlases, kernel, totalTexels, params: p };
    return true;
  }

  dispose() {
    this.enabled = false;
    this.resources = null;
  }
}
