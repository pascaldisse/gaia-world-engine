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
      // moment (triggers stamp $now), loop:false parks at the last point.
      // A waypoint's 4th number is a dwell: seconds parked there before
      // moving on — ferry stops. The walk is time-parameterized so dwells
      // and travel share one clock (phase is seconds too).
      const pts = b.points ?? [];
      if (pts.length >= 2) {
        const speed = b.speed ?? 2;
        const legs = []; // { dwell: pause at the leg's start point, travel: seconds underway }
        let total = 0;
        for (let i = 1; i < pts.length; i++) {
          const dwell = pts[i - 1][3] ?? 0;
          const travel =
            Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]) /
            Math.max(0.01, speed);
          legs.push({ dwell, travel });
          total += dwell + travel;
        }
        total += pts[pts.length - 1][3] ?? 0; // looping: pause at the end too
        let t = Math.max(0, time - (b.start ?? 0)) + (b.phase ?? 0);
        if (b.loop) t = total ? ((t % total) + total) % total : 0;
        else t = Math.min(t, total);
        let seg = legs.length - 1;
        let k = 1;
        for (let i = 0; i < legs.length; i++) {
          if (t < legs[i].dwell) {
            seg = i;
            k = 0;
            break;
          }
          t -= legs[i].dwell;
          if (t < legs[i].travel) {
            seg = i;
            k = legs[i].travel ? Math.min(1, t / legs[i].travel) : 1;
            break;
          }
          t -= legs[i].travel;
        }
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
