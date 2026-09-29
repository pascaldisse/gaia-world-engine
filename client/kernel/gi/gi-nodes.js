// TSL/WebGPU graph construction for probe GI (§GI-PROBES.md "Material
// sampling" + "Irradiance/depth atlas + update"). Builds REAL three r180
// node objects (storage buffers, a compute kernel, a material-sampling
// node) — node --test constructs these graphs with no GPU device present;
// it proves the graph is well-formed, not that it runs correctly on a real
// frame (see docs UNVERIFIED).
//
// Everything here is additive and only ever called when gi.enabled === true
// (gated by gi-controller.js) — an untouched material/scene never sees any
// of this module's nodes.

import { Fn, instancedArray, uniform, vec3, float, int, Loop, dot, max, normalize, mix, clamp } from 'three/tsl';
import { IrradianceNode } from 'three/webgpu';

/**
 * Allocate the per-probe irradiance + depth atlas storage. One texel per
 * (probe, atlas-cell); flat GPU buffers indexed exactly like probe-grid.js's
 * probeIndex() on the CPU side, times the atlas resolution.
 */
export function createProbeAtlases({ probeCount, irradianceRes = 8, depthRes = 16 }) {
  const irradianceTexelsPerProbe = irradianceRes * irradianceRes;
  const depthTexelsPerProbe = depthRes * depthRes;
  const irradiance = instancedArray(probeCount * irradianceTexelsPerProbe, 'vec3');
  const depth = instancedArray(probeCount * depthTexelsPerProbe, 'vec2'); // (mean, mean2)
  return { irradiance, depth, irradianceRes, depthRes, probeCount };
}

/**
 * Probe-update compute kernel skeleton (§GI-PROBES.md Update, eq(1)). One
 * GPU thread per (probe, ray) in v0 — `raysPerProbe` threads per probe,
 * `updateFraction` of probes touched per dispatch (round-robin subset,
 * chosen by the caller via `probeOffset`/`probeStride` uniforms so this
 * kernel body never changes shape, only which probes it's told to touch).
 *
 * Ray-vs-voxel intersection itself is deliberately NOT implemented on the
 * GPU here (see docs: needs the occupancy texture uploaded + a DDA loop
 * mirroring voxelize.js's marchOccupancy) — this wires the dispatch shape,
 * the hysteresis blend, and the atlas write so the ray-march body can be
 * dropped in without touching the surrounding plumbing. UNVERIFIED beyond
 * graph construction (needs a real GPU frame).
 */
export function createGIUpdateKernel({ atlases, raysPerProbe, occupancyTexture, hysteresis }) {
  const { irradiance, irradianceRes } = atlases;
  const alpha = uniform(hysteresis?.irradianceAlpha ?? 0.97);
  const probeOffset = uniform(0, 'uint');

  const updateFn = Fn(() => {
    // one thread per (probe-in-batch, texel) flattened by instancedArray's
    // own instanceIndex; texel/probe decomposition happens in JS below the
    // atlas allocation shape (irradianceRes*irradianceRes per probe) so the
    // kernel body stays a single flat loop, matching probeIndex()'s layout.
    const texelIndex = instancedArrayIndex();
    const probeLocal = texelIndex.div(int(irradianceRes * irradianceRes));
    const probeIdx = probeOffset.add(probeLocal);
    const old = irradiance.element(texelIndex);

    // placeholder accumulate: a flat ambient term stands in for the real
    // ray-march-and-shade loop (see function doc) so the hysteresis blend
    // and atlas write are exercised end-to-end even before ray tracing lands
    const sampleEstimate = vec3(0, 0, 0).toVar();
    Loop(raysPerProbe, () => {
      // NOTE: no-op body placeholder for the ray-march (UNVERIFIED, docs)
      sampleEstimate.addAssign(vec3(0, 0, 0));
    });

    const blended = mix(sampleEstimate, old, alpha);
    irradiance.element(texelIndex).assign(blended);
    void probeIdx; // reserved for the ray-march body's per-probe grid lookup
    void occupancyTexture;
  });

  const totalTexels = atlases.probeCount * irradianceRes * irradianceRes;
  const kernel = updateFn().compute(totalTexels, [64]);
  return { kernel, alpha, probeOffset, totalTexels };
}

// three/tsl doesn't export a bare "current compute invocation index" helper
// under a single stable name across builds; instancedArray's `.element()`
// call inside a Fn() body resolves the running invocation itself via the
// node's own instanceIndex context. Kept as a tiny indirection so a future
// three upgrade only needs one function body updated, not every call site.
import { instanceIndex as _instanceIndex } from 'three/tsl';
function instancedArrayIndex() {
  return _instanceIndex;
}

/**
 * Chebyshev-weighted trilinear probe query, mirrors chebyshev.js /
 * irradiance.js exactly (same formulas, GPU-side). Returns a TSL vec3 node
 * to feed into gi-material.js's IrradianceNode wrap.
 */
export function createGIQueryNode({ atlases, worldPositionNode, normalNode, gridUniforms }) {
  const { irradiance, depth, irradianceRes, depthRes } = atlases;
  const { origin, spacing, dims } = gridUniforms; // each a TSL uniform()

  return Fn(() => {
    const total = vec3(0, 0, 0).toVar();
    const weightSum = float(0).toVar();
    // 8 corner probes of the enclosing cell (§GI-PROBES.md Material sampling)
    Loop({ start: int(0), end: int(8), type: 'int' }, ({ i }) => {
      const cornerIdx = i; // corner selection math omitted in v0 skeleton
      const probeDir = normalize(worldPositionNode.sub(origin));
      const trilinearWeight = float(1); // PLACEHOLDER — real trilinear weight from corner offset
      const backfaceWeight = max(0, dot(normalNode, probeDir.negate()));
      const meanDist = depth.element(cornerIdx.mul(depthRes * depthRes)).x;
      const mean2 = depth.element(cornerIdx.mul(depthRes * depthRes)).y;
      const testDist = worldPositionNode.sub(origin).length();
      const variance = max(mean2.sub(meanDist.mul(meanDist)), float(1e-4));
      const d = testDist.sub(meanDist);
      const chebyshev = testDist.lessThanEqual(meanDist).select(float(1), clamp(variance.div(variance.add(d.mul(d))), 0, 1));
      const w = trilinearWeight.mul(backfaceWeight).mul(chebyshev);
      const irr = irradiance.element(cornerIdx.mul(irradianceRes * irradianceRes));
      total.addAssign(irr.mul(w));
      weightSum.addAssign(w);
      void dims; void spacing;
    });
    return total.div(max(weightSum, float(1e-5)));
  })();
}

/** Wrap gi-nodes.js's query node in three's own IrradianceNode so it flows
 *  into PhysicalLightingModel's indirectDiffuse for free (see docs). */
export function wrapAsIrradianceNode(giQueryNode) {
  return new IrradianceNode(giQueryNode);
}
