// Zones: one coherent world-space assembled from independently authored
// levels. A world with a manifest streams — clients build only the zones
// near the player; a world without one is a single always-loaded zone and
// behaves exactly as before. Pure functions shared by client and server so
// every observer agrees on what is "here".

export function normalizeManifest(raw) {
  if (!raw?.zones?.length) return null;
  return {
    // falling past voidY teleports a body back to its last safe ground
    voidY: raw.voidY ?? -120,
    zones: raw.zones.map((zone) => ({
      name: zone.name,
      origin: zone.origin ?? [0, 0, 0],
      yaw: zone.yaw ?? 0,
      neighbors: zone.neighbors ?? [],
      always: zone.always ?? false,
      voidY: zone.voidY,
      // world-space disc the zone claims; zones without bounds (backdrops)
      // are never "current", only always-loaded scenery
      bounds: zone.bounds ?? null,
    })),
  };
}

// which zone claims (x, z) — smallest containing disc wins, so a courtyard
// zone can sit inside a larger region
export function zoneAt(manifest, x, z) {
  let best = null;
  for (const zone of manifest.zones) {
    if (!zone.bounds) continue;
    const [cx, cz] = zone.bounds.center ?? [0, 0];
    const radius = zone.bounds.radius ?? 0;
    if (Math.hypot(x - cx, z - cz) > radius) continue;
    if (!best || radius < (best.bounds.radius ?? 0)) best = zone;
  }
  return best?.name ?? null;
}

// the set that must be resident: current zone, its neighbors (so nothing
// visible or reachable ever pops in), and the always-zones (backdrops)
export function activeZones(manifest, current) {
  const set = new Set();
  for (const zone of manifest.zones) if (zone.always) set.add(zone.name);
  if (current) {
    set.add(current);
    const zone = manifest.zones.find((z) => z.name === current);
    for (const name of zone?.neighbors ?? []) set.add(name);
  }
  return set;
}

// Seeds are authored zone-local; placing a zone rotates by yaw then offsets
// by origin. Every absolute-coordinate field a component can hold is
// transformed here — entity-relative fields (mesh parts, collider boxes,
// light offsets) ride along for free.
export function placeEntity(comps, zone) {
  const [ox, oy, oz] = zone.origin ?? [0, 0, 0];
  const yaw = zone.yaw ?? 0;
  if (!ox && !oy && !oz && !yaw) return comps;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const rot = (x, z) => [x * cos + z * sin, -x * sin + z * cos];
  const place3 = (p) => {
    const [x, y, z] = p ?? [0, 0, 0];
    const [rx, rz] = rot(x, z);
    return [ox + rx, oy + y, oz + rz];
  };
  const place2 = (p) => {
    const [x, z] = p ?? [0, 0];
    const [rx, rz] = rot(x, z);
    return [ox + rx, oz + rz];
  };

  const out = structuredClone(comps);
  const spatial = out.mesh || out.light || out.sound || out.collider || out.terrain;
  if (out.transform || spatial) {
    const t = (out.transform ??= {});
    t.position = place3(t.position);
    if (yaw) {
      const [rx, ry, rz] = t.rotation ?? [0, 0, 0];
      t.rotation = [rx, ry + yaw, rz];
    }
  }
  if (out.spawn) {
    out.spawn.position = place3(out.spawn.position ?? [0, 2, 0]);
    if (yaw) out.spawn.yaw = (out.spawn.yaw ?? 0) + yaw;
  }
  const behaviors = out.behavior ? (Array.isArray(out.behavior) ? out.behavior : [out.behavior]) : [];
  for (const b of behaviors) {
    if (b.type === 'orbit') b.center = place3(b.center);
    if (b.type === 'path' && b.points) b.points = b.points.map(place3);
  }
  if (out.water) {
    if (out.water.area?.center) out.water.area.center = place2(out.water.area.center);
    if (out.water.level !== undefined) out.water.level += oy;
  }
  if (out.trigger) {
    if (out.trigger.area?.center) out.trigger.area.center = place2(out.trigger.area.center);
    if (out.trigger.yMin !== undefined) out.trigger.yMin += oy;
    if (out.trigger.yMax !== undefined) out.trigger.yMax += oy;
  }
  for (const field of ['scatter', 'particles']) {
    const area = out[field]?.area;
    if (area?.center) area.center = place2(area.center);
    if (out[field]?.motion?.floor !== undefined) out[field].motion.floor += oy;
    if (out[field]?.y !== undefined) out[field].y += oy;
    if (out[field]?.minHeight !== undefined) out[field].minHeight += oy;
    if (out[field]?.maxHeight !== undefined) out[field].maxHeight += oy;
  }
  return out;
}
