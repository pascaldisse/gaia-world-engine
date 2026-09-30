// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)
// Naming law: every identifier this extension coins that could reach a shader (attribute/uniform/varying) or tag a
// foreign object is prefixed `rfX` and is not a WGSL keyword/reserved word (W3C WGSL §reserved-words). Debris uses stock
// materials, so today the only such identifier is the hull-sliver vertex tag; any future one MUST be added here.
export const RFX_NAMES = Object.freeze({
  hullExterior: 'rfXExterior', // per-point flag: point came from an original exterior (non-cap) face (§3.4 tagging)
});
