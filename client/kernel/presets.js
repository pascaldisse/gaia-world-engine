import * as THREE from 'three/webgpu';
import {
  time,
  uv,
  vec2,
  vec3,
  color,
  sin,
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
  cameraPosition,
  normalWorld,
  mx_noise_float,
  mx_fractal_noise_float,
} from 'three/tsl';

// Shader presets as data: a mesh part says {preset: "water"} and gets a TSL
// node material. A failed preset falls back to a standard material — a bad
// shader must never take the world down.
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
        const vert = smoothstep(0.0, 0.3, uv().y).mul(smoothstep(1.0, 0.7, uv().y));
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
        // zone, so a sunny world seen from inside a dark zone must physically
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
        const edge = smoothstep(1.0, 0.55, d);
        material.colorNode = mix(color(part.color ?? '#b7bfbc').mul(0.55), color(part.color ?? '#b7bfbc'), n);
        material.opacityNode = body.mul(edge).mul(part.opacity ?? 0.92);
        material.transparent = true;
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
        // hand-painted aerial haze (fog:false, so zone fog can't wash it out).
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
        // zone's darkness (albedo would multiply to black under a dark env)
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
