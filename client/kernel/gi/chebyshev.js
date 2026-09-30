// One-sided Chebyshev visibility bound (Donnelly & Lauritzen 2006 Variance
// Shadow Maps; reused by RTXGI §4.1 as the probe self-shadow/occlusion test
// instead of a hard depth compare — see docs/GI-PROBES.md).
//
// Given a probe's stored (mean distance, mean distance^2) in some direction
// and a candidate distance to the shading point along that direction,
// estimate P(the probe can see at least that far) in [0,1]. 1 = definitely
// visible (point is nearer than the mean hit), otherwise a soft falloff
// instead of a binary occluded/visible cut (avoids light/dark leak edges).

export const CHEBYSHEV_EPSILON = 1e-4; // PLACEHOLDER floor for zero-variance texels

export function chebyshevWeight(mean, mean2, testDist) {
  if (testDist <= mean) return 1;
  const variance = Math.max(mean2 - mean * mean, CHEBYSHEV_EPSILON);
  const d = testDist - mean;
  const w = variance / (variance + d * d);
  return Math.min(1, Math.max(0, w));
}
