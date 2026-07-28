# Atlas static-site dependency map

§ recon 2026-07-28 — bounded, for SERVERLESS SNAPSHOT MODE + Cloudflare scaffold task.

## Live-server dependencies found

- **client/kernel/net.js** `connect()` — the only websocket. `ws://<host>:__GAIA_PORT__`.
  Drives world state via `onSnapshot`/`onOps` callbacks; `send`/`sendDev`/`sendRaw`
  are the only outbound paths (spawn/set/merge/despawn ops). Single choke point →
  single swap point for static mode.
- **client/main.js** — `net.send`/`net.sendDev` used pervasively (ensurePresence,
  panel/palette/editor/interact/vrmEditor/characterCreator/history, debug-knob
  `saveDebug`, warp handling, level select). Two direct `fetch(...__GAIA_PORT__...)`
  calls outside net.js: `POST /act` (chat "say", foreign uncommitted hunk — not
  touched) and `POST /snapshot` (`+` debug capture) — both already wrapped in
  try/catch, degrade to a console.warn with no server, non-fatal.
- **client/plugins/atlas-strategy.js** `loadGraph()` — fetches `/atlas-graph.json`
  same-origin FIRST, falls back to `${base}/atlas-graph` and
  `${base}/assets/atlas-graph.json` (base = GAIA_PORT server) only if the first
  fails. Already static-friendly: the same-origin fetch resolves against
  whatever origin the client itself was served from — dev (vite :5173) or a
  built dist/ served anywhere.
- **client/plugins/atlas-gate.js** — fetches `/assets/gate-config.json`
  same-origin. Also static-friendly by construction (comment in the file says
  so explicitly). Presentation-layer only — see its own honesty note.
- **client/plugins/atlas-cosmos.js**, **atlas-director.js** — audio via
  `/assets/audio/...` same-origin. Static-friendly.
- **client/kernel/vrm.js**, **client/plugins/vrm-editor.js** — VRM/VRMA URLs
  are all `/assets/vrm/...`, `/assets/vrma/...` same-origin. Static-friendly.
- **world/scenes/*.json** — `src` fields point at `/assets/vrm/...` same-origin,
  not the world server. Static-friendly.
- **server/index.js** — exposes `/world` (GET, the full snapshot:
  `{counter, entities, world, materials}` — exactly the shape needed),
  `/events`, `/sense/*`, `/schema`, `/screenshot`, `/assets/*` (serves
  `$GAIA_WORLD/assets`, DISTINCT from `client/assets/` — world server assets
  are for sim content like weather samples, not referenced by the Atlas
  client), `/prefabs`, `/op`, `/snapshot`, `/act`, plus the ws upgrade. Only
  `/world`'s shape matters for static mode — captured once, see below.
- **vite.config.js** — `root: 'client'`, `define: { __GAIA_PORT__ }`. No build
  section originally (dev-only config) — added `build.target: 'esnext'`
  (top-level await in main.js's renderer boot fails against esbuild's default
  ~chrome87 target), `build.outDir: '../dist'`, and a `closeBundle` copy step
  for `client/assets/**` + `client/atlas-graph.json` (neither is ever
  `import`ed by JS, so Vite's module graph never sees them — a plain
  `vite build` silently drops both; confirmed empirically, see item 4).

## What did NOT need touching

Every `/assets/...` and `/atlas-graph.json` reference in the client is
already a same-origin relative fetch — none of them hardcode `__GAIA_PORT__`
as their primary path. The ONLY live-server dependency that actually needed
replacing was the websocket in net.js.

## Static mode design

`client/kernel/static-world.js` exports `connectStatic({onSnapshot, onOps,
onStatus})` — same call/return shape as `net.js`'s `connect()`, so
`client/main.js` only branches on WHICH one to call (`?static=1` in the URL,
or `__GAIA_STATIC__` baked by `GAIA_STATIC_BUILD=1 vite build`), never
rewrites the callback bodies. One fetch of `/assets/world-snapshot.json` on
load; `send`/`sendDev` loop ops straight back through `onOps` (a same-tick
local echo, not a network round-trip) so every caller that already expects
an eventual `onOps` echo — panel, editor, ensurePresence, debug knobs — keeps
working unmodified. Nothing persists past the tab.

`world-snapshot.json` was built from
`/Users/pascaldisse/projects/paloptic/viz/data/atlas-ops.json` (434 spawn
ops → entities dict) + `viz/world-atlas/world.json` (scene meta) — the
canonical source named in the task, not the live dev server's `/world`
(which had picked up a stray leftover presence entity from an earlier
session, 435 vs 434 entities — the ops file is the clean source).

## Build verified (2026-07-28)

`GAIA_STATIC_BUILD=1 npx vite build` → `dist/` (106 MB): `index.html`,
`assets/index-*.js` (1.4 MB bundle), `assets/{vrm,audio,vrma}/`,
`assets/gate-config.json`, `assets/world-snapshot.json` (632 KB),
`atlas-graph.json` (4.1 MB) at dist root. Served locally on a free port
(4173, `python3 -m http.server`), loaded in a **new** CDP tab at
`?static=1`: `window.gaia` populated, 435 entities (434 snapshot + 1 local
presence loopback), atlas graph loaded (3061 nodes/7748 edges), cosmos +
forge initialized, zero console exceptions. Called `atlasStrategy.select(id)`
directly (deterministic node pick, no coordinate guessing) → panel opened
with full node detail (relations, properties). Screenshot: `proof/static-mode.png`.

## Cloudflare scaffold

See `deploy/cloudflare/README.md` for the full deploy story. Summary: Pages
project `paloptic-atlas`, `functions/_middleware.js` gates every request
(password → SHA-256 vs `GATE_HASH` var, sourced from
`paloptic/gate/gate-config.json`'s hash — never `PASSWORD.txt`) before any
static byte ships, signs an HttpOnly session cookie with a real
`SESSION_SECRET` (bound via `wrangler pages secret put`, not committed).
Verified locally with `wrangler pages dev` + a throwaway test password/hash
(not the real gate secret) — see the README's "Local test" section for the
exact request/response proof.
