// render-api/light-registry.js — per-scene GROW-ONLY light set shared by scene-adapter (decides re-export) and tsl-export (builds LightsNode).
// A TSL package bakes its LightsNode at export (one node per light OBJECT). Keying the baked set on the scene's CURRENT lights re-exports every
// material whenever a pooled light (DS torch pool) is added/removed/reordered. Instead: the baked set = every light ever seen in the scene
// (first-seen order, stable); a light that is currently detached/invisible reads intensity 0 via the live-uniform path (tsl-export defineLive).
// -> pool churn after warm-up changes uniforms only. Re-export happens only when a never-seen light object first appears.
import { leakGuards } from './native/page-memory.js'; // nt-frameleak
export const isShadingLight = (o) => !!(o?.isLight && (o.isDirectionalLight || o.isPointLight || o.isAmbientLight || o.isHemisphereLight));
const reg = new WeakMap(); // scene -> { set:Set<Light> (insertion-ordered), gen:number }
// nt-frameleak (native: leakGuards.weakRegistries, ?nativeWeakRegs=0 = old behaviour): the strong Set kept EVERY light ever seen alive for the scene's lifetime -- and a Light drags its whole
// parent chain (a detached enemy/effect subtree: geometry, materials, decoded textures). Weak mode: `ws` (WeakSet) answers "seen before?", `refs` (WeakRef[], first-seen order) preserves the stable
// baked order; a collected light simply drops out of `all` (gen only bumps on GROWTH, so the baked-set semantics for lights that are still alive are unchanged).
export function lightRegistry(scene) { let r = reg.get(scene); if (!r) reg.set(scene, (r = { set: new Set(), ws: new WeakSet(), refs: [], gen: 0, dead: 0 })); return r; }
const allAlive = (r) => { const out = []; let w = 0; for (let i = 0; i < r.refs.length; i++) { const l = r.refs[i].deref(); if (l) { out.push(l); r.refs[w++] = r.refs[i]; } else r.dead++; } r.refs.length = w; return out; };
// fold the scene's current lights into the registry; returns { live:[lights now in scene], gen (bumps only on growth) }.
export function observeLights(scene) {
  const r = lightRegistry(scene), live = [], weak = leakGuards.weakRegistries && typeof WeakRef !== 'undefined';
  scene.traverse?.((o) => { if (isShadingLight(o)) { live.push(o); if (weak) { if (!r.ws.has(o)) { r.ws.add(o); r.refs.push(new WeakRef(o)); r.gen++; } } else if (!r.set.has(o)) { r.set.add(o); r.gen++; } } });
  return { live, all: weak ? allAlive(r) : [...r.set], gen: r.gen };
}
/** nt-frameleak census: registry size (strong set + weak refs; dead = refs already collected). */
export function lightRegistryCensus(scene) { const r = reg.get(scene); return r ? { strong: r.set.size, weak: r.refs.length, dead: r.dead, gen: r.gen } : { strong: 0, weak: 0, dead: 0, gen: 0 }; }
