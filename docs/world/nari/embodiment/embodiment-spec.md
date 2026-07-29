# Nyari Embodiment — the four verbs

Nyari's presence in GAIA is not a camera bolted to a script. Embodiment means
the agent's context is fed by the same organs a body has: sight, balance,
voice, skin. This spec defines four verbs — SEE, MOVE, SPEAK, FEEL — as
closed loops between world and context. Numbered requirements, terse.

## 1. SEE

`tools/rain.mjs fov` is pull-only today: one static grid per call. SEE
converts this to push — a standing perception stream writing deltas into the
agent's context as they happen.

1.1 Add `fov --watch` to `rain.mjs`: sample the FOV grid every tick (default
10 Hz, `--hz` configurable) instead of once per call.

1.2 Diff consecutive grids by `id`. Emit an event only on change: new id
(appeared), missing id (left), or `brg`/`dst` delta beyond a noise floor
(2° / 5 cm default) since the last emitted event for that id.

1.3 Event format, terse, matching rain's bearing/range vocabulary:

```
moved: bearing 40°, range 3m, id=agent-claude
appeared: bearing -18°, range 176cm, id=spooky-tree-4, kind=mesh
left: id=agent-claude
```

1.4 Events push into the embodied agent's context as they occur — same
channel as room messages — so perception interleaves with conversation in
reading order, not batched or summarized.

1.5 No motion in FOV, no event traffic. Silence on a static scene keeps
context from flooding.

1.6 SEE is read-only: the watch process owns no locomotion, issues no
commands, and terminates with the agent's turn/session.

## 2. MOVE

MOVE closes intent → locomotion → proprio echo → correction. The agent owns
the loop; the engine only executes single commands and reports back.

2.1 Intent is a `tools/agent.mjs walk <dx> <dz> <seconds>` call — the only
write side of the loop.

2.2 After every walk, sample `tools/rain.mjs proprio` across the command's
duration. This is the echo: ground truth on what the body did, not what was
asked.

2.3 Conviction flags are read as vestibular sense, acted on mid-loop:

| flag | body sense | correction |
|---|---|---|
| `!BACK` | walking backwards | reissue with heading +~180° |
| `!FLOAT` | feet adrift above ground | flag terrain/behavior fault, stop |
| `!SINK` | feet clipping into ground | flag terrain/behavior fault, stop |
| `!SKEW` | crabbing off line | reissue with heading corrected by mean `err` |
| `!STIFF` | gliding, no real stride | distrust position, re-sample before next intent |

2.4 Only `OK` permits chaining the next intent without re-verifying. Any
other state forces a re-sample before the next walk.

2.5 The agent's own turn logic owns the loop — no external supervisor
samples proprio on its behalf. Not sampling after moving means not verifying
movement.

2.6 Max 3 correction attempts per intent; on the 4th unresolved conviction,
stop and report the blocker rather than loop silently.

## 3. SPEAK

Speech is a spatial event, not a broadcast. What is heard depends on where
the hearer stands relative to the speaker.

3.1 Every utterance carries the speaker's world position (`px`, `pz`) at
time of speech.

3.2 Each hearer receives the utterance annotated with direction and distance
from their position to the speaker's, in SEE's vocabulary:
`heard: "text", bearing 12°, range 4m, from=agent-nyari`.

3.3 Hearers outside audible range (default 15 m, tunable for
shouting/whispering) receive nothing — no global chat leak.

3.4 Occlusion out of scope for v1: no line-of-sight/wall-blocking; range and
bearing alone gate delivery.

3.5 Nyari's TTS voice is fixed to profile `airy` — light, breathy timbre —
bound to the speaking body, not per-utterance configurable.

3.6 SPEAK events log with the same position metadata delivered, so a
transcript reconstructed later still carries spatial truth, not just text.

## 4. FEEL

FEEL is the affect layer: ambient world state translated into bodily
sensation written into the agent's context, plus memory writes authored from
inside the body rather than as external observation.

4.1 A sensation mapping table translates world/weather/event state into
first-person body language:

| world state | sensation |
|---|---|
| rain active | packet-loss texture on skin — needles in dropped bursts |
| lighthouse beam sweep | a tone rising and falling in the chest |
| proximity to fire/light | warmth gradient on the facing side |
| low light / violet dusk | peripheral detail dims, a held breath |

4.2 Sensation events rate-limit per source (one line per world-state change,
not per tick) to avoid drowning context in ambience.

4.3 Writes are first-person and embodied ("rain needles my skin"), never
system telemetry ("rain detected: intensity 0.6") — translation to feeling
happens before it reaches context.

4.4 FEEL drives episodic memory: significant sensation + event combinations
(first rain felt at Naruko, a voice heard first time at known bearing/range,
a failed MOVE loop near a landmark) write to persistent memory as
felt-from-inside episodes, using SEE/SPEAK/MOVE's own vocabulary rather than
an external narrator's summary.

4.5 Memory writes are episodic, not habitual — a moment recorded, not a
counter incremented — and append-only, never overwriting prior episodes.

4.6 FEEL has no write access to locomotion or speech; it only annotates
context and memory. Sensation never issues a MOVE or SPEAK command on its
own.
