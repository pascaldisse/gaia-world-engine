# FOLD GATES ATOM — report

Worktree ~/projects/GAIA-WE-fold, branch fold @ f9a9433a5e23aef2b66cadd7a4b35193e1d25d18 (unmerged, no code added).

## Iso stack (LEFT RUNNING per instructions)

- world server: GAIA_PORT=8460, PID 90137 (`node server/index.js`)
- vite client: GAIA_CLIENT_PORT=5220, PID 90150 (`npx vite --port 5220 --strictPort`)
- headless Chrome: CDP_PORT=9260, PID 90173 (`--headless=new --mute-audio --remote-debugging-port=9260 --user-data-dir=/tmp/fold-gates-profile`, no window, muted)
- browser tab: `http://localhost:5220/?intro=off&mute=1`, gate token pre-seeded (`localStorage.atlas_gate = '8fc666825e1a4b06'` = `client/assets/gate-config.json`'s `sha256.slice(0,16)` — no password text needed, this is the harness's own bypass, same value the real password would produce after gate.onCorrect()), `atlas_seen_intro='1'`.
- world seeded: POSTed `~/projects/paloptic-fold/viz/data/atlas-ops.json` (512 ops) then `quest-ops.json` (2 ops) to `http://localhost:8460/op` as `{ops:[...]}`, UA `curl/8.4.0` — both `{"ok":true}`.
- page state: `window.gaia.atlasCosmos.ready === true` (3061 nodes), `window.D` = prepared atlas-director (51 keys, hero `089603185d8cf6dc`, cast confirmed by `tools/film-b-boot.mjs`).
- logs: `/tmp/fold-server.log`, `/tmp/fold-vite.log`, `/tmp/fold-chrome.log`.

Frame-check atom: reuse this stack — GAIA_PORT=8460 / GAIA_CLIENT_PORT=5220 / CDP_PORT=9260, same profile dir, gate already passed.

---

## Gate 1 — film-d harness: `bun test test/atlas-analytics.test.js`

Command: `cd ~/projects/GAIA-WE-fold && bun test test/atlas-analytics.test.js`

```
bun test v1.3.14 (0d9b296a)

test/atlas-analytics.test.js:
(pass) buildAdjacency / degree > directed entries with correct dir + weight default [0.72ms]
(pass) pagerank > normalizes to ~1 and hub dominates a star graph [0.83ms]
(pass) pagerank > deterministic across runs (fixed iteration count, no RNG) [0.16ms]
(pass) louvain > finds two communities on a two-clique fixture, modularity > 0, deterministic per seed [0.70ms]
(pass) louvain > modularity improves over singleton baseline [0.25ms]
(pass) shortestPath > finds correct path length + edge list, null for disconnected [0.31ms]
(pass) outliers > returns low-degree ids sorted [0.25ms]
(pass) layouts > layoutByGroups covers every node, no NaN, deterministic per seed [0.45ms]
(pass) layouts > layoutShells covers every node, no NaN, no overlap-at-zero for multi-member shells [0.18ms]
(pass) layouts > layoutTimeline covers every node, nulls parked past axis end, no NaN [0.28ms]
(pass) layouts > layoutOrbit covers centers + all assigned satellites, no NaN [0.31ms]
[sim/500-node] peak energy=5162.0823 (step 55) final energy=4845.4096 median step=1.040ms max step=4.549ms
(pass) createSim > 200 steps on 500-node synthetic graph: energy trends down, no NaN, step timing logged [225.00ms]
[real sidecar] nodes=3061 edges=7748 buildAdjacency=1.8ms pagerank=10.9ms louvain=15.5ms (communities=375 modularity=0.5155) simInit=5.0ms sim60steps=688.8ms avgStep=11.48ms maxStep=12.63ms
(pass) real sidecar (paloptic atlas-graph.json) > load + pagerank + louvain + 60 sim steps, timings logged [733.97ms]

 13 pass
 0 fail
 15844 expect() calls
Ran 13 tests across 1 file. [1032.00ms]
```

**Result: 13/13 pass, 0 fail — NOT 68.** File is a single flat bun suite (`describe`/`test` count checked across every branch in this worktree — film-a/b/c/d/merge, fix-blockers, gate-boot, npc-ui, onboarding, beauty-*, cosmos-art — all identically 13 `test(` blocks, no dry/live env-var branch exists in the file). "dry" (synthetic star/clique/500-node graphs) and "live" (the `real sidecar` test against the actual 3061-node/7748-edge `paloptic/viz/data/atlas-graph.json`, loaded directly off disk) are both inside this one run — there is no separate invocation mode. 68 does not match anything found in this tree; flagging the number mismatch, not fixing/guessing at a second harness that may not exist here.

---

## Gate 2 — film-b numeric audit (`tools/film-b-audit.mjs`)

Boot: `CDP_PORT=9260 GAIA_CLIENT_PORT=5220 node tools/film-b-boot.mjs`
```
{
  "ok": true,
  "keys": 51,
  "cast": { "hero": "089603185d8cf6dc", "blood": { "d": 701.228572111329, "from": "6d81406e5529d1d2", "to": "bc74bc2a2e3c9386" } },
  "nodes": 3061,
  "rite": "dream"
}
```

Audit: `CDP_PORT=9260 GAIA_CLIENT_PORT=5220 node tools/film-b-audit.mjs proof/fold-gates/film-b-audit.json`
```
  dream 0→161.76: 19412 samples
  covenants 161.76→193.2: 3773 samples
  shells 193.2→198: 577 samples
  moons 198→205.48: 898 samples
  dream 205.48→293.44: 10556 samples
```
Full JSON at `proof/fold-gates/film-b-audit.json`. Key fields:
```json
"stops": 0,
"stopsAt": [],
"slowBelow2": 0,
"yawMonotone": true,
"biggestAccelerations": [{ "t": 227.77, "mag": 119.3, "samplesAbove80pct": 22 }]
```

**Result: `stops: 0` — matches expected.** One acceleration cluster flagged around t=227.7 (the "DIVE" phase boundary, mag up to 119.3, `worstKeySpeedJumpPct` max 2.94%) — informational, not a stop, not part of the pass/fail contract stated.

---

## Gate 3 — `tools/eyes-verdict.mjs`

Command: `EYES_CDP_PORT=9260 EYES_CLIENT_PORT=5220 node tools/eyes-verdict.mjs`

```json
{
 "law2": { "eyes": 40, "filmT": [191.8, 191.8], "identical": true, "firstDiff": null,
   "plates": ["proof/eyes/12-law2-a.png", "proof/eyes/12-law2-b.png"] },
 "gate": {
  "eyeDrawObjects": 2,
  "strayEyeMeshes": 0,
  "forgeEyeMeshes": 0,
  "visibleDrawObjectsInScene": 311,
  "eyesDrawn": 45,
  "instancesPerDraw": 45,
  "trisPerEye": 2320,
  "sharesOneMatrixBuffer": true,
  "sharesOneAttrBuffer": true
 },
 "fpsEyesHidden": 59.8,
 "fpsEyesDrawn": 59.8,
 "fpsRollingWatchers": 46.7,
 "frame": { "calls": 162690, "tris": 1906895 },
 "stats": { "eyes": 8, "peak": 47, "capacity": 128, "draws": 2, "tris": 2320,
   "filmT": 205.08820000001768, "keys": ["forge:3059","forge:1","forge:2","forge:3","forge:0","forge:3060","forge:349","forge:3058"] },
 "rollingPlate": "proof/eyes/13-rolling-watchers.png",
 "live": { "filmT": null, "eyes": 16, "filmEyesLeft": 0, "saccading": true }
}
page clean: no [eyes] warnings, no exceptions
```

**Result: `eyeDrawObjects: 2` — matches expected.** `law2.identical: true` (seek-reproducibility holds). fps healthy: 59.8 hidden / 59.8 drawn (eyes cost nothing extra) / 46.7 rolling-at-watchers-peak (full scene, film playing). Note: this tool's own `boot()` (in `tools/eyes-cdp.mjs`) hardcodes `localStorage.atlas_gate='1'`, which is stale against this branch's real gate (token must be `gate-config.json.sha256.slice(0,16)`, not `'1'`) — irrelevant here only because the page was already booted+gated by this atom before the tool ran (`cosmosOf()` truthy ⇒ its `boot()` path never executes). Running this tool cold on a fresh profile on this branch would hang at the gate; not fixed (script unmodified per "do not add code").

---

## Gate 4 — `npx vite build` (production)

Command: `cd ~/projects/GAIA-WE-fold && npx vite build`

```
vite v6.4.3 building for production...
transforming...
../GAIA-World-Engine/node_modules/@pixiv/three-vrm/lib/nodes/index.module.js (106:24): "tslFn" is not exported by "../GAIA-World-Engine/node_modules/three/build/three.webgpu.js", imported by "../GAIA-World-Engine/node_modules/@pixiv/three-vrm/lib/nodes/index.module.js".
✓ 162 modules transformed.
rendering chunks...
[plugin vite:reporter]
(!) /Users/pascaldisse/projects/GAIA-WE-fold/client/plugins/character-creator.js is dynamically imported by /Users/pascaldisse/projects/GAIA-WE-fold/client/plugins/atlas-onboarding.js but also statically imported by /Users/pascaldisse/projects/GAIA-WE-fold/client/main.js, dynamic import will not move module into another chunk.

computing gzip size...
../dist/index.html                                         21.49 kB │ gzip:   4.29 kB
../dist/assets/CormorantGaramond-Regular-DQv4XaSs.ttf     290.24 kB
../dist/assets/CormorantGaramond-Semibold-CJWdwruJ.ttf    290.39 kB
../dist/assets/CormorantGaramond-Italic-D_ufOZIm.ttf      293.04 kB
../dist/assets/index-C1kp0pX_.css                          19.09 kB │ gzip:   4.30 kB
../dist/assets/atlas-gate-pl7aJO26.js                       3.87 kB │ gzip:   1.70 kB
../dist/assets/atlas-analytics-BqvjGTWq.js                 12.85 kB │ gzip:   5.39 kB
../dist/assets/atlas-director-BVRiFaKW.js                  74.12 kB │ gzip:  27.56 kB
../dist/assets/index-BnCqu0KB.js                        1,566.85 kB │ gzip: 447.61 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 2.04s
```

**Result: exit 0, `dist/` produced (`index.html`, `atlas-graph.json`, `assets/`) — build succeeds.** Two pre-existing warnings, not errors: (1) `tslFn` not exported from three's webgpu build via `@pixiv/three-vrm` (upstream dep transform warning, doesn't fail the build), (2) chunk-size advisory on `index-*.js` (1.57MB, no code-splitting configured). Neither is a new regression from `f9a9433a`; not touched (no code changes made per instructions).

---

## Summary

| Gate | Expected | Actual | Match |
|---|---|---|---|
| 1. atlas-analytics.test.js | 68 green | 13 pass / 0 fail (15844 expect() calls) | ✗ count mismatch, 0 failures |
| 2. film-b audit | stops: 0 | stops: 0 | ✓ |
| 3. eyes-verdict | eyeDrawObjects: 2, healthy fps | eyeDrawObjects: 2, fps 59.8/59.8/46.7 | ✓ |
| 4. vite build | clean | exit 0, dist/ built, 2 pre-existing non-fatal warnings | ✓ |

No code changed. No fixes attempted (per instructions — gate 1's discrepancy is reported, not resolved).
