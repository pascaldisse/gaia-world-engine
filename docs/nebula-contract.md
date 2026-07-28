# THE NEBULA CONTRACT — what world-build must emit

Lane: beauty-universe (opus5). The CLIENT half is built, measured and committed.
This file is the exact spec the GENERATOR half must emit; it is the remaining
step, and it is deliberately written as data, not prose.

Shader: `client/kernel/presets.js` → `case 'nebula'` (§IRON NEBULA).
Star fields: `client/kernel/particles.js` → `SPACE_IRON`, opt-in `spec.space`.
Cull: `client/kernel/view.js` → `cullFadedClouds()`.
Pixel governor: `client/kernel/renderer.js` → `PIXEL_IRON`.
Reference application, run against the live world: `tools/universe-probe.mjs`
(`nebulaShellParts` equivalent is inline there — it is the source of truth for
the numbers below).

## 1. per `galaxy:<id>` — append TWO parts to mesh.parts

`D` = 2 × the cluster's **star-field spread radius** (`areaRadius`), NOT the core
radius. Deriving it from the core radius made the cloud 4× too small and it
vanished (probe a2). `norm` = D/2.

```
glow  { shape:'plane', size:[D,D], preset:'nebula', mode:'glow', norm:D/2,
        seed, color:<coreColor>, edge, accent, accent2,
        arms, armCount:2, armSharp, armFloor, lopsided, spin, squash,
        coreFall, freq, floor, gain, lane, laneScale, laneSoft, laneCut,
        hot, facing, rimEnd, opacity, glowStrength, far:[900,3400],
        near:[40,160], castShadow:false, renderOrder:1, fog:false, solid:false }
lanes { ...glow, mode:'lanes', size:[D*0.93,D*0.93], norm:D*0.465,
        color:'#080610', warm:'#241206', octaves:1, laneOctaves:1,
        opacity:0.8, renderOrder:2 }
```

DECORRELATE per cluster (this is the Mensis note — asymmetry and wrong angles):
`seed`, `spin`, `squash`, `arms`, `lopsided`, `accent`, `accent2` must all differ
per cluster, derived from `hashSeed(id)` + cluster index. Three galaxies sharing
one seed read as three copies of one cloud.

## 2. THE CORE MUST YIELD

Measured on plates: at `coreEmissiveIntensity 5.8` + halo `opacity 0.28` + bloom
`threshold 0.5` the two core spheres ARE the galaxy — a headlight whose bloom
covers every filament the cloud draws (probe s2/s3).

- solid core sphere: radius × ~0.26, emissive × ~0.5.
- **halo sphere: DROP IT.** `preset:'glow'` maps `uv()` on a *sphere*, so its
  falloff is equirectangular, not radial: it draws a hard-edged pale disc with a
  terminator across it and read as a MOON at every distance (probe s4-d150,
  a1-d150). It also ignores `opacity`/`emissiveIntensity`, so dimming does
  nothing. The nebula's `hot` core replaces it.
- keep the point light and the pulse behaviour.

## 3. star fields — `starfield:<id>` and `nebula:<id>` particles

Add two keys only: `space: true` and `accents: [2-3 hex]` (that galaxy's own
temperatures). Everything else stays.

## 4. HARD CONSTRAINT — ids the film owns

`atlas-fx-rites.js` (sibling-owned, not to be edited) borrows entities by id:
`nebula:${k}`, `starfield:${k}`, and `/^(dust:sky:|nebula:)/`. It writes
`mesh.count`, `mesh.material.opacity/.transparent/.depthWrite`, and
`spec.motion.radius/.speed`.

→ Those entities and ids must NOT be removed or renamed. Only counts, sizes and
colours may change. `particles.js` space mode preserves all five write points
(`materialOpacity` is read by the node graph on purpose).

Puff budget may come down hard now that the cloud is a shader
(`skyDustPuffs` 300, deep-field puffs 333, `nebulaDustCount` 2400) — the
survivors should read as resolved stars INSIDE the cloud, not as the cloud. Keep
a handful of `dust:sky:` entities alive for the rites.

## 5. the deep field

One large quad, id prefix **`skyfield:`** (deliberately not `nebula:`/`dust:sky:`
so the rites' regex does not borrow it), `armFloor:1` so it is mass and dust
rather than a fourth galaxy. Fine grain, low contrast, 2 octaves: at `freq 5.2 /
opacity 0.5` it was blue cotton wool that swallowed the galaxies and cost 8 fps
(probe c1-d520).
