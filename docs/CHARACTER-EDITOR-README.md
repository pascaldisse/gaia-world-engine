# GAIA Character Editor — build index

> **PHASE 1 + ANIMATION: BUILT & VERIFIED LIVE** (2026-07-08, Nyari, branch
> `vrm-avatars`: 07f6b3f → 499fe83 → abda13a → 7702a61). What now exists:
>
> **Avatars as world data** — `mesh.vrm = { src, edits, idle, dance, animation }`
> (schema: `shared/schema.js → mesh.fields.vrm`):
> - `client/kernel/vrm.js` — load (MToonNodeMaterial → WebGPU ✓), semantic slot
>   map, edits-as-data (`colors`/`expressions`/`bones`/`nodes`/`meta`), per-frame
>   registry, and the §8 in-place GLB round-trip (`patchVrmBytes`/`exportVRM`) —
>   Node-tested: no-edit round-trip JSON-identical, BIN byte-identical, patched
>   file verified by independent `vrmtool.py`. `edits.nodes` scales raw bones by
>   name substring (J_Sec bust/skirt chains — body customization past the
>   humanoid map).
> - `client/kernel/view.js` — mounts the VRM as a mesh-part (async,
>   token-guarded, dispose-owned); `set mesh` ops restyle a live avatar for
>   every client. Measures each avatar's world velocity per frame (the
>   locomotion nerve).
> - `client/plugins/vrm-editor.js` — press **V** in creator mode: templates,
>   color slots + expressions + bone proportions enumerated from the loaded
>   file, meta, spawn/update as ops, export baked `.vrm`.
>
> **Animation stack** (skeleton priority: dance > clip > walk > idle; blink
> always runs):
> - *Idle* — procedural breath/sway/blink/arms; per-entity `idle` spec.
> - *Walk* — phase-driven gait fed by measured velocity: whatever moves the
>   entity (agent intents, behaviors, ops) makes the body walk; the avatar
>   turns to face its direction of travel.
> - *Dance* — `dance: { bpm, energy }`, beat-locked to the world clock.
> - *Clips* — `.vrma` (VRMC_vrm_animation) via three-vrm-animation, humanoid
>   retargeting + crossfade; 6 motion-pack clips in `client/assets/vrma/`.
>
> **Verified live** (CDP + headless Brave): spawn op → 67 meshes / 54 bones;
> expressions drive morphs; spring bones (hair + skirt + J_Sec bust) simulate;
> recolor-by-op; Relax.vrma mocap playback; eternal orbit walk-test
> (`nyari-avatar` circles [0,0,17] r=3.5 in scene main — the standing
> regression check for locomotion). Agent embodiment proven end-to-end:
> `agent-nyari` presence wears the VRM and walks/faces/says via
> `tools/agent.mjs` intents.
>
> **Gotcha:** verification browser needs
> `--disable-backgrounding-occluded-windows` — macOS pauses rAF for covered
> windows and the whole client freezes (fireflies included).
>
> Remaining: Phase 2 (parametric `.vroid` layer below), texture-layer painting,
> VRM 1.0 export switch, walk-cycle mocap clip to replace the procedural gait,
> animation triggers (greet on approach).

Goal: a VRoid-compatible character editor plugin for GAIA-World-Engine.
The format/compatibility groundwork is **done**; this file tells the builder
(Fable) what exists and what to implement. No low-level format work remains for
the slider editor.

## The two file levels (know which you're touching)

| level | file | open? | what it holds | editor role |
|---|---|---|---|---|
| **export** | `.vrm` | yes (glTF 2.0 + VRM ext) | baked mesh, materials, skeleton, expressions, physics | load/edit/render/save avatars **now** |
| **master** | `.vroid` | yes (zip + protobuf) | live parametric sliders (328 params) | parametric editing + author masters |

## Docs (read in this order)

1. **`VRM-CHARACTER-EDITOR-SPEC.md`** — the `.vrm` editor. Container, VRM 0.x
   extension anatomy, MToon materials, 54-bone humanoid, blendshape binds, spring
   bones, the semantic slot map, and full `@pixiv/three-vrm@3.5.4` integration into
   `client/kernel/view.js` (engine already runs three 0.180 ✓). **Build this first.**
2. **`VROID-MASTER-FORMAT-SPEC.md`** — the `.vroid` master. Zip layout, the
   `data.bin` protobuf tree, the parametric model, and §4.1 **value encoding with a
   proven read+write path**. Build this second (parametric layer).
3. **`vroid-parameter-catalog.json`** — machine-readable: 41 slots, 39 groups, 328
   keys, 175 shape sliders. Drive the UI from this.

## What's already DONE (format side — don't redo)

- `.vroid` container + protobuf structure fully documented.
- Full parameter catalog extracted (`vroid-parameter-catalog.json`).
- **Working reference reader/writer:** `docs/vroid_master.py`
  - lossless transcode of `data.bin` (byte-identical round-trip),
  - `read_values(top) -> {catalogKey: float}` for all 328 sliders,
  - `set_value(top, key, float)` sets ANY slider (incl. previously-default ones),
    fixing all protobuf length prefixes; proven with round-trip + isolation tests.
- `.vrm` format fully specified from 4 real VRoid exports.

## What Fable BUILDS

**Phase 1 — VRM editor (fully open, no gaps):**
- Add `@pixiv/three-vrm`; load VRM via GLTFLoader+VRMLoaderPlugin; mount `vrm.scene`
  as a mesh-source in `view.js applyMesh()` (see VRM spec §6); call `vrm.update(dt)`.
- UI: color slots (iris/hair/skin/clothes via MToon `_Color`/`_ShadeColor`, keyed by
  the material-name slot map), expression sliders (`expressionManager`), proportion
  rigging (humanoid bone scale), texture-layer paint, spring-bone params, meta.
- Save: in-place GLB round-trip (VRM spec §8). Templates: `cand-*.vrm`, `nyari-final.vrm`.

**Phase 2 — parametric layer:**
- Port `vroid_master.py`'s transcoder + `read_values`/`set_value` to JS.
- UI: the 175 shape sliders + color slots from the catalog, grouped by part.
- Load `.vroid` → show values → edit → save `.vroid`.
- Produce a VRM either by exporting from VRoid Studio itself, or (long-term)
  GAIA-native once the geometry blob is decoded (VROID master spec Open item 2).

## Honest open items (none block Phase 1 or the Phase 2 slider editor)
- VRoid GUI acceptance of a patched master — mechanical + lossless round-trip pass;
  needs one human eyeball in VRoid Studio (`~/Documents/model-anyslider.vroid`).
- Native slider→mesh bake needs the `field3` geometry arrays decoded (deferred).
- Formal `.proto` names are cosmetic — the transcoder is schema-free.
