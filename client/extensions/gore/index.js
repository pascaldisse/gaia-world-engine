// GAIA-World-Engine gore extension — original implementation (docs/cleanroom/gore-spec.md)
//
// §1 module + API. `createGore` is the drop-in factory an existing game
// consumer calls directly; `register` is the engine extension-contract entry
// point (client/kernel/extensions.js: `register(ctx)` → `{name, api, update}`,
// ctx.three/ctx.tsl may be absent → no-op, never throw).
import { BloodParticles } from './blood-particles.js';
import { BloodPools } from './blood-pools.js';
import { GoreCut } from './cut.js';
import { makeRng } from './rng.js';

/**
 * @param {{ three:any, tsl:any, scene:import('three').Scene }} gpu
 * @param {{ recipes?:any, blood?:{ seed?:number, capacity?:{decal?:number,particles?:number} },
 *           cut?:{ seed?:number } }} [opts]
 */
export function createGore({ three, tsl, scene }, opts = {}) {
  if (!three || !tsl || !scene) throw new Error('createGore requires { three, tsl, scene }');

  const bloodSeed = opts.blood?.seed ?? 1;
  const particleCapacity = opts.blood?.capacity?.particles ?? 2048;
  const decalCapacity = opts.blood?.capacity?.decal ?? 48;
  const cutSeed = opts.cut?.seed ?? 1;

  const rng = makeRng(bloodSeed);
  const pools = new BloodPools({ three, tsl }, scene, { capacity: decalCapacity });
  // §2 "some droplets on ground contact spawn a small decal" -- wired through
  // the shared decal ring (§4 "pools share the decal cap").
  const particles = new BloodParticles({ three, tsl }, scene, rng, {
    capacity: particleCapacity,
    onGroundContact: (pos, normal, size) => pools.decal(pos, normal, size),
  });
  const cut = new GoreCut({ three }, scene, { seed: cutSeed });

  const gore = {
    blood: {
      splash: (pos, normal, strength) => particles.splash(pos, normal, strength),
      pool: (pos, normal, size) => pools.pool(pos, normal, size),
    },
    cut: (mesh, options) => cut.cut(mesh, options),
    update(dt) {
      particles.update(dt);
      pools.update(dt);
      cut.update(dt);
    },
    // §1 "reset to initial state: clears ALL live particles/pools/decals;
    // keeps GPU buffers." `recipes` themselves are procedural (§2 "colours/
    // shapes procedural ... NO texture files required"); an override object
    // is accepted but this pass only implements the reset-to-empty contract
    // (no re-tunable recipe table exists yet to apply on top — §6 unspecified).
    setRecipes(_recipes) {
      particles.reset();
      pools.reset();
    },
    stats() {
      const poolStats = pools.stats();
      return { particles: particles.stats(), decals: poolStats.decals, pools: poolStats.pools, pieces: cut.stats() };
    },
    dispose() {
      particles.dispose();
      pools.dispose();
      cut.dispose();
    },
  };
  return gore;
}

/** Engine extension contract (client/kernel/extensions.js). */
export function register(ctx) {
  if (!ctx || !ctx.three || !ctx.tsl || !ctx.scene) return {}; // no-op, no throw (§5 test 13)
  const gore = createGore({ three: ctx.three, tsl: ctx.tsl, scene: ctx.scene }, ctx.goreOpts ?? {});
  return { name: 'gore', api: gore, update: (dt) => gore.update(dt) };
}

export default register;
