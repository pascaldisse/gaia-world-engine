// gi_compute.wgsl — native probe-GI update (lane nt-gi). LITERAL TRANSLATION of the three TSL graph, no algorithm change:
//   client/kernel/gi/gi-open-raypar.js  (createOpenTraceKernel / createOpenIrradianceBlendKernel / createOpenDepthBlendKernel)
//   client/kernel/gi/gi-open-nodes.js   (readVoxelTSL, marchVoxelsTSL, voxelNormalTSL, resolveProbeTSL, probeWorldPos, batchProbeIndex,
//                                        skyRadianceTSL, fibonacciDirTSL, decodeOctTSL, queryCascadeTSL/queryCascadesTSL)
// Three entry points, dispatched in this order inside one compute pass: trace -> irr_blend -> depth_blend (irr reads the depth fresh-sentinel BEFORE depth blends).
// Every number that is a tunable arrives through `P` (gi_compute.rs GcUniform); only format constants (voxel packing, protocol sentinels) are consts.
struct Cas { a: vec4<f32>, b: vec4<f32> };   // a = (window base cell.xyz, spacing) . b = (dims.xyz, baseIndex)
struct Params {
  cas: array<Cas, 4>,
  start: vec4<u32>,     // per-cascade round-robin cursor at dispatch
  cum: vec4<u32>,       // cumulative batch sizes (probes)
  sun_dir: vec4<f32>,   // xyz = direction the light travels
  sun_col: vec4<f32>,   // xyz colour . w intensity
  zenith: vec4<f32>,
  horizon: vec4<f32>,
  ground: vec4<f32>,
  vbase: vec4<i32>,     // voxel window base brick + biasBricks (xyz)
  vdim: vec4<i32>,      // xyz bricks per axis . w brick size (voxels)
  vcell: vec4<f32>,     // x cellSize . y maxDist . z relocateMax . w bounceScale
  vint: vec4<i32>,      // x cellBias . y marchSteps . z relocateSteps . w cascade count
  res: vec4<u32>,       // x irradianceRes . y depthRes . z raysPerProbe
  cnt: vec4<u32>,       // x trace threads . y irradiance texels . z depth texels . w batch probes
  hy: vec4<f32>,        // x irradianceAlpha . y depthAlpha . z fastAlpha . w adaptive threshold
  misc: vec4<f32>,      // x blendCells . y fibonacci golden angle
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> voxels: array<u32>;
@group(0) @binding(2) var<storage, read_write> ray_buf: array<vec4<f32>>;   // (radiance.rgb, hitT) per (batch probe, ray)
@group(0) @binding(3) var<storage, read_write> irr_atlas: array<vec4<f32>>; // xyz = irradiance (vec3 storage stride 16 = three instancedArray 'vec3')
@group(0) @binding(4) var<storage, read_write> depth_atlas: array<vec2<f32>>; // (mean dist, mean dist^2)
const PI: f32 = 3.14159265358979323846;
const RECIP_PI: f32 = 0.31830988618379067154;
const SOLID_BIT: u32 = 16777216u;    // voxel-window.js SOLID_BIT (1<<24): packed voxel format
const DISABLED_HIT: f32 = -2.0;      // gi-open-raypar.js DISABLED_HIT: ray-buffer flag written by ray 0 of a disabled probe
const COVERAGE_WEIGHT_EPS: f32 = 1e-6;   // gi-reference.js
const GI_MAX_CASCADES_C: i32 = 4;

fn linear_id(gid: vec3<u32>, nwg: vec3<u32>) -> u32 { return gid.x + gid.y * nwg.x * 64u; }

// ---------------------------------------------------------------- voxel window (readVoxelTSL)
fn read_voxel(cx: i32, cy: i32, cz: i32) -> u32 {
  let bs = P.vdim.w;
  let bias = P.vint.x;
  let cb = vec3<i32>(cx + bias, cy + bias, cz + bias);
  let bb = cb / vec3<i32>(bs);
  let l = cb % vec3<i32>(bs);
  let rel = bb - P.vbase.xyz;
  let dims = P.vdim.xyz;
  let in_win = all(rel >= vec3<i32>(0)) && all(rel < dims);
  let slot = (bb.x % dims.x) + dims.x * ((bb.y % dims.y) + dims.y * (bb.z % dims.z));
  let vpb = bs * bs * bs;
  let idx = slot * vpb + l.x + bs * (l.y + bs * l.z);
  let v = voxels[u32(select(0, idx, in_win))];
  return select(0u, v, in_win);
}
fn is_solid(v: u32) -> bool { return v >= SOLID_BIT; }
fn cell_of(p: vec3<f32>) -> vec3<i32> { return vec3<i32>(floor(p / P.vcell.x)); }
fn read_at_world(p: vec3<f32>) -> u32 { let c = cell_of(p); return read_voxel(c.x, c.y, c.z); }
fn unpack_albedo(v: u32) -> vec3<f32> {
  return vec3<f32>(f32((v >> 16u) & 255u), f32((v >> 8u) & 255u), f32(v & 255u)) / 255.0;
}

// ---------------------------------------------------------------- small mirrors (octahedral / fibonacci / sky)
fn sign_not_zero(v: f32) -> f32 { return select(1.0, -1.0, v < 0.0); }
fn encode_oct(dir: vec3<f32>) -> vec2<f32> {
  let l1 = abs(dir.x) + abs(dir.y) + abs(dir.z);
  let inv = 1.0 / max(l1, 1e-8);
  let u0 = dir.x * inv;
  let v0 = dir.y * inv;
  let folded = dir.z < 0.0;
  return vec2<f32>(select(u0, (1.0 - abs(v0)) * sign_not_zero(u0), folded), select(v0, (1.0 - abs(u0)) * sign_not_zero(v0), folded));
}
fn decode_oct(uv: vec2<f32>) -> vec3<f32> {
  let z0 = 1.0 - abs(uv.x) - abs(uv.y);
  let folded = z0 < 0.0;
  let ox = (1.0 - abs(uv.y)) * sign_not_zero(uv.x);
  let oy = (1.0 - abs(uv.x)) * sign_not_zero(uv.y);
  return normalize(vec3<f32>(select(uv.x, ox, folded), select(uv.y, oy, folded), z0));
}
fn oct_texel(uv: vec2<f32>, res: i32) -> i32 {
  let fr = f32(res);
  let tx = clamp(i32(floor((uv.x + 1.0) / 2.0 * fr)), 0, res - 1);
  let ty = clamp(i32(floor((uv.y + 1.0) / 2.0 * fr)), 0, res - 1);
  return tx + res * ty;
}
fn fibonacci_dir(i: i32, ray_count: i32) -> vec3<f32> {
  let fi = f32(i);
  let y = 1.0 - fi / max(f32(ray_count - 1), 1.0) * 2.0;
  let rad = sqrt(clamp(1.0 - y * y, 0.0, 1.0));
  let th = fi * P.misc.y;
  return vec3<f32>(cos(th) * rad, y, sin(th) * rad);
}
fn sky_radiance(dir: vec3<f32>) -> vec3<f32> {
  let t = clamp(abs(dir.y), 0.0, 1.0);
  let s = t * t * (3.0 - 2.0 * t);
  return mix(P.horizon.xyz, select(P.ground.xyz, P.zenith.xyz, dir.y >= 0.0), s);
}
fn luma(c: vec3<f32>) -> f32 { return c.x * 0.2126 + c.y * 0.7152 + c.z * 0.0722; }

// ---------------------------------------------------------------- march / normal (marchVoxelsTSL / voxelNormalTSL)
// fixed-step march; returns hitT (-1 = miss). `go_on` no-ops rays that already missed. break == the TSL `go` guard (hitT recorded at first solid).
fn march(origin: vec3<f32>, dir: vec3<f32>, max_dist: f32, go_on: bool) -> f32 {
  let step = P.vcell.x * 0.5;
  var t = 0.0;
  var hit_t = -1.0;
  for (var i = 0; i < P.vint.y; i = i + 1) {
    if (!(t < max_dist && hit_t < 0.0 && go_on)) { break; }
    let p = origin + dir * t;
    if (is_solid(read_at_world(p))) { hit_t = t; }
    t = t + step;
  }
  return hit_t;
}
fn voxel_normal(hit_pos: vec3<f32>, dir: vec3<f32>) -> vec3<f32> {
  let c = cell_of(hit_pos);
  let o = func_occ(c);
  let g = vec3<f32>(o[0] - o[1], o[2] - o[3], o[4] - o[5]);
  let len = length(g);
  let g_n = g / max(len, 1e-4);
  let faced = select(g_n, -g_n, dot(g_n, dir) > 0.0);
  return select(faced, -dir, len < 1e-4);
}
// 6-neighbour occupancy: [-x,+x,-y,+y,-z,+z] (g = occ(-1)-occ(+1) per axis)
fn func_occ(c: vec3<i32>) -> array<f32, 6> {
  var r: array<f32, 6>;
  r[0] = select(0.0, 1.0, is_solid(read_voxel(c.x - 1, c.y, c.z)));
  r[1] = select(0.0, 1.0, is_solid(read_voxel(c.x + 1, c.y, c.z)));
  r[2] = select(0.0, 1.0, is_solid(read_voxel(c.x, c.y - 1, c.z)));
  r[3] = select(0.0, 1.0, is_solid(read_voxel(c.x, c.y + 1, c.z)));
  r[4] = select(0.0, 1.0, is_solid(read_voxel(c.x, c.y, c.z - 1)));
  r[5] = select(0.0, 1.0, is_solid(read_voxel(c.x, c.y, c.z + 1)));
  return r;
}

// ---------------------------------------------------------------- cascade tables (cascadeFields / probeWorldPos / batchProbeIndex)
fn cascade_of(probe_idx: i32) -> i32 {
  var k = 0;
  for (var j = 1; j < P.vint.w; j = j + 1) { if (probe_idx >= i32(P.cas[j].b.w)) { k = j; } }
  return k;
}
fn probe_world_pos(probe_idx: i32) -> vec3<f32> {
  let k = cascade_of(probe_idx);
  let c = P.cas[k];
  let dd = vec3<i32>(c.b.xyz);
  let slot = probe_idx - i32(c.b.w);
  let s = vec3<i32>(slot % dd.x, (slot / dd.x) % dd.y, slot / (dd.x * dd.y));
  let base = vec3<i32>(c.a.xyz);
  let cell = base + ((((s - base) % dd) + dd) % dd);   // positive mod (WGSL % keeps the dividend sign)
  return vec3<f32>(cell) * c.a.w;
}
fn batch_probe_index(ordinal: i32) -> i32 {
  var within = ordinal;
  var start = i32(P.start.x);
  let c0 = P.cas[0];
  var count = i32(c0.b.x) * i32(c0.b.y) * i32(c0.b.z);
  var base_index = i32(c0.b.w);
  for (var k = 1; k < P.vint.w; k = k + 1) {
    let is_k = ordinal >= i32(P.cum[k - 1]);
    let ck = P.cas[k];
    within = select(within, ordinal - i32(P.cum[k - 1]), is_k);
    start = select(start, i32(P.start[k]), is_k);
    count = select(count, i32(ck.b.x) * i32(ck.b.y) * i32(ck.b.z), is_k);
    base_index = select(base_index, i32(ck.b.w), is_k);
  }
  return base_index + (start + within) % count;   // toroidal round-robin: no wrap split
}

// ---------------------------------------------------------------- probe state (resolveProbeTSL)
struct Resolved { pos: vec3<f32>, disabled: bool };
fn resolve_probe(probe_pos: vec3<f32>) -> Resolved {
  let solid_here = is_solid(read_at_world(probe_pos));
  var dirs = array<vec3<f32>, 6>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(-1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, -1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, -1.0));
  var reloc = probe_pos;
  var found = false;
  if (solid_here) {
    // candidates in priority order (k, then +-x,+-y,+-z); first free wins (TSL assigns in reverse so the highest priority lands last)
    for (var k = 1; k <= P.vint.z; k = k + 1) {
      if (f32(k) * P.vcell.x > P.vcell.z) { break; }
      for (var d = 0; d < 6; d = d + 1) {
        if (!found) {
          let q = probe_pos + dirs[d] * (f32(k) * P.vcell.x);
          if (!is_solid(read_at_world(q))) { reloc = q; found = true; }
        }
      }
    }
  }
  var r: Resolved;
  r.pos = select(probe_pos, reloc, solid_here);
  r.disabled = solid_here && !found;
  return r;
}

// ---------------------------------------------------------------- cascade query (queryCascadeTSL / queryCascadesTSL) — bounce read, same math as forward.wgsl gi_query
fn smooth01(t: f32) -> f32 { let c = clamp(t, 0.0, 1.0); return c * c * (3.0 - 2.0 * c); }
fn pos_mod(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }
fn query_cascade(c: Cas, world: vec3<f32>, normal: vec3<f32>) -> vec4<f32> {
  let sp = c.a.w;
  let base_cell = c.a.xyz;
  let rel = world / sp - base_cell;
  let base = floor(rel);
  let fr = rel - base;
  let irr_res = i32(P.res.x);
  let dep_res = i32(P.res.y);
  let dx = i32(c.b.x);
  let dy = i32(c.b.y);
  let dz = i32(c.b.z);
  let nuv = encode_oct(normal);
  var total = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var o = 0; o < 8; o = o + 1) {
    let ox = o & 1;
    let oy = (o >> 1) & 1;
    let oz = (o >> 2) & 1;
    let cell_abs = base_cell + base + vec3<f32>(f32(ox), f32(oy), f32(oz));
    let wx = select(1.0 - fr.x, fr.x, ox == 1);
    let wy = select(1.0 - fr.y, fr.y, oy == 1);
    let wz = select(1.0 - fr.z, fr.z, oz == 1);
    let tril_w = wx * wy * wz;
    let corner_world = cell_abs * sp;
    let to_probe = corner_world - world;
    let test_dist = length(to_probe);
    let near_zero = test_dist < 1e-6;
    let backface = select(max(0.0, dot(normal, normalize(to_probe))), 1.0, near_zero);
    let slot = pos_mod(i32(cell_abs.x), dx) + dx * (pos_mod(i32(cell_abs.y), dy) + dy * pos_mod(i32(cell_abs.z), dz));
    let p_idx = slot + i32(c.b.w);
    let irr = irr_atlas[u32(p_idx * irr_res * irr_res + oct_texel(nuv, irr_res))].xyz;
    let d_dir = select(normalize(world - corner_world), normal, near_zero);
    let md = depth_atlas[u32(p_idx * dep_res * dep_res + oct_texel(encode_oct(d_dir), dep_res))];
    let variance = max(md.y - md.x * md.x, 1e-4);
    let d = test_dist - md.x;
    let cheb = select(clamp(variance / (variance + d * d), 0.0, 1.0), 1.0, test_dist <= md.x);
    let usable = md.x >= 0.0;   // depth sentinel -1 = disabled / fresh probe
    let w = select(0.0, tril_w * backface * cheb, usable);
    total = total + irr * w;
    wsum = wsum + w;
  }
  return vec4<f32>(total / max(wsum, 1e-6), wsum);
}
// queryCascadesTSL(...).value
fn query_cascades(world: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
  let n = P.vint.w;
  let blend = P.misc.x;
  var qv: array<vec3<f32>, 4>;
  var qw: array<f32, 4>;
  var inside: array<bool, 4>;
  var border: array<f32, 4>;
  for (var k = 0; k < n; k = k + 1) {
    let c = P.cas[k];
    let q = query_cascade(c, world, normal);
    qv[k] = q.xyz;
    qw[k] = q.w;
    let rel = world / c.a.w - c.a.xyz;
    let ext = c.b.xyz - vec3<f32>(1.0);
    inside[k] = all(rel >= vec3<f32>(0.0)) && all(rel <= ext);
    let m = min(min(min(rel.x, ext.x - rel.x), min(rel.y, ext.y - rel.y)), min(rel.z, ext.z - rel.z));
    border[k] = max(0.0, m);
  }
  var result = vec3<f32>(0.0);
  let last = n - 1;
  if (inside[last] && qw[last] > COVERAGE_WEIGHT_EPS) { result = qv[last]; }
  for (var k = n - 2; k >= 0; k = k - 1) {
    let u_k = inside[k] && qw[k] > COVERAGE_WEIGHT_EPS;
    let u_k1 = inside[k + 1] && qw[k + 1] > COVERAGE_WEIGHT_EPS;
    let w_fine = select(1.0, smooth01(border[k] / blend), u_k1);
    if (u_k) { result = mix(result, qv[k], w_fine); }
  }
  return result;
}

// ---------------------------------------------------------------- pass 1: TRACE (one thread per (batch probe, ray)) — createOpenTraceKernel
@compute @workgroup_size(64)
fn trace(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let tid = linear_id(gid, nwg);
  if (tid >= P.cnt.x) { return; }
  let rays = i32(P.res.z);
  let probe_local = i32(tid) / rays;
  let ray_i = i32(tid) % rays;
  let probe_idx = batch_probe_index(probe_local);
  let probe_pos0 = probe_world_pos(probe_idx);
  let st = resolve_probe(probe_pos0);
  let probe_pos = st.pos;
  let disabled = st.disabled;
  let dir = fibonacci_dir(ray_i, rays);
  let max_dist = P.vcell.y;
  let hit_t = march(probe_pos, dir, max_dist, !disabled);
  let hit = hit_t >= 0.0;
  var radiance = sky_radiance(dir);
  if (hit) {
    let hit_pos = probe_pos + dir * max(hit_t, 0.0);
    let N = voxel_normal(hit_pos, dir);
    let albedo = unpack_albedo(read_at_world(hit_pos));
    let out_pos = hit_pos + N * (P.vcell.x * 1.01);
    let L = normalize(-P.sun_dir.xyz);
    let ndotl = max(0.0, dot(N, L));
    let sun_t = march(out_pos, L, max_dist, ndotl > 0.0);
    let sun_e = select(vec3<f32>(0.0), P.sun_col.xyz * ndotl * P.sun_col.w, ndotl > 0.0 && sun_t < 0.0);
    let bounce = query_cascades(out_pos, N) * P.vcell.w;
    radiance = albedo * (sun_e + bounce) * RECIP_PI;
  }
  ray_buf[u32(probe_local * rays + ray_i)] = select(vec4<f32>(radiance, hit_t), vec4<f32>(0.0, 0.0, 0.0, DISABLED_HIT), disabled);
}

// ---------------------------------------------------------------- pass 2a: IRRADIANCE blend (per texel) — createOpenIrradianceBlendKernel
@compute @workgroup_size(64)
fn irr_blend(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let tid = linear_id(gid, nwg);
  if (tid >= P.cnt.y) { return; }
  let res = i32(P.res.x);
  let tpp = res * res;
  let rays = i32(P.res.z);
  let probe_local = i32(tid) / tpp;
  let local_texel = i32(tid) % tpp;
  let probe_idx = batch_probe_index(probe_local);
  let atlas_index = u32(probe_idx * tpp + local_texel);
  let octu = (f32(local_texel % res) + 0.5) / f32(res) * 2.0 - 1.0;
  let octv = (f32(local_texel / res) + 0.5) / f32(res) * 2.0 - 1.0;
  let texel_dir = decode_oct(vec2<f32>(octu, octv));
  let ray_base = probe_local * rays;
  let disabled = ray_buf[u32(ray_base)].w < DISABLED_HIT + 0.5;
  var sample_est = vec3<f32>(0.0);
  for (var r = 0; r < rays; r = r + 1) {
    let dir = fibonacci_dir(r, rays);
    sample_est = sample_est + ray_buf[u32(ray_base + r)].xyz * max(0.0, dot(texel_dir, dir));
  }
  let new_est = sample_est * (4.0 * PI / f32(rays));
  let old = irr_atlas[atlas_index].xyz;
  let rel = abs(luma(new_est) - luma(old)) / (max(luma(new_est), luma(old)) + 1e-3);
  let dep_tpp = i32(P.res.y) * i32(P.res.y);
  let fresh_probe = depth_atlas[u32(probe_idx * dep_tpp)].x < 0.0;   // depth sentinel (-1): just entered the window / was disabled -> no blend with stale data
  let a_eff = select(mix(P.hy.x, P.hy.z, clamp(rel / P.hy.w, 0.0, 1.0)), 0.0, fresh_probe);
  irr_atlas[atlas_index] = vec4<f32>(select(mix(new_est, old, a_eff), vec3<f32>(0.0), disabled), 0.0);
}

// ---------------------------------------------------------------- pass 2b: DEPTH blend (per texel) — createOpenDepthBlendKernel
@compute @workgroup_size(64)
fn depth_blend(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nwg: vec3<u32>) {
  let tid = linear_id(gid, nwg);
  if (tid >= P.cnt.z) { return; }
  let res = i32(P.res.y);
  let tpp = res * res;
  let rays = i32(P.res.z);
  let probe_local = i32(tid) / tpp;
  let local_texel = i32(tid) % tpp;
  let probe_idx = batch_probe_index(probe_local);
  let atlas_index = u32(probe_idx * tpp + local_texel);
  let octu = (f32(local_texel % res) + 0.5) / f32(res) * 2.0 - 1.0;
  let octv = (f32(local_texel / res) + 0.5) / f32(res) * 2.0 - 1.0;
  let texel_dir = decode_oct(vec2<f32>(octu, octv));
  let ray_base = probe_local * rays;
  let disabled = ray_buf[u32(ray_base)].w < DISABLED_HIT + 0.5;
  var w_sum = 0.0;
  var d_sum = 0.0;
  var d2_sum = 0.0;
  for (var r = 0; r < rays; r = r + 1) {
    let dir = fibonacci_dir(r, rays);
    let hit_t = ray_buf[u32(ray_base + r)].w;
    let dist = select(P.vcell.y, hit_t, hit_t >= 0.0);
    let w = max(0.0, dot(texel_dir, dir));
    w_sum = w_sum + w;
    d_sum = d_sum + w * dist;
    d2_sum = d2_sum + w * dist * dist;
  }
  let sw = max(w_sum, 1e-5);
  let fresh = vec2<f32>(d_sum / sw, d2_sum / sw);
  let old = depth_atlas[atlas_index];
  let blended = select(mix(fresh, old, P.hy.y), fresh, old.x < 0.0);   // old sentinel (-1) -> take new directly
  depth_atlas[atlas_index] = select(blended, vec2<f32>(-1.0, -1.0), disabled);
}
