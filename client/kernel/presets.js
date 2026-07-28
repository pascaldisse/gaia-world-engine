import * as THREE from 'three/webgpu';
import {
  time,
  uv,
  vec2,
  vec3,
  color,
  sin,
  cos,
  atan,
  log,
  pow,
  float,
  max,
  saturate,
  length,
  smoothstep,
  mix,
  exp,
  dot,
  cross,
  normalize,
  floor,
  fract,
  min,
  dFdx,
  dFdy,
  positionWorld,
  positionLocal,
  positionView,
  modelPosition,
  billboarding,
  cameraWorldMatrix,
  cameraPosition,
  normalWorld,
  normalView,
  mx_noise_float,
  mx_fractal_noise_float,
} from 'three/tsl';

// Shader presets as data: a mesh part says {preset: "water"} and gets a TSL
// node material. A failed preset falls back to a standard material — a bad
// shader must never take the world down.

// the presets that ARE the sky: sheets the editor's skybox toggle hides
// (the abyss/stone backdrops are scenery, not sky — they stay)
export const SKY_PRESETS = new Set(['sky', 'overcast', 'clouds']);

export function makePresetMaterial(part) {
  try {
    switch (part.preset) {
      case 'glow': {
        const material = new THREE.MeshBasicNodeMaterial();
        const d = length(uv().sub(0.5)).mul(2);
        let g = exp(d.mul(d).mul(-4.2));
        if (part.flicker) {
          // candle-wander, dephased by world position: a field of glows
          // (fake light pools, halos) never pulses in lockstep. Two
          // incommensurate sines read as fire, not as a metronome.
          const sp = part.speed ?? 7;
          const phase = positionWorld.x.mul(7.13).add(positionWorld.z.mul(3.71));
          const wave = sin(time.mul(sp).add(phase)).mul(0.6).add(sin(time.mul(sp * 2.63).add(phase.mul(1.7))).mul(0.4));
          g = g.mul(wave.mul(part.flicker * 0.5).add(1));
        }
        material.colorNode = color(part.color ?? '#ffc46b').mul(g).mul(part.glowStrength ?? 1);
        material.opacityNode = g;
        material.transparent = true;
        material.blending = THREE.AdditiveBlending;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        return material;
      }
      case 'flame': {
        const material = new THREE.MeshBasicNodeMaterial();
        const p = uv().sub(vec2(0.5, 0.32));
        const t = time.mul(part.speed ?? 9);
        const px = p.x.add(sin(t.add(uv().y.mul(9))).mul(0.06).mul(uv().y));
        const body = length(vec2(px.mul(2.6), p.y.mul(1.35)));
        const flame = smoothstep(0.05, 0.42, body).oneMinus();
        const core = smoothstep(0.02, 0.16, length(vec2(px.mul(3.4), p.y.add(0.05).mul(1.8)))).oneMinus();
        const flick = sin(t.mul(1.7)).mul(0.22).add(0.78);
        const col = mix(color(part.color ?? '#e64010'), color(part.tip ?? '#ffc04d'), flame)
          .mul(flame)
          .add(color('#fff2cc').mul(core));
        material.colorNode = col.mul(flick).mul(2.2);
        material.opacityNode = flame.mul(flick);
        material.transparent = true;
        material.blending = THREE.AdditiveBlending;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        return material;
      }
      case 'beam': {
        // fake-volumetric light shaft: brightest through its core, soft at
        // the silhouette and both ends; additive, never writes depth.
        // Fades out near the camera so standing (or falling) INSIDE one is a
        // faint halo, not a wall of fog. Use on open-ended cylinders ({open: true}).
        const material = new THREE.MeshBasicNodeMaterial();
        const core = dot(normalize(cameraPosition.sub(positionWorld)), normalWorld).abs();
        // .oneMinus() rather than smoothstep(1.0, 0.7, ...): an inverted edge
        // pair is a WGSL VALIDATION ERROR on this Dawn ("low not less than
        // high") and takes the whole pipeline down silently — found while
        // debugging the nebula, which failed the same way.
        const vert = smoothstep(0.0, 0.3, uv().y).mul(smoothstep(0.7, 1.0, uv().y).oneMinus());
        const near = smoothstep(2.0, 18.0, length(positionWorld.sub(cameraPosition)));
        // beams are ground-level dressing: seen from high above (the Fall),
        // their walls fill the whole frame from any view angle — isolated by
        // hiding them, the mid-fall grey wash was ONLY these meshes. Fade by
        // CAMERA HEIGHT, which no pitch or yaw can defeat: full below
        // fadeAbove (m), gone by ~2.4x it. Authors override per part.
        const fadeStart = part.fadeAbove ?? 25;
        const high = smoothstep(fadeStart, fadeStart * 2.4, cameraPosition.y).oneMinus();
        const g = core.mul(core).mul(vert).mul(near).mul(high).mul(part.beamStrength ?? 0.5);
        material.colorNode = color(part.color ?? '#9db8d9').mul(g);
        material.opacityNode = g;
        material.transparent = true;
        material.blending = THREE.AdditiveBlending;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        return material;
      }
      case 'sky': {
        // the bright outside as geometry: scene.background is ONE color per
        // scene, so a sunny world seen from inside a dark scene must physically
        // exist. A vertical gradient wall — warm glow at the horizon, cooler
        // tone up high, faint drifting banding so it never reads as a card.
        const material = new THREE.MeshBasicNodeMaterial();
        const k = uv().y;
        const bands = mx_fractal_noise_float(vec3(uv().x.mul(7), k.mul(2.6), time.mul(0.008)), 3)
          .mul(part.bands ?? 0.1);
        const grad = mix(color(part.horizon ?? '#e9e2cd'), color(part.color ?? '#9fb3ba'), smoothstep(0.03, 0.55, k));
        material.colorNode = grad.mul(bands.add(1)).mul(part.glowStrength ?? 1);
        material.fog = false; // it IS the sky; fog would erase it
        material.side = THREE.DoubleSide;
        return material;
      }
      case 'overcast': {
        // the storm roof: heavy cloud cover crawling overhead, brightest
        // where the hidden sun burns through (part.sunPos, world xz). Bright
        // enough that a dark interior's bloom blows out at any opening.
        const material = new THREE.MeshBasicNodeMaterial();
        const p = positionWorld.xz.mul(part.noiseScale ?? 0.0012);
        const n = mx_fractal_noise_float(vec3(p.x, p.y, time.mul(0.01)), 4, 2, 0.55).mul(0.5).add(0.5);
        const base = mix(color(part.color ?? '#67727a'), color(part.bright ?? '#d8ded6'), n);
        const [sx, sz] = part.sunPos ?? [0, 0];
        const sd = length(positionWorld.xz.sub(vec2(sx, sz)));
        const r = part.sunRadius ?? 420;
        const sun = exp(sd.mul(sd).mul(-1 / (r * r)));
        material.colorNode = base.add(color(part.sunColor ?? '#fff1d2').mul(sun).mul(part.sunGlow ?? 1.5));
        material.fog = false;
        material.side = THREE.DoubleSide;
        return material;
      }
      case 'clouds': {
        // a torn cloud sheet: fbm alpha dissolved at the quad's own edges so
        // the rectangle never shows. NORMAL blending, not additive — clouds
        // must occlude what lies beneath them (the abyss), not brighten it.
        const material = new THREE.MeshBasicNodeMaterial();
        const p = positionWorld.xz.mul(part.noiseScale ?? 0.008);
        const drift = time.mul(part.speed ?? 0.03);
        const n = mx_fractal_noise_float(vec3(p.x.add(drift), p.y, time.mul(0.012)), 4, 2, 0.55).mul(0.5).add(0.5);
        const cover = part.cover ?? 0.5;
        const body = smoothstep(1 - cover, Math.min(1, 1 - cover + 0.38), n);
        const d = length(uv().sub(0.5)).mul(2);
        const edge = smoothstep(0.55, 1.0, d).oneMinus(); // inverted edges = WGSL error, see 'beam'
        material.colorNode = mix(color(part.color ?? '#b7bfbc').mul(0.55), color(part.color ?? '#b7bfbc'), n);
        material.opacityNode = body.mul(edge).mul(part.opacity ?? 0.92);
        material.transparent = true;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        material.fog = false;
        return material;
      }
      case 'nebula': {
        // ── THE PROCEDURAL GALAXY ───────────────────────────────────────────
        // §IRON NEBULA. Every number is a named part field with a default here
        // and a measurement comment. world-build declares only WHICH galaxy
        // this is (size, palette, seed, disc angles); the structure is computed
        // per fragment and never baked.
        //
        // What this replaces (measured, proof/beauty/universe/before): 2400
        // sphere instances of ONE colour at opacity 0.19 per galaxy plus 633
        // such puff systems — uniform puffs at 633 draw calls. This is ONE
        // draw call and TWO triangles per layer.
        //
        // FORM: a spiral disc drawn in SCREEN space, textured by noise sampled
        // in WORLD space.
        //   · screen chart → the galaxy always presents its face, and an
        //     ellipse gives the tilted-disc read. Three earlier takes put the
        //     chart in a camera-plane world slice: seen from the side that
        //     slice cuts the disc EDGE-ON, so there were no arms at all and
        //     the plate read as marble. A painting, not a physics sim.
        //   · world noise → the detail belongs to the world, so orbiting the
        //     galaxy changes what you see instead of dragging a filter with
        //     the camera.
        //
        // TWO MODES on one field, so the dark strands land on the bright
        // cloud's own filaments instead of crossing it like a decal:
        //   glow  — additive emission: the cloud.
        //   lanes — NORMAL-blended near-black on an outer quad (renderOrder
        //           above the glow) so a lane OCCLUDES what is behind it. A
        //           carved additive gap is a hole; occlusion is what makes it
        //           dust, and dust lanes are the one thing that sells Hubble.
        const lanesMode = part.mode === 'lanes';
        const material = new THREE.MeshBasicNodeMaterial({ toneMapped: false });
        // `norm` (not `radius`/`size`): the shader needs the cloud's half-size,
        // but those are GEOMETRY cache fields — putting them in MATERIAL_FIELDS
        // would give every differently-sized sphere in the world its own
        // material. Only nebula parts carry `norm`.
        const norm = part.norm ?? part.radius ?? 1;
        const seed = part.seed ?? 0;
        // billboarding() returns a CLIP-space position, so it belongs on
        // vertexNode. On positionNode it fed clip coordinates into
        // positionWorld and every fragment sampled the same point — a
        // perfectly smooth radial haze with no filaments at all.
        material.vertexNode = billboarding({ horizontal: true, vertical: true });

        // ── the disc, in screen space ──────────────────────────────────────
        const cu = uv().sub(0.5).mul(2); // -1..1 across the quad
        // MENSIS: the disc is an ellipse at a WRONG angle, and `squash` is not
        // 1 — a round chart read as a jellyfish, a straight one as a logo.
        const rot = part.spin ?? 0.4;
        const e0 = vec2(
          cu.x.mul(Math.cos(rot)).sub(cu.y.mul(Math.sin(rot))),
          cu.x.mul(Math.sin(rot)).add(cu.y.mul(Math.cos(rot))),
        );
        const e = e0.div(vec2(1, part.squash ?? 0.52));
        const rs = length(e).add(0.03);
        // ── the world slice, for detail that belongs to the world ──────────
        const w = cameraWorldMatrix[0].xyz.mul(cu.x).add(cameraWorldMatrix[1].xyz.mul(cu.y));
        const n1 = mx_noise_float(w.mul(part.warpScale ?? 1.3).add(seed));
        // ARMS. A log-spiral shear of the angle, curled by one noise tap so the
        // arms are never two clean logarithmic strokes. `armCount` 2 is the
        // classic; the (1 + lopsided·cos) term makes ONE arm heavier than the
        // other — the asymmetry the Mensis note asks for.
        const th = atan(e.y, e.x).add(log(rs).mul(part.arms ?? 2.6)).add(n1.mul(part.warp ?? 0.55));
        const armC = part.armCount ?? 2;
        let armF = cos(th.mul(armC)).mul(0.5).add(0.5);
        armF = armF.mul(cos(th).mul(part.lopsided ?? 0.34).add(1));
        armF = pow(saturate(armF), part.armSharp ?? 1.7);
        // the arms never go fully dark: `armFloor` is the inter-arm haze that
        // keeps a galaxy from reading as a pinwheel decal.
        armF = armF.mul(1 - (part.armFloor ?? 0.3)).add(part.armFloor ?? 0.3);
        // radial mass: bright at the core, gone by the quad's rim (which MUST
        // reach zero or the frame shows a rectangle).
        const mass = exp(rs.mul(rs).mul(-(part.coreFall ?? 2.6)));
        const rim = pow(smoothstep(part.hole ?? 0.0, 1.0, length(cu)).oneMinus(), part.facing ?? 1.5);

        // ── the cloud field ───────────────────────────────────────────────
        // 4 octaves is the whole per-fragment budget for one fbm (bible §3);
        // at 6 the wide plate cost ~9 fps for detail no distance resolved.
        const oct = Math.max(1, Math.min(4, Math.round(part.octaves ?? (lanesMode ? 3 : 4))));
        const q = w.mul(part.freq ?? 2.2).add(seed);
        const field = mx_fractal_noise_float(q, oct, 2, part.rough ?? 0.55).mul(0.5).add(0.5);
        // A vacuum FLOOR separates cloud from haze: without it every fragment
        // carries some density and the whole thing reads as one soft ball.
        const floorK = part.floor ?? 0.3;
        let dens = max(field.sub(floorK), 0).mul(part.gain ?? 2.6).mul(armF).mul(mass);
        // DUST LANES: a ridged second field (|noise| inverted = sharp crest
        // lines) at a coarser scale and a different offset. Correlating them
        // with the cloud field itself is free but put every lane exactly on a
        // crest and read as banding, so the offset is not optional.
        const lOct = Math.max(1, Math.min(4, Math.round(part.laneOctaves ?? 2)));
        const ridge = mx_fractal_noise_float(w.mul(part.laneScale ?? 1.5).add(7.7 + seed), lOct, 2, 0.6).abs().oneMinus();
        const lane = smoothstep(part.lane ?? 0.66, (part.lane ?? 0.66) + (part.laneSoft ?? 0.2), ridge);
        // DEPTH GRADE, no extra noise: far away the same field is flattened
        // toward its mean (soft mass), near it keeps full contrast (structure).
        // Cross-fading ONE field is why there is no pop — two different fields
        // at two distances popped visibly on approach. dist is per-OBJECT
        // (constant across the draw), not a per-fragment length().
        const dist = length(modelPosition.sub(cameraPosition));
        const [far0, far1] = part.far ?? [900, 3400];
        const farK = smoothstep(far0, far1, dist);
        dens = mix(dens, mix(dens, float(part.farMean ?? 0.3), 0.7).mul(mass).mul(part.farGain ?? 1.5), farK);

        if (lanesMode) {
          // the occluder: dark only where a lane crosses cloud that HAS
          // density, so lanes never hang in empty sky as a black web.
          const a = lane.mul(saturate(dens.mul(part.laneOnly ?? 2.2))).mul(rim).mul(part.opacity ?? 0.8);
          material.colorNode = mix(color(part.color ?? '#080610'), color(part.warm ?? '#241206'), n1.mul(0.5).add(0.5));
          material.opacityNode = saturate(a);
          material.transparent = true;
          material.depthWrite = false;
          material.side = THREE.DoubleSide;
          material.fog = false;
          return material;
        }

        dens = dens.mul(lane.mul(part.laneCut ?? 0.85).oneMinus());
        // COLOUR DEPTH: never one hue. Core→rim is a temperature ramp and two
        // ACCENT bands ride the (already computed) low-frequency field, so each
        // cloud carries three temperatures. Uniform hue was the puff tell.
        const acc = n1.mul(0.5).add(0.5);
        let col = mix(color(part.color ?? '#a8c6ff'), color(part.edge ?? '#2b1c56'), smoothstep(0.05, 0.9, rs));
        col = mix(col, color(part.accent ?? '#ff6ad5'), smoothstep(0.58, 0.95, acc).mul(part.accentMix ?? 0.8));
        // NOT smoothstep(0.4, 0.05, acc): WGSL rejects an inverted edge pair
        // outright ("low not less than high") and that fails the WHOLE
        // pipeline silently — the cloud drew zero pixels and only Dawn's log
        // said why. Invert the RESULT instead.
        col = mix(col, color(part.accent2 ?? '#7fe6d2'), smoothstep(0.05, 0.42, acc).oneMinus().mul(part.accent2Mix ?? 0.5));
        const a = saturate(dens).mul(rim).mul(part.opacity ?? 0.7);
        // colorNode is NOT pre-multiplied by alpha: THREE.AdditiveBlending
        // already scales the source by srcAlpha, so doing both squared it and
        // the cloud came out at ~1% strength — three "invisible nebula" plates
        // were this one line, not the noise.
        material.colorNode = col.mul(part.glowStrength ?? 1.7);
        material.opacityNode = a;
        material.transparent = true;
        material.blending = THREE.AdditiveBlending;
        material.depthWrite = false;
        material.side = THREE.DoubleSide;
        material.fog = false;
        return material;
      }
      case 'abyss': {
        // the Eternal Darkness given a surface: an obsidian ocean. Vertex-
        // displaced swell (give the plane `segments`), normals rebuilt FLAT
        // per facet from screen-space derivatives — conchoidal glass, not
        // smooth water. Dark but never black: fresnel sheen, crest tint, and
        // hand-painted aerial haze (fog:false, so scene fog can't wash it out).
        const material = new THREE.MeshStandardNodeMaterial({
          roughness: part.roughness ?? 0.22,
          metalness: part.metalness ?? 0.75,
        });
        const ws = part.waveScale ?? 0.04;
        const wh = (part.waveHeight ?? 3.2) * 0.35;
        const lp = positionLocal.xy;
        const swell = sin(lp.x.mul(ws).add(time.mul(0.42)))
          .add(sin(lp.y.mul(ws * 1.71).sub(time.mul(0.33))).mul(0.7))
          .add(mx_noise_float(vec3(lp.x.mul(ws * 2.9), lp.y.mul(ws * 2.9), time.mul(0.05))).mul(1.2));
        material.positionNode = positionLocal.add(vec3(0, 0, swell.mul(wh)));
        // view-space facets (normalNode is consumed as the view-space normal)
        material.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)));
        const viewDir = normalize(cameraPosition.sub(positionWorld));
        const fres = dot(viewDir, normalWorld).abs().oneMinus().pow(3.5);
        const crest = smoothstep(0.6, 2.4, swell);
        const sheen = color(part.glint ?? '#46557a').mul(fres.mul(0.55))
          .add(color(part.crest ?? '#222a3d').mul(crest.mul(0.6)));
        // aerial haze is EMISSIVE, not albedo — painted light survives any
        // scene's darkness (albedo would multiply to black under a dark env)
        const hazeK = smoothstep(550, 1900, length(positionWorld.sub(cameraPosition)));
        material.colorNode = color(part.color ?? '#0b0d14');
        material.emissiveNode = sheen.mul(hazeK.oneMinus()).add(color(part.haze ?? '#8d9ba1').mul(hazeK));
        return material;
      }
      case 'stone': {
        // masonry without textures: world-space ashlar courses, a running
        // bond, per-block value shifts, fbm grain on color and roughness.
        // The pattern lives in WORLD coordinates so every part of a bridge
        // shares the same mortar lines across separate boxes.
        const material = new THREE.MeshStandardNodeMaterial({
          roughness: part.roughness ?? 0.92,
          metalness: 0,
        });
        const [bw, bh] = part.blockSize ?? [3.0, 1.2];
        const wp = positionWorld;
        // tops use (x, z); faces use (x+z, y) — blended by the normal
        const horiz = smoothstep(0.55, 0.85, normalWorld.y.abs());
        const u = mix(wp.x.add(wp.z), wp.x, horiz).div(bw);
        const v = mix(wp.y, wp.z, horiz).div(bh);
        const row = floor(v);
        const uu = u.add(row.mul(0.5)); // running bond: each course shifts half a block
        const col = floor(uu);
        const fu = fract(uu);
        const fv = fract(v);
        const seam = min(min(fu, fu.oneMinus()).mul(bw), min(fv, fv.oneMinus()).mul(bh));
        const mortar = smoothstep(0.018, 0.1, seam).oneMinus().mul(part.grout ?? 0.45);
        const tint = mx_noise_float(vec3(col.mul(7.31).add(0.37), row.mul(3.17).add(0.71), 1.5)).mul(0.16);
        const grain = mx_fractal_noise_float(wp.mul(2.1), 3).mul(part.grain ?? 0.16);
        material.colorNode = color(part.color ?? '#8d8779')
          .mul(tint.add(1))
          .mul(grain.add(1))
          .mul(mortar.oneMinus());
        material.roughnessNode = grain.mul(0.3).add(part.roughness ?? 0.92);
        return material;
      }
      case 'water': {
        const material = new THREE.MeshStandardNodeMaterial({
          roughness: 0.15,
          metalness: 0.6,
          transparent: true,
          opacity: part.opacity ?? 0.95,
        });
        const wp = positionWorld;
        const band = sin(wp.x.mul(0.18).add(time.mul(0.5))).mul(sin(wp.z.mul(0.22).sub(time.mul(0.4))));
        // sparkle: roaming glint patches; 0 = still black water
        const sparkle = smoothstep(0.86, 1.0, band).mul(part.sparkle ?? 0.6);
        const viewDir = normalize(cameraPosition.sub(wp));
        const fresnel = dot(viewDir, normalWorld).abs().oneMinus().pow(3);
        material.colorNode = mix(color(part.color ?? '#0a1420'), color(part.sky ?? '#27405e'), fresnel.mul(0.8));
        material.emissiveNode = color(part.glint ?? '#9db8d9')
          .mul(sparkle)
          .add(color(part.sky ?? '#27405e').mul(fresnel.mul(0.25)));
        return material;
      }
      case 'hologram': {
        const material = new THREE.MeshBasicNodeMaterial({
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const scan = sin(positionWorld.y.mul(part.lines ?? 30).sub(time.mul(part.speed ?? 3))).mul(0.5).add(0.5);
        material.colorNode = color(part.color ?? '#7df9ff').mul(scan.mul(0.7).add(0.3)).mul(1.6);
        material.opacityNode = scan.mul(0.45).add(part.opacity ?? 0.25);
        return material;
      }
      default:
        return null;
    }
  } catch (err) {
    console.warn(`[gaia] preset "${part.preset}" failed, using standard material:`, err);
    return null;
  }
}
