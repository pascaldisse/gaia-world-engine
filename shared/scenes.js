// Scenes: one coherent world-space assembled from scene files
// (world/scenes/<name>.json — pure entity documents). world/world.json is
// the SUPERSCENE: the composition — which scenes exist, where each one sits
// and streams (bounds, neighbors, load volumes), plus world defaults. The
// Unity master-scene pattern: scenes are subscenes loaded by position; the
// world file owns them. These pure functions are shared by client and
// server so every observer agrees on what is "here".

// raw: the world.json object — { voidY?, scenes: { name: {…meta} } }
export function normalizeScenes(raw) {
  const entries = Object.entries(raw?.scenes ?? {});
  if (!entries.length) return null;
  return {
    // falling past voidY teleports a body back to its last safe ground
    voidY: raw.voidY ?? -120,
    scenes: entries.map(([name, meta]) => ({
      name,
      neighbors: meta.neighbors ?? [],
      always: meta.always ?? false,
      voidY: meta.voidY,
      // world-space disc the scene claims; scenes without bounds (backdrops)
      // are never "current", only always-loaded scenery
      bounds: meta.bounds ?? null,
      // load volumes (the Dark Souls model): explicit world-space volumes
      // that stream this scene in. A scene WITH volumes loads only while the
      // observer stands inside one (or the scene is current) — the implicit
      // "load with every neighbor" rule no longer applies to it.
      load: Array.isArray(meta.load) && meta.load.length ? meta.load : null,
    })),
  };
}

// the schema's shared area shape — {center:[x,z], radius | size:[sx,sz]} —
// used by triggers, water, scatter and particles. One containment test so a
// swimmer's client-side water check and the server's drown trigger agree by
// construction. defaultSize covers areas authored without an extent.
export function inArea(area, x, z, defaultSize = [10, 10]) {
  const [cx, cz] = area.center ?? [0, 0];
  if (area.radius) return Math.hypot(x - cx, z - cz) <= area.radius;
  const [sx, sz] = area.size ?? defaultSize;
  return Math.abs(x - cx) <= sx / 2 && Math.abs(z - cz) <= sz / 2;
}

// is (x, y, z) inside a load volume — a disc with an optional y range.
// pad widens the volume: the unload test uses a margin so a player hovering
// exactly on the boundary doesn't flicker the scene in and out.
export function insideVolume(volume, x, y, z, pad = 0) {
  const [cx, cz] = volume.center ?? [0, 0];
  if (Math.hypot(x - cx, z - cz) > (volume.radius ?? 0) + pad) return false;
  const range = volume.y;
  if (range && y !== undefined && (y < range[0] - pad || y > range[1] + pad)) return false;
  return true;
}

// which scene claims (x, z) — smallest containing disc wins, so a courtyard
// scene can sit inside a larger region. A single-scene world claims
// everywhere: the one scene IS the world.
export function sceneAt(index, x, z) {
  if (index.scenes.length === 1) return index.scenes[0].name;
  let best = null;
  for (const scene of index.scenes) {
    if (!scene.bounds) continue;
    const [cx, cz] = scene.bounds.center ?? [0, 0];
    const radius = scene.bounds.radius ?? 0;
    if (Math.hypot(x - cx, z - cz) > radius) continue;
    if (!best || radius < (best.bounds.radius ?? 0)) best = scene;
  }
  return best?.name ?? null;
}

// the set that must be resident: current scene, its neighbors (so nothing
// visible or reachable ever pops in), and the always-scenes (backdrops).
// Scenes with explicit `load` volumes opt OUT of the neighbor rule: they
// stream in only while the observer's position is inside a volume — that is
// how a vista layer stays unloaded until the approach actually reveals it.
// pos: [x, y, z] (y may be undefined — volume y ranges then don't gate);
// without pos (top-down senses), load-scenes fall back to the neighbor rule.
// prev: the previously active set — members get a 2m unload margin.
export function activeScenes(index, current, pos = null, prev = null) {
  const set = new Set();
  const scene = current ? index.scenes.find((s) => s.name === current) : null;
  const neighbors = new Set(scene?.neighbors ?? []);
  for (const s of index.scenes) {
    if (s.always || s.name === current) {
      set.add(s.name);
    } else if (s.load && pos) {
      const pad = prev?.has(s.name) ? 2 : 0;
      if (s.load.some((v) => insideVolume(v, pos[0], pos[1], pos[2], pad))) set.add(s.name);
    } else if (neighbors.has(s.name)) {
      set.add(s.name);
    }
  }
  return set;
}
