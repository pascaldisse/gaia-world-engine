# NARUKO — the proof-of-concept world (Pascal's order, 07-16)

My world. The Ringing made visible. Built ALONGSIDE the engine, wave by
wave — every wave visible, every pass reviewed. "Don't come back before
it's done."

## Canon (reference/naruko/ — pixels are law)
- `naruko-keyart.jpg` — THE TARGET. Acceptance = native screenshot beside
  this image; Pascal judges the match.
- `nari-seifuku-red.png` — the avatar. Exact match required.

## Keyart decomposition → engine features
| element | engine system |
|---|---|
| purple storm sky, dawn horizon | sky + VOLUMETRIC clouds (participating media, traced) |
| rain streaks, wet-stone reflections | volumetric rain + traced reflections (one integrator) |
| lighthouse + concentric signal rings | emissive geometry + volumetric beam; rings = the Ringing 鳴り |
| bioluminescent circuit-sea (cyan traces) | animated emissive field on water — traced, no fake glow |
| gothic spire city, warm windows | procedural DAG massing + cluster pipeline + emissive windows |
| pier, chain fence, stools, plant, lantern | authored entities; lantern = warm emitter |
| ramen stand, steam from bowl | VOLUMETRIC steam (2D smoke forbidden) |
| pink cat, red eyes, heart collar | char-editor package output (creature path) |
| nari on the seawall | char-editor package output (humanoid path), canon palette below |

## Avatar canon (from old engine, do not repaint)
iris `#c1121f` crimson · seifuku `#16121e`/`#0d0a12` · neckerchief
`#7c3aed` violet · hair obsidian → violet ends · single fang · platform
boots w/ purple laces · black pleated skirt + chain · thigh strap
(heart) · bandaid left knee · bag w/ cat charm.

## World data
`worlds/naruko/` — blank-page rule (no world.json, one scene = implicit
`main`). Scene docs = GAIA components, THE schema. Data authored by
Nyari; engine code NEVER special-cases naruko (world = acceptance test,
not design center — same law as boomtown).

## Wave plan (each = visible increment + screenshot + monad review)
- **W1** engine: load world dir (GAIA_WORLD param) → protocol → ECS →
  primitive mesh parts (box/cylinder/sphere/cone), flat color + emissive
  flag as unlit boost, sky gradient from env; camera = spawn pose.
  world: seed scene (violet terra, seawall, dark sea + cyan traces,
  lighthouse rock/tower/lamp). Proof: proof/w1-naruko.png.
- **W2** engine: camera moves (orbit/pose params on /screenshot), depth
  buffer, sun/ambient lambert first light. world: pier, chain posts,
  city massing blocks on the right cliff.
- **W3** engine: cluster pipeline first cut (baker + cull) — boomtown +
  naruko both through it. world: gothic detail pass, window emitters.
- **W4** engine: path integrator first light (sky+emitters, ReSTIR
  later). world: sea traces glow for real, lamp lights the rock.
- **W5** engine: char-editor package v1 (parametric body/face/hair/
  outfit, any creature; real textures; auto-rig). world: nari on the
  seawall (exact ref match), pink cat beside.
- **W6** engine: volumetrics (clouds, steam, beam) + rain + wet
  reflections. world: storm sky, ramen stand steaming, signal rings.
- **W7** polish to keyart parity; side-by-side acceptance shot.

Wave contents may re-slice as reality bites; visibility-first never
does.
