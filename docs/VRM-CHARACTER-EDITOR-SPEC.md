# VRM Character Editor — Compatibility & Implementation Spec

**Target:** a character editor plugin for GAIA-World-Engine with **100% VRM file
compatibility** (load / edit / save the exact files VRoid Studio produces) and an
**editor feature surface matching VRoid Studio**.

**Status of this doc:** format analysis complete and verified against real files.
Every number below was measured from actual VRoid exports in
`~/Projects/nyari-body/` (see *Provenance*). This is the build sheet — an
implementer (Fable) can work straight from it without re-deriving anything.

**Nature of the work:** this is standards interoperability. VRM is an open format
built on Khronos glTF 2.0 with publicly documented extensions. Everything here is
"read the open interchange format and support it correctly." Nothing beyond the
files themselves is required — the slider names in §7 come from the open parameter
catalog (`vroid-parameter-catalog.json`).

---

## 0. TL;DR for the implementer

1. Add `@pixiv/three-vrm@^3.5.4` (peer `three >=0.137`; engine ships `three@0.180.0` ✓).
2. Load VRM via `GLTFLoader` + `VRMLoaderPlugin` → get `vrm.scene`, `vrm.humanoid`,
   `vrm.expressionManager`, `vrm.springBoneManager`, `vrm.materials`.
3. Mount `vrm.scene` into the engine as a new mesh-source kind (§6) alongside the
   existing primitive `parts` system in `client/kernel/view.js → applyMesh()`.
4. Editor edits map to VRM data: colors → MToon material props, expressions →
   `expressionManager`, proportions → humanoid bone transforms, wardrobe/hair →
   per-primitive material+texture swaps (§5, §7).
5. Save: re-export the (possibly edited) glTF to GLB and re-attach the `VRM`
   extension block (§8). Round-trip must preserve humanoid, blendShapeMaster,
   secondaryAnimation, materialProperties, and meta byte-for-semantics.
6. Templates: the three `cand-*.vrm` sample avatars + `nyari-final.vrm` are ready
   editable bases (§9).

---

## 1. Container format (verified)

All VRoid exports are **GLB v2** (binary glTF 2.0):

```
[12B header: magic 'glTF', version=2, totalLength]
[chunk 0: 'JSON' — the glTF document, UTF-8]
[chunk 1: 'BIN\0' — geometry + textures buffer]
```

Verified files (`analyze_vrm.py`):

| file | size | GLB | meshes | materials | textures | accessors | skins | nodes | morph targets |
|---|---|---|---|---|---|---|---|---|---|
| cand-Sakurada_Fumiriya | 18.9 MB | v2 | 3 | 17 | 30 | 198 | 3 | 112 | 390 |
| cand-Sendagaya_Shino | 14.7 MB | v2 | 3 | 17 | 30 | 167 | 3 | 153 | 410 |
| cand-Victoria_Rubin | 15.1 MB | v2 | 3 | 16 | 28 | 177 | 3 | 167 | 410 |
| nyari-final | 15.2 MB | v2 | 3 | 17 | 30 | 167 | 3 | 153 | 410 |

`extensionsUsed = ['KHR_materials_unlit', 'VRM']`. Exporter tag:
`VRoidStudio-0.8.1` (VRM 0.x exporter revision; the app itself is v2.14.0).

**Spec version: VRM 0.x** (`extensions.VRM`). A forward path to VRM 1.0
(`extensions.VRMC_vrm` + `VRMC_materials_mtoon` + `VRMC_springBone`) is in §10.
three-vrm loads both transparently, so the editor is version-agnostic on load; the
version choice matters only on **export** (§8).

---

## 2. Scene / mesh layout (the 3-mesh convention)

VRoid always emits exactly **three meshes**:

| mesh | role | morph targets | notes |
|---|---|---|---|
| `Face.baked` | head: face skin, eyes, brows, lashes, mouth | **all of them** (41 in Shino) | every blendshape binds here |
| `Body.baked` | body skin + worn clothing | 0 | multiple primitives = skin + garment slots |
| `Hair001.baked` | hair | 0 | many primitives (48 in Shino) — one per hair group/material |

Each mesh is split into **primitives**, one per material. Morph (blendshape)
targets live only on `Face.baked`; `mesh.extras.targetNames` carries their names.

---

## 3. Humanoid skeleton (VRM 0.x, 54 bones — exact)

`extensions.VRM.humanoid.humanBones[]`, each `{ bone, node }`. All four files carry
the **same 54-bone set**:

```
hips, spine, chest, upperChest, neck, head,
leftEye, rightEye,
leftShoulder, leftUpperArm, leftLowerArm, leftHand,
rightShoulder, rightUpperArm, rightLowerArm, rightHand,
leftUpperLeg, leftLowerLeg, leftFoot, leftToes,
rightUpperLeg, rightLowerLeg, rightFoot, rightToes,
leftThumbProximal, leftThumbIntermediate, leftThumbDistal,
leftIndexProximal, leftIndexIntermediate, leftIndexDistal,
leftMiddleProximal, leftMiddleIntermediate, leftMiddleDistal,
leftRingProximal, leftRingIntermediate, leftRingDistal,
leftLittleProximal, leftLittleIntermediate, leftLittleDistal,
rightThumb{Proximal,Intermediate,Distal},
rightIndex{Proximal,Intermediate,Distal},
rightMiddle{Proximal,Intermediate,Distal},
rightRing{Proximal,Intermediate,Distal},
rightLittle{Proximal,Intermediate,Distal}
```

This is the standard VRM 0.x humanoid (all required bones + `upperChest` and full
finger chains). three-vrm exposes it as `vrm.humanoid.getRawBoneNode(name)` /
`getNormalizedBoneNode(name)`. Body-proportion editing (§5) drives these.

---

## 4. Materials — the MToon model (verified key set)

Every material uses shader **`VRM/MToon`** (17/17 in Shino; also
`KHR_materials_unlit` in extensionsUsed for the unlit fallback). Each entry in
`extensions.VRM.materialProperties[]` has:

- `name`, `shader: "VRM/MToon"`, `renderQueue`
- `floatProperties`:
  `_Cutoff, _BumpScale, _ReceiveShadowRate, _ShadingGradeRate, _ShadeShift,
   _ShadeToony, _LightColorAttenuation, _IndirectLightIntensity, _OutlineWidth,
   _OutlineScaledMaxDistance, _OutlineLightingMix, _DebugMode, _BlendMode,
   _OutlineWidthMode, _OutlineColorMode, _CullMode, _OutlineCullMode, _SrcBlend,
   _DstBlend, _ZWrite`
- `vectorProperties` (RGBA + tex-ST):
  `_Color, _ShadeColor, _EmissionColor, _OutlineColor,
   _MainTex, _ShadeTexture, _BumpMap, _ReceiveShadowTexture, _ShadingGradeTexture,
   _SphereAdd, _EmissionMap, _OutlineWidthTexture`
- `textureProperties`: `_MainTex, _ShadeTexture, _BumpMap, _SphereAdd, _EmissionMap`
- `keywordMap`: e.g. `{ "_NORMALMAP": true }`
- `tagMap`: e.g. `{ "RenderType": "Opaque" }`

**Color editing contract:** the base color is `_Color` (RGBA, linear 0–1) and the
toon shadow tint is `_ShadeColor`. Recolor = write both (VRoid keeps `_ShadeColor`
a darker multiple of `_Color`). three-vrm materializes these as `MToonMaterial`
instances in `vrm.materials`; set `.uniforms` / material color and flag
`needsUpdate`. On save, mirror back into `materialProperties`.

### 4.1 Semantic slot map (from material names — closes the "which slot" gap)

VRoid names materials `F<base>_<variant>_<slot>_<Region>_<nn>_<CATEGORY>`. The
**suffix category** and the region token identify the slot directly from the file
— no runtime probing needed:

| material name (Shino) | category | editor slot |
|---|---|---|
| `..._Face_00_SKIN` | SKIN | face skin |
| `..._Body_00_SKIN` | SKIN | body skin |
| `..._EyeIris_00_EYE` | EYE | **iris color** |
| `..._EyeWhite_00_EYE` | EYE | sclera |
| `..._EyeHighlight_00_EYE` | EYE | eye highlight |
| `..._EyeExtra_01_EYE` | EYE | eye extra |
| `..._FaceEyeline_00_FACE` | FACE | eyeline |
| `..._FaceEyelash_00_FACE` | FACE | eyelash |
| `..._FaceBrow_00_FACE` | FACE | eyebrow |
| `..._FaceMouth_00_FACE` | FACE | mouth/lip |
| `..._HairBack_00_HAIR` | HAIR | back hair |
| `..._Hair_00_HAIR_01/02` | HAIR | **main hair** |
| `..._Tops_01_CLOTH` | CLOTH | tops |
| `..._Bottoms_01_CLOTH` | CLOTH | bottoms |
| `..._AccessoryNeck_01_CLOTH` | CLOTH | neck accessory |
| `..._Shoes_01_CLOTH` | CLOTH | shoes |

→ Build the slot list at load time by regex on material names. "Iris color" =
material whose name contains `EyeIris`; "hair" = `_HAIR`; "skin" = `_SKIN`, etc.

---

## 5. Blendshapes / expressions (verified binds)

`extensions.VRM.blendShapeMaster.blendShapeGroups[]`. Shino's 15 groups, each with
its `presetName` and the exact `Face.baked` morph index it drives (weight 100):

| group | presetName | binds mesh:index |
|---|---|---|
| Neutral | neutral | (none) |
| A | a | 0:29 |
| I | i | 0:30 |
| U | u | 0:31 |
| E | e | 0:32 |
| O | o | 0:33 |
| Blink | blink | 0:12 |
| Blink_L | blink_l | 0:14 |
| Blink_R | blink_r | 0:13 |
| Angry | angry | 0:0 |
| Fun | fun | 0:1 |
| Joy | joy | 0:2 |
| Sorrow | sorrow | 0:3 |
| Surprised | unknown | 0:4 |
| Extra | unknown | 0:20 (+1 more) |

Standard preset set = 5 visemes (a/i/u/e/o) + 3 blinks + 5 emotions + Neutral,
plus optional `Extra`. three-vrm exposes these as
`vrm.expressionManager.setValue('happy'|'aa'|'blink'|…, 0..1)` then
`vrm.expressionManager.update()`. The editor's "Look/Expression" tab drives these
sliders live; on save, re-emit `blendShapeGroups` with the same binds.

---

## 6. Engine integration (three.js / GAIA)

The engine renders entities from a `mesh` component whose `parts[]` become
`THREE.Mesh(makeGeometry, makePartMaterial)` in `view.js → applyMesh()`
(`geometry.js`, `palette.js`, `outliner.js`, `gizmos.js` all read `mesh.parts`).

**Add a VRM-backed mesh source** without disturbing the primitive system:

1. New component/recipe kind, e.g. `mesh.vrm = { src, edits }` OR a reserved
   `part.kind === 'vrm'`. Keep primitive parts working unchanged.
2. In `applyMesh()`, when a VRM source is present:
   - `const loader = new GLTFLoader(); loader.register(p => new VRMLoaderPlugin(p));`
   - `const gltf = await loader.loadAsync(src); const vrm = gltf.userData.vrm;`
   - `VRMUtils.removeUnnecessaryVertices(gltf.scene); VRMUtils.combineSkeletons(gltf.scene);`
   - `vrm.scene.userData.kind = 'mesh-part'` and `group.add(vrm.scene)` so the
     existing dispose/rebuild path in `applyMesh` still owns its lifecycle.
   - Stash the `vrm` handle (e.g. `group.userData.vrm = vrm`) for editor ops.
3. Per-frame: call `vrm.update(delta)` from the engine's render loop (needed for
   spring-bone physics + expression/lookAt). Hook where particles/behaviors tick.
4. Coordinate space: VRM 0.x faces **-Z**; call `VRMUtils.rotateVRM0(vrm)` (three-vrm
   applies the 180° Y so the avatar faces +Z like the rest of the scene).
5. Bounds/handles: `mesh.parts`-based gizmos won't wrap a VRM automatically; give
   the VRM group a computed bounding box for selection/outliner (fall back to
   `new THREE.Box3().setFromObject(vrm.scene)`).

Async caveat: `applyMesh` is currently sync. Wrap VRM load in a promise and
re-apply transform when resolved (mirror the existing `buildVersion++` bump).

---

## 7. Editor feature-completeness matrix (VRoid Studio parity)

Left = VRoid Studio editor capability. Right = how the GAIA editor delivers it on
VRM data. "Full" = round-trips through the VRM file; "Live" = affects the loaded
model but is baked, not parametric.

| VRoid area | capability | GAIA implementation | fidelity |
|---|---|---|---|
| **Base** | pick preset body (F/M + variant) | load a template VRM as base (§9) | Full |
| **Face › Skin** | skin tone | recolor `_SKIN` materials `_Color`/`_ShadeColor` + optional texture tint | Full |
| **Face › Eyes** | iris color, highlight, sclera | recolor `_EyeIris_`/`_EyeHighlight_`/`_EyeWhite_` | Full |
| **Face › Brows/Lashes/Mouth** | color | recolor `_FaceBrow_`/`_FaceEyelash_`/`_FaceEyeline_`/`_FaceMouth_` | Full |
| **Face › shape** | face contour, eye size/pos, nose, mouth sliders | morph-target weights on `Face.baked` **if present**; else humanoid `head`/`leftEye`/`rightEye` bone scale | Live/partial* |
| **Hair** | hair color | recolor `_HAIR` materials (main `_Hair_*`, back `_HairBack_`) | Full |
| **Hair** | hairstyle swap / procedural hair authoring | swap/hide `Hair*.baked` primitives; import alternate hair mesh | Live |
| **Body** | height, proportions (shoulder/waist/hip/limb) | scale humanoid bones (`hips`,`spine`,`upperLeg`,`upperArm`,`shoulder`…) | Live/partial* |
| **Outfit** | clothing preset + color/texture | recolor `_CLOTH` materials; swap garment primitives; replace `_MainTex` | Full (color) / Live (swap) |
| **Look** | expressions (visemes, blinks, emotions) | `expressionManager` sliders (§5) | Full |
| **Texture layers** | paint layers on face/skin/clothing | edit `_MainTex`/`_ShadeTexture` bitmaps (canvas compositor → re-embed image) | Full |
| **Physics** | hair/skirt sway | edit `secondaryAnimation` params (stiffness/gravity/drag/collider radius) | Full |
| **Meta/License** | title, author, usage permissions | edit `VRM.meta` fields (§8.1) | Full |
| **Export** | VRM0 / VRM1, reduction options | re-export GLB + VRM ext; expose reduction toggles | Full |

\* **Shape fidelity note (be honest about this):** VRoid's face/body *shape*
sliders deform the model at authoring time and are **baked** into the exported mesh
— they are not parametric in the VRM file. So an editor working purely on VRM
gets shape control via (a) any morph targets that survived on `Face.baked`, and
(b) humanoid **bone-scale rigging** (a real, standard technique). This is genuine,
useful proportion editing, but it is not identical to re-running VRoid's original
mesh-deformation sliders. For 1:1 slider parity, edit the parametric master
(`.vroid`) instead — its full slider set is in `vroid-parameter-catalog.json`
(e.g. iris `Level3Iris_*OverlayColor`, base hair `Level1BaseHair_OverlayColor`,
face skin `Level1FaceSkin_*`). Use those names to label the editor's sliders so the
UI vocabulary matches VRoid even where the VRM path bakes the result.

---

## 8. Save / export (round-trip = the "100% write" half)

Goal: a file we save re-opens identically in VRoid, UniVRM, Three, Blender-VRM.

**Strategy — in-place round-trip (recommended):**
1. Keep the original parsed glTF JSON + BIN in memory on load.
2. Apply edits in place:
   - material color/tex → update both the glTF `materials[]` (pbr fallback) **and**
     `extensions.VRM.materialProperties[]` (MToon truth).
   - textures → replace the image in the BIN buffer (or add a bufferView), fix
     `images[]`/`bufferViews[]` offsets.
   - expressions/meta/physics → edit the `VRM` extension sub-objects.
   - baked shape (bone scale) → optionally apply to node transforms.
3. Re-serialize GLB: rebuild JSON chunk, keep/rebuild BIN, fix `byteLength`s, pad
   chunks to 4-byte alignment (GLB requirement), rewrite the 12-byte header.
   `vrmtool.py` (in the working dir) already does this class of GLB byte-editing and
   is a proven reference for the byte mechanics.

**Alternative — three-vrm exporter:** `@pixiv/three-vrm` ships a `VRMExporter`
(and glTF `GLTFExporter`) path. Simpler API, but re-derives the file from the live
three scene — higher risk of dropping data three didn't model. Prefer the in-place
round-trip for "100% compatibility"; use the exporter only when generating a NEW
model from scratch.

### 8.1 Meta / license block (must preserve, verified fields)

`extensions.VRM.meta`:
`title, version, author, contactInformation, reference, texture (thumbnail idx),
allowedUserName, violentUssageName, sexualUssageName, commercialUssageName,
otherPermissionUrl, licenseName, otherLicenseUrl`.

Sample (Shino): `licenseName: CC0`, `allowedUserName: Everyone`, violent/sexual/
commercial usage = `Allow`. Note VRoid's field spellings `violentUssageName` /
`sexualUssageName` (double-s) are canonical VRM 0.x — keep them verbatim.

---

## 9. Templates (ready-to-edit bases)

Loadable editable bases already on disk (`~/Projects/nyari-body/`):

- `cand-Sakurada_Fumiriya.vrm` — VRoid female sample
- `cand-Sendagaya_Shino.vrm` — VRoid female sample (fully mapped above)
- `cand-Victoria_Rubin.vrm` — VRoid female sample
- `nyari-final.vrm` — Nyari canon (garnet iris, obsidian-violet hair)

Copy these into the engine's asset path (e.g. `client/plugins/assets/vrm/`) and
expose them in the editor's preset dropdown. "New from template" = load VRM → edit
→ save-as. This is the honest, working meaning of "load VRoid templates and modify
them": the templates are these VRM exports, and they are 100% editable through the
pipeline above.

---

## 10. VRM 1.0 forward compatibility

For export parity with newer VRoid/UniVRM:
- extension key `VRMC_vrm` (specVersion `1.0`) replaces `VRM`.
- MToon moves to per-material `VRMC_materials_mtoon`.
- spring bones move to `VRMC_springBone`; colliders to `VRMC_node_constraint` where
  relevant.
- humanoid bones become a **map** (`humanBones: { hips: {node}, ... }`) not an array.
- expressions become `expressions.preset.{happy,angry,aa,blink,...}`.
- meta gains explicit `avatarPermission`, `commercialUsage`, `licenseUrl`.

three-vrm loads 0.x and 1.0 into the **same** runtime object model, so the editor UI
is identical; only the serializer branches. Ship VRM 0.x first (matches every file
we have), add a 1.0 export switch second.

---

## 11. Verification checklist (prove each claim)

- [ ] Load each `cand-*.vrm` + `nyari-final.vrm`; assert 3 meshes, 54 humanoid
      bones, expression presets resolve, spring bones initialized.
- [ ] Recolor iris → confirm only `_EyeIris_` material changed; screenshot.
- [ ] Drive `aa`/`blink`/`happy` expressions → visible morph on `Face.baked`.
- [ ] Edit spring-bone stiffness → hair sway changes under `vrm.update(dt)`.
- [ ] Save → reload the saved file in this editor: identical.
- [ ] Save → open the saved file in an independent VRM viewer / Blender-VRM:
      identical materials, expressions, physics, meta.
- [ ] Round-trip a file with **no edits** → byte-stable semantics (diff the parsed
      JSON, not raw bytes; padding may differ).

Use `analyze_vrm.py` / `analyze_vrm_deep.py` (in nyari-body) as the assertion
oracle — run them on input and output and diff the structural summaries.

---

## 12. Provenance

- Format numbers measured by `analyze_vrm.py` / `analyze_vrm_deep.py` (working dir)
  against the four VRM files listed in §1.
- GLB byte-editing reference: `vrmtool.py` (proven read/write/tint/meta on real
  exports).
- VRoid slider names: `docs/vroid-parameter-catalog.json`.
- Engine integration seam: `client/kernel/view.js` (`applyMesh`),
  `client/kernel/geometry.js`, `client/plugins/character-creator.js`.
- Loader: `@pixiv/three-vrm@3.5.4` (peer `three >=0.137`; engine `three@0.180.0`).

**Bottom line:** VRM 0.x is fully specified above from real files; three-vrm + the
engine's existing mesh seam make load/edit/render straightforward; the only honest
asterisk is that VRoid's *shape* sliders are baked at authoring time, so VRM-side
shape editing is bone-scale + surviving morphs (real and useful) rather than a
literal replay of VRoid's mesh deformation. Colors, expressions, textures, physics,
wardrobe, and meta are fully round-trippable — that is the 100%-compatible core.
