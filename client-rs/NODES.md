# NODES — DreamForge node scripting surface (DRAFT for Pascal's ruling, 2026-07-16)

Laws served: pillar 10 (nodes = surface, data = truth; AI agents = primary
users) · pillar 12 (multiplayer is for making) · VisionFlow = Pascal's own
reference spec (research/visionflow-recon.md — the Book of the Eye).
"Better than Blueprints" = the acceptance bar.

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

## 2 · Execution model — two domains, one grammar
- **Logic domain** (runtime behavior; Dreams microchips, corrected):
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
1. The old open call, now due: VisionFlow = (a) the engine's editor
   surface (this doc's assumption), (b) separate product, (c) itself a
   game — Game Beneath folded into (a)?
2. Logic-domain signal rate: fixed tick (deterministic, replayable) vs
   per-frame — propose fixed tick, aligns with physics §8 determinism.
3. Text DSL escape hatch for agents (graphs as terse text, compiles to
   same data) — worth speccing, or ops-only suffices?
