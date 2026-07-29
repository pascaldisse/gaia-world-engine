# SEG-5 · THE CHRISTENING AND THE COVENANT (144.08 → 176.32) — VERDICTS

module `client/plugins/film2/seg5.js` · driver `tools/seg5-driver.mjs`
stack `tools/seg5-stack.sh` (8455 / 5195 / CDP 9245, own `GAIA_WORLD`, own ops)
browser `tools/seg5-browser.sh` (Brave, **hidden + `--mute-audio` + `?mute=1`**)
strip `proof/film2-seg5/strip.png` — 34 plates, 1 per film-second, 2560-wide each

## the driver's own pass — 12/12
```
ok stage: wheeling seas lit, chrome off, sky in the seg-4 rite (3061 motes · 7748 edges)
ok prewarm builds every body before the window opens (811ms, 7748 edges)
ok prewarm leaves NOTHING born at the entry frame
ok every plate is a real frame (no black capture) — min 626KB
ok analytic: every amplitude/birth/death at 163.08 identical after 3 other frames
ok analytic: the same holds mid-christening (155.4)
ok law 1 — nothing born at 147.60 (before its word)
ok law 1 — no thread leaves before 162.05 ('light')
ok the covenant has begun by 163.00 (449 threads walking)
ok the sky is WEBBED at the exit frame — 7748/7748 landed
ok exit pose closes on the cathedral knot at 350.0
ok entry pose alongside the great wheel at 450.0
```

## BIRTH-CRAFT AUDIT — every object, its entrance and its exit
| object | ENTRANCE (phases) | EXIT (phases) |
|---|---|---|
| mist sheets (3) | bloom-from-nothing on **'christened' 148.33**, three sheets phase-offset, drifting, 0.9s | **spent into the rain**: brightness transfers to the condensing drops 150.02→151.6 |
| rain drops (2600) | **condensation**: precipitate out of the mist at their own moment (staggered 1.3s) as flickering points that **elongate** into streaks; per-drop birth flicker `e^(-age/0.5)` | **ember fade-to-ash**: the fall decelerates, the streak shortens back to a point, paleblood warms to ember, the ember goes out (staggered 166.5→172.4) |
| deep fog (6 sheets) | INHERITED (law 2: omnipresent) — no birth in-window; the thing that *arrives* is the paleblood **in** it, blooming with the mist | gives the colour back as the last ember goes to ash |
| contact spark ×7 | 0.06s rise — the plate **on** the word shows the strike, not its eve | 0.5s exponential decay into the afterglow |
| ripple ring ×7 | born **at** the strike, zero radius, full light | expands and thins to nothing over 0.9s (`(1-u)^1.6`) |
| afterglow ×7 | eased in over 0.55s out of the strike | never returns to what it was — dims 45% as the name comes home |
| card plate ×7 | the **rule of light draws itself** left→right; the plate condenses behind it out of the afterglow | contracts **along the tether** toward its mote while the rule un-draws |
| card text ×7 | glyph **churn** (14 Hz, 'hidden') → **per-letter resolve** left→right, each letter landing with its own flare ('shown') | letters **come apart** right→left (the keeper takes the last letter last) |
| tether ×7 | grows mote→card (progressive draw, 0.7s) | retracts card→mote (158.9→160.4) |
| home sparks (182) | born out of the dissolving letters, arc down the tether | **absorbed** into the mote — the mote's own deep pulse is their exit |
| covenant thread ×7748 | a spark **walks** the real edge; the filament is its wake (eased, 1.15s) | persists by design (exit state = a webbed sky); its settle is eased — the arrival flare decays into a slow collective breath |
| thread head | born at the edge's origin on its word | becomes the arrival flare at the far node |
| arrival flare | born on the head's landing | 0.7s decay into the thread's steady value |

No object in the window uses `visible=true`, an opacity toggle, or a bare
`scale(0→1)`. Zero objects without both an entrance and an exit.

## defects the strip convicted, and the fix
1. **mist was a pink wash over the whole plate** (strip 1 + 5) → `MIST_RGB` 0.90 → 0.115 → **0.052**; the frame reads through it.
2. **1100 fat drops read as thrown carrots** → 2600 thin streaks, `R` 0.42→0.105, `LEN` 9→18, plus a **near-lens cull** (a drop 12 units from the eye was a 200-pixel bar) and a depth fade.
3. **the finished web was a white blowout at every hub** → thin (`R` 0.26→0.085), gain 0.30→0.115, and two physical fades: `1/length` and `1/√degree` (a hub's threads are hundreds of near-collinear filaments and additive light stacks).
4. **seven cards landed on one knot as an unreadable smear** → the **fan**: each card stands on its own screen-space spoke around the knot; constant angular size (`CARD_H·distance`) keeps every name legible at any lens distance (law 6).
5. **the 'home' pulse blew the knot white** → 1.15 → 0.42, home sparks dimmed with it.
6. **the covenant's rolling matrix refresh carried state between frames** → in a stepped pass every thread is rewritten every frame (caught by the analytic probe, which is why the probe exists).
7. **the analytic check was itself wrong**: a plate of the same film-t can never be byte-identical — the engine's own mote shimmer runs off `cosmos.elapsed` and the seas wheel on wall time. The check now measures every amplitude, birth and death **this file owns** (`probe(t)`), which is the thing the law is actually about.

## known-remaining (named, not hidden)
- the 'home' beat at ~159 is still the brightest frame in the window; it is one deliberate beat, but half a stop hotter than the rest of the segment.
- the covenant's inter-sea edges bundle into two bright trunks. That is the graph's truth in this layout (the seas are 250+ units apart and the hubs are few), not a bug — but a fold that wants a *web* rather than *trunks* should either fire the covenants rite (which is what the original film does at 161.76) or keep the shot inside one sea.

## laws
1 lyrics = render spec — every event keyed to a word time, nothing before its word (checked at 147.60 / 162.04) · 2 deep = omnipresent centred fog (dust:sky re-centred on the shot + own sheets) · 3 no eyes · 4 pale-**red**, never blue (`RAIN_RGB [3.05,0.46,0.44]`) · 5 real animated events + prewarm (every body built and uploaded before the window, at zero light) · 6 p99 legibility (constant angular card size; rain dimmed and thinned so the web reads) · 7 one continuous C1 shot, 450→350, no cut mechanism in the file · 8 §IRON at the top, every number measured on a plate.
