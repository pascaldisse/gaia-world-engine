# WEDGED FILM START — root cause, fix, proof (branch `start-fix`)

Iso stack: world **8462** · client **5195** · quest **4695** · `GAIA_WORLD=.scratch/start-fix/world`, ops seeded once (`tools/start-fix-stack.sh`).

## ROOT CAUSE — four defects, one symptom

The return-visit click was never "a different code path": **both** WITNESS transitions call
`intro.beginIntro() → director.play()`. What differed was WHEN each path hit an
**unbounded await**, and what covered the screen while it hung.

1. **`film2.prewarmAll()` never settles.** `seg1.prewarm()` awaits
   `renderer.compileAsync()`; on a backend that never settles it (software WebGPU, a
   pipeline that fails validation) the promise hangs forever. No budget anywhere.
   Measured (`tools/start-fix-diag3.mjs`, base commit): `prewarming:true`, **`report:""`
   for 60s** — the loop never finished segment ONE. Both callers hang on it:
   `intro.preload()` (screen sits on "awakening…") and `director.play()` (the click arms
   nothing — `ctx:null`, `armed:false`, `playing:false`, zero console output).
2. **The first-visit click was bound AFTER `await preload()`** — a hung preload left the
   title screen with *no handler at all*. The return screen's buttons are bound in
   `mount()`, so its click DID land — and then hung inside `play()`. Same wedge, two faces.
3. **`play()` dropped `onFirstFrame`.** It rebuilds `this.opts` from a destructured list
   that never included the hook, so `roll()`'s `this.opts.onFirstFrame?.()` was always
   `undefined`: the door's black never lifted, and the film rolled *under* the overlay.
4. **A dead audio clock held frame one forever, silently.** `roll()` waits for
   `el.readyState>=2` with no deadline: on any browser without AAC the mix fails with
   `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` and the picture holds black with `error:null`.

## FIX — §IRON, at the state-machine level

- **Prewarm is an optimisation, never a gate** (`film2/director2.js`): `withBudget()`,
  per-segment `PREWARM_SEG_MS=9s`, whole warm-up `PREWARM_ALL_MS=30s`, final
  `compileAsync` budgeted. A blown budget is RECORDED and the segment stays *enterable*
  (it is built before it compiles — marking it unready would delete the shot).
  `warmLate(rec)` warms a cold shot while the film runs and enters it the frame it lands.
- **The click owns the timing** (`atlas-director.js`): with a gesture in hand the film
  waits at most `GESTURE_WARM_MS=2s` for warming, then rolls cold.
- **ONE arm sequence, both transitions** (`atlas-intro.js`): the click is bound BEFORE any
  await; `preload()` is best-effort + bounded; `beginIntro()` records `armedFrom`
  (`title`/`menu`) and starts a **20s watchdog** that turns a silent stall into
  `status().error` + a visible line. `note()` = console + screen + status.
- **Loud, never silent** (`atlas-director.js`): `fail()` → `status().error`; audio decode
  failure reported; a clock that has not ticked in `AUDIO_WAIT_MS=2.5s` is declared dead
  (`status().clock='wall'`) and the picture rolls anyway; `onFirstFrame` carried into
  `this.opts` and fired on the film's first **painted** frame (not its first ticking one).

## PROOF

### Brave (Metal-3 + AAC) — the picture and the clock · `proof/start-fix/brave/`
`node tools/start-fix-brave.mjs a|b` — hidden (`open -n -g -j`), `--mute-audio`, and the
element itself `muted=true` while `currentTime` advances (LAW).

| station | (a) first visit | (b) return visit |
|---|---|---|
| clicked | the title screen itself | **"Witness the Beginning again"** |
| film rolling by +5s | `t=5.15 playing=true` | `t=5.03 playing=true` |
| audio element IS the clock | `clock=audio audioT=5.15 rs=4` | `clock=audio audioT=5.03 rs=4` |
| and it is silent | `muted=true` | `muted=true` |
| title gone by +5s | yes | yes |
| `status().error` | empty | empty |
| picture changes +2/5/8/12s | 4 distinct frames | 4 distinct frames |
| console errors | **0** | **0** |

`VERDICT: PASS (0 failing)` on both. `a-03-plus5s.png` and `b-03-plus5s.png` are the SAME
shot of the deep (mean luminance 45, no world layers, no UI) — the return path now opens
the film exactly as the first visit does.

### Headless chromium — the state machine · `proof/start-fix/fixed/`
Same stations pass (a: `t=2.43`, b: `t=0.63`, both `playing`, both titles gone). Two RIG
limits are recorded, not hidden — this chromium has **no AAC** (the mix cannot decode →
the fix's loud path fires: `status().error = DEMUXER_ERROR_NO_SUPPORTED_STREAMS`,
`clock='wall'`) and **no Metal WebGPU** (SwiftShader → fragment shaders fail to compile,
`GPUPipelineError`, and every screenshot is a 4799-byte black frame). Both are present on
the BASE commit on the same rig; neither is introduced here. The film is therefore
photographed on Brave, never headless.

## COMMITS (branch `start-fix`, no merge)
```
37325b41  rig + diagnosis (prewarmAll never settles)
6d93e63c  prewarm budgeted; intro binds the click first; one arm sequence + watchdog
a65cf45a  dead clock is loud, wall-clock fallback
f4f8f9f3  the click owns the timing; warmLate
74f1b1fe  play() dropped onFirstFrame — the door never lifted
d2359a3f  the door lifts on the first PAINTED frame
```
