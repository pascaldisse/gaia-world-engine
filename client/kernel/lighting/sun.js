// S2 — pure sun maths (no three, no GPU). World frame: +Y up, +X east, −Z north.
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// Solar position, low-precision (Cooper 1969 declination + hour angle; no
// equation-of-time, no refraction → good to ~1°, ample for a game sky). PORT.
// timeOfDay = local SOLAR hours [0,24); latitude ° (+N); dayOfYear 1..365.
// Returns { dir:[x,y,z] unit vector TOWARD the sun, elevation°, azimuth° (from N, clockwise) }.
export function sunPosition({ timeOfDay = 12, latitude = 40, dayOfYear = 172 } = {}) {
  const decl = -23.44 * D2R * Math.cos((2 * Math.PI / 365) * (dayOfYear + 10));
  const H = (timeOfDay - 12) * 15 * D2R;
  const phi = latitude * D2R;
  const sinEl = clamp(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H), -1, 1);
  const el = Math.asin(sinEl);
  const cosEl = Math.cos(el);
  let az;
  if (cosEl < 1e-9) az = 0;
  else {
    const sinAz = -Math.cos(decl) * Math.sin(H) / cosEl;
    const cosAz = (Math.sin(decl) - sinEl * Math.sin(phi)) / (cosEl * Math.cos(phi) || 1e-9);
    az = Math.atan2(sinAz, clamp(cosAz, -1, 1));
  }
  const dir = [cosEl * Math.sin(az), sinEl, -cosEl * Math.cos(az)];
  return { dir, elevation: el * R2D, azimuth: ((az * R2D) % 360 + 360) % 360 };
}

// explicit direction (any non-zero vec3) → same shape as sunPosition()
export function sunFromDirection(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const dir = [d[0] / l, d[1] / l, d[2] / l];
  const el = Math.asin(clamp(dir[1], -1, 1)) * R2D;
  const az = ((Math.atan2(dir[0], -dir[2]) * R2D) % 360 + 360) % 360;
  return { dir, elevation: el, azimuth: az };
}

// Colour ramp by elevation (°). Anchors are ASSUMED art values (blackbody-ish
// sunset → noon white), not measured: 0° deep orange → 12° warm → 45° near-white.
const SUN_RAMP = [
  [0, [1.0, 0.42, 0.16]],
  [6, [1.0, 0.58, 0.30]],
  [15, [1.0, 0.80, 0.60]],
  [30, [1.0, 0.92, 0.80]],
  [50, [1.0, 0.96, 0.90]],
];
const MOON_COLOR = [0.62, 0.72, 1.0]; // ASSUMED cool
export const SUN_DEFAULTS = {
  peak: 3.0,        // DirectionalLight intensity at high noon — ASSUMED (pairs with ACES/AgX exposure ~1)
  moon: 0.12,       // full-moon-ish night key — ASSUMED
  moonFloor: -6,    // °: sun this far below horizon → pure moon (civil twilight end) — PORT (civil twilight)
};

function rampColor(el) {
  const e = clamp(el, SUN_RAMP[0][0], SUN_RAMP[SUN_RAMP.length - 1][0]);
  for (let i = 1; i < SUN_RAMP.length; i++) {
    if (e <= SUN_RAMP[i][0]) {
      const [e0, c0] = SUN_RAMP[i - 1];
      const [e1, c1] = SUN_RAMP[i];
      const t = (e - e0) / (e1 - e0);
      return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
    }
  }
  return SUN_RAMP[SUN_RAMP.length - 1][1].slice();
}

// Directional key light for a sun elevation. Above horizon: warm→white sun with
// intensity ramping in over the first ~12° (atmospheric path length, Beer–Lambert
// shape approximated by smoothstep). Below: crossfades to a dim cool moon whose
// light travels along the sun's antipode (ASSUMED: moon opposite the sun).
// Returns { color:[r,g,b], intensity, sunWeight, isMoon, direction:[x,y,z] (toward the light) }.
export function sunLight(sunDir, opts = {}) {
  const O = { ...SUN_DEFAULTS, ...opts };
  const el = Math.asin(clamp(sunDir[1], -1, 1)) * R2D;
  const sunWeight = smoothstep(O.moonFloor, 0.5, el); // 0 deep night → 1 sun up
  const sunI = O.peak * smoothstep(-0.5, 12, el) * (0.55 + 0.45 * smoothstep(0, 45, el));
  const sunC = rampColor(Math.max(el, 0));
  const moonI = O.moon * (1 - sunWeight);
  const intensity = sunI + moonI;
  const w = intensity > 1e-9 ? sunI / intensity : 0;
  const color = [0, 1, 2].map((i) => lerp(MOON_COLOR[i], sunC[i], w));
  const isMoon = sunWeight < 0.5;
  const d = isMoon ? [-sunDir[0], -sunDir[1], -sunDir[2]] : sunDir.slice();
  // keep the key light above the horizon so it never lights from below
  if (d[1] < 0.05) { d[1] = 0.05; const l = Math.hypot(...d); d[0] /= l; d[1] /= l; d[2] /= l; }
  return { color, intensity, sunWeight, isMoon, direction: d };
}

// daylight factor 0..1 (night..day) used for hemi level / exposure — ASSUMED curve
export function daylight(sunDir) {
  const el = Math.asin(clamp(sunDir[1], -1, 1)) * R2D;
  return smoothstep(-8, 10, el);
}
