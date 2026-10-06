# scene-export — NOTES
Engine-generic: source .glb + game manifest -> static glTF 2.0 .glb for the native (Rust) renderer. No game code here.

## Run
`node tools/scene-export/export.mjs <manifest.json> [-o out.glb] [--stats s.json]` · test: `bun test test/scene-export.test.js`
Manifest schema = header comment of export.mjs (input, include.roots, exclude.{skinned,nodes,materials}, keepTexCoord1, sun, pointLights, camera). Paths relative to manifest.

## Why a pure-JS reader, not the engine loader
Engine loads level GLBs via three GLTFLoader (client/kernel/gltf.js mountGltf) → browser-only (Blob/ImageBitmap/DDS ext). Node reuse impossible
without a DOM shim → tool reads the same GLB file the loader reads (spec-level), no three dep.

## Contract output
POSITION/NORMAL(generated if absent)/TEXCOORD_0 (+TANGENT, COLOR_0, TEXCOORD_1 if keepTexCoord1) · u32 indices · PBR MR materials (source material JSON kept, texture idx remapped) ·
PNG textures (DDS DXT1/3/5 + RGB masks decoded; undecodable → 1x1 magenta + warning) · node TRS kept, unreachable/empty nodes pruned · no skins/animations ·
KHR_lights_punctual (1 directional + N point) · exactly one camera node.

## DS Asylum source (game side)
Source = `nari-world-companion/.scratch/data/world/gp23-s1/asylum.glb` (258 MB; DS pipeline output, MSFT_texture_dds, 97 skinned characters, collision diagnostics).
Manifest built by game-side script (`.scratch/mkmanifest.mjs`, gitignored, NOT engine): roots render+objects, drop `skinned:`/`collision` nodes + `collision-diagnostic` material,
camera = glb extras.playerStarts[1] (+1.7 m eye), lights from lighting.json (torches → PointLightBank rows; sun → LightBank row of start collision h0000B1).

## Unverified / known gaps
- Sun direction/intensity + torch intensity/range mapping from DrawParam = guessed (colA/10 candela, range=dwindleEnd*4); no DS reference render compared.
- Camera yaw=180° copied from MSB rotation; facing convention under the Z-negated basis not checked on a render.
- Lightmap (second UV, overlay fac 0.5) NOT baked: TEXCOORD_1 kept + material.extras.lightmap (texture idx remapped); glTF cannot express it. Validator reports TEXCOORD_1 UNUSED_OBJECT infos.
- Water prims, alpha modes copied as-is from source; DS mtd shader parity not attempted (source says: only g_Diffuse→baseColor).
- Interior `objects` (doors, props) included as static at their authored pose; dynamic collision not exported.
- Sparse accessors unsupported (error). KTX2 not produced (PNG only).

## Material flags (lampas/r4-scene)
Manifest `materialFlags: [{ name?: regex, extras?: {key: regex}, set: {blend: alpha|additive|subtractive, unlit, depthWrite, renderOrder, castShadow} }]` → `material.extras.gaia` (later rules win). `sun.rotationDeg` = [pitch (+ = from above), yaw] in the source basis + `basisFlip` (default [1,1,-1]); exporter warns when the sun travels up.
## Skinned characters (lampas/r3-skin, 10-06)
Manifest `skinned: { nodes: regex (default '^skinned:'), clip?: regex, maxCharacters? }` → skins + joint hierarchy (ancestors kept) + ONE merged animation `skinned-characters` (first clip `<characterId>/…` touching the skin's joints). JOINTS_0 u16, WEIGHTS_0 f32. selfCheck allows skins/animations only when `skinned` is set; it does NOT check node cycles.
Asylum: `.scratch/asylum-skinned.manifest.json` = scene-export lane's manifest + `skinned.nodes '^skinned:[co]\d{4}_'` → 88 skins / 3302 joints / 82 clips / 9604 channels, 121 MB, 8.5 s. Player parts (`skinned:player*`) excluded (all 36 class bodies sit at the start).
## Ambient (lampas/r5-sky)
Manifest `ambient: {sky:[r,g,b], ground:[r,g,b], scale?}` -> `scenes[0].extras.gaia.ambient {sky,ground}` (colour x scale, linear shader units; engine = hemisphere lerp by n.y). COLOR_0 is passed through if the SOURCE has it (engine multiplies rgb+alpha). DS sky vertex alpha is NOT in the DS glb (companion glb-add-vertex-colors gap, see gaia-render NOTES round 5).
## Visibility groups (lampas/r6-dgcull)
Manifest `visibilityGroups?: {draw:'drawGroups', display:'displayGroups', parent:'drawParent'}` = SOURCE node-extras key names (defaults shown; game names live in data). Per node carrying any of them -> `extras.gaia.visibilityGroups`:
|key|type|meaning|
|---|---|---|
|`draw`|int[] sorted/deduped|group bits the node is drawn for (empty = unconstrained)|
|`display`|int[]|bits the node ACTIVATES (host input for the active set; renderer never reads)|
|`parent`|string?|source parent name (exact or after first `:` of `<kind>:<name>`)|
|`parentNode`|int?|OUTPUT node index of that parent (renderer follows it, own `draw` ignored)|
Parent pruned from output -> its effective draw groups inlined into `draw` + stats warning. Source keys stay on the node verbatim; source root `extras.<draw>` (whole-map table) copied to the output root extras. `stats.visibilityNodes`. Test: `bun test test/scene-export-groups.test.js`. Engine side: gaia-render NOTES round 6.
