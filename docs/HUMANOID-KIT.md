# HUMANOID KIT — survey + gaps (stage 1)

branch `lampas/humanoid-kit` (off `rust-port`) · order: Pascal 2026-10-02 21:01 "model humanoids ONCE, then only change colors, costumes, parameters to generate the rest"
spec → [`HUMANOID-KIT-SPEC.md`](HUMANOID-KIT-SPEC.md) · impl → `shared/humanoid.js`, `client/kernel/humanoid.js`, `client/plugins/humanoid-editor.js`

## 0 · Which client? (target)
| client | what | EE runs it? |
|---|---|---|
| `client/` (JS, vite, three 0.180 WebGPU) | the live engine client; EE = `dev.sh` → `?ext=/@fs<ee>/client/game.js` loaded INTO it | **YES → target** |
| `client-rs/` (Rust, DreamForge, branch `rust-port`) | spec-first native rewrite. CREATE.md §"Character editor package" = `char-editor` (parametric body/face/hair/outfit, humanoid→quadruped) → NARUKO W5, NOT built. FEATURES/CLIENT.md parity rows still list the JS VRM stack as "native Rust" TODO | no |
→ all kit code lands in JS `client/` + `shared/`. Data shape (`mesh.humanoid`) is plain world data → ports to client-rs `protocol.rs` (`mesh.vrm: Option<Value>` precedent, line 135) unchanged.

## 1 · What exists today (3 disjoint paths)
### A · `mesh.parts` + `characterCreator` (C key, `plugins/character-creator.js`, 276 L)
- builds ~20 PRIMITIVE parts (cylinders/boxes/spheres) from 11 scalars: skin/hair/iris/outfit colors, height/head/eye/hairLength/shoulders/hips
- presets (`neutral|nyari|chibi`) = JS object literals in the plugin, NOT files
- no skeleton, no skinning, no animation; each entity = ~20 `THREE.Mesh` + own geometry/material (view.js `makeGeometry`/`makePartMaterial`)
- output = `mesh` + `characterCreator` components via ops (spawn/update, undoable)
- verdict: parametric-by-construction BUT not a body; can't take a costume; doesn't scale to RTS

### B · `mesh.vrm` (V key, `plugins/vrm-editor.js` 362 L + `kernel/vrm.js` 562 L)
- `mesh.vrm = { src, edits:{colors,expressions,bones,nodes,meta}, idle, dance, animation }` (`shared/schema.js` mesh.fields.vrm)
- loader: `GLTFLoader + VRMLoaderPlugin + MToonNodeMaterial`; `removeUnnecessaryVertices` + `combineSkeletons` + `rotateVRM0`
- **colors**: slot = regex on VRoid material name `F<base>_<variant>_<slot>_<Region>_<nn>_<CAT>` (`SLOT_RULES`: iris/hair/tops/bottoms/shoes/…). Hard-wired to VRoid naming. `_ShadeColor` = 0.72×color. Mutates the instance's own materials.
- **bones**: `edits.bones` {VRM humanoid bone → uniform or [x,y,z] scale} via `vrm.humanoid.getRawBoneNode`; `PROPORTION_BONES` = 12 bones; slider 0.6–1.6. `edits.nodes` = raw bone by name-substring (bust/skirt J_Sec chains). Orientation-naive: scale axes = bone-local, no per-rig axis knowledge.
- **expressions** (VRM blendshapes), **idle/walk/dance/.vrma clips** (procedural + retargeted; priority dance>clip>walk>idle), spring bones. Good animation stack — humanoid-bone-name driven.
- **export**: in-place GLB patch (`patchVrmBytes`) → portable .vrm. **.vroid** master read/write (328 sliders; can't bake to mesh).
- templates = 4 whole VRoid exports, **15–19 MB each** (`client/assets/vrm/`): costume "swap" = swap the whole character
- verdict: best body editor today, but VRM-0.x/VRoid-only, per-instance everything (see perf), no costume slots, no teamColor, presets = none.

### C · `mesh.gltf` (`kernel/gltf.js` 192 L, static scene)
- `mountGltf`: per-URL template cache (one fetch/parse, one GPU copy of geometry+textures via `userData.shared`), `SkeletonUtils.clone` for skins ✓
- **materials cloned per instance** (`instance()` → `m.clone()`) so games can tint/fade per entity. At RTS scale this = N materials = N pipelines/uniform sets. This is the EE 2-fps bug's shape.
- spec = `{src, scale, rotation, position, solid}`. NO tint, NO params, NO costume, NO bone access, NO animation hook.
- EE units are glTF → they land HERE: zero customization.

### D · other
- `client/kernel/model.js` `mesh.model` = static OBJ props. `rain.js` proprio assumes a mounted VRM (`!NOBODY` otherwise).
- `view.js applyMesh(group, recipe)` is the single mount seam: `recipe.gltf` → `mountGltf`; `recipe.vrm` → `loadVRM` (token-guarded async, dispose-owned `kind:'mesh-part'` child). New source = new `recipe.<x>` branch + token.

## 2 · Perf evidence (why "model once" must also mean "GPU once")
- VRM: `loadVRM` caches BYTES only; every instance re-parses 15 MB → own geometry, own MToon materials, own skeleton. 100 avatars = 100 parses + 100 GPU copies. Fine for 3 hero avatars, fatal for an RTS.
- glTF: geometry shared ✓, materials per instance ✗.
- AGENTS.md law: *"Geometries/materials are cached by recipe and shared — never mutate a mesh part's material in place; identical recipes are the SAME material object."* The kit must obey: recolor = **pick a shared material from a (src-material, hex) cache**, never mutate/clone per instance.

## 3 · Gaps vs target
target = **1 base body + costume slots + color slots + body params → N characters**, any glTF humanoid (not only VRM), RTS-cheap.

| # | want | today | gap |
|---|---|---|---|
| G1 | base = any glTF w/ humanoid skeleton | VRM-only (B) or no skeleton (A) | rig-agnostic bone resolver: VRM / Mixamo / VRoid `J_Bip` names → one canonical set |
| G2 | costume slot → skinned piece | none | piece GLB skinned to SAME skeleton, rebound BY BONE NAME at load; geometry shared |
| G3 | color slots incl. `team` | VRoid-regex slots, in-place material mutation | slot = material name convention (+`extras.slot`); shared material cache keyed (material, hex) |
| G4 | body params (height/build/head/legs/…) | 12 raw bone sliders, axis-naive | named semantic params → bone scale rules, per-rig bone axes auto-measured |
| G5 | preset = JSON file; preset+overrides = unit | presets = JS literals (A) / none (B) | `mesh.humanoid = {preset, params, costume, colors, seed}`; presets are data files; deterministic merge |
| G6 | variant seed | `randomize()` uses `Math.random` in editor (A) | seeded PRNG in the resolver → same data = same unit on every client |
| G7 | hundreds of instances | VRM: per-instance parse; glTF: per-instance material | one template/base/piece; shared geometry + material cache; per-instance only skeleton + SkinnedMesh shells |
| G8 | editor: pick base, toggle slot pieces, sliders, color pickers, save preset, spawn-as-op | C/V editors each cover a fraction | new `humanoid-editor.js` (H key) over the single data shape; save preset JSON; spawn/update op (undoable) |
| G9 | animation hook | VRM stack bone-name driven but needs `VRM` object | kit exposes `userData.humanoid.bones` {canonical → Bone}; (idle/walk reuse = follow-up) |
| G10 | works in tests w/o browser | vrm.js imports `three/webgpu`+three-vrm (browser) | pure data core in `shared/humanoid.js` (no THREE) + THREE glue testable in node |

## 4 · Non-goals (v1)
- face morphs/expressions (VRM blendshapes stay VRM-only) · .vroid bake · per-vertex body morph targets · texture-layer paint · animation retarget lib · client-rs port
- mask-texture partial tint (stripes on one material) → v2; v1 = one material per slot

## 5 · Reuse (don't duplicate)
`shared/num.js r2` · `kernel/gltf.js` template-cache pattern · `three SkeletonUtils.clone` · editor plugin shape (`vrm-editor.js`: mount div, ops via `net.sendDev`, `history.push(undo, ops)`) · `kernel/geometry.js disposeOwn` (`userData.shared` honored)
