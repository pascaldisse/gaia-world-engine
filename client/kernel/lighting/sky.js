// S2 — physical sky. Preetham analytic daylight model, ported line-for-line
// from three/addons/objects/SkyMesh.js (r180, WebGPU/TSL) in two forms that
// share ONE constant table:
//   skyRadiance(dir, sunDir, params, opts)      pure JS  (tests, CPU consumers)
//   skyRadianceTSL(dirNode, sunDirNode, p, o)   TSL Fn    (GI lane, shaders)
// + skySummary() → {zenith, horizon, ground} 3-colour summary for GI/hemi/fog.
// Source: Preetham, Shirley, Smits 1999 "A Practical Analytic Model for Daylight".
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { Fn, float, vec3, acos, add, mul, sub, clamp, cos, dot, exp, max, mix, normalize, pow, smoothstep, uniform } from 'three/tsl';

const K = {
  totalRayleigh: [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5],
  mieConst: [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14],
  cutoffAngle: 1.6110731556870734,
  steepness: 1.5,
  EE: 1000,
  rayleighZenithLength: 8.4e3,
  mieZenithLength: 1.25e3,
  sunAngularDiameterCos: 0.999956676946448443553574619906976478926848692873900859324,
  threeOver16Pi: 0.05968310365946075,
  oneOver4Pi: 0.07957747154594767,
};

// webgpu_sky example defaults (PORT) — hazier/warmer than SkyMesh's bare ctor defaults
export const SKY_DEFAULTS = {
  turbidity: 6,        // ASSUMED between example (10) and ctor (2): open-city haze
  rayleigh: 2,         // ASSUMED
  mieCoefficient: 0.005, // PORT
  mieDirectionalG: 0.8,  // PORT (SkyMesh ctor)
  groundAlbedo: 0.25,    // ASSUMED: asphalt/grass/concrete mix
  size: 0.7,             // sky-dome radius as fraction of camera.far — ASSUMED
};

const clamp1 = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => { const t = clamp1((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// Pure JS. dir/sunDir: vec3 (need not be unit). Returns [r,g,b] in the same
// display-referred ~0..1 range SkyMesh outputs. opts.disc includes the solar disc
// (off by default: GI wants diffuse sky, not a 19000x spike). Below-horizon
// directions clamp to the horizon value (SkyMesh does the same: max(0, up·dir)).
export function skyRadiance(dir, sunDir, params = {}, opts = {}) {
  const P = { ...SKY_DEFAULTS, ...params };
  const d = norm(dir);
  const s = norm(sunDir);
  // vertex stage
  const zenithAngleCos = clamp1(s[1], -1, 1);
  const sunE = K.EE * Math.max(0, 1 - Math.exp(-(K.cutoffAngle - Math.acos(zenithAngleCos)) / K.steepness));
  const sunfade = 1 - clamp1(1 - Math.exp(s[1] / 450000), 0, 1);
  const rayleighCoefficient = P.rayleigh - (1 - sunfade);
  const betaR = K.totalRayleigh.map((c) => c * rayleighCoefficient);
  const c = 0.2 * P.turbidity * 10e-18;
  const betaM = K.mieConst.map((m) => 0.434 * c * m * P.mieCoefficient);
  // fragment stage
  const zenithAngle = Math.acos(Math.max(0, d[1]));
  const inverse = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - (zenithAngle * 180) / Math.PI, -1.253));
  const sR = K.rayleighZenithLength * inverse;
  const sM = K.mieZenithLength * inverse;
  const Fex = [0, 1, 2].map((i) => Math.exp(-(betaR[i] * sR + betaM[i] * sM)));
  const cosTheta = d[0] * s[0] + d[1] * s[1] + d[2] * s[2];
  const cc = cosTheta * 0.5 + 0.5;
  const rPhase = K.threeOver16Pi * (1 + cc * cc);
  const g = P.mieDirectionalG;
  const g2 = g * g;
  const mPhase = K.oneOver4Pi * (1 - g2) / Math.pow(1 - 2 * g * cosTheta + g2, 1.5);
  const mixK = clamp1(Math.pow(1 - s[1], 5), 0, 1);
  const fade = 1 / (1.2 + sunfade * 1.2);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const sc = sunE * ((betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]));
    let Lin = Math.pow(sc * (1 - Fex[i]), 1.5);
    Lin *= (1 - mixK) + mixK * Math.pow(sc * Fex[i], 0.5);
    let L0 = 0.1 * Fex[i];
    if (opts.disc) L0 += sunE * 19000 * Fex[i] * sstep(K.sunAngularDiameterCos, K.sunAngularDiameterCos + 0.00002, cosTheta);
    const tex = (Lin + L0) * 0.04 + [0, 0.0003, 0.00075][i];
    out[i] = Math.pow(Math.max(tex, 0), fade);
  }
  return out;
}

// TSL twin. p = {turbidity, rayleigh, mieCoefficient, mieDirectionalG} each a
// JS number or a TSL node/uniform. Returns vec3 node. NOT GPU-parity-tested
// in CI (no GPU) — graph-construction only; see docs UNVERIFIED.
export function skyRadianceTSL(dirNode, sunDirNode, p = {}, opts = {}) {
  const P = { ...SKY_DEFAULTS, ...p };
  const f = (v) => (typeof v === 'number' ? float(v) : v);
  const turbidity = f(P.turbidity);
  const rayleigh = f(P.rayleigh);
  const mieC = f(P.mieCoefficient);
  const g = f(P.mieDirectionalG);
  return Fn(() => {
    const d = normalize(dirNode);
    const s = normalize(sunDirNode);
    const sunE = float(K.EE).mul(max(0.0, float(1.0).sub(exp(float(K.cutoffAngle).sub(acos(clamp(s.y, -1, 1))).div(K.steepness).negate()))));
    const sunfade = float(1.0).sub(clamp(float(1.0).sub(exp(s.y.div(450000.0))), 0, 1));
    const betaR = vec3(...K.totalRayleigh).mul(rayleigh.sub(float(1.0).sub(sunfade)));
    const cc = float(0.2).mul(turbidity).mul(10e-18);
    const betaM = float(0.434).mul(cc).mul(vec3(...K.mieConst)).mul(mieC);
    const zenithAngle = acos(max(0.0, d.y));
    const inverse = float(1.0).div(cos(zenithAngle).add(float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0).div(Math.PI)), -1.253))));
    const sR = float(K.rayleighZenithLength).mul(inverse);
    const sM = float(K.mieZenithLength).mul(inverse);
    const Fex = exp(mul(betaR, sR).add(mul(betaM, sM)).negate());
    const cosTheta = dot(d, s);
    const c2 = cosTheta.mul(0.5).add(0.5);
    const rPhase = float(K.threeOver16Pi).mul(float(1.0).add(pow(c2, 2.0)));
    const betaRTheta = betaR.mul(rPhase);
    const g2 = pow(g, 2.0);
    const inv = float(1.0).div(pow(float(1.0).sub(float(2.0).mul(g).mul(cosTheta)).add(g2), 1.5));
    const mPhase = float(K.oneOver4Pi).mul(float(1.0).sub(g2)).mul(inv);
    const betaMTheta = betaM.mul(mPhase);
    const sc = sunE.mul(add(betaRTheta, betaMTheta).div(add(betaR, betaM)));
    const Lin = pow(sc.mul(sub(1.0, Fex)), vec3(1.5)).toVar();
    Lin.mulAssign(mix(vec3(1.0), pow(sc.mul(Fex), vec3(0.5)), clamp(pow(sub(1.0, s.y), 5.0), 0.0, 1.0)));
    const L0 = vec3(0.1).mul(Fex).toVar();
    if (opts.disc) {
      const cd = float(K.sunAngularDiameterCos);
      L0.addAssign(sunE.mul(19000.0).mul(Fex).mul(smoothstep(cd, cd.add(0.00002), cosTheta)));
    }
    const tex = add(Lin, L0).mul(0.04).add(vec3(0.0, 0.0003, 0.00075));
    return pow(tex, vec3(float(1.0).div(float(1.2).add(sunfade.mul(1.2)))));
  })();
}

// {zenith, horizon, ground} — the 3-colour interface the GI lane consumes
// (environment.lighting.skySummary). Each [r,g,b].
//  zenith  = radiance straight up
//  horizon = mean of 8 azimuths at 4° elevation (disc excluded) — also the fog colour
//  ground  = horizon-lit bounce: horizon × groundAlbedo × (daylight-ish sun term)
export function skySummary(sunDir, params = {}, groundBounce = 1) {
  const P = { ...SKY_DEFAULTS, ...params };
  const zenith = skyRadiance([0, 1, 0], sunDir, P);
  const el = (4 * Math.PI) / 180;
  const h = [0, 0, 0];
  const N = 8;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2;
    const c = skyRadiance([Math.cos(el) * Math.sin(a), Math.sin(el), -Math.cos(el) * Math.cos(a)], sunDir, P);
    h[0] += c[0] / N; h[1] += c[1] / N; h[2] += c[2] / N;
  }
  const ground = h.map((v) => v * P.groundAlbedo * groundBounce);
  return { zenith, horizon: h, ground };
}

// Build the visible sky dome (SkyMesh) configured from SKY_DEFAULTS.
// sunDir must be a unit vector (SkyMesh's sunfade term assumes unit sunPosition).
export function createSkyMesh(params = {}) {
  const sky = new SkyMesh();
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.userData.noShadow = true;
  applySkyParams(sky, params);
  return sky;
}
export function applySkyParams(sky, params = {}) {
  const P = { ...SKY_DEFAULTS, ...params };
  sky.turbidity.value = P.turbidity;
  sky.rayleigh.value = P.rayleigh;
  sky.mieCoefficient.value = P.mieCoefficient;
  sky.mieDirectionalG.value = P.mieDirectionalG;
}

export { uniform };
