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
    } else if (b.type === 'path') {
      // waypoint follow at constant speed; `start` anchors it to a world-time
      // moment (triggers stamp $now), loop:false parks at the last point
      const pts = b.points ?? [];
      if (pts.length >= 2) {
        const lens = [];
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
          const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
          lens.push(l);
          total += l;
        }
        let dist = Math.max(0, time - (b.start ?? 0)) * (b.speed ?? 2) + (b.phase ?? 0);
        if (b.loop) dist = ((dist % total) + total) % total;
        else dist = Math.min(dist, total);
        let seg = 0;
        while (seg < lens.length - 1 && dist > lens[seg]) dist -= lens[seg++];
        const k = lens[seg] ? Math.min(1, dist / lens[seg]) : 0;
        const a = pts[seg];
        const c = pts[seg + 1];
        x = a[0] + (c[0] - a[0]) * k;
        y = a[1] + (c[1] - a[1]) * k;
        z = a[2] + (c[2] - a[2]) * k;
        if (b.ground && heightFn) y = heightFn(x, z) + (b.height ?? 0);
      }
    } else if (b.type === 'bob') {
      y += Math.sin(time * (b.speed ?? 1) + (b.phase ?? 0)) * (b.amplitude ?? 0.5);
    }
  }
  return [x, y, z];
}

export function hasMotion(comps) {
  const list = comps.behavior ? (Array.isArray(comps.behavior) ? comps.behavior : [comps.behavior]) : [];
  return list.some((b) => b.type === 'orbit' || b.type === 'bob' || b.type === 'path');
}
