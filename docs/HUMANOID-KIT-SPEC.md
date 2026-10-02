# HUMANOID KIT — spec (stage 2)

survey/gaps → [`HUMANOID-KIT.md`](HUMANOID-KIT.md) · law: **model the body ONCE; everything else = data** (colors, costume pieces, params, seed).
unit = `preset` + overrides. N units = N small JSON docs → 1 base GLB + k piece GLBs + c cached materials.

## 0 · Laws
- L1 data only: whole unit look = `mesh.humanoid` JSON. same data ⇒ same unit on every client (seeded PRNG, no `Math.random`).
- L2 GPU once: geometry per (GLB) shared; material per (src-material, hex) shared; NEVER per-instance clone, NEVER mutate a template material (AGENTS.md perf law).
- L3 rig-agnostic: any glTF w/ a humanoid skeleton. bone names resolve to one canonical set (VRM humanoid names) via aliases (VRM · Mixamo · VRoid `J_Bip`). VRM-file NOT required.
- L4 pieces rebind BY BONE NAME to the base skeleton at load. piece skeleton may use a different naming scheme than the base.
- L5 pure core (`shared/humanoid.js`, no THREE) = resolve/merge/seed/param→scale solve; THREE glue (`client/kernel/humanoid.js`) = load/rebind/apply. both node-testable.
- L6 engine ≠ game: kit code + placeholder assets live in engine; a game ships its OWN base/pieces/presets as world assets, zero engine edits.

## 1 · Component `mesh.humanoid`
```jsonc
{ "preset":  "humanoid/presets/soldier.json",   // optional URL (§10). preset values = defaults
  "base":    "humanoid/base.glb",                // overrides preset.base
  "params":  { "height":1.05, "build":0.9, "legLength":1.1 },   // §5 named body params; omitted = preset → 1
  "bones":   { "head":1.1, "leftUpperArm":[1,1.2,1] },         // escape hatch: canonical bone → scalar|[x,y,z] (multiplies on top of params)
  "costume": { "head":"humanoid/costume/helmet.glb", "torso":"…/armor.glb", "legs":null },  // slot → piece URL | null (explicit empty)
  "colors":  { "skin":"#e8b894", "primary":"#2a4d8f", "team":"#d22" },  // slot → hex (incl. `team`)
  "seed":    1234,                               // number|string; drives preset.vary for keys NOT set here
  "scale":1, "position":[0,0,0], "rotation":[0,0,0],   // placement of the model inside the entity (as mesh.gltf)
  "solid":false }
```
- everything optional; `{base}` alone = bare mannequin. no `base` after merge ⇒ nothing mounts + console warn.
- `team` is just a color slot (convention). a game changes team by `set mesh.humanoid.colors.team` → shared-material swap, no reload.
- facing: base faces **+Z** at rest, feet at y=0, origin between feet. (glTF convention.)

## 2 · Preset file (JSON, world or engine asset)
same shape as §1 plus:
```jsonc
{ "name":"soldier", "extends":"humanoid/presets/base-human.json",   // optional single parent (depth ≤4, cycles → error)
  "base":"…", "params":{…}, "costume":{…}, "colors":{…},
  "vary": {                                            // used ONLY when a seed is given
    "params":   { "height":0.06, "build":0.10 },       // name → ±amplitude around merged value
    "palettes": { "skin":["#f1c7a8","#8f5f4d"], "hair":["#20130f","#efe7d0"] },   // slot → pick one hex
    "costume":  { "head":[null,"…/helmet.glb","…/cap.glb"] } } }          // slot → pick one (null = none)
```
- **merge order** (later wins): `extends` chain (parent→child) → preset → unit overrides. objects deep-merge per key; `costume.<slot>: null` clears; `vary` replaced whole by the nearest definer.
- presets are DATA FILES. preset = recipe, unit = preset + overrides + seed. "save preset" in the editor writes this file.

## 3 · Resolve (pure) — `resolveHumanoid(unit, preset)` → concrete
```
concrete = { base, params:{all PARAM_DEFS filled+clamped}, bones:{canon→[x,y,z]}, costume:{slot→url|null}, colors:{slot→#rrggbb}, key }
```
1. merge (§2). 2. if `seed` present: for every `vary.*` entry whose key was **not set by the unit itself** (unit explicit > seed > preset): draw u∈[0,1) from stream `rng(seed, "<kind>.<key>")` = `mulberry32(hash32(seed+"|"+path))()` first output (per-key streams ⇒ adding/reordering keys never reshuffles others). params: `v + (2u-1)·amp`; palettes/costume: `list[floor(u·len)]`. 3. clamp params to ranges; hex normalize `#rgb|#rrggbb` → lowercase `#rrggbb`. 4. `key` = `hash32(canonical JSON)` hex — identity for diagnostics/tests.
- no `Math.random` anywhere in resolve. editor "🎲" = pick new integer seed → stored as data.

## 4 · Rig — canonical bones + aliases
canonical = VRM humanoid names: `hips spine chest upperChest neck head leftEye rightEye jaw {left,right}{Shoulder UpperArm LowerArm Hand UpperLeg LowerLeg Foot Toes}` + fingers `{thumb:Metacarpal|Proximal|Distal, index|middle|ring|little: Proximal|Intermediate|Distal}`.
- `canonicalBone(name)`: lowercase, strip non-alnum (three's GLTFLoader already drops `:` from `mixamorig:Hips` → `mixamorigHips`; both normalize equal), strip `mixamorig\d*` prefix → lookup in generated table:
  - VRM: `hips`, `leftUpperArm` … · Mixamo: `Hips Spine Spine1 Spine2 Neck Head LeftShoulder LeftArm LeftForeArm LeftHand LeftUpLeg LeftLeg LeftFoot LeftToeBase`, `LeftHandThumb1..3`, `LeftHandIndex1..3` … · VRoid: `J_Bip_C_Hips`, `J_Bip_L_UpperArm`, `J_Bip_L_Index1` …
  - Mixamo `Spine1`→`chest`, `Spine2`→`upperChest`.
- unresolved names are legal (cape bones, props). they never take params; on rebind they fold to nearest mapped ancestor (§6).
- **axes**: bone-local axes differ by rig (VRM-normalized world-aligned; Mixamo-FBX rotated). `lengthAxis(bone)` = argmax |component| of the first mapped child bone's local `position` (leaf bones: parent's axis). measured ONCE per base template. param rules in 'length'/'width' mode use it.
- limitation: counter-scaling children is NOT done; bone scale propagates down the chain (same as vrm editor). rules (§5) are chosen so propagation is the desired look; extreme values distort feet/hands slightly → ranges are conservative.

## 5 · Params (named, unitless, 1 = neutral)
| param | range | rule (canonical bones · mode) |
|---|---|---|
| `height` | .5–1.8 | instance root, uniform |
| `build` | .6–1.6 | `hips` width (non-length axes) → propagates to torso/limbs/head |
| `torsoLength` | .7–1.4 | `spine chest upperChest` length |
| `shoulders` | .7–1.4 | `leftShoulder rightShoulder` length (clavicle → arm spacing) |
| `neckLength` | .6–1.6 | `neck` length |
| `headScale` | .7–1.5 | `head` uniform |
| `armLength` | .7–1.4 | `*UpperArm *LowerArm` length |
| `legLength` | .7–1.4 | `*UpperLeg *LowerLeg` length |
| `handScale` | .6–1.6 | `*Hand` uniform |
| `footScale` | .7–1.4 | `*Foot` uniform |
- modes: `uniform`→[s,s,s]; `length`→s on the bone's length axis; `width`→s on the other two. several rules on one bone multiply; `bones` overrides multiply last. bones absent from the rig are skipped silently.
- `solveBoneScales(concrete, {axes, has})` → `{root, bones:{canon→[x,y,z]}}` pure; THREE glue just writes `bone.scale`.
- "build" via hips-only is deliberate: costume pieces skin to the SAME bones ⇒ they deform with the body automatically (armor on a heavy build just fits).

## 6 · Costume pieces
authoring contract (any DCC): export a GLB containing (a) the humanoid skeleton — any subset that includes the ancestor chain of the bones used — in the **same rest pose as the base**, (b) `SkinnedMesh`es bound to it, (c) optional **rigid** meshes parented under a bone node (weapon in hand, plume on head). materials named by color slot (§7).
- **skinned** piece mesh → per instance: `new SkinnedMesh(sharedGeometry, sharedMaterial)`; `skeleton = new Skeleton(mappedBones, piece.boneInverses)` where `mappedBones[i]` = the INSTANCE's base bone for piece bone i: `canonicalBone(pieceBone.name)` → base canonical map; unmapped → nearest mapped ancestor in the piece hierarchy; none → `hips` (reported). **geometry is never touched** (no skinIndex rewrite) ⇒ geometry shared across all instances AND all bases that share the pose.
- **rigid** piece mesh → cloned (shared geometry/material) and reparented under the base bone for the nearest mapped ancestor in the piece, local transform kept.
- **drift report** (`rebind.report`): per mapped bone, max|Δ| between piece boneInverse and base boneInverse (same canonical bone). `> 1e-3` ⇒ warn `{bone, drift}`: piece authored against a different rest pose (mismatch = visible offset). v1 reports, doesn't fix.
- slots are free strings in data. convention (kit default): `hair head torso legs feet back weaponR weaponL`. one piece per slot; layering conflicts are the author's (radii/offsets).
- `frustumCulled=false` on kit skinned meshes (param scaling invalidates bind-pose bounds; per-instance recompute is O(verts)). perf note §8.

## 7 · Color slots
- slot of a material: `material.userData.slot` (glTF `extras.slot`) else `name` : exact slot, or slot + `[._:\- ]` or `_` suffix (`skin.001`, `primary_trim`); longest slot wins. defaults `skin hair eyes primary secondary accent trim metal team`; kit.json may declare more.
- apply = `acquireMaterial(srcMaterial, hex)` → cache key `srcMaterial.uuid|hex` → one clone (`userData.shared=true`, `color.set(hex)`; map stays ⇒ tint multiplies texture) shared by every instance asking the same pair; **refcounted**, released on despawn/rebuild, disposed at 0.
- slot not colored in `concrete.colors` ⇒ mesh keeps the TEMPLATE material (shared, zero clones).
- v1 = one material per slot. mask-texture partial tint (stripes) → v2.
- cost: distinct (material,hex) pairs, NOT instances. 500 units over 8 teams × 6 slots ≤ 48 materials. palettes (`vary.palettes`) bound the count by design. `color` is a uniform ⇒ new hex ≠ shader recompile.

## 8 · Perf model (RTS)
| thing | shared across instances | per instance |
|---|---|---|
| GLB fetch/parse | URL template cache (base + each piece) | — |
| geometry, textures | yes (`userData.shared`) | — |
| materials | (src-material, hex) cache, refcounted | — |
| boneInverses | piece's array | — |
| skeleton | — | `SkeletonUtils.clone` of base (~20–65 bones) + one `Skeleton` per skinned piece mesh |
| draw calls | — | 1 per skinned mesh (base + each piece mesh). skinned meshes can't be GPU-instanced ⇒ keep pieces few, merge materials. 100 units × (1 base + 4 pieces) = 500 calls |
- not in v1: far-LOD impostors / vertex-animation-texture instancing (needed beyond ~500 on-screen). `userData.humanoid.bones` is exposed so an animation/instancing layer can attach later.
- unit tests prove: 100 mounts ⇒ 1 base load, 1 geometry/mesh, ≤ colors×slots materials, 0 materials cloned per instance.

## 9 · `kit.json` (catalog for tools; NOT read by the renderer)
```jsonc
{ "name":"placeholder",
  "bases":   { "mannequin":"/assets/humanoid/base.glb" },
  "slots":   { "head":{"pieces":{"helmet":"/assets/humanoid/costume/helmet.glb",…}}, … },
  "colorSlots":["skin","hair","primary",…,"team"],
  "presets": { "soldier":"/assets/humanoid/presets/soldier.json" } }
```
a game ships its own kit.json (EE: its own base + pieces) — editor loads any kit URL.

## 10 · URL rules
`http(s)://…` as-is · starts with `/` → **client origin** (engine-bundled `client/assets/…`, like `/assets/vrm/`) · otherwise → **world asset** on the world server (`<GAIA_WORLD>/assets/…`, like `mesh.gltf`). unknown/failed URL ⇒ status `error`, console.error, entity renders nothing (no throw).

## 11 · Engine seams
- `shared/schema.js` `mesh.fields.humanoid` (documented in `GET /schema`).
- `view.applyMesh`: `recipe.humanoid` → `mountHumanoid(group, spec, token, onReady)`; token-guarded (newer applyMesh supersedes), child `kind:'mesh-part'`, `userData.humanoid = {bones, params, concrete, release()}`.
- `view.js disposeObject` calls `userData.humanoid.release()` (material refcounts, skeleton textures) — idempotent.
- `set mesh` ops restyle live (same patch protocol as vrm).

## 12 · Editor (`client/plugins/humanoid-editor.js`, **H** in creator mode)
kit URL → base · preset dropdown · per-slot piece dropdown (+ none) · 10 param sliders · color slot pickers · seed + 🎲 · entity id · buttons: `spawn/update` (undoable op) · `load selected` · `save preset` (downloads JSON; with `extends`/`vary` untouched) · live preview = local `view.applyMesh` on the target entity group (no op per slider tick; op only on spawn/update).

## 13 · Tests
- `test/humanoid-core.test.js`: canonicalBone (3 rigs), merge/extends/cycle, seed determinism + per-key stream stability + explicit>seed>preset, clamp/hex, solveBoneScales (modes, axes), slotOfMaterialName, validate.
- `test/humanoid-rebind.test.js`: real THREE + generated GLBs: rebind by name (cross-rig piece), geometry sharing, material cache/refcount, params applied to bones, rigid attach, drift report, 100-instance sharing, dispose.
- live: 3 variants × 1 base in the real client, screenshots (§ stage 4).

## 14 · Non-goals / open
face morphs · animation (idle/walk clips on kit bodies) · far LOD/instancing · mask tint · piece auto-fit across different rest poses · client-rs port (data shape is portable) · EE base arrives from a parallel lane — swap `base` URL + kit.json, nothing else.
