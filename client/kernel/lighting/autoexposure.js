// AUTO-EXPOSURE (eye adaptation) — docs/AUTO-EXPOSURE.md. Opt-in: post.autoExposure.enabled (default false => nothing built, 0 cost).
// GPU: HDR scene colour (pre-tonemap, pre-static-exposure) -> log2-luminance reduce chain 128² -> 32² -> 8² -> 1×1 (trimmed, centre-weighted
// percentile mean over the 64 cells) -> 1×1 FLOAT target -> ASYNC readback (no stall, 1-3 frame lag) -> CPU adaptation (framerate-independent)
// -> `expMul` uniform node multiplied into the chain BEFORE bloom/tonemap. Static exposure + env dips (renderer.toneMappingExposure) multiply on top.
// Every number below tagged ASSUMED is a tuning guess, not a measured/ported constant.
import * as THREE from 'three/webgpu';
import { rtt, texture, Fn, Loop, If, float, int, vec2, vec4, uniform, uv, select, log2, exp, max, min, dot, vec3, clamp, mix, ivec2 } from 'three/tsl';

export const AE_DEFAULTS = {
  enabled: false,
  minEV: -3,          // stops, lower clamp of the applied exposure — ASSUMED
  maxEV: 3,           // stops, upper clamp (3 = x8 brightening) — ASSUMED
  compensation: 0,    // stops added to the target (user bias) — ASSUMED
  key: 0.18,          // target mean scene luminance (linear) mapped to ev 0 + comp; scene lum==key => no change — ASSUMED (photographic mid grey)
  strength: 1,        // 0 = meter only (ev = comp), 1 = full normalisation toward `key` — ASSUMED
  speedUp: 3,         // 1/s; scene got BRIGHTER (exposure falls) — fast, UE 'dark->bright' naming — ASSUMED  (tau 0.33 s, 90% in 0.77 s)
  speedDown: 1,       // 1/s; scene got DARKER (exposure rises) — slow (tau 1 s, 90% in 2.3 s) — ASSUMED
  centerWeight: 0.6,  // 0 = uniform metering, 1 = strong centre (gaussian falloff) — ASSUMED
  lowPct: 0.1,        // weighted percentile clip: ignore darkest 10% of the metered mass (black voids) — ASSUMED
  highPct: 0.9,       // ignore brightest 10% (sun disc / sky / emissive) — ASSUMED
};
export const resolveAE = (c = {}) => {
  const r = { ...AE_DEFAULTS, ...(c ?? {}) };
  r.lowPct = Math.min(Math.max(r.lowPct, 0), 0.98);
  r.highPct = Math.min(Math.max(r.highPct, r.lowPct + 0.02), 1);
  r.minEV = Math.min(r.minEV, r.maxEV);
  return r;
};
export const LOG_FLOOR = 1e-4;     // lum floor before log2 (≈ -13.3 EV) — ASSUMED
export const LOG_MAX = 14;          // log2 clamp for fireflies/inf — ASSUMED
export const GRID = 8;              // final metering grid GRID×GRID cells
export const STAGES = [128, 32, GRID]; // square reduce chain sizes
const clampN = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------- CPU mirrors (tests + the live adaptation) ----------------
export const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const logLum = (lum) => clampN(Math.log2(Math.max(lum, LOG_FLOOR)), Math.log2(LOG_FLOOR), LOG_MAX);
// weight of grid cell (ix,iy): mix(1, exp(-4 r²), centerWeight), r² = dx²+dy² with d ∈ [-1,1] from the grid centre
export function cellWeight(ix, iy, centerWeight, grid = GRID) {
  const dx = ((ix + 0.5) / grid) * 2 - 1, dy = ((iy + 0.5) / grid) * 2 - 1;
  const f = Math.exp(-4 * (dx * dx + dy * dy));
  return 1 + (f - 1) * centerWeight;
}
export function gridWeights(centerWeight, grid = GRID) {
  const w = [];
  for (let y = 0; y < grid; y++) for (let x = 0; x < grid; x++) w.push(cellWeight(x, y, centerWeight, grid));
  return w;
}
// weighted percentile-trimmed mean of `values` (log2 lum per cell). Exact twin of the final shader (stable rank, index tie-break).
export function trimmedMean(values, weights, lowPct = 0.1, highPct = 0.9) {
  const n = values.length;
  let W = 0; for (let i = 0; i < n; i++) W += weights[i];
  const lo = lowPct * W, hi = highPct * W;
  let sw = 0, sl = 0;
  for (let i = 0; i < n; i++) {
    let below = 0;
    for (let j = 0; j < n; j++) if (values[j] < values[i] || (values[j] === values[i] && j < i)) below += weights[j];
    const c = Math.max(0, Math.min(below + weights[i], hi) - Math.max(below, lo));
    sw += c; sl += c * values[i];
  }
  if (sw < 1e-9) { let s = 0; for (let i = 0; i < n; i++) s += weights[i] * values[i]; return s / W; }
  return sl / sw;
}
// metered log2 lum -> target EV (stops), clamped
export const targetEV = (meterLog2, c) => clampN((c.compensation ?? 0) + (c.strength ?? 1) * (Math.log2(c.key ?? 0.18) - meterLog2), c.minEV, c.maxEV);
// framerate-independent: k = 1-exp(-dt*speed); speedUp when the scene got brighter (target ev below current), speedDown when darker
export function adaptEV(ev, target, dt, c) {
  const speed = target < ev ? c.speedUp : c.speedDown;
  return ev + (target - ev) * (1 - Math.exp(-Math.max(0, dt) * speed));
}
export const evToMul = (ev) => Math.pow(2, ev);

// ---------------- state machine (CPU) ----------------
export class AutoExposure {
  constructor(cfg = {}) {
    this.cfg = resolveAE(cfg);
    this.ev = clampN(this.cfg.compensation, this.cfg.minEV, this.cfg.maxEV);
    this.target = this.ev;
    this.meter = null;      // last metered log2 lum (trimmed mean)
    this.lum = null;        // 2^meter (linear mean luminance)
    this.reads = 0;
    this.expMul = uniform(evToMul(this.ev)); // the TSL uniform node the chain multiplies by
  }
  configure(cfg) { this.cfg = resolveAE(cfg); }
  // readback arrived: store target (first reading snaps, no slow ramp from ev 0 at load)
  ingest(meterLog2) {
    if (!Number.isFinite(meterLog2)) return;
    this.meter = meterLog2; this.lum = Math.pow(2, meterLog2);
    this.target = targetEV(meterLog2, this.cfg);
    if (this.reads++ === 0) this.ev = this.target;
  }
  update(dt) {
    if (this.meter === null) this.target = clampN(this.cfg.compensation, this.cfg.minEV, this.cfg.maxEV);
    else this.target = targetEV(this.meter, this.cfg); // knobs may change live
    this.ev = clampN(adaptEV(this.ev, this.target, dt, this.cfg), this.cfg.minEV, this.cfg.maxEV);
    this.expMul.value = evToMul(this.ev);
    return this.ev;
  }
  get state() { return { ev: this.ev, target: this.target, lum: this.lum, meter: this.meter, mul: this.expMul.value, reads: this.reads }; }
}

// ---------------- GPU meter ----------------
// colorTex: THREE.Texture of the HDR scene colour (scenePass.getTexture('output')). A PLAIN texture node, NOT the PassTextureNode:
// referencing the pass node in a quad graph would make the nested render re-run the whole scene pass. Stages run by hand (run()).
export function buildMeter(colorTex, cfg) {
  const C = resolveAE(cfg);
  const colorNode = texture(colorTex);
  const cw = uniform(C.centerWeight), lowP = uniform(C.lowPct), highP = uniform(C.highPct);
  const W = [];
  const logL = (rgb) => log2(max(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), LOG_FLOOR)).min(LOG_MAX);
  // stage 1: 4×4 bilinear taps over the cell footprint -> mean log2 lum (taps at ±1.5/±0.5 quarter-cells)
  const reduce = (src, outN, isHdr) => {
    const step = 1 / outN;
    return Fn(() => {
      const acc = float(0).toVar();
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
        const o = vec2((a - 1.5) * 0.25 * step, (b - 1.5) * 0.25 * step);
        const s = src.sample(uv().add(o));
        acc.addAssign(isHdr ? logL(s.rgb) : s.r);
      }
      return vec4(acc.div(16), 0, 0, 1);
    })();
  };
  let prev = colorNode;
  const stages = [];
  STAGES.forEach((n, k) => {
    const node = k === STAGES.length - 1
      // last reduce additionally stores the cell weight in G (one fetch per cell in the final pass)
      ? Fn(() => {
          const base = reduce(prev, n, false);
          const d = uv().mul(2).sub(1);
          const f = exp(dot(d, d).mul(-4));
          const w = float(1).add(f.sub(1).mul(cw));
          return vec4(base.r, w, 0, 1);
        })()
      : reduce(prev, n, k === 0);
    const r = rtt(node, n, n, { type: THREE.HalfFloatType });
    r.renderTarget.texture.minFilter = r.renderTarget.texture.magFilter = k === STAGES.length - 1 ? THREE.NearestFilter : THREE.LinearFilter;
    r.renderTarget.texture.generateMipmaps = false;
    stages.push(r);
    prev = r;
  });
  const cells = prev;
  const N = GRID * GRID;
  const cell = (k) => cells.sample(vec2(k.mod(GRID).toFloat().add(0.5).div(GRID), k.div(GRID).toFloat().add(0.5).div(GRID)));
  const fin = Fn(() => {
    const wTot = float(0).toVar();
    Loop({ start: int(0), end: int(N), name: 'cw' }, ({ cw: k }) => { wTot.addAssign(cell(k).g); });
    const lo = lowP.mul(wTot), hi = highP.mul(wTot);
    const sw = float(0).toVar(), sl = float(0).toVar();
    Loop({ start: int(0), end: int(N), name: 'ci' }, ({ ci: i }) => {
      const ci = cell(i);
      const below = float(0).toVar();
      Loop({ start: int(0), end: int(N), name: 'cj' }, ({ cj: j }) => {
        const cjv = cell(j);
        const lt = cjv.r.lessThan(ci.r).or(cjv.r.equal(ci.r).and(j.lessThan(i)));
        below.addAssign(select(lt, cjv.g, 0));
      });
      const c = max(float(0), min(below.add(ci.g), hi).sub(max(below, lo)));
      sw.addAssign(c); sl.addAssign(c.mul(ci.r));
    });
    return vec4(sl.div(max(sw, 1e-6)), sw, wTot, 1);
  })();
  const final = rtt(fin, 1, 1, { type: THREE.FloatType });
  final.renderTarget.texture.minFilter = final.renderTarget.texture.magFilter = THREE.NearestFilter;
  final.renderTarget.texture.generateMipmaps = false;
  const all = [...stages, final];
  const out = {
    stages, final, uniforms: { centerWeight: cw, lowPct: lowP, highPct: highP },
    setCfg(c) { const r = resolveAE(c); cw.value = r.centerWeight; lowP.value = r.lowPct; highP.value = r.highPct; },
    // run the reduce chain (call AFTER the scene pass rendered this frame)
    run(renderer) { for (const n of all) n.updateBefore({ renderer }); },
    dispose() { for (const n of all) { n.renderTarget?.dispose?.(); n.dispose?.(); } },
  };
  return out;
}

// ---------------- owner: meter + async readback + adaptation, hooked into LightingPost ----------------
export class AutoExposureRig {
  constructor({ renderer, colorTex, cfg }) {
    this.renderer = renderer;
    this.cfg = resolveAE(cfg);
    this.ae = new AutoExposure(this.cfg);
    this.meter = buildMeter(colorTex, this.cfg);
    this.inflight = false;
    this.errors = 0;
    this.lastError = null;
    this.frames = 0;      // meter runs
    this.lagFrames = 0;   // frames between issuing a readback and its arrival (last)
    this._issuedAt = 0;
  }
  get expMul() { return this.ae.expMul; }
  get state() { return { ...this.ae.state, inflight: this.inflight, errors: this.errors, lag: this.lagFrames, frames: this.frames, cfg: this.cfg }; }
  configure(cfg) { this.cfg = resolveAE(cfg); this.ae.configure(this.cfg); this.meter.setCfg(this.cfg); }
  // after the post render: reduce + (if none pending) kick an async 1×1 readback. Never awaited => no stall.
  afterRender() {
    if (this.errors > 5) return;
    try {
      this.meter.run(this.renderer);
      this.frames++;
      if (!this.inflight) {
        this.inflight = true; this._issuedAt = this.frames;
        const p = this.renderer.readRenderTargetPixelsAsync(this.meter.final.renderTarget, 0, 0, 1, 1);
        Promise.resolve(p).then((buf) => {
          this.inflight = false; this.lagFrames = this.frames - this._issuedAt;
          this.ae.ingest(Number(buf[0]));
        }).catch((e) => { this.inflight = false; this.errors++; this.lastError = String(e?.message ?? e); });
      }
    } catch (e) { this.errors++; this.lastError = String(e?.message ?? e); }
  }
  update(dt) { return this.ae.update(dt); }
  dispose() { this.meter.dispose(); }
}
