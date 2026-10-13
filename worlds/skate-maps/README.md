# skate-maps — San Vansterdam + S.U.M.R. Camp viewer
Static world: 2 decimated GLBs at native game coords (Y up, m). Source: ~/Games/reskate/maps/EXTRACT.md.
- assets/*.glb = symlinks → ~/Games/reskate/maps/{city,mpr}{,_lod}.glb (gitignored, not committed)
- glb build: `tools/obj2glb.cpp` (meshoptimizer; bbox-filter by centroid, weld, simplify+prune). city 1.82M tris, mpr 1.96M, *_lod ≈ 10 % of those. no normals → flat shaded.
- regenerate scene/game: `bun worlds/skate-maps/gen-world.mjs`
- run: `GAIA_PORT=8431 GAIA_WORLD=$PWD/worlds/skate-maps node server/index.js` + `GAIA_PORT=8431 GAIA_CLIENT_PORT=5241 node_modules/.bin/vite`
- native:  http://localhost:5241/?create=1&mute=1&pos=1700,1300,600&yaw=1.5708&pitch=-0.55
- snap:    http://localhost:5241/?create=1&mute=1&level=snap&pos=1800,1900,1300&yaw=1.5708&pitch=-0.95
- snap = level `snap` in game.json: map_mpr + label_mpr offset (+1207.484, +14.439, +1658.287) → mpr p1.x = city p99.x + 100; z,y aligned to city p1. Toggle = switch `?level=` (or edit map_mpr transform in inspector).
- known: mpr has stray vista shards (centroid inside filter, verts far out); no terrain heightfield (not extracted).
- step 2 (vistas+sky): assets/city_vista.glb, mpr_vista.glb (unpruned `*_vista.obj`, ocean planes dropped y<192.2, simplified 12%/50%), skydome.glb (r=22 km, tx_bam_pano_1300 BC6H→PNG, unlit). Needs `?far=60000` (renderer.js: far/near query param; default 4000/0.1 unchanged). Fog #b9cde6 9k..90k. glbs = symlinks → ~/Games/reskate/maps/. Vistas sit at origin in BOTH levels (not snapped): city+mpr share one world frame natively.
- NOT done: textures/UVs (material→texture binding lives in shader lookup tables, not EBX MeshMaterial — see reskate-maps docs/EXTRACT-maps.md), terrain heightfield obj.
