import * as THREE from 'three/webgpu';
import {
  time,
  uv,
  vec2,
  color,
  sin,
  length,
  smoothstep,
  mix,
  exp,
  dot,
  normalize,
  positionWorld,
  cameraPosition,
  normalWorld,
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
