# FILM LANE D · THE SCRUBBER — merge notes (for nyari)

Branch `film-d`, worktree `../GAIA-WE-filmD`, base `rust-port@89549298`. NOT merged.
Proof: `proof/film-d/report.json` — **68/68** (dry 51 + live 17), plates in this dir.

## Files

| file | change |
|---|---|
| `client/plugins/atlas-scrubber.js` | **NEW** — the whole instrument (665 lines) |
| `tools/scrubber-proof.mjs` | **NEW** — headless proof, dry + live passes |
| `tools/film-d-browser.sh` | **NEW** — the ONLY launch path; `--mute-audio` baked in |
| `client/plugins/atlas-director.js` | **+70 / −0**, additive only (below) |
| `client/index.html` | **+3 / −0** — one `<script type="module">` + its comment |

## Every director line touched (exact, additive, zero deletions)

`git diff 89549298..film-d -- client/plugins/atlas-director.js` → 70 insertions, 0 deletions.

1. **@1448–1511** — new block `── THE DIRECTOR'S TRANSPORT (additive · film lane D) ──`, inserted
   between `release()` and `arm(from)`. Three new methods, nothing else in the class read or
   rewritten:
   - `pause()` — freeze: `playing=false`, cancel the rAF, pause the element. **Not** `stop()`:
     no `restore()`, no `released=true`, the stage stays up.
   - `async resume(from=null)` — roll again from `from`; re-`seek()`s first if a
     `stop({restore:true})` tore the stage down; sets `released=false`; re-arms `music.gain`
     (a completed handover faded it to 0 via `fadeMusic(0, 3.6)`); writes `el.currentTime = t`
     then `roll(t)`. Virtual-clock branch for `{audio:false}`.
   - `async scrub(t, {settle, resume})` — `pause()` → `seek(t)` → **write the clock**
     (`el.currentTime = to`, `virtual = to`) → `resume()` if it was playing.
2. **@1651–1656** — five api lines: `pause`, `resume`, `scrub`, `duration: DURATION`,
   `handoverAt: HANDOVER_T`.

**Why `scrub()` cannot be done outside the director:** `roll()` reads `audio.el.currentTime`
every frame (the drift-proof clock, mechanism 1 in the director's own header). A bare
`seek(t)` during playback is therefore erased by the next rAF tick, and with `{audio:false}`
the same is true of `virtual`. Moving the clock the loop is reading is the whole fix — after a
scrub, `director.t` **is** `el.currentTime`, so A/V lock is structural, not maintained.

## release() / restore() interaction (spec 5, tested)

The live intro at 288.6 calls `release()` (camera left in place, `released=true`) and 4.4s
later `stop({restore:true})` (stage torn down, veils/masks handed back, `cinematic(false)`,
`director-film` class removed). Scrubbing backwards from there is still exact:

- `seek()` → `prepare()` re-captures a stage and re-hooks `cosmos.drawn()`. The restore
  baseline becomes the **post-handover** world — the correct baseline, since that is now what
  "not filming" means.
- `seek()` clears `released`/`handedOver` → the scripted camera writes again and the handover
  fires again when the clock re-crosses 288.6. The intro's `handover()` is idempotent (returns
  early unless `state === 'playing'`), so a re-cross does not re-run the fade.
- `resume()` re-arms `music.gain` (the handover had faded it to 0) → a scrub back is not a
  silent film.
- The scrubber itself re-asserts `cosmos.cinematic(true)` when it scrubs back into a film whose
  chrome the handover restored, and puts it back on close (`hide()`), nothing else.

Proof: `13-handover.png` → `14-restored.png` (`stage:false, released:true, intro:done`) →
`15-back-after-handover.png` (`stage:true, released:false, playing:true, t===el.currentTime,
gain:0.9`) → `16-closed.png`.

## Two things the scrubber does from OUTSIDE, so no other lane's file changes

1. **`intro.skip()` guard.** `atlas-intro` binds Escape on `window` in the capture phase;
   `stopPropagation` does not silence a sibling listener on the same target, so whichever of the
   two runs second still runs. The scrubber wraps `intro.skip` (public instance method,
   reversible, idempotent) to refuse an `'esc'` skip while the scrubber is open **or** within
   90ms of the Escape the scrubber ate, and calls `stopImmediatePropagation()` in its own
   handler. With the scrubber closed, Esc is the visitor's skip, untouched.
   *(This was a real defect the live pass caught: `hide()` cleared `open` before the intro
   asked, and the intro skipped anyway.)*
2. **Surviving `main.js:810`.** The kernel ASSIGNS `window.gaia = { ... }` (fresh object, not a
   merge) at the end of its top-level await chain, erasing plugins that registered earlier —
   `atlas-intro` hits the same wall and re-`publish()`es. The scrubber re-publishes on a
   heartbeat and on every keypress, and restores `window.gaia.director` from the module cache
   (same singleton) **only if it is missing**. Nothing is ever overwritten.

## Invisible to recordings

`paintComposite()`/`rasterizeOverlay()` raster `#atlas-strategy-ui` and `#atlas-cosmos-ui`
only, so `#atlas-scrubber` is structurally absent from `captureStream()`. No change needed —
verified by reading the composite path, not by assumption.

## Silence law (Pascal, 2026-07-28)

No unmuted browser. Launch only via `tools/film-d-browser.sh` (`--mute-audio`); use
`audio:false` unless a run verifies A/V sync; when it does, the harness sets
`audio.el.muted = true` + both gains to 0 and **asserts its own silence** before seeking
(`currentTime` still advances, so the lock is still measured).

## Plates

`01-scrubber-open` (bar + ticks + hover tooltip) · `02-chapter-{candle,split,covenants,descent,
altar}` (5 chapters seeked by clicking) · `03-paused` · `04-dragging` · `05-after-handover` ·
`06-scrubbed-back` · `10-title` · `11-scrubber-live` · `12-av-{65,110,165,230,250}` (A/V lock) ·
`13-handover` · `14-restored` · `15-back-after-handover` · `16-closed`.
