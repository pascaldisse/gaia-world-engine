// render-api/light-registry.js — per-scene GROW-ONLY light set shared by scene-adapter (decides re-export) and tsl-export (builds LightsNode).
// A TSL package bakes its LightsNode at export (one node per light OBJECT). Keying the baked set on the scene's CURRENT lights re-exports every
// material whenever a pooled light (DS torch pool) is added/removed/reordered. Instead: the baked set = every light ever seen in the scene
// (first-seen order, stable); a light that is currently detached/invisible reads intensity 0 via the live-uniform path (tsl-export defineLive).
// -> pool churn after warm-up changes uniforms only. Re-export happens only when a never-seen light object first appears.
export const isShadingLight = (o) => !!(o?.isLight && (o.isDirectionalLight || o.isPointLight || o.isAmbientLight || o.isHemisphereLight));
const reg = new WeakMap(); // scene -> { set:Set<Light> (insertion-ordered), gen:number }
export function lightRegistry(scene) { let r = reg.get(scene); if (!r) reg.set(scene, (r = { set: new Set(), gen: 0 })); return r; }
// fold the scene's current lights into the registry; returns { live:[lights now in scene], gen (bumps only on growth) }.
export function observeLights(scene) {
  const r = lightRegistry(scene), live = [];
  scene.traverse?.((o) => { if (isShadingLight(o)) { live.push(o); if (!r.set.has(o)) { r.set.add(o); r.gen++; } } });
  return { live, all: [...r.set], gen: r.gen };
}
