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
