# gesture-fix — the begin gesture had no hit target

Branch `gesture-fix` (worktree `../GAIA-WE-gesturefix`), off `rust-port` @ `9e5bcc15`.
Not merged: nyari folds and live-probes herself.

## The defect (nyari's live probe, reproduced here)

The 'CLICK TO BEGIN' screen was a stack of PASSIVE layers with `pointer-events:auto`,
and the begin listener was bound on a DIV (`#atlas-intro`) inside that stack.
`document.elementFromPoint(640, 477)` — the middle of the screen, where a human aims —
returned `.in-sub`, the subtitle that says *click to begin*. The click landed on the
label instead of the door. `director.status()` then read
`{t:0, playing:false, armed:false, warm:0, err:null}` **forever**, and that reading is
indistinguishable from "nothing was ever asked of me": the stall was silent.

## 1. The layer audit — measured live, both columns

Both columns come from the SAME running page in the same frame: the probe reads
`getComputedStyle().pointerEvents` (AFTER), deletes the fix's own rule from the live
stylesheet, reads again (BEFORE), and puts the rule back. No recollection, no second build.

| layer | before | after | what it is |
|---|---|---|---|
| `#atlas-intro` | auto | **auto** | the overlay itself — the only thing that should take a pointer |
| `.in-mist` | none | none | drifting nebula wash (already correct) |
| `.in-vignette` | none | none | the corner darkness (already correct) |
| `.in-wrap` | auto | **none** | the flex column that holds the card |
| `.in-title` | auto | **none** | "The Beginning" |
| `.in-rule` | auto | **none** | the hairline under the title |
| `.in-sub` | auto | **none** | **the thief** — "click to begin" |
| `.in-menu` | auto | auto | the real controls (kept) |
| `.in-choice` | auto | auto | the real buttons (kept) |
| `.in-esc` | auto | **none** | the "esc — skip" hint |
| `elementFromPoint(640,477)` | `.in-sub` | **`#atlas-intro`** | first visit — the door, not the label |
| `elementFromPoint(640,477)` | — | `.in-choice` | return visit — the button genuinely sits there |

## 2. The fix

- `client/plugins/atlas-intro.js` (stylesheet): `pointer-events:none` on every passive
  layer, `pointer-events:auto` on `.in-menu` / `.in-choice` and anything onboarding
  injects into the menu (inputs, buttons, links, labels, forms).
- `client/plugins/atlas-intro.js` — `Intro.awaitGesture(why)`: the begin gesture is **any
  `pointerdown` or `keydown` on the whole document**, capture phase, self-removing
  (Bloodborne's *press any button*). Not a div — a document cannot be covered. A real
  control, `Escape` (skip owns it) and modified keys keep their own meaning.
  `showTitle()` arms it; `beginIntro()` spends it, synchronously, in the handler.
  Both witness paths run the one `beginIntro()` chain.
- `client/plugins/atlas-director.js` — `phase` with one writer (`setPhase`), walked through
  `idle → arming → loading-lyrics → warming → building-audio → (await-gesture) → beginning
  → rolling → released/stopped`, `error` when `fail()` has spoken.
  `status()` now carries `state` / `stateFor` (seconds in it) / `stateWhy`;
  `intro.status()` carries `waiting` and `awaitGesture`.
  **`{t:0, playing:false, armed:false, error:null}` can no longer be read as "fine"** —
  before the click it reads `state:'idle'`, `waiting:'title'`.

## 3. The proof — one stack, one run per table

Stack (`tools/gesture-fix-stack.sh`, this lane's own): world **8462** · client **5197** ·
quest **4695** · `GAIA_WORLD` and quest data under `.scratch/gesture-fix/` (git-excluded,
never `/tmp`), ops seeded ONCE before the page loads.
Browser: **Brave, hidden** (`open -n -g -j`), `--mute-audio`, and the `<audio>` element
itself muted while `currentTime` advances — the clock is measured in silence and the
silence is asserted. (chrome-headless-shell is not a witness here: no Metal adapter, no
AAC → black frames on a wall clock.)

`node tools/gesture-fix-probe.mjs both` → **VERDICT PASS (0 failing)**, `stations-click.log`:

| path | gesture | t @ +5s | playing | title | state timeline (t+2/5/8/12s) | console errors |
|---|---|---|---|---|---|---|
| a first visit | ONE anywhere-click at (640,477) — the eaten pixel | **5.17** | true | gone | rolling 1.99 / 5.17 / 8.35 / 12.52 | 0 |
| b 'Witness the Beginning again' (account registered via quest `/auth/register`, reload) | ONE click on the button | **5.01** | true | gone | rolling 1.83 / 5.01 / 8.19 / 12.37 | 0 |

Clock is `audio` on both, `audioT` equals `t`, element `muted:true`, `status().error` null,
4 distinct frames per path (~330–347 KB each — real picture, not black).

`KEY=1 node tools/gesture-fix-probe.mjs a` → **PASS**, `stations-keystroke.log`:
one keystroke (`k`), no pointer anywhere, t **5.26** @ +5s, playing, title gone,
clock `audio` — the keydown grants user activation too, so *press any button* is literal.

Screenshots: `a-01-screen.png`, `a-02-plus{2,5,8,12}s.png`, and the same for `b`.

## Honest limits

- Path b's begin is the menu **button**, not an anywhere-click: the return-visit screen
  offers two doors (witness again / enter the dream), so a blind any-button gesture there
  would choose for the player. `awaitGesture` is armed on the title screen only; what the
  rewatch path shares is the arming chain (`beginIntro` → veil down → `director.play`).
- The audit's BEFORE column is the live cascade with the fix's rule removed. It reproduces
  nyari's `.in-sub` finding exactly, but it is not a run of the old commit.
- Ops seed = the lane's standard `atlas-ops`/`quest-ops`; census was not re-counted here.

## Commits

- `93b0fee2` stage 1 — the hit target is the DOCUMENT, and every wait names itself
- `bc53252f` stage 2 — the lane's own stack (8462/5197/4695) and the live probe
- `7ca0b65a` stage 3 — this report + the proof logs and plates
