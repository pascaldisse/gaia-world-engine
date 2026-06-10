// The component vocabulary as data: what each component means, what its
// fields do, sane ranges and enums. One source of truth — the inspector
// builds its UI from it, the server serves it (`GET /schema`), agents read
// it instead of guessing. Field entries are keyed by LEAF name within their
// component (nested objects and array items share the component's table).

export const SCHEMA = {
  transform: {
    doc: 'where the entity sits in world space',
    default: { position: [0, 0, 0] },
    fields: {
      position: { doc: 'world [x, y, z] (meters)', range: [-400, 400] },
      rotation: { doc: 'euler radians [rx, ry, rz]', range: [-3.1416, 3.1416] },
      scale: { doc: 'uniform number or [x, y, z]', range: [0.05, 8] },
    },
  },
  ground: {
    doc: 'snap y to the terrain (re-snaps when terrain changes)',
    default: { offset: 0 },
    fields: {
      offset: { doc: 'meters above (or below) the ground', range: [-10, 10] },
    },
  },
  mesh: {
    doc: 'visible body: one or more shape parts',
    default: { parts: [{ shape: 'box', size: [1, 1, 1], color: '#9aa0a6' }] },
    fields: {
      shape: { doc: 'primitive', enum: ['box', 'sphere', 'cylinder', 'cone', 'torus', 'octahedron', 'icosahedron', 'plane'] },
      preset: { doc: 'shader instead of a plain material', enum: ['glow', 'flame', 'water', 'hologram', 'beam'] },
      size: { doc: 'box [x,y,z] / plane [w,h]', range: [0.05, 500] },
      radius: { doc: 'sphere/cone/torus radius', range: [0.05, 50] },
      radiusTop: { doc: 'cylinder top radius (0 = point)', range: [0, 50] },
      radiusBottom: { doc: 'cylinder bottom radius', range: [0, 50] },
      height: { doc: 'cylinder/cone height', range: [0.05, 300] },
      tube: { doc: 'torus tube thickness', range: [0.05, 4] },
      open: { doc: 'cylinder without caps (beams)' },
      color: { doc: 'base color' },
      emissive: { doc: 'self-lit color' },
      emissiveIntensity: { doc: 'how hard the emissive burns', range: [0, 6] },
      roughness: { doc: '0 mirror — 1 chalk', range: [0, 1] },
      metalness: { doc: '0 plastic — 1 metal', range: [0, 1] },
      opacity: { doc: 'NOTE: < 0.15 is invisible in dark scenes', range: [0, 1] },
      visible: { doc: 'false: collides but never renders' },
      solid: { doc: 'false: renders but never collides' },
      castShadow: { doc: 'shadows cost; turn off for clutter' },
      flatShading: { doc: 'faceted look (rocks, low-poly)' },
      glowStrength: { doc: 'glow preset brightness', range: [0, 4] },
      beamStrength: { doc: 'beam preset brightness', range: [0, 2] },
      sparkle: { doc: 'water preset: roaming glints (0 = still black)', range: [0, 1] },
      glint: { doc: 'water preset: sparkle color' },
      sky: { doc: 'water preset: fresnel reflection color' },
      tip: { doc: 'flame preset: tip color' },
      lines: { doc: 'hologram scanline count', range: [2, 120] },
    },
  },
  light: {
    doc: 'a real light — lights are the perf budget, not meshes',
    default: { type: 'point', color: '#ffffff', intensity: 20, distance: 30 },
    fields: {
      type: { doc: 'kind of light', enum: ['point', 'spot', 'directional'] },
      color: { doc: 'light color' },
      intensity: { doc: 'brightness', range: [0, 120] },
      distance: { doc: 'falloff range in meters (0 = infinite)', range: [0, 120] },
      offset: { doc: 'entity-local [x, y, z] of the bulb', range: [-10, 10] },
      angle: { doc: 'spot cone half-angle (radians)', range: [0, 1.57] },
      castShadow: { doc: 'expensive — a few per zone at most' },
    },
  },
  sound: {
    doc: 'procedural synth patch or sample file, positional or ambient',
    default: { kind: 'hum', freq: 110, level: 0.2 },
    fields: {
      kind: { doc: 'what makes the sound', enum: ['hum', 'chime', 'patch', 'sample'] },
      ambient: { doc: 'true: everywhere (zone-faded); false: positional' },
      level: { doc: 'volume', range: [0, 1] },
      refDistance: { doc: 'meters at full volume before falloff', range: [1, 60] },
      freq: { doc: 'hum pitch (Hz)', range: [20, 1200] },
      wave: { doc: 'oscillator shape', enum: ['sine', 'square', 'sawtooth', 'triangle'] },
      notes: { doc: 'chime frequencies (Hz), rung in order' },
      interval: { doc: 'seconds between chime notes', range: [0.1, 10] },
      source: { doc: 'patch layer source', enum: ['noise', 'sine', 'square', 'sawtooth', 'triangle'] },
      gain: { doc: 'layer volume', range: [0, 1] },
      detune: { doc: 'cents off pitch', range: [-100, 100] },
      Q: { doc: 'filter resonance', range: [0.1, 20] },
      target: { doc: 'what the LFO wobbles', enum: ['gain', 'freq', 'filter'] },
      rate: { doc: 'LFO speed (Hz)', range: [0, 20] },
      depth: { doc: 'LFO amount', range: [0, 1] },
      reverb: { doc: 'send to the world reverb', range: [0, 1] },
      url: { doc: 'sample path under world/assets/' },
      loop: { doc: 'sample loops' },
    },
  },
  sfx: {
    doc: 'one-shot synth fired by a world event, positional at this entity',
    default: { on: 'lightning', wave: 'noise', freq: 200, decay: 1, level: 0.4 },
    fields: {
      on: { doc: 'event name that triggers it (any journaled event works)', enum: ['lightning', 'grab', 'drop', 'say', 'intent', 'splash', 'drown', 'void', 'title', 'reset'] },
      wave: { doc: 'source', enum: ['sine', 'square', 'sawtooth', 'triangle', 'noise'] },
      freq: { doc: 'start pitch (Hz)', range: [20, 4000] },
      freqEnd: { doc: 'pitch it sweeps to', range: [20, 4000] },
      attack: { doc: 'seconds to full volume', range: [0, 1] },
      decay: { doc: 'seconds to silence', range: [0, 6] },
      level: { doc: 'volume', range: [0, 1] },
      lowpass: { doc: 'filter cutoff (Hz)', range: [40, 8000] },
      sweep: { doc: 'filter sweep target (Hz)', range: [20, 4000] },
      reverb: { doc: 'send to the world reverb', range: [0, 1] },
    },
  },
  behavior: {
    doc: 'deterministic motion on the world clock — every client agrees',
    default: { type: 'spin', speed: 1 },
    fields: {
      type: { doc: 'motion kind', enum: ['spin', 'bob', 'orbit', 'path', 'pulse', 'flicker'] },
      speed: { doc: 'rate (path: meters/second)', range: [-8, 8] },
      amplitude: { doc: 'bob height (meters)', range: [0, 20] },
      phase: { doc: 'offset along the cycle', range: [0, 6.283] },
      center: { doc: 'orbit center [x, y, z]', range: [-400, 400] },
      radius: { doc: 'orbit radius (meters)', range: [0.5, 100] },
      height: { doc: 'meters above center/ground', range: [-10, 60] },
      points: { doc: 'path waypoints [[x,y,z], …] walked at constant speed' },
      start: { doc: 'world time the path starts ($now in trigger ops)' },
      loop: { doc: 'path: return to start vs park at the end' },
      amount: { doc: 'pulse/flicker strength', range: [0, 1] },
    },
  },
  terrain: {
    doc: 'procedural ground; one per zone, registered for heightAt',
    default: { seed: 7, size: 220, segments: 96, amplitude: 6, frequency: 0.02, color: '#2c4a33' },
    fields: {
      seed: { doc: 'same seed = same hills everywhere', range: [1, 99] },
      size: { doc: 'square edge length (meters)', range: [40, 2000] },
      segments: { doc: 'mesh resolution', range: [16, 256] },
      amplitude: { doc: 'hill height (meters)', range: [0, 60] },
      frequency: { doc: 'hill density (lower = wider hills)', range: [0.001, 0.08] },
      color: { doc: 'ground color' },
    },
  },
  collider: {
    doc: 'analytic boxes: walkable tops (decks, bridges) or blocker walls',
    default: { boxes: [{ size: [2, 0.2, 2], position: [0, 0, 0] }] },
    fields: {
      size: { doc: 'box [x, y, z] (entity-local)', range: [0.05, 60] },
      position: { doc: 'box center (entity-local)', range: [-30, 30] },
      blocker: { doc: 'true: pushes bodies out (wall); false: stand on top' },
    },
  },
  water: {
    doc: 'swimmable volume; with drownAfter the water is a death',
    default: { level: 0, area: { center: [0, 0], size: [100, 100] }, drownAfter: 20 },
    fields: {
      level: { doc: 'world y of the surface' },
      center: { doc: 'area center [x, z]', range: [-400, 400] },
      size: { doc: 'area extent [x, z]', range: [1, 1000] },
      radius: { doc: 'circular area radius', range: [1, 500] },
      drownAfter: { doc: 'seconds of swimming before sinking', range: [1, 120] },
    },
  },
  trigger: {
    doc: 'server-side volume watching presences — world logic as data',
    default: { area: { center: [0, 0], radius: 5 }, on: 'enter', event: { name: 'trigger' } },
    fields: {
      center: { doc: 'area center [x, z]', range: [-400, 400] },
      radius: { doc: 'circular area radius', range: [1, 200] },
      size: { doc: 'rect area [x, z]', range: [1, 400] },
      yMin: { doc: 'below this y does not count', range: [-100, 300] },
      yMax: { doc: 'above this y does not count', range: [-100, 300] },
      on: { doc: 'which edge fires', enum: ['enter', 'exit'] },
      when: { doc: 'gate: {"entity.component.key": value} must all match' },
      cooldown: { doc: 'seconds before it can fire again', range: [0, 600] },
      event: { doc: 'event to emit ({name, data})' },
      ops: { doc: 'ops to apply; $now → world time, $id → who entered' },
    },
  },
  persist: {
    doc: 'survives the reset op — keeps its truth while the zone re-seeds',
    default: {},
    fields: {},
  },
  spawn: {
    doc: 'where players enter; also the void-fall return point',
    default: { position: [0, 2, 0], yaw: 0 },
    fields: {
      position: { doc: 'entry [x, y, z]', range: [-400, 600] },
      yaw: { doc: 'facing (radians)', range: [-3.1416, 3.1416] },
      gameMode: { doc: 'true: world starts with editing locked (G unlocks)' },
    },
  },
  scatter: {
    doc: 'hundreds of instanced copies from one document (trees, candles)',
    default: { seed: 1, count: 80, area: { center: [0, 0], radius: 40 }, instance: { parts: [{ shape: 'cone', radius: 0.4, height: 1.2, color: '#3c5a40' }] } },
    fields: {
      seed: { doc: 'same seed = same placement', range: [1, 99] },
      count: { doc: 'instances', range: [1, 5000] },
      shape: { doc: 'area shape', enum: ['circle', 'rect'] },
      center: { doc: 'area center [x, z]', range: [-400, 400] },
      radius: { doc: 'circular area radius', range: [1, 500] },
      size: { doc: 'rect area [x, z]', range: [1, 1000] },
      scale: { doc: 'random size range [min, max]', range: [0.05, 8] },
      tilt: { doc: 'random lean (radians)', range: [0, 1] },
      rotateY: { doc: 'false: all face the same way' },
      noise: { doc: 'cluster density frequency', range: [0.001, 0.1] },
      bias: { doc: 'cluster floor (1 = everywhere)', range: [0, 1] },
      minHeight: { doc: 'skip ground below this y', range: [-50, 100] },
      maxHeight: { doc: 'skip ground above this y', range: [-50, 100] },
      offsetY: { doc: 'lift above the ground', range: [-5, 10] },
      y: { doc: 'fixed y when ground: false' },
    },
  },
  particles: {
    doc: 'animated instanced motes: fireflies, souls, rain',
    default: { seed: 1, count: 60, size: 0.08, color: '#ffe066', area: { center: [0, 0], radius: 20 }, motion: { type: 'drift' } },
    fields: {
      seed: { doc: 'same seed = same anchors', range: [1, 99] },
      count: { doc: 'motes', range: [1, 5000] },
      size: { doc: 'mote radius (meters)', range: [0.01, 2] },
      color: { doc: 'mote color' },
      center: { doc: 'area center [x, z]', range: [-400, 400] },
      radius: { doc: 'area radius (also drift wander radius)', range: [0.5, 500] },
      type: { doc: 'motion', enum: ['drift', 'rain'] },
      speed: { doc: 'motion rate (rain ≈ 0.2 hangs in the air)', range: [0, 5] },
      height: { doc: 'drift: above ground; rain: fall column height', range: [0.5, 600] },
      bob: { doc: 'drift vertical wobble', range: [0, 5] },
      floor: { doc: 'drift: never below this world y' },
    },
  },
  environment: {
    doc: 'the world mood: sky, fog, light, bloom, audio buses — one entity',
    default: { background: '#101c30', fog: { color: '#101c30', density: 0.008 }, exposure: 1 },
    fields: {
      background: { doc: 'sky color' },
      exposure: { doc: 'overall brightness', range: [0.2, 3] },
      density: { doc: 'fog thickness', range: [0.001, 0.05] },
      sky: { doc: 'hemisphere sky color' },
      intensity: { doc: 'light strength', range: [0, 3] },
      ambient: { doc: 'the skylight: a true global light — raise this when the note is "more light"' },
      strength: { doc: 'bloom amount', range: [0, 2] },
      threshold: { doc: 'how bright before it blooms', range: [0, 1] },
      level: { doc: 'master volume', range: [0, 1] },
      reverb: { doc: 'world reverb send', range: [0, 1] },
    },
  },
  weather: {
    doc: 'server-simulated sky: lightning strikes and rain cycles',
    default: { lightning: true, minGap: 8, maxGap: 40, rainCycle: 90, rainAmount: 0.5 },
    fields: {
      lightning: { doc: 'strikes on/off' },
      minGap: { doc: 'shortest seconds between strikes', range: [1, 120] },
      maxGap: { doc: 'longest seconds between strikes', range: [2, 240] },
      frequency: { doc: 'multiplier dividing the gaps (storm knob)', range: [0.2, 5] },
      double: { doc: 'chance a strike doubles', range: [0, 1] },
      rainCycle: { doc: 'seconds per rain cycle', range: [5, 600] },
      rainAmount: { doc: 'peak rain 0–1', range: [0, 1] },
    },
  },
  zone: {
    doc: 'stamped by the server in zoned worlds — which level owns this entity',
    fields: { name: { doc: 'zone name from the manifest' } },
  },
  presence: {
    doc: 'a connected player or embodied agent (published, not authored)',
    fields: {},
  },
};

// the add-component menu: everything with an authorable default
export function componentDefaults() {
  const out = {};
  for (const [name, entry] of Object.entries(SCHEMA)) {
    if (entry.default !== undefined) out[name] = entry.default;
  }
  return out;
}

export function fieldInfo(component, key) {
  return SCHEMA[component]?.fields?.[key] ?? null;
}
