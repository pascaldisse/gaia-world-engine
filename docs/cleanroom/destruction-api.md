# destruction-api.md — PUBLIC API CONTRACT, engine `rayfire` extension
Companion to `destruction-spec.md` (behaviour). This file = exported names/signatures/shapes.
Derived from OUR consumers (read-only): EE `client/destruction-rayfire.js`, `client/building-lifecycle.js`,
`test/destruction-rayfire.test.mjs`, `test/building-lifecycle-rayfire.test.mjs`. Drop-in = those run unchanged.

## Entry
- file `client/extensions/rayfire/index.js` · `export function register(ctx?) -> { name:'rayfire', api }`
- `register()` w/o arg legal (consumers: `(await import(.../index.js)).register().api`). ctx ignored.
- also `export const api` + all names below as named ESM exports (same objects).
- URL served by engine: `/extensions/rayfire/index.js`. Bare imports: `three`, `three/addons/math/ConvexHull.js` only (render.js + hull.js).
- header every source file: `// GAIA-World-Engine destruction extension — original implementation (docs/cleanroom/destruction-spec.md)`

## Shapes
- vec `{x,y,z}` plain numbers. aabb `{min:vec,max:vec}`. triangle `[vec,vec,vec]` CCW-from-outside. soup `triangle[]`.
- face `{verts:vec[]≥3, interior:boolean, materialId:number}`. exterior materialId 0, interior 1.
- cell `{index, seedPoint:vec, faces, uncappedLoops:boolean, hullFallback:boolean}`.
- fragment (`demolishMesh` out) `{index, seedPoint, faces, volume, centroid, aabb, depth, demolition, uncappedLoops, hullFallback}`.
  - `volume` ≥1e-9 (floored) · `centroid` = mean of own face vertices · `depth`=0 · `demolition={am,var,dpf,bias,sd,depth:1}` with `am=nextFragmentAmount(parent am,dpf)`.
- joint `{i,j,broken:boolean, strength?, area?, stress?}` i,j index fragment array.
- "fragment-like" record accepted by structure fns: `{volume, centroid, aabb, unyielding?}` (consumer passes its own records).
- body `{id, position, rotation(euler), velocity, angularVelocity, mass, shape, kinematic, awake, sleepCounter}`; `shape={type:'sphere',radius}|{type:'obb',halfExtents}`.

## API surface (every name on `register().api`) — §16.38 checks EXACTLY this list
### math / determinism
- `v3(x=0,y=0,z=0) -> vec`
- `createRng(seed) -> () => number∈[0,1)` (uint32-coerced, deterministic)
- `mixSeed(seed, salt) -> uint32` · `rand01(seed, ...keys) -> number∈[0,1)` stateless keyed roll (pair/shard-keyed randomness)
- `RFX_NAMES` frozen table of every rfX-prefixed identifier the extension emits (see naming law)
### fracture core (pure, no THREE except hull.js)
- `meshVolume(triangles) -> signed number` (divergence theorem; unit box CCW = +1)
- `facesVolume(faces) -> signed number`
- `isWatertight(facesOrTriangles) -> boolean` (§3.5; accepts face[] or triangle[]; empty=false)
- `closeOpenShell(triangles, opts?) -> { faces:face[], uncappedLoops:boolean, capped:number }` (§3.4 step 1)
- `fractureCells(triangles, opts) -> cell[]` opts `{amount=15, seed=1, variation=0, bias=0, biasPoint?:vec, interiorMaterial=1, exteriorMaterial=0}` (also accepts `am`,`sd`,`var`). ≤amount cells, all watertight+positive volume.
- `nextFragmentAmount(am, dpf) -> int` = max(3, trunc(am*dpf))
- `DEMOLITION_DEFAULTS` = `{am:15,var:0,dpf:0.5,bias:0,sd:1}` frozen
- `demolishMesh(triangles, opts) -> fragment[]` opts = DEMOLITION_DEFAULTS keys + `biasPoint`.
### render / THREE glue
- `facesToBufferGeometry(faces) -> THREE.BufferGeometry` non-indexed; `position`+`normal`; flat normals; groups: 0=exterior(mat 0), 1=interior(mat 1) (group 1 absent if no interior faces); bbox+sphere computed.
- `geometryToTriangles(geometry) -> soup` (indexed or not)
- `fracture(input, opts) -> THREE.Mesh[]` input Object3D-with-`.geometry` | BufferGeometry, else throws `/fracture: input/`. Mesh `material=[outer,inner]` (`opts.materials` `{outer,inner}` or defaults); Object3D input ⇒ `matrixAutoUpdate=false`, `matrix.copy(source.matrixWorld)`; `userData.rayfire={index,centroidLocal,aabbLocal}`.
- `demolish(target, opts) -> { meshes, world, bodies, closest }` opts: fracture opts + `point`(vec/Vector3 world) `impulse`(vec | number ⇒ along +y) `world`(RFWorld, else new) `impulseMode`. `bodies`=body objects (1/fragment, dynamic, sphere shape from aabb, world centroid); `mesh.userData.rayfire.bodyId` set; `closest`=index of fragment with world-centroid nearest `point` (impulsed one). No `point` ⇒ closest=-1, no impulse.
### rigid sim
- `class RFWorld({gravity=v3(0,-9.81,0), groundY=0, sleepLinear=0.02, sleepFrames=10, restitution=0.05, friction=0.6})`
  - `bodies: Map<id,body>` (ids strictly increasing, never reused) · `gravity` `groundY` readable
  - `addBody({position, shape, mass=1, kinematic=false, velocity?, angularVelocity?, rotation?}) -> id`
  - `removeBody(id) -> boolean` · `getBody(id) -> body|undefined` (LIVE object)
  - `step(dt)` · `applyImpulse(id, impulse, mode='impulse'|'velocityChange')` · `applyAngularVelocity(id, angVel)` · `raycast(origin, direction, maxDistance=Infinity) -> {id,point,distance,normal}|null`
- `RF_WORLD_DEFAULTS` frozen.
### structure
- `pointInBox(point, {center,size}) -> boolean` inclusive · `markUnyielding(fragments, box) -> count`
- `buildAdjacency(fragments, {expand=0}) -> [i,j][]` (i<j, AABB overlap)
- `assignJointStrength(edges, fragments, {breakForce=100,breakForceVar=10,forceByMass=false,seed=1}) -> joint[]`
- `breakJoints(joints, forceAt(i)->number) -> count`
- `connectedComponents(fragmentCount, joints) -> number[][]` (each sorted asc; components ordered by min index)
- `partitionByUnyielding(components, fragments) -> {held:number[][], released:number[][]}`
- `computeSupport(fragments, joints, {support=45, gravity=v3(0,-1,0)}) -> boolean[]`
- `tickErosion(joints, fragments, supported, {erosion=1,threshold=100,gravity}) -> newlyBrokenCount`
### collapse
- `CollapseType = {BY_AREA:'byArea', BY_SIZE:'bySize', RANDOM:'random'}` frozen
- `removeByArea(joints, fragments, minArea, {var=0,seed=0}) -> count` · `removeBySize(joints, fragments, minSize, {var=0,seed=0}) -> count` · `removeRandom(joints, fragments, percent, {seed=0}) -> count`
- `collapseStep(joints, fragments, percentage, opts) -> count` opts `{type=BY_AREA, min?, max?, var=0, seed=0}`; threshold=lerp(min,max,percentage/100). Defaults when min/max absent: BY_AREA 0..1.0001×max joint area(default area 1); BY_SIZE 0..1.0001×max fragment volume; RANDOM 0..100 ⇒ percent=percentage.
- `runCollapseSteps(joints, fragments, opts) -> [{step,percentage,removed}]` opts `{type,start=0,end=75,steps=10,duration=15,var=0,seed=0,min?,max?}`; steps+1 samples. `COLLAPSE_DEFAULTS` frozen.
- Protection: joint with an `unyielding` endpoint is never removed by any rule.
### activation
- `createActivationState({off=0,vel=0,dmg=0,con=false,uny=false,atb=false,seed=1}) -> state` (`state.activated=false`)
- `shouldActivate(state, body, {damage=0, connectivityLost=false}) -> boolean`
- `activate(state, world, bodyId) -> boolean` kinematic→dynamic, wake, seeded ≤0.3 rad/s/axis spin iff body perfectly still; idempotent.
### fade
- `FadeType = {NONE:'none', DESTROY:'destroy', SCALE_DOWN:'scaleDown'}` frozen
- `createFadeState(seed) -> {age:0, phase:'living'|'fading'|'faded', scale:1, removed:false, roll}` 
- `tickFade(state, dt, {fadeType=SCALE_DOWN, fadeTime=5, lifeTime=7, lifeVariation=3}) -> state` (mutated + returned); lifetime=max(0,lifeTime+(2·roll−1)·lifeVariation).
- `FADE_DEFAULTS` frozen.
### impulses
- `explode(world, fragments, position, {range=5,strength=1,variation=50,chaos=30,forceByMass=true,seed=1}) -> affected[]` fragments need `bodyId`; affected=`[{index,bodyId,distance,magnitude}]`
- `shoot(world, origin, direction, {strength=10,maxDistance=1000}) -> {hit,impulse}|null` hit=raycast result; mode velocityChange.

## Naming law
Any attribute/uniform/varying identifier the extension emits (none required today: debris uses stock materials, flat normals are position-derived) MUST start `rfX`, ∉ WGSL reserved words (W3C WGSL §keywords/§reserved-words, https://www.w3.org/TR/WGSL/#keyword-summary, #reserved-words). `RFX_NAMES` is the single table; test `rayfire-index.test.js` scans sources.

## Consumer-relied behaviours (test-pinned)
- `createCrumble` loop: `world.bodies.size` after N addBody/removeBody exact; `world.getBody(removedId)===undefined`.
- kinematic body not integrated, not ground-clamped; `activate` makes dynamic ⇒ clamped to `groundY+radius`.
- `body.awake===false` ⇒ asleep (fade trigger). dt clamped by consumer ≤0.05 ⇒ sleep must be reachable at dt=0.05.
- `collapseStep(joints, records, pct, {type: RANDOM, seed})` must not throw for record arrays w/o `area`.
- cache purity: `fractureCells`/`demolishMesh` never mutate input triangles, no module state ⇒ same (soup,seed) → deep-equal output.
