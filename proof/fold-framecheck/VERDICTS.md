# FOLD FRAME-CHECK #3 — VERDICTS (final, post-app-fix)

Branch `fold`, worktree `~/projects/GAIA-WE-fold`. Stack: world :8461, vite :5221,
Brave CDP :9261 headless muted, profile `~/.gaia/tmp/fold-fc-profile`.
Driver tooling: `tools/fold-framecheck3-{lib,surfaces,plates}.mjs` (committed).

## Blocker — root-caused AND fixed this pass

`gaia.atlasIntro.status()` stuck at `state:'waiting'`/`'done'` with `director:null`,
never reaching `'menu'`/`'title'`. Root cause: `client/main.js`'s late
`window.gaia = { ... }` (a **fresh object, not a merge**) lands *after*
`atlas-gate.js` / `atlas-director.js` / `atlas-onboarding.js` / `atlas-intro.js`
self-register early — the overwrite silently dropped
`window.gaia.{atlasGate,director,atlasOnboarding,atlasIntro}` forever (ES
modules only run their top-level self-registration once). Same wipe hit the
scrubber (survived only via its own heartbeat republish) and the QA intro
lane on 07-28.

**App fix landed** (`client/main.js` ~line 832): preserve-and-extend instead
of overwrite —

```js
// plugins self-register on window.gaia before this line — never overwrite, extend
// (3 independent victims 07-28: scrubber, QA intro, frame-check menu)
window.gaia = Object.assign(window.gaia ?? {}, { ...same object... });
```

**Verified directly** (no driver hack): fresh profile, seed
`atlas_gate`/`atlas_seen_intro`, plain `Page.navigate` reload —

```
reached state: menu
handles present: {"atlasGate":true,"director":true,"atlasOnboarding":true,"atlasIntro":true}
```

The driver's cache-busting re-import (`ensureKernelHandles()` in
`fold-framecheck3-surfaces.mjs`) is no longer load-bearing — it now re-runs
each plugin's self-registration IIFE onto an *already-correct* `window.gaia`,
a harmless no-op merge. Left in place per instruction as a fallback; not
removed.

## Gate re-check (post-fix)

```
$ bun test test/atlas-analytics.test.js
 13 pass
 0 fail
 15844 expect() calls
Ran 13 tests across 1 file. [1105.00ms]

$ npx vite build
✓ 162 modules transformed.
✓ built in 2.12s
```
(Only pre-existing warnings: three.js `tslFn` re-export notice, chunk-size
advisory, `character-creator.js` dual dynamic/static import notice — none new,
build is clean/green.)

## App-code bugs found (still logged, not fixed — out of this fix's scope)

1. **`atlas-onboarding.js` `mountMenuLogin()` never calls `injectStyle()`**
   (only `mountCreator()`, the first-visit path, does) — the return-visit
   `.ob-menu-login` login form renders with raw UA input styling unless an
   earlier `mountCreator()` call already seeded the stylesheet. Driver seeds
   it off-screen before the shot; real fix is a one-line `injectStyle();`
   add at the top of `mountMenuLogin()`.
2. **`#atlas-intro` never dismisses itself on the return-visit menu path**
   unless a player clicks a choice — shares z-index (2147483000) with
   `#atlas-onboarding`, wins paint order over Doll panel/scrubber once the
   creator overlay is gone. Driver calls `atlasIntro.enter()` explicitly.
3. **`atlas-scrubber.js` `show()` no-ops silently** (`{open:false, why:'no
   film'}`) unless `scrubbable()` is already true — `director.stop({restore:
   true})` (e.g. from `intro.enter()`) tears the stage down and nothing
   rearms it. Driver calls `seek()` (the module's own documented re-prep
   path) explicitly.

## BATCH A — surfaces (`tools/fold-framecheck3-surfaces.mjs`, re-shot post-fix)

| # | Surface | File | Verdict |
|---|---|---|---|
| 1 | Gate (fresh profile, password screen) | `surf-01-gate.png` | **PASS** — quote + eye glyph + vignette, fully opaque, no bleed-through |
| 2 | Start screen, return-visit menu w/ skinned `.ob-menu-login` | `surf-02-start-screen.png` | **PASS** — title, both choices, styled hunter-name/password/Log In |
| 3 | Creator screen (blood/eyes swatches) | `surf-03-creator.png` | **PASS** — name/password fields, blood lineage swatches, iris swatches, all legible |
| 4 | Doll panel w/ THE DOLL'S RIDDLES board | `surf-04-doll-panel.png` | **PASS** — portrait, dialogue line, riddles board (Echoes/Insight/Solved, objective line, Offer form) |
| 5 | Scrubber open (secret-key transport) | `surf-05-scrubber.png` | **PASS** — transport bar (readout, track, tick marks, keys legend) over a real mid-film frame, Doll panel correctly closed first |

**Zero default-white controls** across all 5 surfaces: confirmed — every
input/button uses the Atlas skin (`--atlas-*` custom properties).

## BATCH B — film plates (`tools/fold-framecheck3-plates.mjs`, re-shot post-fix)

Seeked via `director.seek(t)` (discontinuous jumps — each plate is "what the
film shows AT that second").

| t | file | scene/rite | subtitle (visual) | Verdict |
|---|---|---|---|---|
| 10 | `0100-10s.png` | void/dream | (none — pre-verse) | PASS — faint opening mote cluster, correct for t=10 |
| 55 | `0550-55s.png` | deep/dream | **"The deep…"** ✓ | **PASS** — subtitle present and legible, matches spec's explicit check |
| 79.7 | `0797-79_7s.png` | candle/dream | "The old blood woke, a candle spark" | PASS — single ignited point, subtitle synced |
| 108.9 | `1089-108_9s.png` | split/dream | "It split its blood to seed the stone" | PASS — motes scattering, reveal=0.028 |
| 135.8 | `1358-135_8s.png` | sparks/dream | "Each one a soul, each one a flame" | PASS — sparks/motes visible, reveal=0.675 |
| 180.8 | `1808-180_8s.png` | watchers/covenants | "The Great Ones stirred from ageless years" | **DEFECT** — spec calls for "eyes open" at this timestamp; at normal exposure the frame shows only small distant motes/dust, no legible eye geometry (dist=775) |
| 236.3 | `2363-236_3s.png` | descent/dream | (none legible) | **DEFECT** — frame is almost pure black, effectively blank; spec requires "no blanks" |
| 258 | `2580-258s.png` | altar/dream | "And one was left behind the door" | PASS — a translucent tentacled Presence is visible (Ebrietas's cue fires at 248.5, before this t) |
| 270 | `2700-270s.png` | home/dream | "Left behind, and reaching still" | **DEFECT** — spec requires "Ebrietas a being" at this timestamp; frame is almost entirely black, no recognizable being at normal exposure |
| 285 | `2850-285s.png` | home/dream | (Doll dialogue open, no subtitle line) | **PASS** — the Doll panel being open here is *scripted film content*: `atlas-director.js`'s `tickScene('home')` calls `c.openFigure('doll')` + plays `doll-welcome-home.ogg` once `t >= 278.2`, which `seek(285)` correctly replays in order |

**No-blanks check: FAIL at t=236.3 and t=270** (unchanged from prior run —
the app fix landed in `window.gaia` plumbing, not in film exposure/lighting;
these three DEFECTs are independent of the fixed bug).

**Exposure-gap analysis this pass** (6× brightness + 4× crop, done as an
extra diagnostic, not a visual-spec substitute): confirms geometry IS
present but underexposed at t=180.8 (small mottled circular glyphs, plausibly
eye/iris shapes, plus a small winged figure — all sub-threshold at native
exposure) and at t=270 (a diffuse round silhouette with tentacle-like
trailing shapes below it, matching the recognizable Ebrietas silhouette seen
clearly at t=258 — also sub-threshold). t=236.3 stayed flat/empty even at 6×
brightness — this one reads as camera framing looking at genuinely empty
space (`eye=[-780,477,154]` / `tgt=[122,-877,-93]`, a long, oblique shot),
not an exposure bug. Net: 180.8 and 270 are lighting/exposure bugs (content
exists, isn't visible to a normal viewer); 236.3 is either missing content or
a camera-placement bug. All three remain DEFECT against the spec's explicit
per-timestamp visual checklist, which reads at normal exposure, not
post-processed.

`subtitleText` in `index.json` is `null` for every row — cosmetic bug in the
plates driver's own DOM selector (`.director-subtitle, .film-subtitle,
[data-subtitle]` matches nothing on this branch); the subtitle IS visually
present and correct in the screenshots (confirmed by eye, see table above).

## Summary

- **App fix landed**: `client/main.js` `window.gaia` overwrite → preserve-
  and-extend (`Object.assign`). Verified live: plain navigate now reaches
  `'menu'` with all plugin handles intact, no driver workaround required.
- Gate re-check: `bun test test/atlas-analytics.test.js` 13/13 pass;
  `npx vite build` clean.
- Surfaces: **5/5 PASS** (re-shot post-fix).
- Plates: **7/10 PASS, 3/10 DEFECT** (180.8 eyes not visible, 236.3
  near-blank, 270 Ebrietas not recognizable at normal exposure) — unchanged
  from pre-fix run; these are film-exposure/content bugs independent of the
  `window.gaia` fix.
- Zero default-white controls: confirmed clean across every surface.
- 3 app-code bugs found and logged (onboarding login style, intro
  self-dismiss, scrubber re-arm) — out of this fix's scope, not fixed.
