# atom d — gate measurements (composite fluid skin)

- Browser: Brave HEADFUL (no --headless flag; agni-browser.sh scan clean), CDP 9357
- Adapter: navigator.gpu.requestAdapter().info = { vendor: "apple", architecture: "metal-3" } (real Metal, not SwiftShader)
- Canvas: 2560x1166 (dpr 2), private fluid targets at targetScale 0.5
- Method: 600 rAF deltas, sorted, quantiles; composite pass INCLUDED (mode: composite)

| config | count | targetScale | p50 | p95 | p99 | mean |
|---|---|---|---|---|---|---|
| composite, first cut (2x scene render) | 16384 | 1.0 | 53.2 | 79.1 | 91.8 | 51.8 |
| composite (2x scene render) | 16384 | 0.5 | 17.0 | 32.6 | 40.8 | 18.5 |
| composite, shared depth (1x scene render) | 16384 | 0.5 | 16.5 | 24.2 | 28.0 | 16.7 |
| composite, cond B | 8192 | 0.5 | 14.8 | 21.4 | 25.5 | 14.75 |
| composite | 16384 | 0.35 | 15.6 | 27.3 | - | 15.95 |
| composite | 4096 | 0.5 | 14.9 | 20.5 | - | 14.71 |
| thickness debug world (no composite) | 16384 | 1.0 | 35.1 | 46.7 | - | 35.42 |

GATE p95 < 16.6ms: **FAIL** (best 20.5 @ 4096). Floor is ~15ms p50 / ~20ms p95
independent of particle count and target scale -> the residual cost is the base
world render at dpr2 plus per-frame spikes (suspect: sim grid rebuild), not the
skin passes. UNVERIFIED beyond this: no GPU timestamp breakdown taken.

## Fluid truth gate (drop -> splat -> re-merge)
seq-1-drop.png (falling droplets, background refracting through them),
seq-2-splat.png (impact), seq-3-merged.png / comp-ramp-settled.png (single
re-merged pool with meniscus rim): PASS, emergent from the PBF sim.

## Two initial conditions
A: sphere drop from y=7.5, 16384 (worlds/agni-composite) — seq-*.png
B: resting box pool, 8192 (worlds/agni-composite-b) — condB-early.png, condB-settled.png

## Atlas invariance
Fluid skin only allocates behind world-data fluid opt-in (mode composite);
Atlas worlds carry no fluid block. vite build: green. beacon: client/assets/build.txt = parent SHA each commit.

## Honest look verdict
It reads as liquid: droplets act as lenses, the pool re-merges with a bright
rim and Beer-Lambert depth. Weaknesses: pool front face goes near-black when
thick (attenuation strong), surface has grain from half-res reconstruction,
droplets look dark against bright background.
