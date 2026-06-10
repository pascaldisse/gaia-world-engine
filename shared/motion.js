// Deterministic motion: orbit/bob positions are pure functions of world time,
// so the renderer, the server's senses, and any future client all agree on
// where a moving thing is.
export function animatedPosition(comps, time, heightFn) {
  const t = comps.transform ?? {};
  let [x, y, z] = t.position ?? [0, 0, 0];
  if (comps.ground && heightFn) y = heightFn(x, z) + (comps.ground.offset ?? 0);
  const list = comps.behavior ? (Array.isArray(comps.behavior) ? comps.behavior : [comps.behavior]) : [];
  for (const b of list) {
    if (b.type === 'orbit') {
      const [cx, cy, cz] = b.center ?? [0, 0, 0];
      const angle = time * (b.speed ?? 0.3) + (b.phase ?? 0);
      const radius = b.radius ?? 10;
      x = cx + Math.cos(angle) * radius;
      z = cz + Math.sin(angle) * radius;
      y = b.ground && heightFn ? heightFn(x, z) + (b.height ?? 0) : cy + (b.height ?? 0);
    } else if (b.type === 'bob') {
      y += Math.sin(time * (b.speed ?? 1) + (b.phase ?? 0)) * (b.amplitude ?? 0.5);
    }
  }
  return [x, y, z];
}

export function hasMotion(comps) {
  const list = comps.behavior ? (Array.isArray(comps.behavior) ? comps.behavior : [comps.behavior]) : [];
  return list.some((b) => b.type === 'orbit' || b.type === 'bob');
}
