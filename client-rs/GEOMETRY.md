# Geometry — hybrid polygon/voxel/SDF architecture (rust-port)

§ scope → the rendering/authoring model for ALL solid geometry backends in
client-rs, superseding "polygons only" as an assumption. Ruling doc, not a
proposal — content below is settled; extend by appending, not rewriting.
Companion: [FEATURES.md](FEATURES.md) (parity contract), [PARITY.md](PARITY.md)
(boomtown delta). This doc owns the *new* geometry-kernel rows those contracts
reference.

## 1. Doctrine

| rule | detail |
|---|---|
| default | polygons — meshes/tubes/terrain/GLTF/instancing (today's engine, `client/kernel/geometry.js`) stay the baseline for every entity that doesn't opt in to something else. |
| opt-in | voxel volumes and SDF sculpts are PER-ENTITY components (`voxels`, `sdf`), not a global mode switch. An entity picks one. |
| output convergence | every backend writes into ONE deferred G-buffer (albedo/normal/material/depth). No backend owns its own forward pass. |
| lighting | representation-blind — the light pool, shadows, fog, post-fx (§ FEATURES.md render/post chain rows) read the G-buffer only; they never know if a fragment came from a rasterized triangle, a raytraced brick, or a contoured SDF mesh. |

Consequence: adding voxel/SDF entities must NOT branch the lighting code path
— only the G-buffer *fill* stage branches per entity, by component type.

## 2. Backends

### A) Polygon pass — today's engine

Meshes, tubes, terrain, GLTF, instancing. Source: `client/kernel/geometry.js`,
`client/kernel/terrain.js`, `client/kernel/scatter.js`,
`instanced-models.js` (§ PARITY.md `asset-backed static models` row). Port
note unchanged from FEATURES.md/PARITY.md: native Rust rasterization, GLTF
loader → native asset/cache, instance batches keyed mesh+material.

### B) Voxel volumes

Component: `voxels` on an entity.

| field | meaning |
|---|---|
| `voxelSize` | world-unit edge length of one voxel; has a default (do not require authors to set it). |
| brick data ref | pointer/id into brick storage (§ 2B storage below) — not inline per-voxel data on the entity doc. |
| palette | array mapping palette index → named material (`materials.json` names, same library polygons use — § FEATURES.md "Named materials" row). |

**Render — Teardown pattern:**
1. Rasterize the entity's OBB as a 12-triangle proxy (cheap, standard raster
   pipeline, same as any polygon draw).
2. Per covered fragment, raytrace into the brick texture in the proxy's local
   voxel space (screen-space-ray → voxel-space DDA).
3. Write hit material/normal into the SAME deferred G-buffer polygons use.

Cite: blog.voxagon.se (2018) "Rendering voxels" — screen-space-to-voxel-space
ray derivation; juandiegomontoya/teardown_breakdown (github) — Teardown's
OBB-proxy + fragment-raytrace reconstruction, the reference this backend
follows.

**Storage:**
- 8³ bricks, linear allocator + streaming requests. Cite:
  stijnherfst/BrickMap (github) — brick indirection table + streaming pattern.
- Palette: 8-bit material index per voxel. Cite: voxagon "spraycan" writeup
  (blog.voxagon.se) — palette-indexed brick storage keeping memory low while
  supporting many materials.
- Shadows/AO: octant-packed occupancy mips (coarse "is this octant solid"
  levels derived from brick occupancy), walked instead of the full brick for
  cheap shadow rays / AO cone steps.

**Edits:** brick-diff ops through the existing op journal (same journal as
scene edits — § AGENTS.md "op journal caps at 2000 entries"). An edit = a
diff against one or more bricks, not a full-volume rewrite; persists and
replicates like any other dev op.

### C) SDF sculpts

Component: `sdf` on an entity — a FLAT primitive list:

```
sdf: [{ shape, op: "add"|"subtract", blend: { k } }, ...]
```

`k` = smooth-min blend radius (0 = hard boolean).

Relation to existing carve: **carve is the special case** `op:"subtract",
blend.k:0`. This generalizes, not replaces, the current CSG carve pipeline
(`client/kernel/geometry.js:65-105`, `three-bvh-csg` `Evaluator` +
`SUBTRACTION`/`HOLLOW_SUBTRACTION`). The `carve` DATA MODEL on mesh parts is
kept as-is (§ FEATURES.md "Carve CSG" row, "data model kept" ruling) — only
the mesh-CSG *evaluator* retires once the shared contouring kernel (§3)
covers its cases; carve authoring/edit-lens UX carries forward unchanged.

**Phases (ship in order, each independently usable):**

| phase | behavior | feel |
|---|---:|---|
| 1 | contour-on-release: edit → CPU/GPU contour once → static mesh → G-buffer | current carve UX (rebuild-on-release, one undo op) |
| 2 | GPU compute re-mesh live, every frame while editing | Dreams-style live sculpt |
| 3 (optional) | direct trace of the SDF field, no meshing step | only if 1+2 prove insufficient for a concrete case |

## 3. Shared contouring kernel

ONE contouring implementation serves voxel terrain-scale volumes, SDF
sculpts, AND the carve special case — not three separate meshers.

| piece | detail |
|---|---|
| occupancy | bit-packed, one bit (or palette index) per voxel |
| chunking | Morton-ordered 32³ chunks |
| algorithm | dual/binary contouring |
| reference | `~/projects/johnlin-BinaryMeshFitting` (cloned locally) — binary/dual contouring implementation to port from, not reinvent |

Phase-1 SDF contouring and voxel-volume meshing both call into this kernel;
carve's mesh-CSG evaluator is the thing this kernel eventually retires (§2C).

## 4. Format-agnostic volume pipeline

Author-time and runtime voxel data need NOT share a byte layout. Pattern:
typed per-voxel attributes at authoring time, converters translate
authoring-format ↔ packed brick format at bake/import. Cite: Lin, voxely.net
"perfect-voxel-engine" writeup — the format-agnostic typed-attribute +
converter pattern this pipeline follows (avoids locking the authoring tools
to the runtime brick layout from day one).

## 5. Skips — considered, not building, with reasons

| considered | verdict | reason |
|---|---|---|
| hardware ray tracing as PRIMARY path | skip | would be a second renderer alongside the deferred rasterizer; violates §1 "one G-buffer" convergence rule — the Teardown fragment-raytrace approach (§2B) gets voxel realism without a parallel RT pipeline |
| SVRaster | skip | research/static-scene oriented, not a fit for a live-edited, streaming, multiplayer world |
| flecs `Domain` | skip | already have `gaia-ecs` (this project's own ECS); no need for a second ECS abstraction |

## 6. Edit-lens grammar extension (SDF)

Extends the existing mesh edit-lens (§ AGENTS.md "ONE hands-on lens" section;
`client/kernel/editor.js`, `client/kernel/geometry.js`) to SDF primitives:

| gesture | current (carve/tube) | + SDF |
|---|---|---|
| ghost representation | translucent red carve cutter meshes, orange tube control points | SDF primitives render as ghosts too, same visual language |
| transform | W/E/R on selected ghost | same, W/E/R unchanged |
| new: blend control | n/a (carve is hard subtract) | drag/scroll adjusts `blend.k` on the selected primitive live |
| birth | N (or outliner `+ hole`) spawns a cutter at look position | same N gesture spawns an SDF primitive at look position, appended to the entity's `sdf` list |
| commit | rebuild-on-release, one undoable mesh op | same commit discipline — phase 1 (§2C); phase 2 live re-mesh relaxes this once shipped |

Outliner/inspector rules carry over unchanged: ghosts list as entity children
only while the lens is on; raw arrays visible in the JSON tab even when the
lens is off.

## 7. Open questions

| question | status | note |
|---|---|---|
| fluid sim scope | gated | server-side only, small volumes — not a general client fluid renderer; scope confined until a concrete world needs it |
| CSG crate: make-or-buy | open | recon needed before phase-1 contouring implementation (§ FEATURES.md companion-contracts line: "CSG make-or-buy recon before impl") — evaluate existing Rust CSG/contouring crates against porting `johnlin-BinaryMeshFitting` (§3) directly |
| mip/shadow format | open | octant-packed occupancy mips (§2B) need a concrete texture/buffer format decision before the shadow/AO path is implemented |

## 8. Acceptance

One frame renders, together, through one light pass:
- boomtown polygons (existing scene content, unmodified),
- one voxel volume entity (Teardown-pattern G-buffer fill),
- one SDF sculpt entity (phase-1 contour-on-release G-buffer fill).

Verification discipline per root AGENTS.md: screenshot-verified — data/sense
checks are not sufficient for this claim (rendering, materials, and the
G-buffer convergence itself are pixel facts, not world-state facts).
