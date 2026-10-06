# Codebase map — for a TIMELINE EDITOR plugin

Scope → read-only survey, 2026-08-13. Repos: `~/projects/GAIA-World-Engine`
(engine=E) + `~/projects/paloptic` (film=P). Goal: locate what exists before
building a timeline plugin. Note: `docs/timeline/research-unity-timeline.md`
(same dir) already covers Unity Timeline concepts — this file is the GAIA/
paloptic-side inventory, not a redo of that research.

---

## 1 — ENGINE PLUGIN API

Two coexisting patterns, do not confuse them:

**A. `register(ctx)` extension contract — E `client/kernel/extensions.js:1-90`.**
This is THE plugin mechanism. Law (comment E:extensions.js:1-9): "what the
engine loads is a parameter, not an import." Host page sets
`window.__GAIA_EXTENSIONS__ = [mod|registerFn|'/url.js', …]` (or `?ext=` query,
or engine's own `DEFAULT_EXTENSIONS = []` E:extensions.js:46 — empty by
default, engine ships no production).

- `extensionList()` E:extensions.js:61 resolves that list.
- `loadExtensions(ctx)` E:extensions.js:77 — for each entry: dynamic
  `import()` (string) or use the passed module/fn directly, call
  `register(ctx)`, collect `{name, api, sync, update}`. A throwing/malformed
  extension is warned+skipped, never takes the engine down.
- Return contract: `register(ctx)` → `{ name, api, sync(), update(dt) }` (all
  optional; pure side-effect extensions may return nothing).
- `ctx` shape, called once at boot — E `client/main.js:52`:
  `{ store, view, camera, player, dom, renderer, scene, audio, effects, environment }`.
  Note: called BEFORE `editor`/`panel`/`outliner` exist (those build at
  E:main.js:754+), so an extension does not get them in `ctx` — it reaches
  them later through `window.gaia.editor` / `.panel` (see §5 window.gaia).
- Publishing: `loaded.filter(name&&api)` → `Object.assign(window.gaia, …, extensions.published, …)`
  at E `client/main.js:843-861` — "plugins self-register on window.gaia before
  this line — never overwrite, extend" (comment at E:main.js:841-842).
- `sync()`/`update(dt)` are called every frame by the engine's own loop
  (engine stays ignorant of what an extension IS — comment E:extensions.js:33).
- `gateModule()` E:extensions.js:68 — same parametric pattern for a
  pre-boot "gate" overlay (`window.__GAIA_GATE__`), awaited in
  `waitForGate()` E:main.js:84-99 before the world's data path opens.

**Smallest complete example** — P `client/game/atlas-fusion-stars.js:228-236`:
```js
export function register(ctx) {
  const fusion = new AtlasFusionStars(ctx);
  return { name: 'atlasFusionStars', api: fusion, update: () => fusion.update() };
}
```
Published as `window.gaia.atlasFusionStars`. `update()` is polled every frame
until its dependency (`window.gaia.atlasStrategy.cosmos`) exists, then goes
inert — no `sync()`, no teardown hook exists in the contract.

**Host-page wiring (real, in production)** — P `client/engine-boot.js:1-42`:
static `import * as atlasStrategy from './game/atlas-strategy.js'` etc. (must
be static so a bundler embeds it — comment engine-boot.js:11-16), then
`window.__GAIA_EXTENSIONS__ = [atlasStrategy, atlasFusionStars, archTree]`
(engine-boot.js:26) before `await import('@engine/main.js')` (engine-boot.js:42).

**B. Kernel-native hardwired plugins** — E `client/plugins/character-creator.js`,
`vrm-editor.js`. Statically imported by name in E:main.js:21-22, constructed
directly (`new CharacterCreator({...})` E:main.js:815), own DOM mount + fixed
CSS panel (`this.mount.id = 'character-creator'` character-creator.js:138).
No `register(ctx)`, no dynamic list — this is the engine's OWN feature
surface (character/VRM tools), not extension-loaded. Not a pattern to copy
for a timeline plugin — pattern A is the one meant for "not core to the
engine" features, and a timeline editor is exactly that.

There is no manifest file, no plugin.json, no directory scan — the whole
mechanism is the one array + `register(ctx)` function shape above.

---

## 2 — THE EXISTING INSPECTOR (do not build a new one)

**Where** → E `client/kernel/panel.js`, class `Panel` (panel.js:21). Built
once, at E `client/main.js:754-765`.

**Selection model** → single-select. `Editor.select(id)` E
`client/kernel/editor.js:260-286` sets `this.selected = id` (a string entity
id, or `null`), attaches gizmo/outline, then calls `this.panel.show(id)`
(editor.js:286) or `this.panel.hide()` (editor.js:273). A second mode exists:
`panel.showScene(name)` (panel.js:66-70) for editing a *scene* (streaming
geography, not an entity) — wired from Outliner's `onScene` callback at
E:main.js:783-786. No multi-select anywhere in Panel/Editor.

**How it renders/edits** → schema-driven, zero per-component UI code
(comment panel.js:5-7). `Panel.render()` (panel.js:194) reads
`this.store.get(this.id)` → a plain JSON doc keyed by component name
(`transform`, `mesh`, `light`, …). `renderFields(body, comps)` (panel.js:237)
does `for (const name of Object.keys(comps))` (panel.js:239) — **it iterates
whatever keys are literally present on the entity's document, not a
whitelist**. `renderValue()` (panel.js:296+) then recurses by JS `typeof`:
number → slider+number (numberRow, panel.js:378), boolean → checkbox, string
→ color-picker/select/text depending on shape, array → vec-row or item-list,
object → recurse. Edits are staged locally then `queueCommit()`
(panel.js:167, 120ms debounce) or `setComponent()` (panel.js:180) sends
`{op:'set', id, component, value}` through `send` (= `net.sendDev`) and
pushes an undo/redo pair onto `History`.

`shared/schema.js` (`SCHEMA` object, schema.js:7) supplies OPTIONAL metadata
only: `doc` (tooltip/section blurb), `default` (only entries with a default
appear in the "+ add component" dropdown — `componentDefaults()`
schema.js:407), `fields.<key>.{doc,range,enum}` (used by `fieldInfo()`
schema.js:415, read live on every render call — panel.js:301, panel.js:361).
Fallback numeric ranges the schema doesn't cover live in `RANGES` at the top
of panel.js (panel.js:8-14).

**EXTENSION SEAM (the exact one, per Pascal's law: no new inspector)**:
1. A component key present in an entity's data ALWAYS renders — with zero
   code — because `renderFields` loops `Object.keys(comps)`, not `SCHEMA`
   keys. A plugin that `send([{op:'set', id, component:'timelineCue', value:{...}}])`
   gets a free, generic, editable section in the SAME Panel, same tab
   ("fields"/"json" toggle at panel.js:224-232), same undo stack.
2. To give that section a doc string / sane slider ranges / enums, add an
   entry to `SCHEMA` in `shared/schema.js` (schema.js:7-363) — `SCHEMA` is a
   plain exported object; `fieldInfo()`/`doc` lookups are done live at render
   time (panel.js:301, 361), so mutating `SCHEMA` at runtime from a
   `register(ctx)` extension (before the entity is selected) works for docs
   and ranges.
3. Caveat: `COMPONENT_DEFAULTS` (panel.js:19, `= componentDefaults()`) is
   snapshotted **once at module-import time** — panel.js is a static import
   of E:main.js (main.js:11), which resolves before `loadExtensions()` runs
   (main.js:52) — so a runtime `SCHEMA` mutation from an extension is too
   late to add a NEW entry to the "+ add component" dropdown. It is not too
   late for `doc`/`range`/`enum` on a component already present in data. If
   the timeline plugin wants "+ add component → timelineCue" in the
   dropdown, that one entry has to live in `shared/schema.js` at source
   level, not be injected at runtime.
4. `Panel.jsonEditor()` (panel.js:159-174) is a second, code-free seam: raw
   JSON textarea + apply, used identically by both entity fields (`tab='json'`
   → `renderJson` panel.js:388) and scene docs (`renderScene` panel.js:88).

No "add a tab" / "add a section" plugin API exists beyond the two seams
above — there is no registry Panel consults; it is pure data-in → UI-out.

---

## 3 — THE EXISTING TIMELINE/SCRUBBER + DIRECTOR API

**Scrubber** → P `client/game/atlas-scrubber.js` (599 lines). Explicitly "NOT
part of" the app's own HUD (comment atlas-scrubber.js:9) — "a cutting-room
transport bolted onto atlas-director.js." It is DATA-DRIVEN: constructed with
`this.scenes = director.scenes` (the SCENES table, see below) and never
computes chapter boundaries itself — `chapterAt(t)` (atlas-scrubber.js:268)
does `this.scenes.find(...)`. Every seek goes through `director.seek(t)`
(comment atlas-scrubber.js:18-21) — "scrubbing does not fake a frame." Own
keys: ←/→ 5s, ⇧←/⇧→ chapter jump (atlas-scrubber.js:365 `chapterStep`), F9
toggle. Secret-key summoned only (`#atlas-scrubber` only in DOM once a key
combo fires — Director comment P:intro-v4.js "static FILM_LAYERS").

**Director (transport)** → P `client/game/intro-v4.js`, class `Director`
(intro-v4.js:~730+), exposed as `window.gaia.director` (intro-v4.js:2068-2071).
Public API (intro-v4.js:2044-2062):
```
play(o) preload() release() fadeMusic(to,secs) say(file,o) stop(o)
seek(t,o) pause() resume(from) scrub(t,o) duration status() cast() scenes
```
`status()` (intro-v4.js:2015-2039) — the read model: `{t, scene, mode,
playing, released, handedOver, forged, dust, armed, audioT, ctx, recording,
bytes, saved, error, state, stateFor, stateWhy, clock, waitingForAudio, warm,
reveal, rite}`. `seek(t)` (intro-v4.js:1595) is the authoritative jump —
re-derives the whole world's visible state at `t`, not a delta. `scrub(t)`
(intro-v4.js:1845) additionally moves the audio clock. `sceneAt(t)`
(intro-v4.js:1615) is the one-liner: `this.scenes.find(x => t>=x.t0 && t<x.t1)`.

**What is DATA vs hardcoded**:
- `SCENES` table (chapter list) — P `client/game/intro-v4.js:194-202` — 8
  rows `{t0, t1, id, note}`, plain array literal, exported (intro-v4.js:2072)
  and re-published as `window.gaia.director.scenes`. This is the chapter data
  the scrubber draws — DATA, but hardcoded in this one module (no JSON file,
  no server source — comment at intro-v4.js:190-193 says the rows are
  "the CHAPTERS the scrubber draws; the windows are the segment modules' own
  WINDOW exports, not a second source of truth").
- Per-segment `WINDOW` — P `client/game/film2/seg5.js:201`
  (`export const WINDOW = [144.08, 176.32]`), same in seg7.js:94, seg8.js:96,
  and film4/seg*.js — each segment module owns its own `[t0,t1]` as a plain
  exported constant. `director2.js` reads these to build its dispatch table
  (`segAt(t)`, director2.js:411).
- `entryPose`/`exitPose` — per-segment exported constants (e.g.
  seg5.js:351-352, seg7.js:311-312) — camera pose at segment boundaries,
  DATA, blended by the spine (`BATON_MAX`, `DISAGREE` constants,
  director2.js:65-66) when two segments disagree by >10%.
- Camera flight itself (the ONE continuous 44-key shot, intro-v4.js:271-450)
  is a big literal array of keyframes (`{t, tgt, dist, yaw, pitch}`) — DATA
  in shape, but every `tgt` is frequently a live resolver function (closures
  over `D.posOf(id)` etc.), so it's "data with embedded live queries," not
  pure JSON — a timeline plugin cannot treat this as static without also
  carrying those resolver closures.
- Lyric-driven subtitle cues — `cuesFromLyrics(lyrics)` (intro-v4.js:631-669)
  turns `lyrics.json` word-time data (`data/…/lyrics.json`,
  `media/audio/beginning/lyrics.json`) into `{t0,t1,text}` cues at runtime —
  genuinely external DATA, loaded via fetch (intro-v4.js:1586-1590).
- Word-time event cues (`riteCues`, world-mutation cues) are NOT data —
  they are imperative calls, see §4.

`director2.js` (P `client/game/film2/director2.js`, 802 lines) is the newer
segment SPINE — see its own `SEAM-CONTRACT.md` (same dir) for the target
architecture (`draw(ctx,t)` pure / `effects(ctx,t)` mutations gated by
`replaying` / `worldStateAt(t)` pure fold for seeks). Only seg5 has migrated
so far (`SEAM_CONTRACT = true`, seg5.js:667); seg7/seg8 have not.

---

## 4 — EVENTS TODAY: "something happens at t"

No single event system — at least four distinct mechanisms, by file:

1. **Word-time fire-once cues** — `Director.cue(key, t, at, fn)` P
   `client/game/intro-v4.js:1181-1186`: `if (t < at || fired.has(key)) return;
   fired.add(key); fn()`. Idempotent forward-only firing (a seek backward
   un-fires nothing — `fired` is never cleared on seek, a noted gap).
   Consumed by `riteCues(t)` (intro-v4.js:1406-1494, ~9 `this.cue(...)`
   calls: `r:layer-on` 160.9, `r:baked-off` 161.45, `r:covenants` 161.76,
   `r:shells` 193.2, `r:moons` 198.0, `r:sim` 201.0, `r:simoff` 204.4,
   `r:dream` 205.48, `r:handback` 207.62) — each fires an imperative world
   mutation (`c.setRite(...)`, `c.simOn = true`, etc.), called once per frame
   from `Director`'s tick loop BEFORE `film2.frame()` (comment
   intro-v4.js:1522-1525).
2. **Subtitle cue matching** — a second, different cue array: `this.cues`
   (from `cuesFromLyrics`), matched every frame by linear scan
   `this.cues.findIndex(c => t>=c.t0-0.05 && t<=c.t1)` (intro-v4.js:1494) —
   NOT fire-once, re-evaluates every frame (so it IS seek-safe, unlike #1).
3. **Segment enter/tick/exit windows** — P `client/game/film2/director2.js`,
   `frame(t,...)` (director2.js:590-660): compares `segAt(t)` to
   `this.current`; on change calls `exit()` on the outgoing segment
   (`callSeg(prev,'exit',...)`, director2.js:610), `enter()` on the incoming
   (director2.js:625-627), then every frame `tick(t,dt)` on the active one
   (director2.js:654-656). This is the closest thing to a generic timeline
   track evaluator in the codebase — 8 segment modules × ~1 window each.
4. **IRON constant tables** — per-file config objects named `IRON` (not an
   event system, but every timed VFX reads its `t0`/duration from one of
   these): P `client/game/atlas-fx-opening.js:41`, `atlas-fx-rites.js`,
   `atlas-eyes.js`, and one per segment (`film2/seg5.js`, `seg7.js`,
   `seg8.js`, `film4/seg1.js`…`seg6.js` — 8 files total). Rough count: 11
   files define an `IRON = {...}` table.
5. **Direct FX spawn calls, pure-in-t** — `spawnTeardrop(scene, from, to,
   dur, {t0})` (atlas-fx-opening.js:180), `igniteFlash(...)`
   (atlas-fx-opening.js:247), `hearthGlow(...)` (atlas-fx-opening.js:341) —
   each returns an object whose pose is `f(t - t0)`, called once from
   `openingFx(D)` (atlas-fx-opening.js:397-484, comment at 478 "the drop is
   BORN at 74.89, one object, spawned once, pure in t"). `atlas-fx-rites.js`
   has its own `fxTick(director, t)` (atlas-fx-rites.js:1480) driving a
   similar but separate table. Rough per-file counts of
   `.add(`/`scene.add(`-style object creation: atlas-cosmos.js 19,
   atlas-forge.js 50, atlas-fx-rites.js 8, atlas-fx-opening.js 8,
   atlas-npc.js 8, film2/seg5.js 14, film2/seg8.js 13, film4/seg2.js 11,
   film4/seg4.js 12, film4/seg6.js 8, film2/seg7.js 2, film4/seg1.js 2,
   film4/seg3.js 4 — scattered across 13+ files, no shared registry.

---

## 5 — OBJECT LIFECYCLE / choke points

**Engine side (E) — ONE real choke point.**
`WorldStore` E `client/kernel/world.js:1-49` is an op-applier +
pub/sub: `applyOps(ops)` (world.js:23-43) switches on `op.op` (`spawn` /
`set` / `despawn` / `clear`), mutates `this.entities` (a `Map`), then
`this.emit({kind, id, component})` (world.js:14-16) to every `onChange(fn)`
listener (world.js:9-11). `View` is the ONLY consumer that turns an entity
into a live `THREE.Object3D`: `store.onChange(event => this.handle(event))`
E `client/kernel/view.js:81`, funnelling into `View.build(id)`
(view.js:352-369) — `this.groups.set(id, group); this.scene.add(group)`
(view.js:365-366) is the literal line an entity becomes a scene object.
**A recorder that wants "which object appeared at which t" for engine
entities should wrap/observe `store.onChange` (or monkey-patch
`View.build`)** — this single point sees every spawn/despawn, already
carries `id`, and `clock.now()` (E `client/main.js:69`) gives the world-time
to stamp it with.

**Film side (P) — NO single choke point.** The film's cinematic objects
(stars, flames, teardrops, per-segment meshes) are NOT `WorldStore` entities
— they are created ad hoc by whichever segment module is active, via direct
`scene.add()`/`group.add()` calls scattered across 13+ files (§4.5 list).
The closest thing to a choke point on this side is `Director2.frame(t,...)`
P `client/game/film2/director2.js:590` — it is the one function that always
knows, every frame, which segment is `active` (`rec.active`, director2.js
throughout) and calls that segment's `enter`/`tick`/`exit` — but it does NOT
see individual object creation inside a segment's own `enter()`, only
segment-level activation. A timeline plugin wanting per-object film events
would have to hook `Director2.frame` for segment-level "which shot is live"
and separately instrument each segment module (or its `IRON`/spawn tables,
§4.4-5) for sub-segment object birth — there is no existing single seam for
that finer grain.

Note the asymmetry: engine world = declarative op stream + one builder
function (recordable for free); film VFX = imperative code with `t0`s baked
into per-file constants (recordable only by adding instrumentation per file,
or by treating `director2.js:frame()`'s segment-level dispatch as the
coarsest available grain).

---

## SEAMS: what a timeline plugin can hook without touching film code

1. **Registration** — ship as a `register(ctx)` module, added to
   `window.__GAIA_EXTENSIONS__` in `engine-boot.js` (P) or via `?ext=`
   query for a dev probe — zero engine/film source edits
   (E `client/kernel/extensions.js:61-90`, P `client/engine-boot.js:26`).
2. **Inspector row for a "timeline" component** — `send([{op:'set', id,
   component:'timeline', value:{...}}])` renders a free, generic, editable
   section in the existing `Panel` with zero Panel code changes (E
   `client/kernel/panel.js:239` `Object.keys(comps)` loop); optionally add
   one `shared/schema.js` entry for docs/ranges (source-level only, see §2.3
   caveat on `COMPONENT_DEFAULTS` snapshot timing).
3. **Playhead control** — drive/observe the existing transport instead of
   building a new one: `window.gaia.director.{seek,scrub,pause,status}` (P
   `client/game/intro-v4.js:2044-2062`) is already the single source of
   truth for `t`, already what `atlas-scrubber.js` uses.
4. **Event/track data** — read, don't reinvent: `window.gaia.director.scenes`
   (chapter table, P intro-v4.js:194-202) + each segment's own exported
   `WINDOW`/`entryPose`/`exitPose` (P `film2/seg5.js:201,351-352` pattern)
   are already plain, inspectable constants a plugin can list as tracks.
5. **Object-appeared-at-t recording** — hook `WorldStore.onChange` (E
   `client/kernel/world.js:9-16`) for engine entities (complete, free); for
   film-side VFX there is no equivalent seam — the coarsest available hook
   is `Director2.frame(t,...)` segment dispatch (P
   `client/game/film2/director2.js:590`), not per-object.
