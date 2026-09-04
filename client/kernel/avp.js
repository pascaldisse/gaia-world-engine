// Unity AnimationCurve's unweighted cubic-Hermite segment evaluation.
export function evaluateCurve(curve, t, fallback = 0) {
  const keys = Array.isArray(curve) ? curve : curve?.keys;
  if (!Array.isArray(keys) || keys.length === 0) return fallback;
  const read = (key) => Array.isArray(key)
    ? { t: key[0], v: key[1], inSlope: 0, outSlope: 0 }
    : key;
  const first = read(keys[0]);
  if (t <= first.t) return first.v ?? fallback;
  for (let i = 1; i < keys.length; i++) {
    const a = read(keys[i - 1]);
    const b = read(keys[i]);
    if (t > b.t) continue;
    const span = b.t - a.t;
    if (!(span > 0)) return b.v ?? fallback;
    const u = (t - a.t) / span;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * (a.v ?? fallback)
      + h10 * span * (a.outSlope ?? 0)
      + h01 * (b.v ?? fallback)
      + h11 * span * (b.inSlope ?? 0);
  }
  return read(keys[keys.length - 1]).v ?? fallback;
}

// Unity Rigidbody drag integration (Unity 6 linearDamping implementation).
export function applyDrag(velocity, drag, dt) {
  return velocity * Math.max(0, 1 - drag * dt);
}

// Unity Rigidbody angular drag integration (Unity 6 angularDamping implementation).
export function applyAngularDrag(angularVelocity, angularDrag, dt) {
  return angularVelocity * Math.max(0, 1 - angularDrag * dt);
}
