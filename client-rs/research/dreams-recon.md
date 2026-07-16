# Media Molecule DREAMS — full engine inventory — PARKED EVIDENCE (sonnet, 07-16)

Feeds: GEOMETRY.md (SDF sculpting) · CREATE.md (all sections; AUDIO = the
sole COPY LICENSE, Pascal) · NODES.md (microchips) · animation doctrine.

## Renderer/geometry (Evans SIGGRAPH 2015 "Learning from Failure")
- Sculpt = EDIT LIST: ordered CSG primitives (add/subtract, hard or smin
  soft blend, per-edit color), 1–100k edits/model ("Dad's head" = 8,274).
  Operationally-transformed trees → live re-eval on every edit. NO BAKE
  ANYWHERE — the entire remix economy depends on it.
- Pipeline: edit list → compute evaluator ("CS of doom", 3000+-instr
  shaders, 40+ CS chain) → sparse SDF (8³ bricks, all LODs) → multi-res
  point clouds → SPLAT renderer (no triangles for sculpts). LOD auto:
  brick ≈ >8px ⇒ ~1 voxel/px. Characters: blended SDFs (morphs), 16,384
  surface points regenerated per change.
- Failed iterations (instructive): marching-cubes polygons (mushy/slivers)
  → GigaVoxels → brick engine (2yrs, too slow, "untextured Unreal but
  slower") → refinement renderer (4-10× too slow) → shipped splats. Art
  demand drove it: "look like the concept art" (painterly), not raw SDF.
- DoF = radially exploding points (free from the representation).
- DreamForge relation: validates SDF-native sculpt data model (GEOMETRY.md
  edit-list ≈ our sdf primitive list, ratified); our render path differs
  (contouring → clusters → one pipeline) — their lesson kept: EVALUATOR
  SPEED IS EVERYTHING; hard numbers live in the SIGGRAPH PDF
  (media.lolrus.mediamolecule.com/AlexEvans_SIGGRAPH-2015-sml.pdf) —
  next-pass direct read. GDC 2020 "The Architecture of Dreams" (de
  Valmency) = other unmined primary.

## AUDIO — the copy target (Colvin interview asoundeffect.com/dreams-game-audio + Sónar+D 2018 + Twitch 05-2018 breakdown dreamskool)
- Full custom DAW inside the running game: ALL mixing/instruments/music/
  SFX live, PS4. People: Tom Colvin (lead), Bogdan Vera (DSP, MIR
  researcher — ensemble-timing papers), Ed Hargrave.
- GRANULAR CORE: "all of the voices are grains all of the time" —
  sampler×synth hybrid; stutter/stretch/texture free via grain speed.
- PER-NOTE DSP INSTANCING: every note gets its own full chain instance
  (EQ/dist/delay/filter) → real-time articulation morphing. No third-party
  plugins by design (perf).
- ONE TIMELINE for music+SFX+light+animation+gameplay events — "Pro Tools
  and Maya and After Effects in one place, running live"; playhead
  scrubbable, reversible, drivable by any signal.
- Performance-first input: 8 buttons = scale notes, tilt = octave; Canvas
  + imp drawing = playing; PERFORMANCE FIELDS = freeform circles bundling
  arbitrary DSP params (draw through = live automation) → captured →
  editable as piano roll AND automation curves. Arpeggiator. Mic →
  instruments (beatbox→drums, voice→choir/bass). Audio importer (web,
  quota-gated). 3D-placed sound objects. Live "Beatbox" performance mode.
- Stealth-create ladder: stamp finished track → arrange stems → perform
  instrument → build instrument → procedural/hardware-hooked. Publish at
  ANY granularity (track/stem/instrument/beat) — all remixable-live.
- Logic↔music: gameplay drives tempo/notes and vice versa (Art's Dream
  guitars fire in key/sync).

## Creation UX
- Imp = cursor (motion or sticks), possesses puppets (also = playtesting).
  Gesture-first doctrine: no "endless menus, endless sliders."
- Game-jam tools kept: Clone Repeat (clone-to-target = instant staircase),
  Color Tumbler (playful palette cycling). Sculpt+paint share ONE gesture
  vocabulary (deliberate). Style mode for materials.
- Remix economy: everything published = live-editable Element (nothing
  baked ⇒ remixing a track = its instruments still editable). Beta scale:
  21k dreamers/35k creations in 6 weeks.

## Logic (microchips) → NODES.md
- Analog DATAFLOW, not boolean: wires carry continuous 0..1 "energy";
  sensors → gates/calculators → actuators. Loops = literal wire feedback.
- Microchip = encapsulation canvas w/ exposed I/O ports = one custom
  gadget, shareable. Node gadget = pure routing/labeling.
- Turing-complete in practice (Ben Visness: 15/25 AoC 2022 days + toy LISP
  — bvisness.me/advent-of-dreams/); friction: no lists/arrays, cycle-
  timing pain → our nodes must fix exactly these.

## Animation + character → doctrine pre-validated
- Keyframe: pose-to-pose w/ timeline retime/smooth. PUPPETEERING: "record
  possession" — perform motion live, captured AS keyframe data (trophy
  requires 12min of it). Community DIY facial mocap from taped DS4s.
- Procedural auto-walk DEFAULT on blank puppets (rig-free): tweak channels
  arm vigour/flail/springiness 0-100%; keyframing a limb OVERRIDES that
  channel — procedural + keyframe + puppeteered COMPOSE/LAYER. Puppet
  Interface gadget: same wiring drives scripted AND performed control,
  outputs state telemetry.
- = DreamForge's puppeteer doctrine + auto-rig, shipped on 2013 hardware.
- IK/locomotion algorithm not published — GDC 2020 talk = likely source,
  next-pass.
