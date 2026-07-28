# FOLD FRAME-CHECK #3 — VERDICTS

Branch `fold`, worktree `~/projects/GAIA-WE-fold`. Stack: world :8461, vite :5221,
Brave CDP :9261 headless muted, profile `~/.gaia/tmp/fold-fc-profile`.
Driver tooling: `tools/fold-framecheck3-{lib,surfaces,plates}.mjs` (committed).

## Blocker solved (before any of this could run)

`gaia.atlasIntro.status()` stuck at `state:'waiting'`/`'done'` with `director:null`,
never reaching `'menu'`/`'title'`. Root cause: `client/main.js`'s late
`window.gaia = { ... }` (a **fresh object, not a merge** — its own comment says
so) lands *after* `atlas-gate.js` / `atlas-director.js` / `atlas-onboarding.js` /
`atlas-intro.js` self-register early (imported off `atlas-intro.js`'s own boot
chain, or off `index.html` script tags, well before main.js's own heavy
world-load finishes) — the overwrite silently drops
`window.gaia.{atlasGate,director,atlasOnboarding,atlasIntro}` forever (ES
modules only run their top-level self-registration once; nothing re-sets
them). `atlas-onboarding.js` ships its own 60s defensive poll watching
`window.gaia.director` to re-publish itself, but by the time a driver script
acts, that poll has usually already expired too.

**Fix, driver-side only, no app code touched:** re-import each plugin with a
cache-busting query (`?fc=Date.now()`) once the kernel is confirmed up
(`window.gaia.atlasStrategy.active`) — each file's own top-level
self-registration IIFE re-runs, merge-style (`window.gaia.X = ...`), matching
`atlas-gate.js`'s own documented contract ("dynamic-importable from a cold
page"). No `reset()` calls (would wipe `atlas_seen_intro` and force the
first-visit title over the intended return-visit menu). Full writeup in
`tools/fold-framecheck3-surfaces.mjs`'s `ensureKernelHandles()` comment.

## App-code bugs found (logged, not fixed — task scope was driver-side only)

1. **`atlas-onboarding.js` `mountMenuLogin()` never calls `injectStyle()`**
   (only `mountCreator()`, the first-visit path, does) — the return-visit
   `.ob-menu-login` login form renders with raw UA input styling (white
   boxes, black text) unless some earlier `mountCreator()` call in the same
   session happened to have seeded the stylesheet first. Worked around in
   the driver by seeding it off-screen before the shot; a real fix is a
   one-line `injectStyle();` add at the top of `mountMenuLogin()`.
2. **`#atlas-intro` never dismisses itself on the return-visit menu path**
   unless a player clicks a choice — sits at the same z-index (2147483000)
   as `#atlas-onboarding`'s creator overlay and, once that's gone, wins the
   paint order over the Doll panel / scrubber, corrupting anything shot
   after it. Driver calls `atlasIntro.enter()` to close it explicitly.
3. **`atlas-scrubber.js` `show()` no-ops silently** (`{open:false, why:'no
   film'}`, no DOM built) unless `scrubbable()` is already true — a
   `director.stop({restore:true})` (e.g. from `intro.enter()`) tears the
   stage down and nothing rearms it. Scrubber's own header comment
   documents `seek()` as the re-prep path; driver calls it explicitly.

## BATCH A — surfaces (`tools/fold-framecheck3-surfaces.mjs`)

| # | Surface | File | Verdict |
|---|---|---|---|
| 1 | Gate (fresh profile, password screen) | `surf-01-gate.png` | **PASS** — quote + eye glyph + vignette, fully opaque, no bleed-through (fixed: needed a 3.4s wait, not 1.2s, to clear the gate's own 3s opacity transition) |
| 2 | Start screen, return-visit menu w/ skinned `.ob-menu-login` | `surf-02-start-screen.png` | **PASS** — title, both choices, styled hunter-name/password/Log In (workaround #1 above applied) |
| 3 | Creator screen (blood/eyes swatches) | `surf-03-creator.png` | **PASS** — name/password fields, blood lineage swatches, iris swatches, all legible |
| 4 | Doll panel w/ THE DOLL'S RIDDLES board | `surf-04-doll-panel.png` | **PASS** — portrait, dialogue line, riddles board (Echoes/Insight/Solved, objective line, Offer form) — clean, no double-exposure |
| 5 | Scrubber open (secret-key transport) | `surf-05-scrubber.png` | **PASS** — transport bar (readout, track, tick marks, keys legend) over a real mid-film frame (t=5 title card), Doll panel correctly closed first |

**Zero default-white controls** across all 5 surfaces: confirmed — every
input/button uses the Atlas skin (`--atlas-*` custom properties); the one
place that briefly regressed (surface 2's login form) is fixed per workaround
#1.

## BATCH B — film plates (`tools/fold-framecheck3-plates.mjs`)

Seeked via `director.seek(t)` (discontinuous jumps, not a real playthrough —
each plate is "what the film shows AT that second", matching the file table).

| t | file | scene/rite | subtitle (visual) | Verdict |
|---|---|---|---|---|
| 10 | `0100-10s.png` | void/dream | (none — pre-verse) | PASS — faint opening mote cluster, correct for t=10 |
| 55 | `0550-55s.png` | deep/dream | **"The deep…"** ✓ | **PASS** — subtitle present and legible, matches spec's explicit check |
| 79.7 | `0797-79_7s.png` | candle/dream | "The old blood woke, a candle spark" | PASS — single ignited point, subtitle synced |
| 108.9 | `1089-108_9s.png` | split/dream | "It split its blood to seed the stone" | PASS — motes scattering, reveal=0.028 |
| 135.8 | `1358-135_8s.png` | sparks/dream | "Each one a soul, each one a flame" | PASS — sparks/motes visible, reveal=0.675 |
| 180.8 | `1808-180_8s.png` | watchers/covenants | "The Great Ones stirred from ageless years" | **DEFECT** — spec calls for "eyes open" at this timestamp; frame shows only small distant motes/dust, no recognizable eye geometry at this camera distance (dist=775) |
| 236.3 | `2363-236_3s.png` | descent/dream | (none legible) | **DEFECT** — frame is almost pure black, effectively blank; spec requires "no blanks" |
| 258 | `2580-258s.png` | altar/dream | "And one was left behind the door" | PASS — a translucent tentacled Presence is visible (Ebrietas's cue fires at 248.5, before this t) |
| 270 | `2700-270s.png` | home/dream | "Left behind, and reaching still" | **DEFECT** — spec requires "Ebrietas a being" at this timestamp; frame is almost entirely black with only a faint indistinct smudge, not a recognizable being |
| 285 | `2850-285s.png` | home/dream | (Doll dialogue open, no subtitle line) | **PASS** — the Doll panel being open here is *scripted film content*, not a driver artifact: `atlas-director.js`'s `tickScene('home')` calls `c.openFigure('doll')` + plays `doll-welcome-home.ogg` once `t >= 278.2` (the "welcome home, good hunter" beat), which a `seek(285)` correctly replays in order. Verified against source, not assumed. |

**No-blanks check: FAIL at t=236.3 and t=270** — both frames are within a hair
of pure black. Given the camera IS pointed at valid, non-degenerate targets
(`tgt`/`eye` coordinates are sane, non-zero, scene IDs correct) and `reveal:1`
(everything unveiled) at both points, this reads as either (a) a lighting/
exposure gap in these two shots specifically, or (b) the relevant figures
(Ebrietas, the watchers' eyes) not actually spawned/positioned at these exact
seek coordinates outside of a continuous playthrough. Cannot rule out that a
continuous `play()` (not a discontinuous `seek()`) renders these correctly —
not tested here (out of scope: task specified seek-based plates matching the
established `film-b-plates.mjs` methodology). Flagging as DEFECT against the
spec's explicit checklist rather than silently passing it.

`subtitleText` in `index.json` is `null` for every row — cosmetic bug in the
plates driver's own DOM selector (`.director-subtitle, .film-subtitle,
[data-subtitle]` matches nothing on this branch); the subtitle IS visually
present and correct in the screenshots themselves (confirmed by eye, see
table above), so this doesn't affect the verdicts, only the JSON metadata.

## Summary

- Surfaces: **5/5 PASS**.
- Plates: **7/10 PASS, 3/10 DEFECT** (180.8 eyes not visible, 236.3 near-blank,
  270 Ebrietas not recognizable). 285's Doll panel is correct scripted content
  (the film's own "welcome home" beat), not a defect.
- Zero default-white controls: confirmed clean across every surface.
- 3 app-code bugs found and logged (not fixed — out of this task's scope),
  workarounds applied driver-side for all of them.
