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
  tabs pause rendering). Keep exactly ONE tab open — every extra tab is a
  full extra player session whose stale presence pollutes the world and may
  be the tab that answers your screenshot request.
- List sessions with `GET /sense/query?has=presence`; closing a tab despawns
  its presence.
- Low-alpha standard materials (`opacity` < ~0.15) are effectively invisible
  in dark scenes. For light shafts/halos use the additive presets (`beam`,
  `glow`) — that is what they are for.

## Other ground rules

- Senses ARE the right tool for spatial/logic verification: positions,
  routes, triggers firing (check `/events`), lint (`check`).
- Kill the dev server BEFORE deleting `world.json` — its debounced save
  (weather merges dirty it every ~1s) resurrects old state.
- The op journal caps at 2000 entries and presence updates flood it; query
  event tails promptly or you will miss them.
- Worlds are separate repos (`GAIA_WORLD`). Never edit a world repo's frozen
  demo content; the engine's own `world/` is the hub world.
