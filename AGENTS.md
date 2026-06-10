# Working on GAIA — instructions for AI agents (any of them)

## Confirm rendering with screenshots, not senses

The sense API (`look/map/describe/query/check`) reads world DATA. It cannot
see pixels. Materials, lighting, fog, transparency, bloom, particle
visibility — none of that is confirmable through senses. **Any change that
affects how the world LOOKS must be confirmed with a screenshot before
calling it done:**

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
  `?create=1&select=<id>&gizmos=colliders,triggers,water,lights,sounds,paths,areas,zones&pos=x,y,z&yaw=r&pitch=r`
  — creator mode opens by itself, the entity is selected, the listed gizmo
  categories switch on, and the camera goes exactly where you said (editor
  mode has no gravity, so it stays). Gizmos draw into the WebGL canvas, so
  `shot` captures them; the DOM panels (outliner/inspector) do NOT appear in
  canvas screenshots — verify those with a headless Chromium screenshot
  (e.g. Brave: `--headless --screenshot=out.png --user-data-dir=/tmp/x <url>`).

## Other ground rules

- Senses ARE the right tool for spatial/logic verification: positions,
  routes, triggers firing (check `/events`), lint (`check`).
- `GET /schema` documents every component: field meanings, sane ranges,
  enums. Read it before inventing values.
- Deep-link extras: `&log=1` opens the world log drawer (the op stream,
  visible in screenshots), `&mute=1` keeps your tab silent.
- Kill the dev server BEFORE deleting `world.json` — its debounced save
  (weather merges dirty it every ~1s) resurrects old state.
- The op journal caps at 2000 entries and presence updates flood it; query
  event tails promptly or you will miss them.
- Worlds are separate repos (`GAIA_WORLD`). Never edit a world repo's frozen
  demo content; the engine's own `world/` is the hub world.
