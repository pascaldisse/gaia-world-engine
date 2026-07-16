# Tools · agent surface · operator contracts

Scope → JS source `tools/`; `AGENTS.md`; `docs/`; root `package.json`; `vite.config.js`; server/client entrypoints. Plan labels → **native endpoint** = preserve/add server HTTP/WS route; **control channel** = authenticated local Rust-client IPC, replacing Chromium DevTools; **stays** = external operator/CI helper, not a runtime-client feature.

## Capability inventory

| Capability | Source | Behavior | client-rs plan |
|---|---|---|---|
| Agent identity/base selection | `tools/agent.mjs` | `GAIA_URL`→`http://localhost:8420`; `GAIA_AGENT`→`agent-claude`; identity travels as `as`. | **native endpoint**; retain env compatibility; native client identifies its presence over WS. |
| Agent `look` | `tools/agent.mjs` → `GET /sense/look` | Text view; CLI forwards `--as` plus arbitrary paired flags; server accepts `as,x,y,z,yaw,fov,range`. | **native endpoint**; preserve sense text protocol. |
| Agent `map` | `tools/agent.mjs` → `GET /sense/map` | ASCII terrain/entity map at positional args `x z radius`; server also accepts `cells`. | **native endpoint**; preserve route/query contract. |
| Agent `describe` | `tools/agent.mjs` → `GET /sense/describe` | One entity’s semantic description and position by `id`. | **native endpoint**. |
| Agent `query` | `tools/agent.mjs` → `GET /sense/query` | Entity filter; CLI paired flags; server supports `has,name,nearX,nearZ,radius`. | **native endpoint**. |
| Agent `check` | `tools/agent.mjs` → `GET /sense/check` | Semantic world lint; spatial/logic verification, not pixels. | **native endpoint**. |
| Agent `events` | `tools/agent.mjs` → `GET /events` | Op-journal tail from positional `since` (default `0`); route also accepts `limit`, max 500; journal caps at 2000. | **native endpoint**; retain sequence cursor and bounded tail. |
| Agent `move` | `tools/agent.mjs` → `POST /act` | `move_to` intent: `x,z[,speed]`; blocks until arrival and prints result + next `look` frame. | **native endpoint**; native controller remains the body executor. |
| Agent `walk` | `tools/agent.mjs` → `POST /act` | `walk` intent: `dx,dz[,seconds=2]`; embodied finite motion. | **native endpoint**. |
| Agent `face` | `tools/agent.mjs` → `POST /act` | `face` accepts entity id or numeric yaw. | **native endpoint**. |
| Agent `grab` / `drop` | `tools/agent.mjs` → `POST /act` | Intent-layer carry control; `grab` names an entity, `drop` has no payload. | **native endpoint**. |
| Agent `say` | `tools/agent.mjs` → `POST /act` | `say` joins trailing CLI text; server returns action plus look frame. | **native endpoint**; preserve spatial chat semantics when implemented. |
| Agent `shot` | `tools/agent.mjs` → `GET /screenshot` | Writes relay PNG; default `shot.png`; optional second arg becomes `?from=<presence-id>`. | **native endpoint** backed by native renderer capture responder. |
| Presence-targeted screenshot | `server/index.js`, `client/main.js`, `AGENTS.md` | Server broadcasts a request; only matching presence responds when `from`; untargeted first responding/frontmost tab wins; 8-s timeout. | **native endpoint**; correlate request id + native presence, select deterministically. |
| Raw live ops CLI | `tools/patch.mjs` → `POST /op` | `spawn,set,merge,despawn,clear,state,reset,load`; `state` merges `world-state`; `load` posts JSON file. | **native endpoint**; retain operation grammar and `dev` write path. |
| World/prefab CLI | `tools/patch.mjs` → `GET /world`, `GET/POST /prefabs` | `snapshot` prints world; `prefabs` lists; `prefab` creates/updates named component docs. | **native endpoint**. |
| Schema endpoint | `server/index.js` → `GET /schema` | Machine-readable component docs/ranges/enums; agents must read before inventing values. | **native endpoint**; Rust schema export is authoritative. |
| Screenshot/debug capture | `client/main.js`, `server/index.js` → `POST /snapshot` | `+` posts canvas data URL + player `{id,position,yaw,pitch,scene}`; optional `radius`; server writes sibling `debug/<stamp>.png` and `.json`. | **native endpoint**; native renderer sends PNG bytes/data URL equivalent. |
| Debug snapshot JSON contract | `server/index.js` | JSON contains `time:{wall,world}`, `player`, `carried` presence components/null, all `state` components, `nearby` query at `radius` default 20, and line-array `look`; PNG only when image supplied. | **native endpoint**; preserve fields/path pairing. |
| CDP target discovery | `tools/cdp-lib.mjs` | `CDP_HOST` default `127.0.0.1`, `CDP_PORT` default `9222`; finds first page whose URL contains `:${GAIA_CLIENT_PORT:-5173}`, including localhost/IPv6. | **control channel**; native app publishes an explicit local control socket, no target scan. |
| CDP evaluation | `tools/cdp.mjs` | `eval <expression>` sends `Runtime.evaluate`, awaits promises, prints by-value result; exposes `window.gaia` internals. | **control channel**; typed/native debug RPC for pose, editor, render stats, input and rAF probe; do not expose arbitrary production eval. |
| CDP full-page screenshot | `tools/cdp.mjs` | `shot [file]` uses `Page.captureScreenshot`; captures DOM panels + canvas unlike relay canvas screenshot. | **control channel**; native compositor/window capture including native editor chrome. |
| CDP launch discipline | `AGENTS.md`, `docs/RAIN.md` | Brave: `open -n -g -j`; dedicated `--user-data-dir`; `--remote-debugging-port=9222`; three anti-throttle flags; never `--headless`; use `&mute=1`. | **stays** only while web client exists; native debug launch must be background/nonintrusive and keep frame ticking when occluded. |
| Occlusion/rAF probe | `AGENTS.md` | Covered browser tabs freeze rAF/timers without anti-throttling; validate via `requestAnimationFrame` before trusting deep links, simulated input or reads. | **control channel**; native diagnostics return live frame counter/timestamp. |
| Seam CPU profile | `tools/profile-seam.mjs` | CDP Profiler samples at 200 µs; evals supplied seam trigger/default teleport; waits 4 s; prints 25 hottest self-time functions. | **control channel**; native tracing/CPU-profile command around named scenario, retain frame-time probe. |
| rain proprioception | `tools/rain.mjs`, `client/kernel/rain.js`, `docs/RAIN.md` | CDP calls `gaia.rain.proprio(id,{ticks,hz})`; integer grid detects `!BACK,!SKEW,!FLOAT,!SINK,!STIFF` or `OK`. | **control channel**; native rain RPC returns byte-identical text/codebook. |
| rain FOV | `tools/rain.mjs`, `client/kernel/rain.js`, `docs/RAIN.md` | CDP calls `gaia.rain.fov(id,{fov,range})`; facing-relative, range/FOV-culled nearest-first rows. | **control channel**; native rain RPC. |
| rain `--watch` contract | `docs/world/nari/embodiment/embodiment-spec.md` | Specified, **not implemented** by current `tools/rain.mjs`: 10-Hz configurable FOV diff stream; appear/leave/move events after 2°/5-cm noise floors; read-only/session-scoped. | **control channel**; implement subscription stream, then retain CLI `fov --watch --hz`. |
| Embodied motion verification | `docs/RAIN.md`, `docs/world/nari/embodiment/embodiment-spec.md`, `AGENTS.md` | After each `walk`, sample proprio; only `OK` chains motion; correct at most three times; use senses for logic and screenshot for visual claims. | **stays** as agent policy; native endpoints/control channels supply evidence. |
| Nari soma behavior daemon | `tools/nari-soma.mjs` | 200-ms command-file daemon: priority dispatch (`walkTo`,`follow`,`face`,`halt`,`affect`), 2-s position sampling, stuck detection, idle wandering, affect JSON/log/PID files. | **stays** external daemon; preserve agent CLI/API compatibility, replace hard-coded engine root before reuse. |
| Nari voice bridge | `tools/nari-say.sh` | Posts `agent-nyari` speech first, health-checks/starts claude-voice, then backgrounds `airy` TTS; explicitly avoids engine process control. | **stays** external integration; native client may consume spatial audio but does not own voice daemon. |
| VRoid parser regression | `tools/test-vroid.mjs` | Reads fixed `~/Documents/model.vroid`; ZIP-extracts `v1model/data.bin`; asserts byte-identical protobuf round trip and editable slider read/write. | **stays** Node regression helper; port core codec tests to Rust when VRoid I/O moves. |
| ZIP/VRoid regression | `tools/test-zip.mjs` | Reads fixed `/tmp/model-src.vroid`; validates ZIP entries/data and exact 328 slider keys, then byte-identical archive contents. | **stays** fixture-dependent helper; duplicate assertions in Rust codec tests. |

## Browser/deep-link surface

| Capability | Source | Behavior | client-rs plan |
|---|---|---|---|
| `?create=1` | `client/main.js`, `AGENTS.md` | Enters creator mode after spawn; hides overlay; free editor camera/no gravity. | **control channel** plus optional native launch argument. |
| `?select=<id>` | `client/main.js` | Selects entity and frames it in creator mode. | **control channel**. |
| `?gizmos=a,b,c` | `client/main.js`, `AGENTS.md` | Toggles named overlay categories; documented set: `colliders,triggers,water,lights,sounds,paths,areas,scenes`. | **control channel**; preserve category vocabulary. |
| `?pos=x,y,z` | `client/main.js` | Explicit finite 3-number editor camera pose; overrides selected-entity framing. | **control channel**. |
| `?yaw=r` / `?pitch=r` | `client/main.js` | Explicit editor camera angles; missing/invalid maps to zero. | **control channel**. |
| `?level=<id-or-name>` | `client/main.js`, `AGENTS.md` | Finds level by `id` or `name`, skips menu, respawns and applies exact level setup; combines with mute for probes; reset affects live shared world. | **native endpoint** for level data/ops; native launch argument/control channel for selection. |
| `?log=1` | `client/main.js`, `AGENTS.md` | Opens DOM world-log drawer. | **control channel**; native log panel capture must be included in debug capture. |
| `?mute=1` | `client/main.js`, `AGENTS.md` | Mutes browser work tab; mandatory for agent verification tabs. | **stays** URL compatibility during web migration; native launch/control option defaults muted for automation. |
| Deep-link timing contract | `AGENTS.md` | Deep links need a visible rendering client; canvas relay shot captures gizmos but not DOM; DOM requires CDP full-page shot. | **control channel**; expose native editor selection/gizmo/capture without browser timing races. |

## Game/session and port contracts

| Capability | Source | Behavior | client-rs plan |
|---|---|---|---|
| `game.json` title screen | `server/index.js`, `client/main.js`, `AGENTS.md` | Presence of game data replaces plain overlay with `{title,subtitle,levels}`; absent file keeps plain GAIA overlay. | **native endpoint**; parse identical contract. |
| Menu camera/frozen probe | `game.json` contract in `AGENTS.md`, `client/main.js` | `menu.camera:{position,yaw,pitch}` holds rendered menu shot; no presence until level selection; `player.frozen`; changing frozen pose streams/snapshots without body. | **control channel** for native pose probe; native client preserves frozen semantics. |
| Level entry | `client/main.js`, `AGENTS.md` | `{id,name,spawn:{position,yaw},reset,ops}`; body exists before ops; `$id` and `$now` substitute; reset then ops; menu NEW GAME chooses first. | **native endpoint**; preserve ordering/substitution and shared-world reset side effect. |
| GAIA server/world routing | `server/index.js`, `package.json` | `GAIA_PORT=8420` default; `GAIA_WORLD` selects separate world dir; `npm run dev` concurrently starts Node server + Vite. | **native endpoint**; native client config carries server URL/world remains server-owned. |
| Web client port injection | `vite.config.js`, `AGENTS.md` | `GAIA_CLIENT_PORT=5173` default; Vite injects `GAIA_PORT` as `__GAIA_PORT__`; IPv6 fallback URL is `http://[::1]:5173/`. | **stays** web-dev compatibility; native control discovery takes explicit endpoint, not port heuristics. |
| Tool port matrix | `tools/{agent,patch,cdp-lib}.mjs`, `AGENTS.md` | Agent/patch use `GAIA_URL`; CDP tools use `CDP_HOST/CDP_PORT` and `GAIA_CLIENT_PORT`; screenshot/op/sense curls target selected world-server port. | **native endpoint/control channel**; one native config object supplies HTTP + debug socket addresses. |
| Rendering evidence discipline | `AGENTS.md` | Sense APIs read data only; materials/fog/transparency/bloom/particles require a screenshot read from a connected visible client; target presence and minimize tabs. | **stays** verification policy; native endpoint/control capture is required evidence. |
| Play-path evidence discipline | `AGENTS.md` | In-world claims require real chat, player controller movement, senses/rain and screenshots; logs/internal injection alone are unverified. | **stays** verification policy; native controls must drive real controller path, never mutate final state directly. |
| Screenshot visual constraints | `AGENTS.md` | Low-alpha standard material is effectively invisible in dark scenes; light shafts/halos use additive `beam`/`glow`; screenshot must be inspected. | **stays** rendering/operator contract; native renderer parity tests use captured pixels. |
| Authoring/runtime boundary | `AGENTS.md` | Scene/world files reload through `reset`; dev writes carry `dev:true`; gameplay remains runtime-only; player saves overlay scene truth. | **native endpoint**; no tool/control shortcut bypasses server authoring semantics. |

## Tool-file gate

Required set = every `tools/*.mjs` file at audit time. The source column above names every entry; `cdp-lib.mjs` is the shared capability rather than a standalone CLI.

```text
$ ls tools/*.mjs | xargs -n1 basename | sort
agent.mjs
cdp-lib.mjs
cdp.mjs
nari-soma.mjs
patch.mjs
profile-seam.mjs
rain.mjs
test-vroid.mjs
test-zip.mjs

$ rg -o 'tools/[A-Za-z0-9-]+\.mjs' client-rs/features/TOOLS.md | sed 's#tools/##' | sort -u
agent.mjs
cdp-lib.mjs
cdp.mjs
nari-soma.mjs
patch.mjs
profile-seam.mjs
rain.mjs
test-vroid.mjs
test-zip.mjs

$ diff -u <(ls tools/*.mjs | xargs -n1 basename | sort) <(rg -o 'tools/[A-Za-z0-9-]+\.mjs' client-rs/features/TOOLS.md | sed 's#tools/##' | sort -u)
# exit 0
```
