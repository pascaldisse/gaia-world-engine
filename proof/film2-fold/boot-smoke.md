# FILM2 FOLD · boot smoke (stage 4)

Iso stack: world server 8456 (GAIA_WORLD=/tmp/film2fold-world, seeded from
paloptic viz/data/atlas-ops.json → **512 entities**), vite 5196 (own cacheDir
.scratch/vite), Brave hidden + `--mute-audio` on CDP 9256. No window, never
8420/8421/5173/5174. Raw numbers: `boot-smoke.json`.

| check | result |
|---|---|
| world census | **512 entities** (server `/world`); atlas records in cosmos: 3061 |
| film starts | yes — `director.play()` through the gate/intro path, `playing:true` |
| audio is the clock | t 6.010096 vs audioT 6.010667 → t 11.018667 vs audioT 11.018667 (**identical**), `waitingForAudio:false`, `paused:false` |
| clock advances | yes (6.01 → 11.02 over 5 wall seconds, real time) |
| silence | browser `--mute-audio` (OS level) + `?mute=1`; element `muted:false` so `currentTime` is a REAL clock read, and nothing reached the speakers |
| prewarm | **8/8 ok** — seg1 132ms · seg2 120ms · seg3 2ms · seg4 21ms · seg5 269ms · seg6 73ms · seg7 40ms · seg8 76ms, all inside the drone |
| console errors | **0 errors, 0 exceptions**; 2 warnings, both `THREE.BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed` (three.js, not the fold) |
| scrubber seeks | `scrub(160)` → `{t:160, scene:'seg5', audioT:160, playing:true}`, and 2.5s later t=162.51 still in seg5 → the seek MOVED THE CLOCK and playback continued |

Gates: `atlas_gate` must be the gate-config sha256 prefix (`8fc666825e1a4b06`) —
`'1'` is not a token and `main.js` blocks forever on `await waitForGate()`
with the world stuck at "connecting… · 0 entities". That is what a dead boot
looks like, and it is not a film bug.
