# motion-rt proof (R3) — real gaia-motion rt server → GWE motion world
stack: gaia-motion `rt/server` (`python -m gaia_motion.cli rt --port 8979 --hz 60`) ↔ `client/kernel/motion-rt.js` ↔ world `worlds/motion-rt`; url `http://localhost:5262/?level=stage&mute=1&motion=1`; driver = CDP (Brave headless=new, real Input.dispatchKeyEvent keys).

## contract table
| field | server (`gaia_motion/rt.py` `_render`) | client (before) | fix |
|---|---|---|---|
| `bodies[i].pos` | `d.xpos[1:25]` = body ORIGIN (joint), m, 4 dp — NOT COM (`xipos`) | assumed origin | none ✓ |
| `bodies[i].quat` | `quat_wxyz_to_xyzw(d.xquat)` → xyzw | xyzw (`?motionQuat=wxyz` flips) | none ✓ |
| up axis | MuJoCo world Z-up (pelvis z≈0.93 standing) | assumed Y-up identity → figure lay flat/off-floor | `group.rotation.x = -π/2` (pos+quat convert together); `?motionUp=y` = old identity (mock) |
| frame | `{t,bodies[24],phase}` | `{t,phase?,bodies}` | none ✓ |
| phase | `idle` \| `bodyBalance` \| RDR name (`catchFall`…) | HUD prints string | none ✓ |
| cmds | `{cmd:impulse,body,ns,axis}` `{cmd:behaviour,name}` `{cmd:reset}` `{cmd:stats}` | same shapes, keys I/R/1-5 | none ✓ |
| impulse axis | world Z-up axes | KeyI sends `[1,0,0]` (+x = three +x, unchanged by Z→Y rotation) | none ✓ |

## body names (identical sets, 24)
server `BODY_NAMES` = client `CHILD`/`RADIUS` keys: Pelvis L_Hip L_Knee L_Ankle L_Toe R_Hip R_Knee R_Ankle R_Toe Torso Spine Chest Neck Head L_Thorax L_Shoulder L_Elbow L_Wrist L_Hand R_Thorax R_Shoulder R_Elbow R_Wrist R_Hand → HUD `24 bodies`.

## runs
- HUD: `live · 59.5–60.4 Hz` (client-measured, 1 s window); server stats `hz_window` 59.99–60.07, target 60, resyncs 0.
- sequence: R (reset) → rt-01 → `2` catchFall → `I` impulse Pelvis 300 Ns +x → rt-02 (+0.3 s) → rt-03 (+1 s) → rt-04 (+3.5 s) → `R` → rt-05.

| shot | server t | phase | pelvis xyz (m) | read |
|---|---|---|---|---|
| `proof/rt-01-stand.png` | 2.62 | idle (behaviour=catchFall, no trigger) | -0.085, 0.011, 0.929 | upright capsule figure, arms raised (policy stand pose), feet on floor |
| `proof/rt-02-fall-0.3s.png` | 3.35 | catchFall | 1.234, 0.047, 0.767 | torso pitched forward, left arm reaching out, knees buckling |
| `proof/rt-03-fall-1s.png` | 4.17 | catchFall | 2.981, 0.264, 0.185 | on the ground, supine/sprawled |
| `proof/rt-04-ground.png` | 6.78 | catchFall | 2.938, 0.220, **0.118** | settled on floor, arm propped |
| `proof/rt-05-reset.png` | 1.65 | idle | -0.122, -0.037, 0.948 | upright again |

Note: server `stats` carries no pelvis; z read from the live frame (`bodies[0].pos[2]`) at the same instant as stats (`sim_t` 6.783).

## lights (E)
`scenes/main.json`: key point 45, fill point 20, sky 1.1 (R2 lowered values). rt-01: floor + figure readable, grey/white parts not clipped, no blow-out.

## notes
- mid-fall, floor looks plain because the world has no collider visual for the server's ground; the server floor is z=0 → three y=0 ✓ matches `mr_floor`.
- `gaia-motion` push to `gaia` remote: HTTP 500 ×3 (10 s apart) — see report.
