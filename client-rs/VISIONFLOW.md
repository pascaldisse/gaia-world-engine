# VISIONFLOW — DreamForge's node system (DRAFT, named by Pascal 2026-07-16)

VISIONFLOW = THE name (Pascal ruling 07-16): ALL node-based surfaces are
ONE system — programming/logic nodes · shader graphs · animation trees ·
behavior trees · procedural generation. 3D, spatial, UI-LAYER ONLY — all
just data underneath, manipulated as easily by AI as by hand. The
Blueprints/Dreams-microchips equivalent, built to beat both.
Ruling absorbed: VisionFlow = (a) the engine's node surface, Game Beneath
folded in (closes DOSSIER §6's open call).
Laws served: pillar 10 · pillar 12 · the Book of the Eye (research/
visionflow-recon.md). "Better than Blueprints" = acceptance bar.

## 1 · Truth model
- A graph is DATA: entities/components like everything else — stored in
  scenes, edited by ops, versioned, remixable, agent-writable. The node
  VIEW renders that data; deleting the view deletes nothing.
- Round-trip guaranteed: any state the engine holds is reachable and
  editable through the graph surface ("an abstract representation of the
  data" — Pascal, DOSSIER §6.1). No privileged hand (Canto XIV): human,
  agent, child, stranger — same rights, same surface.
- Users never write code. Agents MAY write graph-data directly; humans see
  what agents wrote as nodes, immediately, live.

## 2 · ONE THING — there are no domains (Pascal 07-16, final form:
"there's literally no shader graph, no animation trees... it's all just a
fucking node with data attached to it")
- A NODE IS DATA. Whatever the data says, happens. A node may carry shader
  data, a calculation, an animation, a behavior tick, a field, a sound —
  the system neither knows nor cares. There are no graph TYPES, no domain
  walls, no "50 million systems that don't interact" (anti-Unity law).
- ANYTHING WIRES TO ANYTHING where the data shapes fit: animation output →
  shader parameter → constraint stiffness → music tempo → spawn density.
  The Dreams north star (run-speed driving tempo) is the trivial case,
  not a feature.
- Nodes ARE entities with components — the engine's own schema is the node
  vocabulary; adding a component type adds a node kind with zero VisionFlow
  code (pillar: new components never require engine changes).
- Evaluation is per-NODE by data kind, invisible: shader data reaches the
  integrator as material recipes; field data evaluates lazily at any scale;
  signal data ticks; animation data feeds poses (composing with puppeteer
  layers, CREATE.md §3); the wall between "edit-time" and "runtime" does
  not exist — it is a live world either way.
- What LOOKS like a "shader graph" or "behavior tree" is just a corner of
  the one graph where someone wired those data kinds together. The words
  describe content, never systems.

- **Signal semantics** (Dreams microchips, corrected):
  analog DATAFLOW — wires carry continuous 0..1 signals (not just events);
  sensors → processors → actuators. Encapsulation = chip w/ exposed ports
  (publishable as an Element). FIXES to Dreams' documented frictions:
  first-class lists/arrays + iteration nodes · deterministic cycle
  semantics (explicit delay node; cycles without delay = authoring error,
  shown in-view) · proper math/string/entity-query node library.
- **Procedural domain** (CREATE.md §5): lazy DAG, attributes-as-data,
  field-valued sockets (the one weighted-field primitive), evaluated on
  demand at any scale — edit-time AND runtime.
- Both compile to the same ECS scheduler primitives the engine already
  runs (systems/queries/ops) — nodes are a FRONTEND to the data model,
  never a second VM bolted on. (Dreams proved Turing-complete dataflow;
  we keep the power, fix the ergonomics.)

## 3 · Spatial surface (VisionFlow laws, desktop-first)
- 3D node graphs in the world — desktop viewport first, VR later (pillar
  11); same scene renderer draws them (they're entities).
- Law 1 GRAVITY = COUPLING: layout always derived, never hand-placed;
  force-directed by dependency; a node torn between clusters = visible
  architectural smell.
- Law 2 PERCEPTUAL CHANNELS: size=cost · brightness=call frequency ·
  color-shift=error · motion=executing now. Perceived, not decoded.
- Law 3 CO-LOCATION = CONCURRENCY (keystone): what runs together sits at
  the same depth — parallelism read pre-attentively. The one claim flat
  text cannot match.
- Law 4 ZOOM = MEANING: semantic LOD; far = clusters/architecture, near =
  ports/values; no privileged floor (same law as cluster DAG + VT — the
  whole engine virtualizes by meaning).
- Law 5 EXECUTION AS WEATHER: the running graph is lit — hot paths storm,
  signals flow as light; debugging = standing inside the living body,
  never reading the corpse of a log.
- Aesthetic bar (Pascal, live-session ruling): UNIVERSE SANDBOX — fresnel
  star nodes, subsystem-tinted, dust nebulae per cluster, edges as faint
  threads. Never a plexus diagram, never a code city.

## 4 · Collaboration (pillar 12 — the awareness layer)
- Co-present builders in the same graph: pointing is VISIBLE (your ray/
  hand highlights the node for everyone), selection halos per-person,
  hold/grab semantics (one holder at a time, visible who), gravity
  re-settling as many hands move the work.
- Agents get presence too: an AI co-builder's cursor/hand is rendered the
  same as a human's — you SEE your agent working beside you.
- Transport: existing ops/presence protocol (editors already are clients
  of live shared data — the awareness layer is new UI, not new plumbing).

## 5 · Better than Blueprints — the case, explicit
| Blueprints suck | DreamForge nodes |
|---|---|
| 2D spaghetti, hand-layout rots | derived 3D layout, coupling IS position |
| compile step, play-in-editor gap | live data, running world, no compile |
| exec-order invisible | co-location = concurrency, weather shows it |
| graph ≠ engine data (own VM/serialization) | graph IS entity data, ops, remixable |
| single-user asset lock | co-present multi-hand editing (pillar 12) |
| debugging = breakpoints on wires | execution-as-weather, scrub the timeline |
| agents can't collaborate | agents are first-class co-authors |

## 6 · Package mapping (pillar 13)
nodes-core (graph data model + compiler to scheduler) · nodes-view-3d
(spatial surface) · nodes-logic (chip library) · nodes-procedural (field
DAG library) · nodes-presence (awareness layer). Core stays clean.

## 7 · Milestones
N1 graph data model + compiler: a chip toggles a light in a live world,
   authored via ops by an agent AND via view by a human — same file.
N2 spatial view: derived layout + perceptual channels on a real scene's
   logic; Universe Sandbox look; screenshot-gated.
N3 weather: live execution visualization; scrub a timeline, watch signals.
N4 presence: two clients + one agent co-edit a graph; pointing/hold
   visible to all; play-tested per PLAY-IT law.
N5 procedural domain merge: CREATE.md C5 graph runs in the same view.

## Open questions for Pascal
1. ~~VisionFlow (a)/(b)/(c)~~ RULED 07-16: (a) the engine's node surface.
2. ✅ RULED: fixed tick (deterministic, replayable; aligns w/ physics §8).
3. ✅ RULED DEAD (Pascal 07-16): no DSL — "nodes are data, the engine is
   AI first." Agents speak ops natively; data IS the agent interface. A
   DSL would be a second door into a house with no walls.
