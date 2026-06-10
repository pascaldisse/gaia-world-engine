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
  `shot` captures them; the DOM panels (outliner/inspector/log) do NOT
  appear in canvas screenshots. For those, launch a dedicated visible
  browser instance with the DevTools protocol and use `tools/cdp.mjs`:
  ```sh
  "Brave Browser" --user-data-dir=/tmp/gaia-profile --remote-debugging-port=9222 "<url>" &
  node tools/cdp.mjs shot ui.png      # full page: DOM + canvas
  node tools/cdp.mjs eval 'gaia.gizmos.root.children.length'   # poke the kernel
  ```
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
- You can drive a full play-test over CDP without a keyboard: set
  `gaia.player.locked = true`, toggle modes via `gaia.editor`, and hold keys
  with `gaia.player.keys.add("KeyW")` / `.delete(...)`. Verify climbs by
  reading `gaia.player.position` — feet are `y - 1.6`.

## Other ground rules

- Senses ARE the right tool for spatial/logic verification: positions,
  routes, triggers firing (check `/events`), lint (`check`).
- `GET /schema` documents every component: field meanings, sane ranges,
  enums. Read it before inventing values.
- Deep-link extras: `&log=1` opens the world log drawer (the op stream,
  visible in screenshots), `&mute=1` keeps your tab silent.
- Kill the dev server BEFORE deleting `world.json` — its debounced save
  (weather merges dirty it every ~1s) resurrects old state.
- A `use` op expands against the world as it was BEFORE its batch — send it
  in its own request, after the ops that position the user, or the range
  check reads stale state and silently refuses.
- The op journal caps at 2000 entries and presence updates flood it; query
  event tails promptly or you will miss them.
- Worlds are separate repos (`GAIA_WORLD`). Never edit a world repo's frozen
  demo content; the engine's own `world/` is the hub world.
