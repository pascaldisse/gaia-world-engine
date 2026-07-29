# FILM2 · SEG-1 · THE DEEP · 0.00 → 73.64 — VERDICTS

Module `client/plugins/film2/seg1.js` · driver `tools/seg1-driver.mjs` ·
ctx contract `tools/seg1-ctx.js` · lane `tools/seg1-stack.sh`
Strip `proof/film2-seg1/strip/` — 74 plates, REAL TIME (wall ≈ film t, see
`strip.log`), real `<audio>` clock (`full-mix.m4a`), muted three ways.

## 0 · CENSUS (checked, not assumed)
`/sense/query?has=transform` on the lane's own world (`GAIA_WORLD=.scratch/seg1/world`,
ops POSTed exactly once): **511** — 426 node · 72 dust · 3 galaxy · 3 starfield ·
3 nebula · 2 dream · 1 skyfield · 1 player presence. Plus the 2 transform-less
`atlas:` groups = **512 entities, the clean op-set**. Not multi-loaded.
The **3061** in the boot log is a DIFFERENT population and must not be confused
with it: the cosmos RECORD layer read from the `atlas-graph.json` sidecar. It is
not world state, and all 3061 are veiled by index every frame.

## 1 · TIMING — one correction to the brief, in the brief's own favour
The brief quoted the whisper at 2.5–36 and the holds at 55.0–73.64. `lyrics.json`,
which the brief also names the render spec, says:
30.000–35.000 · 36.960–41.960 · 44.240–48.880 · 48.880–53.880 · 55.000–59.440,
next line (seg-2's red drop) 73.640. **lyrics.json wins.** 0.00–30.00 is therefore
deliberately wordless — which is exactly "before creation there is only the deep".
Every constant in `IRON.W` is a word time copied from that file.

## 2 · BIRTH-CRAFT AUDIT — every object, entrance AND exit
`scale(0→1)` alone, opacity toggles and `visible=true` appear **nowhere**.

| object | entrance | exit |
|---|---|---|
| **the deep** (veil+core, 180 bodies) | *gather-from-void*, 0.00–2.60, 3 phases: over-spread ×1.95 and near-black → 3 radial turbulence beats (`GATHER_BEATS`) → settles into its breathing body | **none, by design** — it is the one thing that outlives the film; handed to seg-2 alive, breathing, dead-centre |
| **murmur** (560 stirrings) | born inside the gather, with the mass | never removed — it is the deep's own motion, *stilled* (amplitude → `STILL_FLOOR`, period ×2.35), not switched off |
| **shore seam** ("No" 36.960) | 2-phase *flicker-condense*: a band of density rises with two damped flickers | *unravel* on "shore," — lateral scatter grows to 120u as the seam thins to nothing by 38.21 |
| **name filament** (46 bodies, "no" 38.306) | 2-phase *trace-then-bloom*: drawn progressively along its own length, then a bloom-flicker on the word | *un-written from BOTH ends inward* on "name," (distance-from-middle decides who goes first), then disperses at 150u |
| **sleeping things** (576, "thousand"/"thousand") | **3 phases each, individually timed** — 64 bodies staggered across the first "thousand", 512 across the second: *gather* (the fog around the place contracts inward, the body is not there yet) → *coalesce* (rise + two catch-flickers) → *settle* (×1.16 overshoot easing to dormant breathing on "sleeping") | **2 phases each, reverse order** — *unwrite* ("Unwritten," per-body: swell ×1.48, dim ×0.55, edges scatter) then *dissolve* back into the mass, staggered 59.44→66.20 |

Mid-transition frames are in the strip and are legible as pictures in themselves
(`t44_72` first wave arriving, `t46_05` second wave, `t49_72` unwriting).

## 3 · FRAME VERDICTS (measured with `ctx.lum()`, judged by eye)

| t | note | p99 | cover | centroid (cx,cy) | verdict |
|---|---|---|---|---|---|
| 0.99 | gather | 0.11 | 0.44→ | (0.12, 0.00) | PASS — arriving out of nothing, already centred |
| 20.0 | the-deep-alone | 0.30 | 0.89 | (0.03, 0.00) | PASS — dark, screen-filling, breathing |
| 41.7 | no-watching-EYE | 0.32 | 0.94 | (0.00, −0.10) | PASS *(after defect 2 fixed)* |
| 46.0 | THOUSAND-2 | 0.40 | 0.98 | (0.01, −0.15) | PASS — suggestions, never distinct objects |
| 58.0 | DEEP-2 | 0.45 | 1.00 | (0.03, −0.11) | PASS — mass leans at the lens, centroid holds |
| 73.6 | stilling | 0.45 | 1.00 | (0.03, −0.04) | PASS — near-still, dead-centre, dist 600 |

Laws: **centred** |cx| ≤ 0.036, |cy| ≤ 0.151 throughout (the centroid is measured
from the PICTURE, not from the camera goal). **Screen-filling** cover 0.89→1.00
after the gather. **Legible on black** p99 0.11–0.45 — reads as fog, never glows.
**No light, no record, no Dream, no skyfield**: `unveiled 0 · kinds {} ·
cosmosEnabled false · forgeActive 0 · visibleGroups 0 · figures 0 · lights 0`,
re-asserted every frame and printed with every plate.
**One shot**: goal `[162,−368,−125]` (seg-2's ignition point) every frame, yaw 0,
pitch 0, dist 900→600 on one monotone C1 ease with **zero velocity at 73.64**.

## 4 · DEFECTS FOUND AND FIXED
1. **The deep was a lit nebula.** First build ran `CORE_RGB .052/.047/.104` and
   came back pale white-lilac, p99 .82 at t=20 — a light, which is the one thing
   this window may not contain. Fixed three ways: hue made cold (blue-grey with a
   violet undertone), brightness ÷3.9, and the heart **hollowed**
   (`CORE_BIAS 1.30` packs bodies outward, brightest shell at `DEPTH_PEAK 0.70`)
   so lines of sight through the middle stop stacking into a blown core.
2. **Nineteen lights survived the veil.** Hiding the film's group layers left a
   hemisphere, a directional, an ambient and 16 point lights parented straight to
   the scene — visible in the strip as bright pinpricks at frame centre
   (`strip/t41_74.png`). Enumerated, switched off and restored by `exit()`;
   `proof/film2-seg1/after-lights-off-t41.png` is the same frame, clean.
3. **The deep was a ball in black.** `CORE_R 520` gave cover 0.38. Re-sized to the
   lens (at dist 900, fov 50° the frame is ±420 × ±747 at the mass' depth):
   `CORE_R 760`, veil out to 2100 — omnipresent, only the *mass* centred.
4. **The strip's clock never advanced.** 104 plates all labelled t=0.00:
   chrome-headless-shell refuses `play()` on even a MUTED element without a user
   gesture, so the film clock stood at 0 while the wall clock ran to 103s.
   `--autoplay-policy=no-user-gesture-required`; the element stays muted three
   ways regardless. *This is why a strip must print the film clock next to the
   wall clock — a strip that only prints plate numbers would have passed.*
5. **The lane booted against another lane's client.** Port 5191 was already the
   beauty lane's; the readiness curl answered from ITS vite. Ports moved to
   8541/5241/9341 and the stack now refuses to boot if any is held.
6. **A neighbour lane reaped this lane's vite mid-run.** `pkill -f` matches argv,
   not the environment, so the `GAIA_SEG1_LANE=1` marker matched nothing and
   `down` was a no-op. Markers moved into argv; the lane now supervises itself.

## 5 · HAND-OFF
Entry pose `{goal:[162,−368,−125], dist:900, yaw:0, pitch:0}` ·
exit pose `{…, dist:600, …}`, reached with zero camera velocity.
Exit world-state: **nothing exists but the deep** — and the deep is left IN the
scene, still breathing, for seg-2's red drop to fall through. `exit()` gives back
only what seg-1 borrowed (background, autoFrame, the 19 lights).

## 6 · KNOWN TENSION, DECIDED
"utter stillness" at 73.64 vs law 2 "always visibly breathing". Law 2 outranks a
segment note, and seg-2 must be handed a living deep, not a photograph: the breath
decays to `STILL_FLOOR 0.11` of amplitude at 1/2.35 speed — near-stillness, not
stillness. Stated here rather than hidden in a constant.
