# BEAUTY LANE · EYES — what the plates prove

Target (Pascal, verbatim): *"why are the eyes just fucking sprites and not a
texture on an eyeball?"* — and the film's thesis, *grant us eyes*.

Layer: `client/plugins/atlas-eyes.js` (the organ) · wiring: `atlas-forge.js`
(attachment point) + `atlas-director.js` (one line in `frame()`).
Rig: `tools/eyes-stack.sh` · `tools/eyes-browser.sh` (headless, `--mute-audio`)
· `tools/eyes-cdp.mjs` · `tools/eyes-verdict.mjs`.

## the arc, in plates
| plate | what it shows |
|---|---|
| `02-hero.png` | a white marble — `positionLocal` is NOT local under instancing (`InstanceNode` assigns the instance-transformed position into it), so every fragment sampled one texel of sclera |
| `04-iris-texture.png` | the iris canvas, honestly: fibres/crypts/limbal ring good — vessels were ZIGZAG POLYLINES |
| `05-hero-graded.png` | an eye in a CAPSULE: `|y| < open` is a circle of latitude, which projects to a straight edge |
| `07-hero-almond.png` | the almond aperture — the first plate that is an eye |
| `08-ab-cornea-off/on.png` | the wet pass, A/B in one run: the cornea is what makes it too-wet |
| `09-crop.png` | pupil blown at every close-up (proximity ramp topped out at 0.16 rad), crypts a cog wheel |
| `10-lid-sweep.png` | **the OPEN** as a strip: 0.14 · 0.42 · 0.64 · 0.90 |
| `11-open-on-the-word.png` | **the watchers OPEN on 'stirred' (181.34)** — 181.20 shut · 181.50 slits · 181.70 cascade · 182.60 staring |
| `12-law2-a/b.png` | law 2: two seeks to 191.8 from opposite directions |
| `13-rolling-watchers.png` | the wreath outstaying its scene → window cut back to 192.5 |
| `15-forge-pagerank-eye.png`, `15-crop.png` | **a pagerank eye ON a body**: globe, iris, pupil, lid lit by the flesh's own colour |

## verdicts (one run, `tools/eyes-verdict.mjs`)
- **draw calls: 2** for every eye in the world (`eyeDrawObjects: 2` of 123 visible
  draw objects), `strayEyeMeshes: 0`, `forgeEyeMeshes: 0` — the disc is gone.
  One `instanceMatrix` buffer and one `aEye` attribute buffer, shared by both
  passes (`sharesOneMatrixBuffer: true`, `sharesOneAttrBuffer: true`).
- **fps, film rolling through the watchers**: 119.8 eyes drawn · 120.0 eyes
  hidden (45 eyes) → the layer costs ~0.2 fps. 1584 tris per eye (globe 1120 +
  cornea 464), bible budget ≤2.5k.
- **law 2 (analytic)**: eye state at t=191.8 IDENTICAL across seeks from 187.9
  and from 120.0 — 40 eyes, open/iris/radius/position to 5 decimals.
  NOT judged on pixels: the atlas camera lerps to its goal, so two seeks are
  photographed from slightly different places whatever this layer does.
- **the film leaves cleanly**: after `stop()`, `filmT: null`,
  `filmEyesLeft: 0`, and the world's own eyes are still saccading.

## defects that cannot fail a check
`renderer.info.render.calls` reported exactly 15/frame whether the eye group was
visible or hidden and whether 0 or 45 eyes were drawn — it cannot answer the
draw-call question here, so the gate is answered structurally (scene walk) and
in time (fps A/B) instead.
