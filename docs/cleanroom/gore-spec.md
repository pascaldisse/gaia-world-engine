# gore extension — requirements (own design, Pascal 09-29 "2")
Source of these requirements = OUR game code only (EE `client/gore-fx.js` + `client/gfx-fx.js` call sites) + game needs. No third-party code/data/assets consulted or allowed.
Implementer reads: this file · engine WT (kernel, extension contract `client/kernel/extensions.js`, `client/extensions/timeline` as example) · three r180 webgpu/tsl docs · public refs below. NOT: any `boomtown-rampage/Assets/**`, any `lampas-ee-fx|lampas-gore` `client/extensions/gore/**`, `tools/gore/**`, `test/*gore*`.

## §1 Module + API (drop-in; served `/extensions/gore/index.js`)
- `export function createGore({ three, tsl, scene }, opts) → gore`. `opts = { recipes?, blood?: { seed?, capacity?: { decal? }, textures?, meshes? }, cut?: { seed?, lifetime? } }`. `recipes/textures/meshes` = OPTIONAL overrides; absent → built-in procedural look (§2). Unknown keys ignored.
- `export function register(ctx)` per engine extension contract (ctx.three/ctx.tsl may be absent → no-op, no throw).
- `gore.blood.splash(pos[3], normal[3], strength>0) → int` particles emitted (0 if capped/invalid).
- `gore.blood.pool(pos[3], normal[3], size>0) → handle|null` ground decal that grows to `size` m radius.
- `gore.cut(mesh, { part, impulse?[3] }) → { stump, piece } | null` — part ∈ `head|leftArm|rightArm|leftLeg|rightLeg`.
- `gore.cut(mesh, { plane: { point[3], normal[3] } }) → { stump, piece } | null` — world-space plane.
  - `stump`,`piece` = `three.Mesh` added to `scene` (the `createGore` scene), world transforms baked; `piece.userData.gore.velocity` = mutable length-3 array (caller overwrites in place), integrated by `update`.
  - null when plane misses mesh / result would be empty / degenerate. Never throws on valid mesh; bad input → null.
- `gore.release(obj) → boolean` — `obj` = a `stump` or `piece` returned by `cut`. Removes it from ALL internal lists + `scene`, disposes its geometry+materials. Idempotent (2nd call → false); unknown/invalid obj (null, foreign mesh, `{}`) → false, no throw. Releasing piece never touches its stump (independent). Released piece is no longer simulated by `update`.
- `opts.cut.lifetime?: number` (seconds, default absent/0 = never) — auto-expiry: piece AND stump auto-`release`d `lifetime` s after `cut`, driven by `update(dt)`. Bounds per-frame cost over long matches; callers may instead call `release` themselves.
- `gore.update(dt seconds)` advances particles, pools, piece motion (gravity, ground y=0 rest, damping).
- `gore.setRecipes(recipes)` = reset to initial state: clears ALL live particles/pools/decals; keeps GPU buffers.
- `gore.stats() → { particles, decals, pools, pieces }` (ints, live counts).
- `gore.dispose()` removes everything it added from scene + disposes geometry/material.

## §2 Blood look (own tunables; name + rationale in code)
- splash: dark-red droplets burst from pos along hemisphere around normal, count ∝ strength (≈20·strength), speed 1–4 m/s, gravity, life 0.4–1.2 s, shrink+fade; some droplets on ground contact spawn a small decal.
- pool: flat decal on ground, radius 0→size over ~2 s ease-out, persists, darkens slightly; oldest evicted at cap.
- colours/shapes procedural (TSL noise/radial masks); NO texture files required.
- Techniques (public): GPU instanced particles (three.js InstancedMesh / SpriteNodeMaterial docs); projected/flat ground decals (three.js DecalGeometry example).

## §3 Cut (own design)
- Non-skinned meshes REQUIRED (EE infantry). Skinned = best-effort (may bake current pose first) else null.
- part mode: part → axis-aligned band of the mesh's bounding box (head = top ~15% height; arms = upper-side thirds; legs = lower halves by x); split plane through band boundary. PLACEHOLDER tunables.
- plane mode: triangle–plane slicing (split straddling triangles, keep UV/normal interpolation), both halves capped (fill cut loop, triangulate, red cap material). Ref: standard mesh plane-clipping (e.g. Sutherland–Hodgman per triangle; ear-clipping for caps).
- materials cloned, not shared with source. Deterministic for same input + seed.

## §4 Hard limits
- GPU: every material/geometry ≤ 6 vertex buffers incl. instanced attrs (WebGPU max 8; live black-screen bug came from 9). Pack per-instance data into vec4s.
- Caps: particles default 2048, decals `capacity.decal` default 48, pools share decal cap; oldest evicted. All loops bounded.
- Seeded: same seed + same call sequence → identical particle/cut output (own PRNG, no Math.random).
- No per-frame allocation in update hot path.

## §5 Acceptance tests (given/when/then; each must fail under the noted mutant)
1. splash(strength 2) → returns >0, stats.particles grows; mutant: emit 0 → RED.
2. particles expire after max life + update → stats.particles back to 0; mutant: no expiry → RED.
3. particle cap: splash ×N beyond cap → stats.particles == cap; mutant: cap removed → RED.
4. decal cap: pool ×(cap+5) → stats.decals == cap, oldest gone; mutant: evict newest → RED.
5. setRecipes() → all counts 0 AND scene children for decals/particles hidden/removed; mutant: counts reset only → RED.
6. dispose() → scene has no gore children, geometries disposed (spy); mutant: skip remove → RED.
7. vertex-buffer budget: enumerate every geometry+material the extension creates → attribute count ≤ 6; mutant: add one attr → RED (threshold 6).
8. cut plane on unit cube → stump+piece closed (every edge shared by 2 tris), volumes sum ≈ 1 (±1e-3); mutant: no cap → RED.
9. cut plane missing mesh → null, source untouched.
10. cut part 'head' on a box-man fixture (non-skinned) → piece bbox above neck band; each part → distinct piece.
11. determinism: same seed twice → identical particle positions after 10 updates & identical cut vertex arrays; mutant: Math.random → RED.
12. piece motion: velocity set → update moves piece, rests at y≥0; mutant: velocity ignored → RED.
13. register(ctx without three) → no throw.
14. real three r180 webgpu+tsl construct test (skip only if module missing; report skip count).

15. release(piece|stump) → true, stats.pieces & internal lists back to 0, off scene, geometry disposed; 2nd call/unknown → false; cut.lifetime auto-expiry empties lists; mutants: release not splicing list / not disposing / expiry off → RED.

## §6 UNSPECIFIED (implementer free)
exact colours, droplet shape, pool noise, cap material look, arm/leg band fractions, damping constants, file layout.
