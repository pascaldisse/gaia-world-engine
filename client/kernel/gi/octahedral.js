// Signed-octahedron unit-vector encode/decode (Cigolle et al. 2014, §GI-PROBES.md).
// A unit direction <-> a [-1,1]^2 point, used to lay a sphere of probe-ray
// directions out as a small square irradiance/depth atlas per probe.

function signNotZero(v) {
  return v >= 0 ? 1 : -1;
}

/** dir: [x,y,z] unit vector -> [u,v] in [-1,1]^2 */
export function encodeOct(dir) {
  const [x, y, z] = dir;
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z);
  // l1===0 only for the zero vector, which is not a valid direction —
  // callers own normalization; guard so this never emits NaN.
  const inv = l1 > 0 ? 1 / l1 : 0;
  let u = x * inv;
  let v = y * inv;
  if (z < 0) {
    const ou = (1 - Math.abs(v)) * signNotZero(u);
    const ov = (1 - Math.abs(u)) * signNotZero(v);
    u = ou;
    v = ov;
  }
  return [u, v];
}

/** [u,v] in [-1,1]^2 -> unit vector [x,y,z] */
export function decodeOct(uv) {
  const [u, v] = uv;
  let x = u;
  let y = v;
  let z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const ox = (1 - Math.abs(y)) * signNotZero(x);
    const oy = (1 - Math.abs(x)) * signNotZero(y);
    x = ox;
    y = oy;
  }
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}
