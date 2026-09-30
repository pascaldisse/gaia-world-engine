# GAIA Timeline — plugin spec (v0)

Derived from: `research-unity-timeline.md` (@codex) · `research-web-prior-art.md` (@terra) · `codebase-map.md` (@ghoul-sonnet). Verified anchors only.

## §0 goal (Pascal, 2026-08-13)
See what happens on the film clock — every event, every object, when it is created — click it → **the inspector we already have** shows keyframes/events → edit them. Fix timing/pop-in defects by hand instead of by lane.

## §1 laws
- L1 **plugin, not a fork** → `register(ctx)` via `window.__GAIA_EXTENSIONS__` (`client/kernel/extensions.js:76-90`). ZERO edits to engine source. Opt-in `?ext=`.
- L2 **no second inspector** → selection publishes a `timeline` component; `Panel.renderFields` renders + edits ANY component key generically (`client/kernel/panel.js:239-272`; SCHEMA only adds doc strings).
- L3 **no second transport** → drive the existing `window.gaia.director.{seek,scrub,pause,status,duration,scenes}` (`paloptic/client/game/intro-v4.js:2044-2062`).
- L4 **state ≠ events** → props = state-at-`t` (pure: baseline reset → evaluate active tracks at exact t). events = crossings `(prevT,t]`. Scrub suppresses events unless the marker declares `idempotent:true`. 因 the film's FX INTEGRATE per frame (measured 6.6× understatement at t=176, `tools/film-shoot.mjs` header) → a seeked frame is not the played frame until a track is migrated.
- L5 **document is data** → one JSON doc, GAIA schema, no external format canonical. Theatre Studio NOT adopted: `@theatre/studio` = **AGPL-3.0-only** (verified npm registry 0.7.2; `@theatre/core` Apache-2.0). Ideas taken: sheet/object/prop addressing, dope-sheet hierarchy, aggregate keys, connector→ease editor, transaction-vs-drag undo.
- L6 **nothing invented that already exists** → chapter table, segment `WINDOW`/`entryPose`/`exitPose`, lyric word times are ALREADY data; read them, never re-author.

## §2 document
```
TimelineDoc { id, duration, fps?, tracks[] }
Track  { id, kind, label, targetRef?, mute?, lock?, clips[], markers[] }
kind   ∈ chapter | activation | prop | event | audio
Clip   { id, start, duration, clipIn?, ease?, source?, payload }
Marker { id, t, name, payload, idempotent?:bool }
targetRef → { entityId } | { path: 'scene/…' } | { film: 'segId' }
```
Bindings live OUT of the doc (`targetRef` → live `Object3D`), Unity's director-binding split.

## §3 phases
**P1 — read-only witness (ship first).**
- lanes drawn from: `director.scenes` (chapters) · segment `WINDOW` exports · `WorldStore.onChange` (`client/kernel/world.js:9-16`) recorded against `director.status().t` → "object appeared at t" for engine entities · `Director2.frame(t)` segment dispatch (`film2/director2.js:590`) as the coarse film hook.
- playhead = director's clock, bidirectional (drag → `scrub`).
- click lane/clip/marker → inspector `timeline` component (L2).
- **no writes.** Acceptance: every entity add/remove in a run appears on a lane at the right t; scrubbing the panel moves the film and vice versa.

**P2 — events editable.** Markers become authored data; the film reads its cue table from the doc instead of literals, one segment at a time. Acceptance: move a marker → the effect moves, replay identical.

**P3 — props keyframed.** Property adapters registry (`propPath → get/set/lerp`), curves + tangents, record mode (edit at playhead → key written). Only for tracks migrated to state-at-t.

## §4 non-goals
compiled PlayableGraph · skeletal/additive blending · humanoid retargeting · Unity reflection-style property picking (we ship explicit adapters) · shipping any AGPL editor.

## §5 open, unresolved
- dev-vs-prod environment divergence (`bg #101c30`+linear fog local vs `#03040a`+FogExp2 deployed, measured 08-13) — the editor must show WHICH world source it is editing, or every timing fix gets judged against the wrong picture.
