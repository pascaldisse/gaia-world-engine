# Working on GAIA — instructions for AI agents (any of them)

## Confirm rendering with screenshots, not senses

The sense API (`look/map/describe/query/check`) reads world DATA. It cannot
see pixels. Materials, lighting, fog, transparency, bloom, particle
visibility — none of that is confirmable through senses. **Any change that
affects how the world LOOKS must be confirmed with a screenshot before
calling it done:**

### Rain: machine-native body and field-of-view measurements

`rain` is deliberately different from the ordinary data senses above. Its
`fov` grid measures geometry around any rendered entity; `proprio` samples a
mounted VRM body's world-space bones against terrain. Use it for locomotion,
grounding, facing, and nearby spatial verification — not for judging
appearance. Read `docs/RAIN.md` before using it:

```sh
node tools/rain.mjs fov <entity-id>
node tools/rain.mjs proprio <vrm-avatar-id>   # !NOBODY if no mounted VRM
```

For a VRM avatar-motion regression, `proprio` must not report `!BACK`,
`!FLOAT`, `!SINK`, `!SKEW`, or `!STIFF`. Rain is not a screenshot
replacement: still use a real screenshot for materials, lighting, fog,
transparency, and other pixel-visible claims.

```sh
node tools/agent.mjs shot out.png     # or GET /screenshot
```

Then actually read the image. "The entity exists at the right position" is
not evidence that it renders.

Screenshot discipline:
- The capture comes from a connected, **visible** browser tab (background
  tabs pause rendering). With several tabs open the FIRST tab to render
  answers — target one session with
  `node tools/agent.mjs shot out.png <presence-id>`
  (`GET /screenshot?from=<presence-id>`). Find the new tab's id by diffing
  `GET /sense/query?has=presence` before/after opening it.
- Still keep tabs to a minimum — every tab is a full player session whose
  stale presence pollutes the world after it closes.
- Low-alpha standard materials (`opacity` < ~0.15) are effectively invisible
  in dark scenes. For light shafts/halos use the additive presets (`beam`,
  `glow`) — that is what they are for.
- ALWAYS open your work tabs with `&mute=1` — the player may be sitting at
  the machine, and your verification session must not make noise.
- You cannot press keys in the browser. To screenshot the EDITOR (outliner,
  gizmos, selection) open a deep-link instead:
  `?create=1&select=<id>&gizmos=colliders,triggers,water,lights,sounds,paths,areas,scenes&pos=x,y,z&yaw=r&pitch=r`
- A world with `game.json` (in its world dir) gets a TITLE SCREEN: the
  default overlay becomes `{ title, subtitle, levels: [...] }` with NEW GAME /
  LEVEL SELECT. A level entry is pure data — `{ id, name, spawn: {position,
  yaw}, reset, ops }`; its ops run with `"$id"` resolved to the choosing
  presence (the interact convention), so "equipment/stats" are just granted
  components. `?level=<id>` applies the SAME entry and skips the overlay —
  the fastest way to start a verification session deep in a game (combine
  with `&mute=1`). Worlds without game.json keep the plain GAIA overlay
  (the frozen demo relies on that). NOTE: picking a level (or ?level=) sends
  its `reset` + ops to the LIVE world — it rewinds shared quest state.
  game.json can also carry `menu: { camera: { position, yaw, pitch } }` —
  the boot menu then holds that shot over the LIVE world (player frozen, NO
  presence spawned until a level is picked; `gaia.player.frozen` is the
  flag, and setting `gaia.player.position` while frozen makes a free
  streaming/screenshot probe — scenes stream around the menu camera).
- THE SCENE MODEL (single state — there is no other model): a world is
  `world/world.json` (the SUPERSCENE: which scenes exist and how they
  compose — bounds discs, neighbors, `load` volumes, world defaults like
  voidY) plus `world/scenes/<name>.json` (pure entity docs keyed by id,
  world-space) — THE source of truth, read at boot and on `reset`, and
  every dev edit writes back into the scene file (gizmo drags, panel
  fields, palette stamps, deletes, debug-menu save). Ops count as dev edits
  when their batch carries `dev: true` — the client's authoring surfaces
  use `gaia.net.sendDev`, and over HTTP it's `{"dev": true, "ops": [...]}`.
  Gameplay traffic (presence moves, `use`, trigger output, weather) stays
  runtime-only. The player layer — presences, `persist` entities, entities
  no scene claims — lives in `world/saves/player_<GAIA_SAVE>_state.json`
  (gitignored): scenes always win on boot, the save only overlays the
  player's own. A world with NO world.json and one scene file (or none) is
  the blank page: a single implicit always-loaded scene named `main`.
- Streaming is data, editable live: a scene's world.json entry may carry
  `load: [{ center: [x,z], radius, y: [min,max] }]` volumes (Dark Souls
  style) — such a scene streams in ONLY while the observer is inside a
  volume (or the scene is current); it no longer rides the neighbor rule.
  The `scene` op edits world.json at runtime and persists it:
  `{ "op": "scene", "name": "<scene>", "value": { "load": [...] } }` (null
  deletes a key). In the editor, the `scenes` gizmo chip draws bounds +
  dashed load cages, and the ⛭ on a scene's outliner group opens its
  world.json entry as editable JSON in the inspector.
- Scene entries may be prefab INSTANCES: `{"prefab": "torch", ...deltas}`
  deep-merges `world/prefabs/torch.json` under the deltas; write-back diffs
  against the prefab, so instances stay tiny. `world/materials.json` holds
  named looks — a part says `"material": "obsidian"` and may override any
  field locally; the `material` op (`{op, name, value}`, null deletes)
  edits the library live and clients rebuild what references it. EDITING
  scene files or world.json on disk (by hand or a generator re-run) while
  the server runs: send a `reset` op (`{"op":"reset","scene":"<name>"}`) —
  reset re-reads the files from disk and is the official pickup gesture.
- Creator mode has a viewbar (top center): `lit / unlit / wire` draw modes,
  a `view ▾` effects dropdown, and a `■ stop` toggle. Unlit shows floored
  albedo with fog and exposure neutral — edit a midnight scene in daylight;
  wire shows the geometry. The dropdown is Unity's scene-view toggles:
  skybox (background color + sky/overcast/clouds preset sheets), fog,
  particles, post fx (bloom + lightning flashes + exposure dips), lights
  (the point-light pool; sun/sky stay), audio. Draw modes set defaults —
  unlit/wire turn fog+particles+post OFF, wire also skybox OFF (so stepping
  outside a mountain doesn't flood the wires with daylight) — and any
  toggle can then be flipped per-feature. ■ stop freezes behaviors,
  particles, triggers and sound (the default edit-mode rest state) while
  movement, streaming and edits keep working. Leaving create mode always
  restores lit + everything on + running. Programmatic:
  `gaia.setDrawMode('unlit'|'wireframe'|'lit')`, `gaia.setStopped(true)`,
  `gaia.viewFx.on` (the toggle state).
  — creator mode opens by itself, the entity is selected, the listed gizmo
  categories switch on, and the camera goes exactly where you said (editor
  mode has no gravity, so it stays). Gizmos draw into the WebGL canvas, so
  `shot` captures them; the DOM panels (outliner/inspector/log) do NOT
  appear in canvas screenshots. For those, launch a dedicated browser
  instance with the DevTools protocol and use `tools/cdp.mjs`:
  ```sh
  open -n -g -j -a "Brave Browser" --args --user-data-dir=/tmp/gaia-profile \
    --remote-debugging-port=9222 --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding --disable-background-timer-throttling "<url>"
  node tools/cdp.mjs shot ui.png      # full page: DOM + canvas
  node tools/cdp.mjs eval 'gaia.gizmos.root.children.length'   # poke the kernel
  ```
  ALWAYS launch with `open -n -g -j` (background + hidden): the player works
  on this machine and the work window must NEVER pop in front of theirs.
  Hidden still renders — the disable-backgrounding flags keep WebGPU rAF,
  timers, /screenshot and cdp.mjs shots fully alive (verified); probe rAF
  after launch as below if in doubt. To make the window visible on purpose
  (watching a play-test), click the Brave icon in the dock — don't launch
  visible by default.
  Do NOT use `--headless` — it hangs on WebGPU init. The dedicated
  `--user-data-dir` instance keeps your work out of the player's browser
  (their instance can also wedge on localhost after heavy tab churn — a
  blank tab with an empty title means restart THEIR browser, not the
  server). `window.gaia` exposes store/view/gizmos/editor/audio in the page.
- Launch the work instance with `--disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding --disable-background-timer-throttling`.
  An occluded window freezes requestAnimationFrame AND timers — deep-links
  silently never run, simulated input does nothing, and `gaia` reads stale
  state. If evals look frozen, check rAF first:
  `eval 'window.__t=0; requestAnimationFrame(()=>__t=1)'` … then read `__t`.
- If another project squats 127.0.0.1:5173, the engine's vite still binds
  IPv6 — open `http://[::1]:5173/` instead (cdp.mjs matches both).
- The whole stack moves ports via env: `GAIA_PORT` (world server; vite
  injects it into the client as `__GAIA_PORT__`) and `GAIA_CLIENT_PORT`
  (vite). The Tomb game's `game/dev.sh` defaults to 8421/5174 so it runs
  beside other games on 8420/5173. Set `GAIA_CLIENT_PORT` for
  `tools/cdp.mjs` / `profile-seam.mjs` tab matching, and point screenshot/
  op/sense curls at the right server port.
- You can drive a full play-test over CDP without a keyboard: set
  `gaia.player.locked = true`, toggle modes via `gaia.editor`, and hold keys
  with `gaia.player.keys.add("KeyW")` / `.delete(...)`. Verify climbs by
  reading `gaia.player.position` — feet are `y - eyeHeight` (1.7 standing,
  1.0 crouched). Space jumps off the grounded branch; ctrl/C crouch.
- '+' in the client (or `POST /snapshot` with `{image?, player}`) drops a
  debug snapshot: `debug/<stamp>.png` + `.json` next to the world dir —
  pose, the presence's components, every `state` component, nearby ids,
  and the agent-sense `look()` of that pose. The fastest way to answer
  "what did the world believe when this frame looked wrong" — players can
  file pixel bugs with it too, and you read their JSON instead of guessing.

## Performance rules (M13 — keep streaming invisible)

- The scene's light SET is part of every material's shader cache key.
  Runtime point lights ride a fixed pool (nearest 16 win slots) so lighting
  lanterns is free — but adding a `spot`/`directional`/`castShadow` light,
  at runtime, recompiles every pipeline in the scene. Author those at build
  time only.
- Scene fogs must stay in one family: exp↔exp crossfades mutate the existing
  fog object (free); switching linear↔exp replaces it and re-keys every
  pipeline. Every scene env should use `density` (exp) fog.
- The whole world builds AND renders once at load (three warm frames,
  unculled, behind the entry overlay); after that scenes stream by pure
  visibility. If a fresh material variant appears ONLY in op payloads the
  warm-up can't see (beyond `interact.ops` / `triggers.*.ops` mesh values,
  which it probes), its first draw compiles mid-play — prefer pre-seeding a
  lit example somewhere or reusing an existing recipe.
- Geometries/materials are cached by recipe and shared (`userData.shared`)
  — never dispose what you didn't create, and never mutate a mesh part's
  material in place (edit the component; identical recipes are the SAME
  material object).
- `tools/profile-seam.mjs '<js that triggers the moment>'` CPU-profiles the
  page over CDP and prints the hottest functions — use it before guessing,
  and verify hitches with a rAF frame-time probe
  (`window.__t=performance.now()` … measure deltas), not by feel.
- Teleporting a player/agent ACROSS scenes by setting `gaia.player.position`
  in one jump can trip the OLD scene's `voidY` for one frame (the player
  respawns at the world spawn). Real movement never does this; for tests,
  prefer the `warp` component (below) — it moves streaming/voidY/safe-ground
  with the body in the same frame — or teleport in two steps and check
  `gaia.scenes.current` after.
- A `light` component ON a presence entity is a carried light. For its own
  client it rides the camera (offset in the camera's flat frame, z < 0 =
  ahead); interact/trigger ops grant it with `id: '$id'` (the presence that
  fired). The server reaps presences on disconnect — worlds that grant
  carried things re-grant them from world state (see the Tomb's
  flame-keeper trigger pattern).
- Presence `scene` stamps update server-side as they move — senses scope by
  where the player actually IS, not where they connected.
- MOVING A PLAYER from world logic: set a `warp` component ON the presence
  (`{position, yaw?, pitch?, fade?}` — position is an EYE pose like spawn).
  The owning client executes it — body, streaming, voidY and last-safe move
  together, `fade` masks the cut with a dark dip — then clears the component
  (edge-fired). Works from interact/trigger ops via `id: "$id"` (teleporter
  doors as pure data), from daemons (checkpoint respawns), from level ops.
  The client still owns its body: a warp on a menu-frozen client is ignored
  and burned.
- CAMERA RIGS are scene data: a `camera` component on the scene's environment
  entity (`GET /schema` documents it). `mode: "side"` is the fixed-frame 2.5D
  camera — fixed yaw/pitch, follows the body from `distance`/`height`, WASD
  moves in the fixed frame, the own presence mesh RENDERS (worlds should
  dress presences via level/daemon ops — the default is the pale head
  sphere), the carried light rides the body, no crosshair, and E picks the
  nearest usable interactable around the body (server range rules, minus the
  slack). Scenes without a camera stay first-person; creator mode always
  keeps the free camera, and `gaia.player.rig` shows the live spec. CDP
  play-tests drive it exactly like first person (`keys.add`), but yaw-based
  facing checks should read `gaia.player.bodyYaw`.

## Other ground rules

- Senses ARE the right tool for spatial/logic verification: positions,
  routes, triggers firing (check `/events`), lint (`check`).
- `GET /schema` documents every component: field meanings, sane ranges,
  enums. Read it before inventing values.
- Deep-link extras: `&log=1` opens the world log drawer (the op stream,
  visible in screenshots), `&mute=1` keeps your tab silent.
- NAMING WATCH: `world.json` is the SUPERSCENE (composition/meta) — it has
  NOT been the runtime snapshot since the scene model landed. Runtime player
  state lives in `saves/`; never delete world.json to "reseed". To apply
  regenerated or hand-edited files to a running server: `reset` op.
- A `use` op expands against the world as it was BEFORE its batch — send it
  in its own request, after the ops that position the user, or the range
  check reads stale state and silently refuses.
- The op journal caps at 2000 entries and presence updates flood it; query
  event tails promptly or you will miss them.
- Worlds are separate repos (`GAIA_WORLD`). Never edit a world repo's frozen
  demo content; the engine's own `world/` is the hub world.
- Caves/tunnels are ONE mesh part: `shape: 'tube'` — spline `path` (part-
  local control points) + `radii` per point (eases between), `inside: true`
  to walk through it (floor raycast-walkable — add `solid: true` when using
  a preset like stone), `wobble` for rock. The `paths` gizmo chip draws the
  spine + radius rings; edit points as plain numbers in the inspector or
  ops. Long systems: author as ~100m SEGMENTS (surfaceAt culls meshes whose
  entity origin is >60m away in xz; segments also stream better). Walls
  don't block (blockers are boxes) — fine for caves, gate the mouths.
- ONE hands-on lens: the `edit` button on the inspector's mesh section
  (it toggles to `done`). It shows everything the mesh is made of — tube
  spline control points as grabbable orange dots (W moves, R thickens) and
  the `carve` cutters ("holes") as translucent red ghost meshes, listed in
  the OUTLINER as children of the entity while the mode is on. A ghost is
  JUST A MESH: no renderOrder, no x-ray — it depth-tests, sorts, and fogs
  like every other mesh, so the world partially hides it and the visible
  edge is the intersection contour. It follows the draw mode (wires in
  wireframe) and frames like a mesh too: double-click its outliner row
  (or F while selected) to jump to it. The handle root re-syncs to the
  entity's body every frame, so ground re-snaps, streams, and transform
  ops can never make the ghost and the cut drift apart.
  Click a point/ghost in the world or a hole row in the outliner,
  W/E/R it with the entity gizmos; N (or the outliner's `+ hole` row)
  births a cutter where you look, ⌫ removes the selected one, esc is done.
  Outside edit mode the holes are invisible everywhere (including the
  inspector fields — the JSON tab still shows the raw `carve`). The mesh
  rebuilds on RELEASE (carves re-run CSG per rebuild); each release is one
  undoable mesh op. The data stays the flat `path`/`carve` arrays on the
  part — the "children" exist only as the lens, never as entities.
- Components have NO remove-×: click a section head to select it, ⌘⌫
  removes the component (one op, undoable). Programmatic removal stays
  `{op:'set', id, component, value: null}`.

## FX extensions: gore + rayfire (clean-room, branch `lampas/engine-ee-clean`)

Both live in `client/extensions/<name>/` and ride the extension contract
(`client/kernel/extensions.js`: `register(ctx)` → `{name, api, update?}`,
published as `window.gaia.<name>`). NOT on `main`, NOT in the Boomtown
engine worktree (`astra-gameplay-tree` has no `client/extensions/`). Status +
open work: `plan.md` → M21.

Clean-room law (both): implementer inputs = `docs/cleanroom/*` spec + own game
call sites + public refs ONLY. Never read/copy the older non-clean branches
(`lampas/engine-gore`, `lampas/engine-rayfire`, `lampas/engine-ee-fx` →
`client/extensions/gore|rayfire/**`, `tools/gore/**`) or any third-party
source/assets. Every source file carries the "original implementation"
header; `rayfire-index.test.js` checks it.

### gore — blood, pools, dismemberment
- Spec: `docs/cleanroom/gore-spec.md` (§1 API, §4 hard limits, §5 tests).
- Entry: `createGore({three, tsl, scene}, opts)` — drop-in factory a game
  calls itself (EE `client/gore-fx.js` imports `/extensions/gore/index.js`);
  or `register(ctx)` — engine loader, reads `ctx.three/tsl/scene` + optional
  `ctx.goreOpts`; missing three/tsl/scene → `{}` no-op, never throws.
- API: `blood.splash(pos,normal,strength)→count` · `blood.pool(pos,normal,
  size)→handle|null` · `cut(mesh,{part}|{plane})→{stump,piece}|null` ·
  `release(obj)→bool` (idempotent) · `update(dt)` · `setRecipes()` (= reset
  to empty; recipe table itself NOT implemented) · `stats()` · `dispose()`.
- `opts`: `blood.seed`, `blood.capacity.{particles=2048,decal=48}` (pools
  share the decal ring, FIFO eviction), `cut.seed`, `cut.lifetime` (s; auto-
  release stump+piece — set it in long matches or call `release` yourself).
- cut: non-skinned = required path; skinned = best-effort current-pose bake
  else null. Parts `head|leftArm|rightArm|leftLeg|rightLeg` = bbox-band
  PLACEHOLDER planes (one plane → one half-space piece). Materials cloned,
  red cap group. `piece.userData.gore.velocity` = mutable [3], integrated by
  `update`.
- PERF/GPU LAW: ≤6 vertex buffers per mesh incl. `instanceMatrix`/
  `instanceColor` (device max 8; live black screen came from 9) — audit with
  `vertex-budget.js` `auditVertexBudget`. Pack per-instance data into vec4s.
- WGSL LAW: a geometry/TSL attribute name becomes a WGSL identifier verbatim;
  a keyword/reserved word (live bug: `meta`) = shader compile fail = black
  screen. All gore attrs prefixed `goreX…`, checked against
  `wgsl-keywords.js` (W3C table). Any new attr: prefix + add to the test.
- Seeded own PRNG, no `Math.random`, no per-frame allocation in `update`,
  one InstancedMesh each for particles and decals.
- GOTCHA: ground is hard-coded `GROUND_Y = 0` (particles, decal contact, cut
  pieces) — worlds with terrain/floors ≠ 0 see blood/pieces sink or float.
- GOTCHA (4c7b03c): piece ground-rest must use ABSOLUTE world Y, not local
  offset. (ccd0637): leg planes need x-dominant normals or left/right legs
  produce identical pieces.

### rayfire — Voronoi fracture, demolition, structural collapse
- Spec: `docs/cleanroom/destruction-spec.md` (behaviour, §16 numbered
  acceptance) + `docs/cleanroom/destruction-api.md` (exact export list —
  machine-checked by `rayfire-index.test.js`; add a name ⇒ update both).
- Entry: `register(ctx?)` → `{name:'rayfire', api}`; ctx ignored, no module
  state, call any number of times. Games: `(await import('/extensions/
  rayfire/index.js')).register().api` (EE `client/destruction-rayfire.js`).
  Every api name is also a named ESM export. No `update` — the consumer
  drives `RFWorld.step(dt)`, fade and collapse ticks itself.
- Layers: fracture core (pure, no THREE: closure → Voronoi cells, convex hull
  fallback) · render glue (`facesToBufferGeometry`, `fracture(obj)`,
  `demolish(obj,{point,impulse})`) · `RFWorld` (own rigid sim) · structure
  (anchors/adjacency/joints/support/erosion) · collapse · activation · fade ·
  impulses (`explode`, `shoot`).
- HARD GUARANTEE: every fragment watertight + volume > 0, 0 throws, on the
  full census (407 EE buildings, 7430 fragments, seed 7 amount 20). Open-shell
  assets are the NORM — closure caps them first.
- Perf: census p95 ≈62 ms/model fracture, single thread. >2× p95 regression =
  fail. Output pure+deterministic per (soup, seed) ⇒ cache/pre-warm
  consumer-side; fragment caps are consumer-side too.
- `RFWorld`: semi-implicit Euler, ONE ground plane (`groundY`, default 0),
  sphere/OBB bounds, sleep, bounding-sphere raycast. NO body-vs-body contact.
  Swappable backend interface (step/addBody/removeBody/getBody/raycast/
  applyImpulse/applyAngularVelocity). Set `groundY` from the world — 0 is a
  default, not a floor.
- Look: flat normals, stock materials, groups 0=exterior 1=interior (cut).
  `fracture()` freezes fragment matrices to the source `matrixWorld`
  (`matrixAutoUpdate=false`) — move them via the body, not the source.
- Naming law: any attr/uniform/varying = `rfX…`, ∉ WGSL reserved; single
  table `names.js` `RFX_NAMES` (today only `rfXExterior`).
- Fade: `SCALE_DOWN` default (life 7±3 s, fade 5 s); `body.awake===false` =
  asleep = consumer's fade trigger; sleep must be reachable at dt=0.05.
- GOTCHAS: (f47b68d) `step(0)` still lifts a just-activated body out of the
  ground — consumers' first tick is dt=0. (dc76801) watertight oracle is
  exact-first; repeated-edge tris dropped; flat-sheet components; ear-clip
  diagonal conflict guard. Concave sources → approximate caps (§3.8).
  Unyielding (anchored) joints are never removed by collapse.

### Verification (both)
```sh
node --test test/gore-*.test.js      # 62 pass (incl. real three/webgpu+tsl construct)
node --test test/rayfire-*.test.js   # 125 pass, 1 skip = census
EE_ASSETS=<dir with bld_*.gltf> node --test test/rayfire-census.test.js
```
Unit green ≠ renders. Blood/pool/cut caps/debris = pixels → screenshot per
§ Confirm rendering, in a game that wires the extension, via its real
trigger (shot/kill/explosion), then PLAY IT (below). Black screen after
wiring = check vertex-buffer count + WGSL identifier names first.

## ⚠ PLAY IT BEFORE YOU CLAIM IT (Pascal, 2026-07-12 — non-negotiable)

Never tell Pascal a feature works because logs, unit checks, or injected
commands say so. Before claiming ANY in-world feature is implemented or
fixed, PLAY it through the real player path — the exact path a player
uses: real chat (POST /act say), real movement (player controller /
gaia.player.keys), real senses (/sense/*, rain proprio/fov, screenshots
for pixels). The engine was built with eyes, ears, senses, and player
controllers FOR agents — use them. Injecting into a daemon's command
file, reading its log, or poking internal state is NOT verification; it
bypasses the path the player actually uses. If you did not play it, the
claim is UNVERIFIED and must be labeled so.
