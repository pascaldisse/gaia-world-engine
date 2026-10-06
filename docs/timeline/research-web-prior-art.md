# Web / three.js timeline-editor prior art

> Scope → design input; no implementation. Retrieval date for every linked source: **2026-08-13**. “Deterministic seek” means a render/world state is computed from target `t`, not merely that a UI has a seek button.

## Decision frame

- Required editor ≠ generic animation player: value curves + discrete game/world commands + durable scene data + world-owned render/update loop + existing inspector/undo.
- Separate semantic classes from day one:
  - **curve track** → `valueAt(t)`; interpolation/ease; safe arbitrary seek.
  - **state/clip track** → active range `[start,end)`; enter/leave derives from prior vs next active sets.
  - **event track** → point command `{t,type,payload,id}`; must define seek policy explicitly: never fire while scrubbing; preview through pure reducer; playback fires once only on directed crossing; rebuild/replay after a seek if effects must be represented.

## Theatre.js — closest match

### What it is / model

- Project → Sheet(s) → Sheet Object(s) → typed props; each Sheet has one Sequence; sequence aggregates its objects’ keyframes. [Concepts](https://www.theatrejs.com/docs/latest/concepts) — retrieved 2026-08-13.
- `getProject(name, {state})`; `project.sheet()` yields/creates a Sheet; `sheet.object(key, config)` yields/creates a typed object; Sheet Sequence holds keyframes + current position. [Core API](https://www.theatrejs.com/docs/latest/api/core) — retrieved 2026-08-13.
- Props drive arbitrary host state through `object.onValuesChange`; official plain-THREE example assigns received values onto Three objects. Thus host may retain its own renderer/RAF; Theatre need not own a Three renderer. [THREE.js integration](https://www.theatrejs.com/docs/latest/getting-started/with-three-js) — retrieved 2026-08-13.
- Studio UI → Outline (Projects/Sheets/Objects), Details (props), Sequence Editor/Dope Sheet, extension panes/toolbars. [Studio manual](https://www.theatrejs.com/docs/latest/manual/studio) — retrieved 2026-08-13.
- Sequenced props expose keyframes; Studio supports key insert/delete, aggregate keys, multi-selection/copy/paste, focus range, connector tween/ease editing. [Sequences manual](https://www.theatrejs.com/docs/latest/manual/sequences) — retrieved 2026-08-13.
- Studio transaction/scrub APIs provide undo grouping; setting a sequenced prop via Studio creates a keyframe at current sequence position. [Studio API](https://www.theatrejs.com/docs/latest/api/studio) — retrieved 2026-08-13.

### Data / deployment / integration boundary

- Studio-open state autosaves JSON to `localStorage`; export/import JSON project state; production passes exported `state` to `getProject`. [Projects manual](https://www.theatrejs.com/docs/latest/manual/projects) — retrieved 2026-08-13.
- Programmatic save exists: `studio.createContentOfSaveFile(projectId)` returns JSON; Studio also exposes selection APIs and extension pane/toolset hooks. [Studio API](https://www.theatrejs.com/docs/latest/api/studio) — retrieved 2026-08-13.
- Studio is opt-in (`studio.initialize()`), can be hidden/restored; official THREE guide recommends dev-only inclusion. [Studio manual](https://www.theatrejs.com/docs/latest/manual/studio), [THREE guide](https://www.theatrejs.com/docs/latest/getting-started/with-three-js) — retrieved 2026-08-13.
- Plain Three integration is subscription/application into host objects; this is compatible with a host-owned WebGPU render loop **provided the host makes timeline evaluation part of its own update path**. Theatre’s docs demonstrate application into Three objects, not renderer ownership. [THREE.js integration](https://www.theatrejs.com/docs/latest/getting-started/with-three-js) — retrieved 2026-08-13.
- Studio can be extended, but its supplied editor remains an overlay/editor with its own project/object/prop ontology; replacing it with GAIA’s native inspector and first-class world-event model would be adaptation, not configuration. Extension/pane APIs are documented, while the UI’s outline/details/sequence composition is fixed in its manual. [Studio API](https://www.theatrejs.com/docs/latest/api/studio), [Studio manual](https://www.theatrejs.com/docs/latest/manual/studio) — retrieved 2026-08-13.
- License split: `@theatre/core` Apache-2.0; `@theatre/studio` AGPL-3.0-only. Repo README says Studio is intended during design/development and final bundle normally contains core only. [Repository README](https://github.com/theatre-js/theatre), [Studio package manifest](https://github.com/theatre-js/theatre/blob/main/packages/studio/package.json) — retrieved 2026-08-13.

### Fit verdict — **take ideas only**

- Take: Sheet/Object/prop addressing; dope-sheet hierarchy; aggregate compound keys; click-a-connector → interpolation editor; JSON export boundary; transaction-vs-drag-scrub undo semantics. [Concepts](https://www.theatrejs.com/docs/latest/concepts), [Sequences manual](https://www.theatrejs.com/docs/latest/manual/sequences), [Studio API](https://www.theatrejs.com/docs/latest/api/studio) — retrieved 2026-08-13.
- Do not adopt Studio as GAIA editor: AGPL boundary conflicts with casually embedding a shipped browser editor; its primary unit is a sequenced property, not a durable engine command/event; its JSON is Theatre project state rather than GAIA scene/world schema. License/model evidence: [Repository README](https://github.com/theatre-js/theatre), [Concepts](https://www.theatrejs.com/docs/latest/concepts), [Projects manual](https://www.theatrejs.com/docs/latest/manual/projects) — retrieved 2026-08-13.
- Conditional narrow adoption: Apache core only, dev tooling only, one-way adapter from Theatre values to GAIA values, no authority over RAF/serialization/inspector; still leaves events and schema integration to GAIA. The official subscription model supports this narrow technical path. [THREE.js integration](https://www.theatrejs.com/docs/latest/getting-started/with-three-js) — retrieved 2026-08-13.

## Unreal Sequencer — concepts only

- Level Sequence asset stores tracks, cameras, keyframes, animations; sequence actor binds asset to a level. [Epic Sequencer overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-sequencer-movie-tool-overview) — retrieved 2026-08-13.
- Tracks bind objects/properties; sections are finite time ranges; therefore UI separates *what is targeted* from *when/how it evaluates*. [Epic Tracks](https://dev.epicgames.com/documentation/en-us/unreal-engine/tracks?application_version=4.27) — retrieved 2026-08-13.
- Event Track distinguishes **Trigger** (once at one keyed frame) from **Repeater** (every frame over a section), and binds payload/logic through a sequence-specific Director layer. [Epic Event Track](https://dev.epicgames.com/documentation/en-us/unreal-engine/event-track?application_version=4.27) — retrieved 2026-08-13.
- Take → first-class `EventPoint` vs `EventSpan`; target binding + typed payload; evaluation policy visible in track type, never disguised as a curve.

## Blender Dope Sheet / NLA — curves vs events

- Dope Sheet edits keyframes across scene animation; Graph Editor gives F-Curve/interpolation control; NLA sequences/layers reusable named Actions. [Blender animation editors](https://docs.blender.org/manual/en/latest/animation/animation_editors.html) — retrieved 2026-08-13.
- NLA works at action/strip level: stacked tracks, reusable Action strips, precedence/blending; Tweak Mode opens a strip’s individual keys in Dope Sheet. [Blender NLA](https://docs.blender.org/manual/en/latest/editors/nla/introduction.html) — retrieved 2026-08-13.
- Markers denote key/significant frames and are snap targets; they are annotations, not executable side effects. [Blender NLA 3.6 markers](https://docs.blender.org/manual/en/3.6/editors/nla/introduction.html), [Blender playhead/snap](https://docs.blender.org/manual/en/latest/animation/animation_editors.html) — retrieved 2026-08-13.
- Take → two zoom levels: **Dope/curve editing** for continuous values; **NLA-like strip arrangement** for reusable clips/actions; markers for editorial notes. GAIA needs an additional executable Event Track, not overloaded markers.

## Declarative JavaScript timelines

### GSAP

- Imperative/declarative builder: a timeline composes tweens; child start times can be shifted/spliced; `seek()` controls a tween/timeline playhead. Current official TypeScript declarations document `Timeline.seek()` and `Timeline.shiftChildren()`. [GSAP timeline type source](https://unpkg.com/gsap@3.14.2/types/timeline.d.ts) — retrieved 2026-08-13.
- A point event is `timeline.call(callback, params, position)`; type declaration explicitly describes a function call at optional position. [GSAP timeline type source](https://unpkg.com/gsap@3.14.2/types/timeline.d.ts) — retrieved 2026-08-13.
- Arbitrary numerical seek: **yes for tweened values**; deterministic whole-world seek: **not guaranteed by GSAP alone**, because `call()` is arbitrary side-effect code and `from` tweens may depend on current target state. `call`, `seek`, and `fromTo` are all declared in the published GSAP API; current-state dependence follows from `from`/`to` semantics rather than a timeline snapshot model. [GSAP timeline type source](https://unpkg.com/gsap@3.14.2/types/timeline.d.ts), [GSAP core type source](https://unpkg.com/gsap@3.14.2/types/gsap-core.d.ts) — retrieved 2026-08-13.
- Take → ergonomic positional composition and explicit callback-at-position API; reject as engine timeline authority.

### Remotion

- Model is frame-pure by convention: components read `useCurrentFrame()`; `interpolate(frame, inputRange, outputRange)` computes a value for any frame. [Remotion frame API](https://www.remotion.dev/docs/use-current-frame), [Remotion interpolate](https://www.remotion.dev/docs/interpolate) — retrieved 2026-08-13.
- Docs explicitly say animate from `useCurrentFrame()` and warn against non-frame-driven CSS transitions; renderer evaluates frames independently. [Remotion animating properties](https://www.remotion.dev/docs/animating-properties), [independent-frame explanation](https://www.remotion.dev/docs/miscellaneous/snippets/accelerated-video) — retrieved 2026-08-13.
- A timed “event” is normally conditional render/code at a frame or a `<Sequence from durationInFrames>` range, not a durable event-record track; player offers `seekTo(frame)`. [Remotion frame API](https://www.remotion.dev/docs/use-current-frame), [Player examples](https://www.remotion.dev/docs/player/examples) — retrieved 2026-08-13.
- Arbitrary seek determinism: **strong, if user code is a pure function of frame/props**; weakens with external media, random/time/side effects. Take → GAIA evaluator signature `evaluate(t, baseWorld) → previewWorld`.

### Motion Canvas

- TypeScript generator animation code + real-time editor; explicitly says it is not a traditional video editor. [Motion Canvas introduction](https://motioncanvas.io/docs/) — retrieved 2026-08-13.
- `waitUntil('event')` creates an editor-draggable named time event; downstream events shift by default; event duration can drive a tween with `useDuration`. [Motion Canvas time events](https://motioncanvas.io/docs/time-events/) — retrieved 2026-08-13.
- Generators describe sequential flow (`yield`, `yield*`); `delay(time, task)` schedules a callback/task after seconds. [Motion Canvas flow](https://motioncanvas.io/docs/flow/) — retrieved 2026-08-13.
- Arbitrary seek determinism: **not assumed** for arbitrary generators/callbacks; use it as UX precedent for named, ripple-editable timing constraints, not GAIA runtime model.

## three.js / browser-editor attempts

### Official three.js editor

- Current editor has an Animation panel: discovers scene/attached `AnimationClip`s, shows track rows, colored duration blocks + key markers; selection/play/pause/stop/time scale/scrub are implemented. [editor source](https://github.com/mrdoob/three.js/blob/dev/editor/js/Animation.js) — retrieved 2026-08-13.
- Scrub sets `AnimationAction.time`, pauses it, then calls `mixer.update(0)`; it is a playback/inspection panel, not keyframe authoring. [editor source](https://github.com/mrdoob/three.js/blob/dev/editor/js/Animation.js) — retrieved 2026-08-13.
- Underlying three.js model: `AnimationClip` contains property `KeyframeTrack`s; `AnimationMixer` controls playback/blending. [three.js animation-system manual](https://threejs.org/manual/en/animation-system.html) — retrieved 2026-08-13.
- Take → minimal useful inspector layout and `set time → evaluate zero-delta` preview pattern. Gap → no first-class editable game events / authoring UX.

### Threepipe Timeline UI

- Existing Apache-2.0 plugin advertises create/edit/play timeline animation; manager interface is `TimelineTrack` containing time/duration `TrackItem`s with optional normalized key offsets and edit setters. [plugin README](https://github.com/repalash/threepipe/tree/master/plugins/timeline-ui), [manager source](https://github.com/repalash/threepipe/blob/master/plugins/timeline-ui/src/TimelineManager.ts) — retrieved 2026-08-13.
- UI exposes clip cards, draggable/move/resize handles and keyframe dots; adapters map glTF animation, camera views, materials, video, animation objects into tracks. [timeline UI source](https://github.com/repalash/threepipe/blob/master/plugins/timeline-ui/src/timeline.tsx), [extensions source](https://github.com/repalash/threepipe/blob/master/plugins/timeline-ui/src/extensions.ts) — retrieved 2026-08-13.
- Good architecture precedent → adapter-fed track view + host undo service. Mismatch → React/Threepipe plugin dependency + range-card emphasis; no evidenced durable point-event/replay semantics. [UI-plugin source](https://github.com/repalash/threepipe/blob/master/plugins/timeline-ui/src/TimelineUiPlugin.ts), [manager source](https://github.com/repalash/threepipe/blob/master/plugins/timeline-ui/src/TimelineManager.ts) — retrieved 2026-08-13.

### Other attempts / Three.js Journey

- Threepipe is the strongest actively maintained browser/three.js timeline UI found in this survey; open source and Apache-2.0. [Threepipe repo](https://github.com/repalash/threepipe), [plugin README](https://github.com/repalash/threepipe/tree/master/plugins/timeline-ui) — retrieved 2026-08-13.
- Lewcid Editor advertises a “Basic Animation Timeline Editor”, but its README supplies no public data model/event semantics; useful only as existence evidence, not an adoption candidate. [Lewcid Editor](https://github.com/leweyg/lewcid_editor) — retrieved 2026-08-13.
- The official three.js site lists Three.js Journey as a learning resource; retrieved public material did not document a reusable timeline-editor implementation, so no technical claim/adoption recommendation is made for it. [three.js resources listing](https://threejs.org/) — retrieved 2026-08-13.

## RECOMMENDATION — **build a native GAIA timeline; take ideas, do not adopt a whole editor**

1. **Semantic fit:** GAIA needs deterministic world preview plus point commands with explicit scrub/replay rules; Theatre/GSAP/Motion Canvas encode mostly props/tweens/callbacks, not engine event authority. Unreal’s Trigger-vs-Repeater split is the directly relevant precedent. [Epic Event Track](https://dev.epicgames.com/documentation/en-us/unreal-engine/event-track?application_version=4.27), [GSAP timeline type source](https://unpkg.com/gsap@3.14.2/types/timeline.d.ts), [Motion Canvas flow](https://motioncanvas.io/docs/flow/) — retrieved 2026-08-13.
2. **Ownership fit:** GAIA already owns WebGPU loop, inspector, scene persistence, undo and entity schema. Build a small adapter-driven panel whose evaluator is called from that loop; avoid competing project/state/selection systems. Theatre’s host subscription model proves the boundary; Threepipe demonstrates adapter tracks + host undo. [Theatre THREE integration](https://www.theatrejs.com/docs/latest/getting-started/with-three-js), [Threepipe manager source](https://github.com/repalash/threepipe/blob/master/plugins/timeline-ui/src/TimelineManager.ts) — retrieved 2026-08-13.
3. **Licensing/deployment:** Theatre Studio is AGPL while GAIA needs an embedded editor; core-only still fails to solve editor/events/schema. [Theatre README](https://github.com/theatre-js/theatre), [Studio manifest](https://github.com/theatre-js/theatre/blob/main/packages/studio/package.json) — retrieved 2026-08-13.

**Strongest counter-argument:** Theatre Studio already delivers polished dope sheet, property inspector, curves, undo, export, extension panes and plain-Three value binding; using it only in local authoring could radically shorten prototype time. [Theatre Studio](https://www.theatrejs.com/docs/latest/manual/studio), [Sequences](https://www.theatrejs.com/docs/latest/manual/sequences), [THREE integration](https://www.theatrejs.com/docs/latest/getting-started/with-three-js) — retrieved 2026-08-13.

**Resolution:** prototype native data/evaluator first; borrow Theatre/Blender interaction patterns and Threepipe adapter boundary. Evaluate a dev-only Theatre-core adapter only after the GAIA event seek contract is proven; do not make Studio or any external timeline format canonical.
