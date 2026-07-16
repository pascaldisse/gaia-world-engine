# FEATURES.md — the 100% contract

Rule (Pascal, 2026-07-16): the rewrite is **feature-complete vs the existing
engine**. Every row in the section docs must reach ✅ (native parity proven by
the section's own verification discipline) before the web client dies.
Boomtown/PARITY.md = acceptance test, never the scope.

## Sections (inventoried from source, zero-missing cross-checks pasted in room)

| doc | scope | rows | gate proof |
|---|---|---:|---|
| [features/CLIENT.md](features/CLIENT.md) | every `client/` module: renderer, geometry kernel (tube spline + carve CSG + edit lens), materials/presets, terrain/scatter/particles, light pool, fog/environment, warm-up, player, streaming, full editor surface, behaviors, rain.js, audio, HUD/title, VRM, net | 79 | 28/28 kernel modules mentioned |
| [features/SERVER.md](features/SERVER.md) | every `server/` + `shared/` file: HTTP/WS/journal, all ops, 24 schema components, senses, triggers, world model, saves, presence lifecycle, env config, shared math | 121 | 24/24 schema components, exact order |
| [features/TOOLS.md](features/TOOLS.md) | `tools/*`, AGENTS.md contracts: agent CLI verbs, CDP→control channel, profile-seam, rain proprio/fov, snapshots, deep links, title/level data, ports | — | 9/9 tools/*.mjs documented |

## Companion contracts
- [PARITY.md](PARITY.md) — boomtown/unity-import delta (merge list + risks). Subset of this contract.
- Mesh tools = first-class: tube spline, carve CSG (rebuild-on-release, one undo op), edit-lens interaction → geometry-kernel subsystem. CSG make-or-buy recon before impl.
- Rain = port requirement: fov/proprio native off ECS (no browser), /screenshot framebuffer = pixel-truth organ. NOTE: `rain fov --watch` implemented on naruko branch, not this tree — port from there.

## Cross-branch spread (features living outside this tree — contract still owns them)
| feature | where |
|---|---|
| unity compat verticals (traffic, carjack, weapons, crime, police, peds, gangs, ECS host, GLTF/instancing/skinned, AVP) | `GAIA-World-Engine-unity` @ unity-import |
| rain `--watch`, nerves/feel daemons, spatial speech | `GAIA-World-Engine-naruko` (+ addon branch) |
| VRM avatars | this branch (vrm-avatars base) |

## Status convention
Each section doc's last column = port disposition (native Rust / DOM overlay /
Bun stays / control channel / dies). Implementation waves check rows off by
adding `✅ <commit>` to the row. No row, no feature. No ✅, no death of the
web client.
