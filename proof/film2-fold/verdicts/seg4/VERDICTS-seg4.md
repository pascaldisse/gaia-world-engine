# SEG-4 · ACCRETION (123.60 → 144.08) — VERDICTS

Module `client/plugins/film2/seg4.js` · rig `tools/seg4-driver.mjs` + `tools/seg4-serve.sh`
Stack: worktree `../GAIA-WE-seg4` branch `film2-seg4` off `f20e48e6` · vite **5187** · server **8436** ·
CDP **9241** · `GAIA_WORLD=.scratch/world` (own, empty, ops re-POSTed: 512 entities) · Brave **hidden + --mute-audio** ·
no /tmp, never 8420/8421/5173/5174 · no shared file edited (atlas-director.js read ONLY).

## 1 · THE STRIP (real-time, 1 fps, ENTRY→EXIT, one continuous shot)
`proof/seg4/t*.png` (21 plates) + `proof/seg4/strip.json` + contact sheet `proof/seg4-contact.png`.

| measurement | value | verdict |
|---|---|---|
| wall seconds vs film seconds | 21.01 vs 20.48 | **real time** (not seeks) |
| page frames / fps during capture | 2478 / 118.0 | motion is real, not a slideshow |
| sparks before 'sparks' (129.20) | **0** at 123.62…128.62 | LAW 1 holds |
| motes before their arrival | 0 until 130.64 | LAW 1 holds |
| cathedral mist before 'Cathedrals' (139.64) | **0** | LAW 1 holds |
| landed at exit / still flying | **3061 / 0** | the database is fully born |
| exit clean (no transient alive at 144.08) | **true** | nothing to switch off at the handover |
| prewarm assertion | `firstLaunch 129.20`, `lastArrival 139.90` | thrown on the word, landed before 'keys' |

Word-locked events, read off the plates: 129.65 first grain (275 in flight) · 131.63 the scatter ·
134.63 the arrival peak (577 flares) · 138.64 the wheel turning · 140.63 the mist gathering (540 motes) ·
143.63 the cathedrals struck.

## 2 · BIRTH-CRAFT AUDIT (every object: entrance AND exit, ≥2 phases, no toggles)

| object | ENTRANCE | EXIT |
|---|---|---|
| **spark (grain in flight)** | 1 candle-flicker at the core mouth (aperiodic stabs, 0.18s) → 2 flare bloom at 0.22 of flight → 3 cools into a tapered grain | flare-out **on arrival**: white spike ×2.2 decaying τ0.34 → collapses into the mote it becomes (brightness handover, never a toggle) |
| **streak (tail)** | grows out of its own head, length 0→v·τ over 0.12s, bowed by the throw | ash-fade after landing: reddens, shortens ∝f² to 0 over 0.5s |
| **mote (landed record)** | inherits the spark's flare → two settle bounces (damped cos, τ0.28) → joins the wheel | none — it is the state seg-5 inherits (handed over by `exit()`, not destroyed) |
| **wheel (the seas)** | ω ramps from 0 on 'wheeling' (138.10) over 1.8s, differential (inner faster), sea-swell bob travelling outward | persists (exit state) |
| **cathedral body** | 1 mist gather (90 motes spiral in, 1.0s) → 2 **morph**: noise-displaced formless blob whose amplitude falls to 0 over 0.9s + a hairline rim shell rings outward → 3 hang: overshoot-and-settle, halo bloom, slow breath | persists; struck on 'keys' (143.40) in a silent arpeggio (uniform-driven bloom + ring) |
| **cathedral mist** | spiral-in from r=92 with rising luminance | **dissolves into the body**: decelerates, reddens to ash, shrinks, sinks (0.45s) — never switched off |
| **core** | entry state (seg-3); standalone fallback = candle-flicker up over 1.0s | persists, **dims 42%** as it gives its light to the grain; every burst kicks it (τ0.20) |
| **deep** | already burning at ENTRY (law 2), re-centred on the shot every frame, breathing at 0.037 Hz | persists |

`scale(0→1)` alone: **not used anywhere**. `visible=true`: used only by the staging veil (hiding the
un-worded world), never to introduce one of this segment's objects. Every object above has both columns filled.

## 3 · DEFECTS FOUND BY THE STRIP, AND FIXED
1. **Black-on-black risk / blow-out.** First pass: 0.0017 rad floor at gain 1.55 saturated a 1432-mote sea to a
   white blob and killed the kind tints. Fixed: 0.0014 floor (≈1.8 px core), gain 0.92→1.05, arrival flare 3.1→2.2.
2. **Cores photographed as opaque brown eggs** (a wide dim sphere is not a glow under this surface).
   Fixed: corona deleted, one small genuinely bright body + the scene's own bloom; angular floor 0.0135→0.0055.
3. **The shot framed 7° wide of its own subject** — the galaxy centroid is not where the mass is. Fixed:
   six Weiszfeld steps put each core on the geometric median.
4. **The seas photographed as ~100 px chips in 85 % black.** Measured: p95 radii 29 / 25 units, cores 327 apart —
   the brief's "mid ~450" belongs to another layout. Fixed: the close half of the move is scaled at prewarm to the
   big sea's own p90 radius (`CLOSE_K 3.4·seaR + 60`); `exitPose` declares nominal **and** rule so nyari can fold it.
5. **The throw read as a tight fizz** (most records live 27 units from their core). Fixed: the grain now
   **overshoots and settles back** (e peaks ~1.16 at u≈0.72) and the streaks run 0.15 of the flight with a 6-unit floor.
6. **The world kept re-showing itself mid-window** (24 forged `node:*` groups re-appeared after staging) —
   records with no word on screen. Fixed: the veil is re-asserted every frame (`holdStage`).
7. **Cathedrals ate the frame as white eggs** (0.045 cap), then **hid inside the core glow** (0.013 cap).
   Fixed at 0.015 floor / 0.022 cap with halo ×2: larger and stiller than a mote, not the subject.

## 4 · POSES (the fold's contract)
- **entryPose** 123.60 — dist 700, yaw 2.28, pitch 0.115, aim = centroid of the three young cores. World: three cores + deep, no record drawn.
- **exitPose** 144.08 — nominal dist 450 / effective `3.4·seaR(p90)+60` (~160 on these ops), yaw 3.02, pitch 0.198,
  aim = a point on the largest sea's rim carried by its own wheel. World: three wheeling mote-seas at their real
  layout positions + 11 hung cathedrals + the dimmed cores + the deep.

## 5 · KNOWN, NOT FIXED (budget)
- The two small seas are physically 25–30 units wide: at the wide end they are points of light, by design of the data.
- The right third of the exit frame is empty deep — a composition choice the fold may re-yaw by ±0.15 without touching timing.
