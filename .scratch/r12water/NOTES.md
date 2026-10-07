# r12-water NOTES (telegraphic)
## S1 findings (18:12)
- USER: burnout-paradise-gwe client/bp-water.js:12-22 — static `THREE.CubeTextureLoader` (6 PNG refl_k.png, SRGB) → TSL `cubeTexture(cube, vec3(-R.x,R.y,R.z)).rgb*reflGain` in a NodeMaterial (sky reflection, SOURCED 3ddce850). NO CubeCamera / PMREM / envMap / scene.background in game. → STATIC cube via material TSL binding.
- ENGINE: tsl-export.js:10 kindOf → 'texture-cube'; wgpu-backend.js createShaderMaterial (~l.404-413) accepted only texture-2d / texture-2d-array → `kind texture-cube unsupported` (the refusal). Rust three_material.rs reflected Cube dim already but bind loop gave 2D view/white (no cube store).
- scene.background CubeTexture + scene.environment cube ALREADY implemented at HEAD (r6-scene: readCube → backend.setBackgroundTexture kind cube; scene-adapter.js:448 'unsupported' = only non-Texture / unreadable bg).
- three flipEnvMap(-1 x) is applied by the TSL node in generated WGSL → core uploads faces raw, +X -X +Y -Y +Z -Z.
## S2 Rust (18:13): CubeTex store + create_texture_cube (6 faces, GPU mips) + white_cube fallback + three_material Cube bind + wasm createTextureCube + tests/texture_cube.rs
