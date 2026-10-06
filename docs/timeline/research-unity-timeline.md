# Unity Timeline → GAIA World Engine: research notes

Scope → Unity Timeline package 1.8.13 / Unity Manual + Scripting API; retrieval: 2026-08-13.  
Terms → authored asset ≠ scene-instance binding ≠ evaluated runtime graph.

## §1 — data model first

| Unity unit | Kind / owner | Contents / responsibility | GAIA analogue |
|---|---|---|---|
| `TimelineAsset` | authored project asset; `PlayableAsset` | root track hierarchy; clips; markers; duration/frame-rate/editor metadata; reusable sequence definition | serializable `TimelineDocument`; no live `Object3D` references |
| `TrackAsset` | authored child of `TimelineAsset`; `PlayableAsset` | typed lane; ordered clips + markers; child/group tracks; declares output/binding type; creates its playable subtree | `Track { id, type, targetSlot, clips, markers, settings }` |
| `TimelineClip` | authored timing wrapper; child of a `TrackAsset` | placement/timing + blend/ease/extrapolation + reference to playable/source payload; **not** the source animation/audio itself | `Clip { id, start, duration, in, speed, ease, sourceRef, params }` |
| `PlayableDirector` | scene component; Timeline **instance** controller | links a TimelineAsset to a scene; stores track→scene-object bindings; builds/owns/evaluates playback; clock/wrap/play/pause | `TimelinePlayer` attached to editor/runtime world; document + binding map `slotId → entityId/Object3D` |
| `PlayableGraph` | ephemeral runtime evaluation graph | connected playable nodes + outputs; topology determines evaluation; created/destroyed by Director; `Evaluate()` updates connected outputs | compiled evaluator/cache: track evaluators → property writers / audio / events; rebuild on structural edits, evaluate at arbitrary `t` |

Asset/runtime split → `TimelineAsset` deliberately does **not** contain bindings to scene GameObjects; one asset → many scene instances / casts. `PlayableDirector.SetGenericBinding()` associates a track output/reference object with a loaded scene object. Track binding is therefore instance-local, serializable scene configuration, not source-film data.  
Binding resolution → authored `targetSlot` / semantic role (`hero`, `cameraA`, `sfxBus`) → instance binding map → validated resolved object/component; missing binding = visible warning + no-op/diagnostic, never silently mutate another object.  
Graph consequence → authoring document must remain declarative; evaluators/plugins consume track/clip payloads and emit deterministic writes. Do not persist a Three.js mixer graph as the timeline asset.

Sources → [Playable Director component](https://docs.unity3d.com/Manual/class-PlayableDirector.html) (retrieved 2026-08-13); [PlayableGraph API](https://docs.unity3d.com/ScriptReference/Playables.PlayableGraph.html) (retrieved 2026-08-13); [SetGenericBinding API](https://docs.unity3d.com/ScriptReference/Playables.PlayableDirector.SetGenericBinding.html) (retrieved 2026-08-13); [TimelineAsset API](https://docs.unity3d.com/Packages/com.unity.timeline@1.0/api/UnityEngine.Timeline.TimelineAsset.html) (retrieved 2026-08-13); [TimelineClip API](https://docs.unity3d.com/Packages/com.unity.timeline@1.0/api/UnityEngine.Timeline.TimelineClip.html) (retrieved 2026-08-13).

## §2 — track vocabulary / expression surface

| Track | Unity expression | GAIA film mapping |
|---|---|---|
| Animation | animation clips / recorded infinite clip → animate bound GameObject or humanoid | `transform`, camera, light, material, skeleton/morph/property curves; target = `Object3D` / component path |
| Activation | activation clips → whether bound GameObject is active | visibility/enabled; preferably explicit `visible`/`enabled`, not Three.js object destruction |
| Audio | Audio clips; track-level animated volume/pan/spatial blend | `AudioBufferSource` scheduling + gain/pan automation; preview policy required |
| Control | schedules sub-Timeline; controls particle system, prefab, `ITimeControl` script | nested timeline / particle seek / plugin-controlled entity; **not** arbitrary imperative side effect by default |
| Signal | Signal Emitters → bound object’s Signal Receiver reaction | typed named event marker → event bus handler / plugin action |
| Marker track / markers | zero-duration marker area; marker can attach to a track or timeline-wide marker track | `Marker { time, type, payload, target? }`; chapter/note/cue/event; timeline-global markers separate from target-bound events |
| Playable / custom playable track | `PlayableAsset` script creates custom animation/effect/gameplay mechanism | plugin track contract: schema + editor renderer + evaluator + optional inspector; isolated capability boundary |

Track semantics → lane type owns composition rule: Animation/Audio overlap mix; discrete Activation/Control/typical Playable overlap does not intrinsically blend—later/defined precedence is necessary.  
Custom extensibility → Unity discovery requires custom clip asset inheriting `PlayableAsset`; GAIA ES-module plugin equivalent → manifest registers `trackType`, clip payload schema/version, `evaluate(ctx, clip, localTime, weight)`, optional `renderLane` / inspector.  
Do **not** copy Unity class inheritance / PlayableGraph API into JS; copy the declarative contract and evaluator boundary.

Sources → [Add tracks](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/trk-add.html) (retrieved 2026-08-13); [Timeline namespace/API](https://docs.unity3d.com/Packages/com.unity.timeline@1.2/api/UnityEngine.Timeline.html) (retrieved 2026-08-13); [Control Track manual](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/insp-clip-control.html) (retrieved 2026-08-13).

## §3 — clips / time math / composition

Core fields → `start` timeline seconds; `duration`; `end = start + duration`; `clipIn` source-time offset; `timeScale`/play speed; source duration; display name. UI supports seconds or frames; store canonical seconds or integer ticks + project frame-rate, never float frame labels alone.  
Local source time → `sourceT = clipIn + (t - start) * speed`; clamp/wrap only after selected extrapolation policy.  
Trim ≠ source edit → moving/shortening the wrapper changes its active source range; clip-in exposes a later source segment. `Match Content` / duration extension may reveal source data.  
Ease → non-overlap edge fade against gap/underlying state; `easeInDuration`, `easeOutDuration`, curve; output weight ramps 0→1 / 1→0.  
Blend / crossfade → overlaps on compatible animation/audio lanes; weights crossfade over overlap; blend curve must be explicit/inspectable. Do not imply generic blending for booleans, events, object creation, or arbitrary plugins.  
Edit modes → Mix permits intersections → blends; Ripple shifts following clips while preserving gaps; Replace cuts intersecting clips. Nice UX; authoring transforms only, separate from evaluation semantics.  
Extrapolation (Animation clip gaps) → `None` = scene/base state; `Hold` default = first/last sampled value; `Loop` = repeat; `Ping Pong` = forward/reverse repeat; `Continue` = source asset’s loop/hold policy. Pre and post independently configured; left clip post normally governs an intervening gap.  
GAIA base-state rule → scrub evaluation needs a known baseline for every animated property. Snapshot/reset target properties before evaluation, then deterministic layer/composition order; otherwise `None`/gaps inherit stale prior scrub state.

Sources → [Trim clips](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/clip-trim.html) (retrieved 2026-08-13); [Animation clip properties](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/insp-clip-anim.html) (retrieved 2026-08-13); [Ease in/out](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/clip-ease.html) (retrieved 2026-08-13); [Content view + edit modes](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/clip-overview.html) (retrieved 2026-08-13); [Gap extrapolation](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/clip-gap-extrap.html) (retrieved 2026-08-13).

## §4 — markers / signals = “EVENT at t”

Marker → instantaneous, time-positioned authored object; location = a track associated with target object, or timeline marker area.  
Signal pattern → `SignalEmitter` marker references reusable `SignalAsset`; track binding resolves to GameObject; its `SignalReceiver` maps Signal → reaction method + target. `Emit Once` / `Retroactive` alter firing rules.  
GAIA event model → `EventMarker { id, time, name/type, payload, delivery: crossing|seek, once? }`; route to plugin/event-bus handler via instance binding.  
Scrub distinction → property evaluation is state-at-`t`; events are crossings `(previousT, t]`, not state. Define seek policy explicitly: preview events disabled by default / opted-in idempotent preview actions; never replay non-idempotent effects accidentally while dragging.  
Non-translation → Unity Inspector method picker / arbitrary component-method reaction relies on Unity serialized object/reflection model; replace with registered, typed, permissioned event handlers.

Sources → [Markers and signals workflow](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/wf-signals.html) (retrieved 2026-08-13); [Add tracks: Signal](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/trk-add.html) (retrieved 2026-08-13); [Create custom marker](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/wf-custom-marker.html) (retrieved 2026-08-13).

## §5 — keyframes / curves / recording / evaluation

Curve data → per binding/property path: ordered keys `{ time, value, inTangent, outTangent, interpolation }`; evaluate scalar/vector/quaternion channels deterministically. Tangents + interpolation determine between-key curve shape.  
Per-clip distinction → an Animation clip usually references a source AnimationClip; a recorded **Infinite clip** contains basic recorded animation spanning entire Animation track; recording creates a `Recorded` source asset child of TimelineAsset. Audio-track properties also have curves; imported animation may be read-only in Timeline’s Curves view.  
Dope Sheet → property rows + key occurrence/time; compact timing/selection view; does not communicate numeric curve shape.  
Curves view → graph values over time; add/move keys; alter tangents/interpolation; practical editor for easing; clip / audio-track context.  
Record mode → select empty bound animation lane → enable record → edit transform or other animatable scene/Inspector property at playhead → write key at current time; later edit → another key. Preserve undo transaction / changed-property granularity; never sample every render frame unless auto-key recording is an intentional mode.  
Preview/scrub → `evaluate(t)` must: restore baseline → evaluate every active relevant track at exact `t` → compose deterministic outputs → render; no dependence on traversing intervening time or real-time playback. Unity graph `Evaluate()` explicitly updates connected outputs; build GAIA’s equivalent as pure/as-near-pure evaluation plus tightly controlled audio/events.  
Quaternion note → ordinary independent Euler curve interpolation is cheap but rotation artifacts; proper quaternion interpolation + additive/weighted blending is materially harder.

Sources → [Record basic animation](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/wf-record-anim.html) (retrieved 2026-08-13); [Curves view](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/curves-overview.html) (retrieved 2026-08-13); [Use Animation curves](https://docs.unity3d.com/Manual/animeditor-AnimationCurves.html) (retrieved 2026-08-13); [PlayableGraph `Evaluate`](https://docs.unity3d.com/ScriptReference/Playables.PlayableGraph.Evaluate.html) (retrieved 2026-08-13).

## §6 — editor UX → minimum viable film editor

Layout → fixed left Track List / headers; horizontally scrollable Content view / clip lanes; top time ruler + frame/seconds labels; playhead shared across lanes; overview/scrollbar; zoom around pointer/playhead; snapping to frames, clip edges, markers, playhead.  
Track header → name/type/icon; hierarchy/group foldout; target binding field + missing-target warning; lock = prohibit selection/edit/delete; mute = exclude track from eval while keeping editable.  
Solo → requested useful feature, but **not a documented core Unity Timeline 1.8 per-track toggle**; GAIA may add editor-local solo set → effective enabled = `!mute && (noSolo || soloed)`. Do not serialize it into film content unless render/export needs it.  
Selection → clip selection drives Inspector: timing (`start`, `duration`, `clipIn`, speed), source, blend/ease, extrapolation, track-type payload; marker selection drives event payload/delivery; track selection drives binding/settings.  
Playback controls → play/pause, step frame, jump start/end, current time field; looping play range; current time is source of truth for Scene preview.  
Essential interaction priorities → 1) select/scrub/deterministic preview; 2) drag/move/trim/snap; 3) Inspector direct edit; 4) binding picker; 5) record/autokey; 6) overlaps/blends; 7) curves; 8) groups/ripple/replace.  
UX non-translation → Unity’s Inspector is a global native serialized-object editor and its scene gizmos/Animator integration are engine/editor infrastructure; GAIA needs explicit property adapters and per-plugin inspector UI, not imitation.

Sources → [Track header](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/trk-header.html) (retrieved 2026-08-13); [Lock and mute tracks](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/trk-lock-mute.html) (retrieved 2026-08-13); [Timeline settings](https://docs.unity3d.com/Packages/com.unity.timeline@1.2/manual/tl_settings.html) (retrieved 2026-08-13); [Content view + edit modes](https://docs.unity3d.com/Packages/com.unity.timeline@1.8/manual/clip-overview.html) (retrieved 2026-08-13).

## §7 — translation table

| Unity concept | what it means for a three.js film | cheap-or-expensive to reproduce |
|---|---|---|
| TimelineAsset | portable declarative film document; no live scene refs | cheap |
| TrackAsset + typed output | typed lane + property/effect evaluator contract | moderate |
| PlayableDirector binding | document reusable across scenes/casts via target-slot→`Object3D` map | moderate |
| PlayableGraph | compiled evaluator/composition graph; lifecycle/invalidation/cache | expensive |
| Animation track / clips | animate transforms, cameras, lights, material props, skeletons | moderate → expensive for skeletal/additive blending |
| Activation track | visibility/enabled state lanes | cheap |
| Audio track / clips | timed audio buffers + gain/pan curves | moderate; sample-accurate seek/export expensive |
| Control track / sub-timeline | nested sequence + plugin-controlled seekable effects | moderate; arbitrary side-effect control does **not** translate safely |
| Signal / Receiver | typed marker event → registered handler | cheap; Unity’s reflection-method picker does **not** translate |
| Marker track | global or target-local cue/event annotations | cheap |
| Custom Playable track | ES-module plugin schema + evaluator + lane/inspector renderer | moderate; arbitrary third-party runtime graph composition expensive |
| Clip trim / clip-in / speed | source-window timing transform | cheap |
| Ease + overlap blend | explicit weights and curves for compatible continuous properties | moderate; generic blending across all plugin/data types does **not** translate |
| Gap extrapolation | baseline/hold/loop/ping-pong policy | cheap; `Continue` depends on source-asset import semantics, so does **not** map exactly |
| Record mode | property adapters write keyframes from live viewport/inspector edits | moderate |
| Curves + tangent editing | graph editor + interpolation evaluator | moderate |
| Unity humanoid/Animator binding | Unity-specific retargeting/state-machine integration | does **not** translate; expensive replacement system |
| Scene scrubbing / `Evaluate(t)` | baseline-reset + deterministic random-access evaluation | moderate; non-idempotent effects/audio/events need separate policy |
| Lock / mute / requested solo | edit protection / evaluation filter / editor-local focus | cheap |
| Unity Inspector / serialized references | target/property selection via explicit GAIA schemas | does **not** translate directly; moderate replacement |
