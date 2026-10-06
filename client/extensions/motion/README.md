# motion — GAIA-World-Engine real-time active-ragdoll extension
Real-time active ragdoll (Euphoria-style controllers) on Rapier. Plain ESM, no deps; Rapier `@dimforge/rapier3d-compat` 0.21.0 INJECTED by the game (`createMotion({rapier})`). Games import `/extensions/motion/index.js` (like rayfire/gore). NOT gaia-motion (= separate offline Houdini/Endorphin-style tool); history imported from its mis-homed `runtime-web-1` `web/`.

## Contract (frozen — EE consumes it)
- `createMotion({rapier, world?, gravity?, dt?=1/60, maxActive?=16, …cfg})` → `motion`
- `humanoidRig({bounds, up, forward, scale})` → `{bodies[], joints[]}` (11 bodies; any rig w/ `{name,parent,center,halfExtents,mass}` + joints works, roles by name heuristic / `rig.roles`)
- `motion.spawn(rig, {position, quaternion, velocity?, behaviour, impulse?:{body|'all', dir, magnitude N·s}, seed, params?})` → `h`
- `motion.step(dt)` — fixed-step accumulator (`dt` cfg, `substeps`, `maxStepsPerCall`)
- `h.transforms()` → `Map(name → {p:[x,y,z], q:[x,y,z,w]})` world space
- `h.breakJoint(name)` → `{body, velocity}` | `null` if already broken
- `h.setBehaviour(name, params?)` · `h.asleep` · `h.phase` · `h.state()` · `h.dispose()`
- `motion.diagnostics()` → `{handles, active, passive, asleep, bodies, avgStepMs, maxStepMs…}` · `motion.dispose()`
- extras: `syncThree(h, {name→Object3D})` (duck-typed, no three import) · `BEHAVIOURS` · `DEFAULTS`

## createMotion cfg (all defaulted, motion.js)
`substeps 2 · maxStepsPerCall 4 · stepWorld true` (false → caller steps world at dt/substeps) `· solverIterations null · lodRadius ∞ · friction .9 · linearDamping .05 · angularDamping .4 · motorModel 'force' · groundRay 4 · sleepFreeze true · params → DEFAULTS override`

## Behaviours (behaviours.js `BEHAVIOURS`)
| name | does | reads Euphoria-like? (my read of numbers, NOT filmed) |
|---|---|---|
| balance | CoP-capped support torque + hip lean vs capture-point error + reactive steps | yes idle (pelvis Δ 2 mm / 5 s) |
| stagger | balance w/ weaker support + eager steps for staggerMs | PARTIAL — recovers 15/20/30/40/100 N·s, **falls at 25 & 60** (non-monotone) |
| catchFall | arms reach along fall dir, legs soft, head up | yes — hands down 0.62 s, head 1.00 s |
| protectHead | forearms over head, chin tuck, spine curl | yes-ish — forearm–head 0.245 m vs limp 0.644 |
| death / bodyWrithe | writhe → motors decay to limp over decayMs, knees buckle | 11-body: yes (rests 2.52 s). EE 6-body: **2/4 seeds propped** (sit / jack-knife) |
| shot | local impulse + flinch → stagger, or death if `lethal` | path correct; flinch pose unfilmed |
| limp | passive: limits + limpDamping | baseline |

LOD: over `maxActive` → oldest go passive limp. Asleep → bodies frozen (`sleepFreeze`).

## Params (behaviours.js `DEFAULTS`, override per createMotion or per spawn)
- effectors: `stiffness 16 · damping 1 · torqueRatio 3 · roleStrength{spine,neck,shoulder,elbow,hip,knee,ankle}` — k = stiffness·G_j (G_j = gravity load at joint) → rig-size independent
- support: `support 1 · supportK 60 · supportD 14 · footHalfLength .08H` — virtual CoP torque on pelvis, capped by support polygon
- stepping: `stepThreshold · stepWidth · stepGain 1.15 · maxStep .5H · stepMs 260 · stepHeight · stepCooldownMs · swingStiffness · retargetFrac · fallTilt .6 · fallHeightFrac .65 · fallConfirmMs · fallCpOut`
- reactions: `reactionDelayMs 80 ± reactionJitterMs 40 (seeded) · armBlendMs · catch* · protect* · fallLeg* · headUp`
- down/death: `downHeightFrac · settleSpeed · settleMs · downStrength · downDecayMs · deathStrength .8 · decayMs 1600 · decayPow · writhe* · buckle* · crumple*`
- shot/stagger: `flinchMs · flinchSpine · flinchReach · lethal · staggerMs 1500 · staggerSupport .8 · staggerStepScale .8`

## PLACEHOLDER / heuristic (not measured)
- rig proportions = fractions of H (rig.js, PLACEHOLDER anthropometry); masses total 70 kg
- every gain in DEFAULTS = hand-tuned on this rig, no mocap / no human-data fit
- role resolution = name heuristic → wrong names = wrong controllers silently
- capture-point stepping = linear inverted pendulum approx; swing-foot overshoots target (25 N·s trace: target z .14 → lands .58) → the 25/60 holes

## Measured (web/test, `node --test test/*.test.mjs`, 14/14, commit d0dbd3f)
- 16 ragdolls × 11 bodies, 2 substeps: **CPU 3.6–4.6 ms/step** (process.cpuUsage; wall 8–114 ms avg under loadavg 57–69 → wall NOT a budget number)
- determinism: same seed+inputs → bit-identical transforms (same process, same Rapier build)
- breakJoint('neck') + 2 N·s → head–torso 2.43 m after 1.5 s

## Known defects
1. stagger band non-monotone (25, 60 N·s fall; seeds don't change outcome) — stepping controller
2. kneeless rigs (EE) corpse can rest propped: torso .45–.51 m, seed 3 not asleep by 6 s

## Tests
`GAIA_RAPIER_FROM=<game dir w/ node_modules/@dimforge/rapier3d-compat> node --test test/motion.test.js` — missing Rapier = throw, never skip.
