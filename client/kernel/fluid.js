// fluid.js — REAL GPU FLUID. Position Based Fluids (Macklin & Müller 2013)
// run entirely as WebGPU compute via TSL. No CPU particle loop, no fake
// "sparkle" particles: densities, constraints and neighbour forces are solved
// on the device, so falling water hits the floor, splats, and RE-GATHERS
// because the density constraint says it must — the behaviour is emergent,
// never scripted.
//
// LAW §IRON — nothing here is hard-coded. Every number lives in FLUID_PHYSICS /
// FLUID_RENDER below with a default, and every entry point takes overrides.
//
// SEAM — this module is a statically registered ENGINE CAPABILITY
// (client/kernel/extensions.js contract: export register(ctx) → {name, api,
// sync(), update(dt)}). Registration has no GPU side effect: allocation starts
// only at an explicit host/query probe or exactly one world-data component
// `{ fluid: { enabled: true, ... } }`. Atlas replaces the default list, so its
// behavior remains unchanged.
//
// UNVERIFIED: 60 fps on a real Metal adapter. No browser measurement has been
// taken from this file yet; treat every perf claim as unproven until a real
// tab reports frame times with the particle count printed.

import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, instanceIndex, instancedArray, uniform, atomicAdd, atomicStore,
  float, int, ivec3, vec3, color, materialColor, uint, min, length, select, atomicLoad,
} from 'three/tsl';

// ─────────────────────────────────────────────────────────────── parameters ──
// PBF is scale-sensitive: `radius` (kernel support h) sets the rest spacing,
// and everything else is expressed relative to it. Change radius alone and the
// simulation stays stable — that is the point of keeping them together.
export const FLUID_PHYSICS = {
  count: 16384,          // particles. >= 10000 by decree; power-of-two friendly
  radius: 0.16,          // h, smoothing kernel support (m)
  restDensity: 1000.0,   // ρ0 (kg/m³ nominal; mass is derived from it)
  substeps: 1,           // integrations per frame
  iterations: 3,         // density constraint solver iterations per substep
  relaxation: 100.0,     // ε in λ = -C / (Σ|∇C|² + ε)  — CFM regularisation.
                         // measured on visible Metal-3: 1e-4 explodes at t1.2 and
                         // leaves the tank floating at t3.2; 100 gives a splat mound
                         // that re-coalesces into a puddle, zero GPU errors.
  gravity: [0, -9.81, 0],
  dt: 1 / 60,            // fixed sim step; frame dt is clamped to dtMax below
  dtMax: 1 / 30,         // never integrate a stall as one giant step
  viscosity: 0.05,       // XSPH coefficient (measured stable pair with relaxation 100)
  vorticity: 0.0,        // vorticity confinement ε (0 = off; costs a pass)
  sCorrK: 0.001,         // tensile instability (artificial pressure) strength
  sCorrN: 4,             // its exponent
  sCorrQ: 0.3,           // |Δp| sample point, as a fraction of radius
  maxVelocity: 12.0,     // clamp: a blown-up particle must not poison the grid
  damping: 0.35,         // tangential velocity kept on a wall hit (splat, not bounce)
  restitution: 0.0,      // normal velocity kept on a wall hit
  bounds: { min: [-4, 0, -4], max: [4, 8, 4] }, // broadphase tank (world units)
  // `box` preserves the original tank; `cylinder` adds a radial wall inside it;
  // `cone` makes that wall y-dependent so it can match a flared basin's inner
  // face (radius at the base → radiusTop at base+height, clamped outside).
  // radius and center are world-data parameters, never mesh-derived magic.
  container: { type: 'box', center: [0, 0, 0], radius: 4.0, radiusTop: null, height: null },
  cellsPerAxis: 48,      // uniform grid resolution over `bounds`
  cellCapacity: 48,      // max particles binned per cell (overflow is dropped)
  // NEIGHBOUR LIST (perf, measured): the 3³ cell walk visits ~200 candidates to
  // find ~35 real neighbours, and the old code paid that walk SEVEN times per
  // substep (λ, Δp ×iterations, then finalize). Built once per substep instead,
  // every later pass reads a compact list. `neighborSkin` widens the search
  // radius so a neighbour that drifts inward during the projection iterations
  // is already on the list (the passes still test the exact h themselves).
  maxNeighbors: 128,     // per-particle list capacity (overflow is dropped)
  neighborSkin: 1.2,     // search radius = radius * skin, for list building
  spawn: {
    mode: 'block',       // 'block' | 'sphere'
    center: [0, 5.0, 0],
    size: [2.2, 2.2, 2.2],
    jitter: 0.25,        // fraction of spacing; breaks the lattice symmetry
    velocity: [0, 0, 0],
  },
};

export const FLUID_RENDER = {
  enabled: true,
  pointSize: 6.0,        // px, sprite footprint
  color: [0.32, 0.62, 1.0],
  colorFast: [0.85, 0.95, 1.0], // tint at |v| = maxVelocity (speed shows motion)
  // 1 = the original expression (colour runs from `color` at rest to `colorFast`
  // at maxVelocity — motion is READ off the liquid). 0 flattens it to a paint
  // chip; that default was a regression and is not allowed to return.
  speedColorMix: 1.0,
  opacity: 0.85,
  sizeAttenuation: true,
};

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

// ───────────────────────────────────────────────────────────────── kernels ──
// Poly6 and Spiky, written once, in TSL. W(r,h) is zero outside h — every
// neighbour loop below relies on that, not on an if-forest.
const poly6 = /*#__PURE__*/ Fn(([r2, h]) => {
  const h2 = h.mul(h);
  const t = h2.sub(r2).max(0.0);
  // 315 / (64 π h⁹)
  const coeff = float(1.566681471).div(h2.mul(h2).mul(h2).mul(h2).mul(h));
  return coeff.mul(t).mul(t).mul(t);
});

const spikyGrad = /*#__PURE__*/ Fn(([rv, r, h]) => {
  // -45 / (π h⁶) * (h - r)² * r̂
  const coeff = float(-14.323944878).div(h.mul(h).mul(h).mul(h).mul(h).mul(h));
  const t = h.sub(r).max(0.0);
  const dir = rv.div(r.max(1.0e-6));
  return dir.mul(coeff.mul(t).mul(t));
});

/**
 * Build a GPU fluid. Pure: it creates buffers, compute passes and a mesh, and
 * hands them back. Nothing global is touched — the caller decides whether the
 * mesh joins a scene and when `update` runs.
 *
 * @param {object} o
 * @param {THREE.Renderer} o.renderer  a WebGPURenderer (the engine's own)
 * @param {object} [o.physics]  overrides for FLUID_PHYSICS
 * @param {object} [o.render]   overrides for FLUID_RENDER
 */
export function createFluid({ renderer, physics = {}, render = {} } = {}) {
  if (!renderer) throw new Error('[fluid] renderer required');
  const P = { ...FLUID_PHYSICS, ...physics,
    bounds: { ...FLUID_PHYSICS.bounds, ...(physics.bounds || {}) },
    container: { ...FLUID_PHYSICS.container, ...(physics.container || {}) },
    spawn: { ...FLUID_PHYSICS.spawn, ...(physics.spawn || {}) } };
  const R = { ...FLUID_RENDER, ...render };
  const coneContainer = P.container.type === 'cone';
  const radialContainer = P.container.type === 'cylinder' || coneContainer;
  // A cone with no second radius/height authored degenerates to its cylinder.
  const containerRadiusTop = P.container.radiusTop ?? P.container.radius;
  const containerHeight = Math.max(1e-6, P.container.height ?? 1);

  const count = Math.max(1, Math.floor(P.count));
  const NC = Math.max(2, Math.floor(P.cellsPerAxis));
  const CAP = Math.max(4, Math.floor(P.cellCapacity));
  const MAXN = Math.max(8, Math.floor(P.maxNeighbors));
  const SKIN = Math.max(1, P.neighborSkin);
  const cells = NC * NC * NC;

  const bMin = V3(P.bounds.min);
  const bMax = V3(P.bounds.max);
  const size = new THREE.Vector3().subVectors(bMax, bMin);
  const cellSize = new THREE.Vector3(size.x / NC, size.y / NC, size.z / NC);
  // The neighbour search only scans 3³ cells, so a cell may not be smaller than
  // the kernel support in any axis — otherwise neighbours are silently missed.
  const gridOk = Math.min(cellSize.x, cellSize.y, cellSize.z) >= P.radius;

  // mass from rest density and rest spacing (h/2 lattice) — derived, not typed
  const spacing = P.radius * 0.5;
  const mass = P.restDensity * spacing * spacing * spacing;

  // ── buffers ────────────────────────────────────────────────────────────────
  // `instancedArray` owns vec3's GPU alignment. Passing a padded JS array
  // makes its logical count/stride wrong; create count elements then seed the
  // backing three-float array before its first upload.
  const position  = instancedArray(count, 'vec3').setName('fluidPosition');
  const predicted = instancedArray(count, 'vec3').setName('fluidPredicted');
  const velocity  = instancedArray(count, 'vec3').setName('fluidVelocity');
  seed(position.value.array, velocity.value.array, count, P, spacing);
  position.value.needsUpdate = true;
  velocity.value.needsUpdate = true;
  const lambda    = instancedArray(count, 'float').setName('fluidLambda');
  const delta     = instancedArray(count, 'vec3').setName('fluidDelta');
  // counting-sort-free binning: fixed capacity buckets + atomic slot handout.
  const cellCount = instancedArray(cells, 'uint').setPBO(true).setName('fluidCellCount');
  cellCount.setAtomic(true);
  const cellItems = instancedArray(cells * CAP, 'uint').setName('fluidCellItems');
  // compact per-particle neighbour list, rebuilt once per substep
  const neighborCount = instancedArray(count, 'uint').setName('fluidNeighborCount');
  const neighborList = instancedArray(count * MAXN, 'uint').setName('fluidNeighborList');

  // ── uniforms (live-tunable; the tables above are only the defaults) ─────────
  const U = {
    dt: uniform(P.dt),
    gravity: uniform(V3(P.gravity)),
    h: uniform(P.radius),
    restDensity: uniform(P.restDensity),
    mass: uniform(mass),
    relaxation: uniform(P.relaxation),
    viscosity: uniform(P.viscosity),
    sCorrK: uniform(P.sCorrK),
    sCorrQ: uniform(P.sCorrQ * P.radius),
    maxVelocity: uniform(P.maxVelocity),
    damping: uniform(P.damping),
    restitution: uniform(P.restitution),
    bMin: uniform(bMin.clone()),
    bMax: uniform(bMax.clone()),
    cellSize: uniform(cellSize.clone()),
    hSearch2: uniform(P.radius * SKIN * P.radius * SKIN),
  };
  // Container uniforms exist ONLY when a radial wall is authored: a `box`
  // world must not even allocate them, so no doubt can remain about whether
  // the default path's generated shader changed.
  if (radialContainer) {
    U.containerCenter = uniform(V3(P.container.center));
    U.containerRadius = uniform(P.container.radius);
  }
  if (coneContainer) {
    U.containerRadiusTop = uniform(containerRadiusTop);
    U.containerBase = uniform(P.container.center[1]);
    U.containerHeight = uniform(containerHeight);
  }
  // The wall limit at height y. For `cylinder` this is the uniform itself, so
  // the generated shader for the existing path is byte-identical.
  const wallRadius = (y) => (coneContainer
    ? U.containerRadius.add(U.containerRadiusTop.sub(U.containerRadius)
        .mul(y.sub(U.containerBase).div(U.containerHeight).clamp(0, 1)))
    : U.containerRadius);
  const NCn = int(NC), CAPn = int(CAP), MAXNn = int(MAXN);

  // Integer coordinates keep array indices and loop offsets in WGSL's i32
  // domain. Binning clamps a transient out-of-tank prediction; neighbour
  // traversal separately skips such coordinates so no bucket is visited twice.
  const cellCoord = Fn(([p]) => ivec3(p.sub(U.bMin).div(U.cellSize).floor()).toVar());
  const cellHash = Fn(([c]) => {
    const cc = c.clamp(int(0), NCn.sub(1)).toVar();
    return cc.x.add(cc.y.mul(NCn)).add(cc.z.mul(NCn).mul(NCn));
  });

  // r180 dispatches ceil(count/workgroup) invocations, so the tail workgroup
  // runs threads past the end of every buffer. Guard, always — an unguarded
  // atomicAdd from a tail thread corrupts a real cell's bucket.
  const guarded = (n, body) => Fn(() => {
    If(instanceIndex.lessThan(uint(n)), body);
  })().compute(n);

  // ── pass 1: predict ────────────────────────────────────────────────────────
  const kPredict = guarded(count, () => {
    const v = velocity.element(instanceIndex).toVar();
    v.addAssign(U.gravity.mul(U.dt));
    const s = length(v);
    If(s.greaterThan(U.maxVelocity), () => { v.assign(v.div(s.max(1e-6)).mul(U.maxVelocity)); });
    velocity.element(instanceIndex).assign(v);
    predicted.element(instanceIndex).assign(position.element(instanceIndex).add(v.mul(U.dt)));
  });

  // ── pass 2: clear grid ─────────────────────────────────────────────────────
  // atomic buffers are written through atomic ops only — a plain assign to an
  // atomic<u32> is a binding-type error, not a slow path.
  const kClear = guarded(cells, () => { atomicStore(cellCount.element(instanceIndex), uint(0)); });

  // ── pass 3: bin (atomic slot handout inside a fixed-capacity bucket) ────────
  const kBin = guarded(count, () => {
    const cell = cellHash(cellCoord(predicted.element(instanceIndex).toVar()).toVar()).toVar();
    const slot = atomicAdd(cellCount.element(cell), uint(1)).toVar();
    If(slot.lessThan(uint(CAP)), () => {
      cellItems.element(cell.mul(CAPn).add(int(slot))).assign(uint(instanceIndex));
    });
  });

  // grid visitor: 3³ cells around p, bucket-bounded. `body(j)` is inlined.
  // Used ONCE per substep now (to build the list) — the solver passes walk the
  // list, not the grid.
  const forEachGridCandidate = (p, body) => {
    const base = cellCoord(p).toVar();
    Loop({ start: int(-1), end: int(2), type: 'int', name: 'dz' }, ({ dz }) => {
      Loop({ start: int(-1), end: int(2), type: 'int', name: 'dy' }, ({ dy }) => {
        Loop({ start: int(-1), end: int(2), type: 'int', name: 'dx' }, ({ dx }) => {
          const c = ivec3(base.x.add(dx), base.y.add(dy), base.z.add(dz)).toVar();
          // Do not clamp neighbour coordinates: at tank edges clamping maps
          // several offsets to one bucket and counts every occupant repeatedly.
          const valid = c.x.greaterThanEqual(0).and(c.x.lessThan(NCn))
            .and(c.y.greaterThanEqual(0)).and(c.y.lessThan(NCn))
            .and(c.z.greaterThanEqual(0)).and(c.z.lessThan(NCn));
          If(valid, () => {
            const cell = cellHash(c).toVar();
            const n = min(int(atomicLoad(cellCount.element(cell))), CAPn).toVar();
            Loop({ start: int(0), end: n, type: 'int', name: 'k' }, ({ k }) => {
              body(int(cellItems.element(cell.mul(CAPn).add(k))));
            });
          });
        });
      });
    });
  };

  // ── pass 3b: neighbour list (the grid walk, paid once) ─────────────────────
  // Self is deliberately NOT stored: it contributes nothing to Δp or XSPH, and
  // its density term is added analytically in λ below (same arithmetic, one
  // slot saved per particle).
  const kNeighbors = guarded(count, () => {
    const pi = predicted.element(instanceIndex).toVar();
    const n = int(0).toVar();
    forEachGridCandidate(pi, (j) => {
      If(n.lessThan(MAXNn).and(j.notEqual(int(instanceIndex))), () => {
        const rv = pi.sub(predicted.element(j)).toVar();
        If(rv.dot(rv).lessThan(U.hSearch2), () => {
          neighborList.element(int(instanceIndex).mul(MAXNn).add(n)).assign(uint(j));
          n.addAssign(int(1));
        });
      });
    });
    neighborCount.element(instanceIndex).assign(uint(n));
  });

  // list visitor: what every solver pass uses from here on.
  const forEachNeighbour = (_p, body) => {
    const n = min(int(neighborCount.element(instanceIndex)), MAXNn).toVar();
    const base = int(instanceIndex).mul(MAXNn).toVar();
    Loop({ start: int(0), end: n, type: 'int', name: 'k' }, ({ k }) => {
      body(int(neighborList.element(base.add(k))));
    });
  };

  // ── pass 4: λ (density constraint + its gradient magnitude) ────────────────
  const kLambda = guarded(count, () => {
    const pi = predicted.element(instanceIndex).toVar();
    // self term: poly6(0, h) — the list omits self, the physics does not
    const rho = float(0).add(U.mass.mul(poly6(float(0), U.h))).toVar();
    const gradI = vec3(0).toVar();
    const sumGrad2 = float(0).toVar();
    forEachNeighbour(pi, (j) => {
      const rv = pi.sub(predicted.element(j)).toVar();
      const r2 = rv.dot(rv).toVar();
      If(r2.lessThan(U.h.mul(U.h)), () => {
        rho.addAssign(U.mass.mul(poly6(r2, U.h)));
        const g = spikyGrad(rv, r2.sqrt(), U.h).mul(U.mass.div(U.restDensity)).toVar();
        gradI.addAssign(g);
        sumGrad2.addAssign(g.dot(g));
      });
    });
    const C = rho.div(U.restDensity).sub(1.0).toVar();
    sumGrad2.addAssign(gradI.dot(gradI));
    lambda.element(instanceIndex).assign(
      C.negate().div(sumGrad2.add(U.relaxation)),
    );
  });

  // ── pass 5: Δp (with tensile-instability correction) then project ─────────
  const kDelta = guarded(count, () => {
    const pi = predicted.element(instanceIndex).toVar();
    const li = lambda.element(instanceIndex).toVar();
    const dp = vec3(0).toVar();
    const wq = poly6(U.sCorrQ.mul(U.sCorrQ), U.h).toVar();
    forEachNeighbour(pi, (j) => {
      const rv = pi.sub(predicted.element(j)).toVar();
      const r2 = rv.dot(rv).toVar();
      If(r2.lessThan(U.h.mul(U.h)).and(r2.greaterThan(1e-12)), () => {
        const ratio = poly6(r2, U.h).div(wq.max(1e-12)).toVar();
        const sCorr = U.sCorrK.negate().mul(ratio.pow(float(P.sCorrN))).toVar();
        dp.addAssign(spikyGrad(rv, r2.sqrt(), U.h).mul(li.add(lambda.element(j)).add(sCorr)));
      });
    });
    delta.element(instanceIndex).assign(dp.mul(U.mass.div(U.restDensity)));
  });

  const kApply = guarded(count, () => {
    const p = predicted.element(instanceIndex).add(delta.element(instanceIndex)).toVar();
    // Broadphase box plus optional authored circular basin wall. The latter is
    // a positional constraint, so density projection cannot leak into corners.
    p.assign(p.clamp(U.bMin, U.bMax));
    if (radialContainer) {
      const radial = vec3(p.x.sub(U.containerCenter.x), 0, p.z.sub(U.containerCenter.z)).toVar();
      const distance = length(radial).toVar();
      const limit = coneContainer ? wallRadius(p.y).toVar() : U.containerRadius;
      If(distance.greaterThan(limit), () => {
        const edge = radial.mul(limit.div(distance.max(1e-6))).add(U.containerCenter).toVar();
        p.assign(vec3(edge.x, p.y, edge.z));
      });
    }
    predicted.element(instanceIndex).assign(p);
  });

  // ── pass 6: finalize — velocity from motion, XSPH viscosity, wall response ──
  const kFinalize = guarded(count, () => {
    const p0 = position.element(instanceIndex).toVar();
    const p1 = predicted.element(instanceIndex).toVar();
    const v = p1.sub(p0).div(U.dt).toVar();

    // XSPH: velocity relaxes toward the neighbourhood mean → coherent sheets
    const dv = vec3(0).toVar();
    forEachNeighbour(p1, (j) => {
      const rv = p1.sub(predicted.element(j)).toVar();
      const r2 = rv.dot(rv).toVar();
      If(r2.lessThan(U.h.mul(U.h)), () => {
        dv.addAssign(velocity.element(j).sub(v).mul(poly6(r2, U.h)).mul(U.mass.div(U.restDensity)));
      });
    });
    v.addAssign(dv.mul(U.viscosity));

    // splat, don't bounce: normal velocity is killed, tangential is damped
    const onMin = p1.lessThanEqual(U.bMin.add(1e-4));
    const onMax = p1.greaterThanEqual(U.bMax.sub(1e-4));
    const hit = onMin.or(onMax);
    v.assign(vec3(
      select(hit.x, v.x.mul(U.restitution.negate()), v.x),
      select(hit.y, v.y.mul(U.restitution.negate()), v.y),
      select(hit.z, v.z.mul(U.restitution.negate()), v.z),
    ));
    let radialHit = null;
    if (radialContainer) {
      const radial = vec3(p1.x.sub(U.containerCenter.x), 0, p1.z.sub(U.containerCenter.z)).toVar();
      const distance = length(radial).toVar();
      radialHit = distance.greaterThanEqual(wallRadius(p1.y).sub(1e-4));
      // Remove only outward radial speed: a wall captures the splash without
      // inventing an inward impulse, then shares the normal wall damping.
      If(radialHit, () => {
        const normal = radial.div(distance.max(1e-6)).toVar();
        const outward = v.dot(normal).toVar();
        If(outward.greaterThan(0), () => { v.subAssign(normal.mul(outward)); });
      });
    }
    const anyHit = radialHit ? hit.x.or(hit.y).or(hit.z).or(radialHit) : hit.x.or(hit.y).or(hit.z);
    If(anyHit, () => { v.mulAssign(U.damping); });

    const s = length(v);
    If(s.greaterThan(U.maxVelocity), () => { v.assign(v.div(s.max(1e-6)).mul(U.maxVelocity)); });

    velocity.element(instanceIndex).assign(v);
    position.element(instanceIndex).assign(p1);
  });

  // ── mesh ───────────────────────────────────────────────────────────────────
  const mesh = buildFluidMesh({ count, position, velocity, U, R });
  mesh.frustumCulled = false;
  mesh.visible = !!R.enabled;

  let running = true;
  let acc = 0;

  const api = {
    mesh,
    count,
    params: { physics: P, render: R },
    uniforms: U,
    buffers: { position, velocity, predicted, lambda, delta, cellCount, cellItems, neighborCount, neighborList },
    diagnostics: { cells, cellCapacity: CAP, maxNeighbors: MAXN, cellSize: cellSize.toArray(), mass, gridOk },
    get running() { return running; },
    set running(v) { running = !!v; },

    /** advance the simulation; `dt` seconds of wall time */
    step(dt = P.dt) {
      if (!running) return;
      const clamped = Math.min(Math.max(dt, 0), P.dtMax);
      acc += clamped;
      const h = P.dt;
      let steps = 0;
      const maxSteps = Math.max(1, P.substeps * 2);
      while (acc >= h && steps < maxSteps) { acc -= h; steps += 1; substep(); }
      // if we can never catch up, drop the backlog rather than spiral
      if (acc > h * 4) acc = 0;
    },

    dispose() {
      mesh.geometry?.dispose?.();
      mesh.material?.dispose?.();
    },
  };

  // One array per substep: r180 runs them in the order given, on ONE command
  // encoder — a per-pass await would stall the CPU on the GPU every frame.
  const chain = [kPredict, kClear, kBin, kNeighbors];
  for (let i = 0; i < P.iterations; i += 1) chain.push(kLambda, kDelta, kApply);
  chain.push(kFinalize);
  function substep() { renderer.compute(chain); }

  return api;
}

// ─────────────────────────────────────────────────────────────────── render ──
function buildFluidMesh({ count, position, velocity, U, R }) {
  // SpriteNodeMaterial billboards each instance for us; the instance's world
  // position comes straight out of the storage buffer the compute passes wrote,
  // so NOTHING is read back to the CPU — no instanceMatrix updates at all.
  const material = new THREE.SpriteNodeMaterial({
    transparent: R.opacity < 1,
    depthWrite: R.opacity >= 1,
    sizeAttenuation: R.sizeAttenuation,
  });
  // SpriteNodeMaterial's native `color` follows its tested color-management
  // path. Raw colorNode constants did not: a blue world value rendered yellow.
  material.color.setRGB(...R.color);
  if (R.speedColorMix > 0) {
    const speed = length(velocity.element(instanceIndex)).div(U.maxVelocity).clamp(0, 1);
    const speedTint = float(R.speedColorMix).clamp(0, 1).mul(speed);
    material.colorNode = materialColor.mix(color(...R.colorFast), speedTint);
  }
  material.opacityNode = float(R.opacity);
  material.positionNode = position.element(instanceIndex);
  material.scaleNode = float(R.pointSize * 0.01);

  const geo = new THREE.PlaneGeometry(1, 1);
  const inst = new THREE.InstancedMesh(geo, material, count);
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.name = 'gaia-fluid';
  return inst;
}

// ──────────────────────────────────────────────────────────────────── seed ──
// A lattice with jitter: a perfect lattice is a metastable state PBF will hold
// for a suspiciously long time, which reads as "the sim is frozen".
function seed(posArr, velArr, count, P, spacing) {
  const c = P.spawn.center, s = P.spawn.size, v0 = P.spawn.velocity;
  const nx = Math.max(1, Math.floor(s[0] / spacing));
  const ny = Math.max(1, Math.floor(s[1] / spacing));
  const jitter = P.spawn.jitter * spacing;
  for (let i = 0; i < count; i += 1) {
    const ix = i % nx;
    const iy = Math.floor(i / nx) % ny;
    const iz = Math.floor(i / (nx * ny));
    const j = () => (Math.random() - 0.5) * 2 * jitter;
    let x = c[0] - s[0] / 2 + ix * spacing + j();
    let y = c[1] - s[1] / 2 + iy * spacing + j();
    let z = c[2] - s[2] / 2 + iz * spacing + j();
    if (P.spawn.mode === 'sphere') {
      const r = Math.cbrt(Math.random()) * Math.min(s[0], s[1], s[2]) * 0.5;
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      x = c[0] + r * Math.sin(ph) * Math.cos(th);
      y = c[1] + r * Math.cos(ph);
      z = c[2] + r * Math.sin(ph) * Math.sin(th);
    }
    posArr[i * 3 + 0] = x; posArr[i * 3 + 1] = y; posArr[i * 3 + 2] = z;
    velArr[i * 3 + 0] = v0[0]; velArr[i * 3 + 1] = v0[1]; velArr[i * 3 + 2] = v0[2];
  }
}

// ───────────────────────────────────────────────────────── extension seam ──
// The ONLY way this file enters the running engine. `register` is called by
// extensions.js with the live context; if the world never opts in, none of the
// above ever runs. Opt-in is explicit and OFF by default.
export function register(ctx = {}) {
  const { renderer, scene, store } = ctx;
  const q = (() => { try { return new URLSearchParams(location.search); } catch { return null; } })();
  const wanted = (typeof window !== 'undefined' && window.__GAIA_FLUID__) || null;
  const probe = wanted?.enabled === true || q?.get('fluid') === '1';
  const isWebGPU = renderer?.backend?.isWebGPUBackend === true;
  let sim = null;
  let activeConfig = null;

  const stop = () => {
    if (!sim) return;
    scene?.remove(sim.mesh);
    sim.dispose();
    sim = null;
    activeConfig = null;
  };
  const start = (opts = {}) => {
    if (!isWebGPU) {
      console.warn('[fluid] backend is not WebGPU — GPU fluid stays OFF (no compute available)');
      return null;
    }
    if (sim) return sim;
    activeConfig = opts;
    sim = createFluid({
      renderer,
      physics: { ...(wanted?.physics || {}), ...(opts.physics || {}) },
      render: { ...(wanted?.render || {}), ...(opts.render || {}) },
    });
    scene?.add(sim.mesh);
    return sim;
  };
  const worldConfig = () => {
    const matches = [...(store?.entities?.values?.() ?? [])]
      .map((components) => components?.fluid)
      .filter((fluid) => fluid?.enabled === true);
    // Ambiguous world data is not consent: one component owns the singleton.
    return matches.length === 1 ? matches[0] : null;
  };
  const sync = () => {
    const config = worldConfig();
    if (!config) {
      if (!probe) stop();
      return;
    }
    const next = { physics: config.physics || {}, render: config.render || {} };
    if (JSON.stringify(next) !== JSON.stringify(activeConfig)) {
      stop();
      start(next);
    }
  };

  if (probe) start();

  return {
    name: 'fluid',
    api: {
      start, stop,
      get sim() { return sim; },
      FLUID_PHYSICS, FLUID_RENDER, createFluid,
    },
    sync,
    update(dt) { sim?.step(dt); },
  };
}

export default register;
