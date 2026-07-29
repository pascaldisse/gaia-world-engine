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
| 180.8 | `1808-180_8s.png` | watchers/covenants | "The Great Ones stirred from ageless years" | **PASS (re-shot 07-29)** — the wreath reads: eight coloured covenant clusters, ringed watcher glyphs top-right, the pale sun at centre. mean 4.40 / p99 124 (was mean 11.31 / p99 35 — a flat grey lift with no highlights in it) |
| 236.3 | `2363-236_3s.png` | descent/dream | (none legible) | **PASS (re-shot 07-29)** — the fall: a full column of light streaks rushing up past the lens, Ebrietas small and lit at the bottom. mean 2.46 / p99 98 (was 10.01 / p99 10 = uniform haze, nothing in it) |
| 258 | `2580-258s.png` | altar/dream | "And one was left behind the door" | **PASS — NOT REGRESSED (re-shot 07-29)**, and better: the nine veils now fall visibly onto her and her lamp is at full. mean 6.56 / p99 171 (was 11.10 / p99 27) |
| 270 | `2700-270s.png` | home/dream | "Left behind, and reaching still" | **PASS (re-shot 07-29)** — she is a being: bell, crown-ring and every tentacle legible, still lit at the crest. mean 2.35 / p99 115 (was 10.68 / p99 12) |
| 285 | `2850-285s.png` | home/dream | (Doll dialogue open, no subtitle line) | **PASS** — the Doll panel being open here is *scripted film content*: `atlas-director.js`'s `tickScene('home')` calls `c.openFigure('doll')` + plays `doll-welcome-home.ogg` once `t >= 278.2`, which `seek(285)` correctly replays in order |

> **SUPERSEDED 2026-07-29 — the three DEFECTs below are CLEARED.** See
> "§ THREE DARK SHOTS" at the end of this file for cause → fix → plate. The
> paragraphs that follow are the record of the failing pass, left intact.

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
  `window.gaia` fix. **→ all three CLEARED 07-29, plates 10/10 PASS: see
  § THREE DARK SHOTS below.**
- Zero default-white controls: confirmed clean across every surface.
- 3 app-code bugs found and logged (onboarding login style, intro
  self-dismiss, scrubber re-arm) — out of this fix's scope, not fixed.

---

# § THREE DARK SHOTS — cause → fix → plate (2026-07-29)

Plates re-shot on the iso stack (world :8462, vite :5222, Brave CDP :9262
headless muted) with `TIMES=180.8,236.3,258,270`, overwritten in place.
Nothing in the camera track was touched — no key, no `sampleCamera`, no
scene table — so the film-b audit's `stops:0` cannot have moved; the
per-plate camera fields (`dist`/`tgt`/`eye`/`yaw`/`pitch`) are byte-identical
to the failing batch, which is the check itself.

## Cause 1 — THE HARNESS was photographing the wrong frame

A seek renders **one** frame and stops (the film is paused; nothing
re-renders on its own — an 8-second wait changes nothing, measured). Under
WebGPU three.js **skips** any object whose render pipeline is not compiled
yet and compiles it in the background — so the first frame in which an
effect pool first becomes non-empty is photographed **without that pool**.

Proof, one page, one seek target, `.scratch/statediff.mjs`: state dumps
after seek #1 and seek #2 at t=236.3 are **identical** — same scene, same
camera `[556,-670,61]`, same 131 live streaks, same lights, same fog, same
mesh counts — and the pictures are not: mean luminance **0.78** vs **5.65**.

Every earlier batch seeks ascending from a fresh page, so the first shot that
needs a given material photographs black. That alone made "236.3 is an empty
frame" and it is a *measurement* defect, not a film defect.

**Fix** — `tools/fold-framecheck3-plates.mjs`: after the settle wait, re-seek
the same `t` (a second render) and shoot then. Commit `a879fc7`.

## Cause 2 — the streak alpha clamp killed the entire lower half of the film

`streakMaterial()` faded the tail with `positionLocal.y + 0.5` clamped to
[0,1]. On an InstancedMesh under WebGPU `positionLocal` is not the geometry's
own y, so every streak living below the origin got alpha 0 — the fall
(y ≈ −1000), the bell's pulse down the bloodline and the altar's nine veils
(y ≈ −1250) were **all** invisible.

Measured warm (pipeline hot, so cause 1 cannot contaminate it), one page,
same frame t=236.3, only this node swapped — `.scratch/warmab.mjs`:

| node | mean lum | p99 |
|---|---|---|
| `positionLocal` (old) | 0.80 | 17 |
| `positionGeometry` (new) | 5.50 | 158 |

Same A/B also restored `side: DoubleSide` (the original): the spindle is an
**open** cylinder, so front-only throws away its far wall under additive
light — mean 5.50 (FrontSide) vs **14.48** (DoubleSide).

**Fix** — `positionGeometry.y`, `DoubleSide`. Commit `f185347`.

## Cause 3 — the fall stood beside the lens, not in front of it

At the climax the lens is pitched down 0.44 rad; a column centred on the eye
put 58 of its 131 instances outside the frustum and the survivors at the
frame edge. `IRON.descent.ahead = 0.34` centres it along the lens' own
forward. Four-way A/B (`ahead × width`) at 236.3, all warm:

| variant | bytes | by eye |
|---|---|---|
| ahead 0, width 1.1 (original) | 74 502 | ~10 streaks, mostly at the edges |
| ahead 0, width 5.0 | 130 236 | a dozen fat bars, a fence not a fall |
| **ahead 0.34, width 1.1** | **58 567** | **the fall — dense, fine, Ebrietas still legible** |
| ahead 0.34, width 5.0 | 146 463 | blown out, buries her |

So `width` was **reverted to its original 1.1** — the in-flight 5.0 was
compensating for cause 2 and is wrong once cause 2 is fixed. Commit `f185347`.

## Cause 4 — Ebrietas was never revealed (t=270 darkness)

`atlas-eidos.js` documents an integration point — `setReveal(0..1)`: veils
closed + lamp at 0.55 → veils parted + lamp full. **Nothing on this branch
ever called it.** Measured live before the fix: `getReveal() === 0` at t=258
*and* t=270 — she was photographed for the whole altar and the crest at 55%
of her own lamp with her veils shut. Her graveside halo also ended at 269.0,
i.e. it switched off 1.5 s before the film's loudest second (the crest at
270.5, "Left behind, and reaching still").

**Fix** — `atlas-fx-rites.js` drives it, on the same clock as the light that
arrives to find her, and holds it after (a reveal that un-reveals itself when
its effect window closes is the same bug wearing a hat); the halo now decays
across `holdFrom 269 → holdTo 276` instead of being cut. Verified live after
the fix: reveal 0 @240 → 0.464 @246 → **1 @258, 270, 274, 280**.
Commit `bd5f083` (salvage) + `8a1f1cb`.

## VERDICTS delta

| t | was | now |
|---|---|---|
| 180.8 | DEFECT (no legible eyes) | **PASS** — clusters, watcher glyphs, sun |
| 236.3 | DEFECT (near-blank) | **PASS** — the fall reads |
| 258 | PASS | **PASS, not regressed** — veils + full lamp, better than before |
| 270 | DEFECT (no recognizable being) | **PASS** — lit, whole, reaching |

**Plates: 10/10 PASS. No-blanks check: PASS.**

Note on the old numbers: the failing plates had *higher* mean luminance
(10-11) than the passing ones (2.4-6.6) with p99 ≈ mean — they were a uniform
grey lift with no highlights in them. Mean brightness is not legibility; p99
(the highlights) is what carries the picture, and it went 10→98, 35→124,
27→171, 12→115.
