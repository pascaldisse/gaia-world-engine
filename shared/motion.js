// Deterministic motion: orbit/bob positions are pure functions of world time,
// so the renderer, the server's senses, and any future client all agree on
// where a moving thing is.

// the behavior array-or-single convention, decided once — every consumer
// (renderer, senses, gizmos) normalizes through here
export function behaviorList(comps) {
  return comps.behavior ? (Array.isArray(comps.behavior) ? comps.behavior : [comps.behavior]) : [];
}

// the legs/total table is a pure function of a path's points and speed, but
// followers ask for it every frame (twice — position and heading) and the
// server's senses per trigger tick. Cache per behavior object; ops replace
// the object wholesale, so the WeakMap invalidates itself.
const legsCache = new WeakMap();
function pathLegs(b, pts) {
  const speed = b.speed ?? 2;
  const cached = legsCache.get(b);
  if (cached && cached.pts === pts && cached.speed === speed) return cached;
  const legs = []; // { dwell: pause at the leg's start point, travel: seconds underway, dist: leg length in meters }
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dwell = pts[i - 1][3] ?? 0;
    const dist = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    const travel = dist / Math.max(0.01, speed);
    legs.push({ dwell, travel, dist });
    total += dwell + travel;
  }
  total += pts[pts.length - 1][3] ?? 0; // looping: pause at the end too
  const entry = { pts, speed, legs, total };
  legsCache.set(b, entry);
  return entry;
}

// pure polyline geometry — no time, no speed, no dwells — the single source
// of truth for "how long is this path" and "where is arc-length s along it".
// Shared by the time-parameterized walk below (arcAtTime) and by anything
// that just wants a fixed spot on the path (paused entries, scrubbing).
// Cached per points array; ops replace the array wholesale like `b` above.
const lengthCache = new WeakMap();
export function pathLength(points) {
  const cached = lengthCache.get(points);
  if (cached !== undefined) return cached;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
      points[i][2] - points[i - 1][2]
    );
  }
  lengthCache.set(points, total);
  return total;
}

export function pointAtArc(points, s) {
  if (!points.length) return [0, 0, 0];
  if (points.length === 1) return [points[0][0], points[0][1], points[0][2]];
  const total = pathLength(points);
  let d = total ? ((s % total) + total) % total : 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const c = points[i];
    const legLen = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    if (d <= legLen || i === points.length - 1) {
      const k = legLen ? Math.min(1, d / legLen) : 1;
      return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k];
    }
    d -= legLen;
  }
  const last = points[points.length - 1];
  return [last[0], last[1], last[2]];
}

// the time-domain walk (dwells + travel, `start`/`loop`/`phase`) collapsed
// to "how far along the polyline, in meters, is this behavior right now" —
// exactly the parameter the old inline code derived before interpolating
// a position from it. Position/heading now read that arc length instead of
// re-deriving it, so there is one source of truth for the walk.
export function arcAtTime(b, time) {
  const pts = b.points ?? [];
  if (pts.length < 2) return 0;
  const { legs, total } = pathLegs(b, pts);
  let t = Math.max(0, time - (b.start ?? 0)) + (b.phase ?? 0);
  if (b.loop) t = total ? ((t % total) + total) % total : 0;
  else t = Math.min(t, total);
  let cum = 0;
  for (let i = 0; i < legs.length; i++) {
    if (t < legs[i].dwell) return cum;
    t -= legs[i].dwell;
    if (t < legs[i].travel) return cum + legs[i].dist * (legs[i].travel ? Math.min(1, t / legs[i].travel) : 1);
    t -= legs[i].travel;
    cum += legs[i].dist;
  }
  return cum;
}

export function animatedPosition(comps, time, heightFn) {
  const t = comps.transform ?? {};
  let [x, y, z] = t.position ?? [0, 0, 0];
  if (comps.ground && heightFn) y = heightFn(x, z) + (comps.ground.offset ?? 0);
  const list = behaviorList(comps);
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
      // and travel share one clock (phase is seconds too). `paused` freezes
      // the entry at a fixed arc-length (`pausedAt`, meters) regardless of
      // time — the mover's own pause/resume state, not a global stop.
      const pts = b.points ?? [];
      if (pts.length >= 2) {
        const s = b.paused ? (b.pausedAt ?? 0) : arcAtTime(b, time);
        [x, y, z] = pointAtArc(pts, s);
        if (b.ground && heightFn) y = heightFn(x, z) + (b.height ?? 0);
      }
    } else if (b.type === 'bob') {
      y += Math.sin(time * (b.speed ?? 1) + (b.phase ?? 0)) * (b.amplitude ?? 0.5);
    }
  }
  return [x, y, z];
}

export function hasMotion(comps) {
  return behaviorList(comps).some((b) => b.type === 'orbit' || b.type === 'bob' || b.type === 'path');
}
