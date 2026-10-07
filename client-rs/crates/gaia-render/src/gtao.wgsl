// r12-post: GTAO. LINE-FOR-LINE PORT of three r180 examples/jsm/tsl/display/GTAONode.js (setup() `ao` Fn, L~160-250 of the file) + src/nodes/utils/PostProcessingUtils.js
// (getViewPosition L17, getScreenPosition L48, getNormalFromDepth L67). Not hand-designed: every expression below mirrors a TSL node of that Fn (cited as GTAONode:<tsl name>).
// Inputs: full-res scene depth (Depth32Float, WebGPU 0..1 NDC), 5x5 magic-square noise (GTAONode generateMagicSquareNoise). Normals = RECONSTRUCTED FROM DEPTH
// (getNormalFromDepth, three's own fallback when ao(depth, null, camera) has no normal node) -- the core has no normal MRT target.
// Output: R = raw GTAO term (white/1 where sky = three `depth >= 1 -> discard` over a white clear), G = engine rig distance-fade weight (lighting/post.js aoFade: 1 - smoothstep(fadeStart, fadeEnd, -viewZ)).
struct AoU {
  proj: mat4x4<f32>,
  proj_inv: mat4x4<f32>,
  p0: vec4<f32>, // radius, thickness, samples, distanceExponent
  p1: vec4<f32>, // distanceFallOff, scale, fadeStart, fadeEnd
  res: vec4<f32>, // AO target size (resolution uniform), unused
};
@group(0) @binding(0) var<uniform> au: AoU;
@group(0) @binding(1) var depth_tex: texture_depth_2d;
@group(0) @binding(2) var noise_tex: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}
const PI: f32 = 3.14159265358979;
fn dsize() -> vec2<i32> { return vec2<i32>(textureDimensions(depth_tex)); }
// GTAONode sampleDepth(uv): depthNode.sample(uv).r  (nearest, clamp-to-edge)
fn sample_depth(uv: vec2<f32>) -> f32 {
  let s = dsize();
  let p = clamp(vec2<i32>(floor(uv * vec2<f32>(s))), vec2<i32>(0), s - vec2<i32>(1));
  return textureLoad(depth_tex, p, 0);
}
fn load_depth(p: vec2<i32>) -> f32 { let s = dsize(); return textureLoad(depth_tex, clamp(p, vec2<i32>(0), s - vec2<i32>(1)), 0); }
// PostProcessingUtils.getViewPosition (WebGPUCoordinateSystem branch)
fn get_view_position(screen: vec2<f32>, depth: f32) -> vec3<f32> {
  let sp = vec2<f32>(screen.x, 1.0 - screen.y) * 2.0 - 1.0;
  let v = au.proj_inv * vec4<f32>(sp, depth, 1.0);
  return v.xyz / v.w;
}
// PostProcessingUtils.getScreenPosition
fn get_screen_position(view: vec3<f32>) -> vec2<f32> {
  let c = au.proj * vec4<f32>(view, 1.0);
  let uv = c.xy / c.w * 0.5 + 0.5;
  return vec2<f32>(uv.x, 1.0 - uv.y);
}
// PostProcessingUtils.getNormalFromDepth (5-tap, picks the smaller one-sided depth delta per axis)
fn get_normal_from_depth(uv: vec2<f32>) -> vec3<f32> {
  let size = vec2<f32>(dsize());
  let p = vec2<i32>(uv * size);
  let c0 = load_depth(p);
  let l2 = load_depth(p - vec2<i32>(2, 0));
  let l1 = load_depth(p - vec2<i32>(1, 0));
  let r1 = load_depth(p + vec2<i32>(1, 0));
  let r2 = load_depth(p + vec2<i32>(2, 0));
  let b2 = load_depth(p + vec2<i32>(0, 2));
  let b1 = load_depth(p + vec2<i32>(0, 1));
  let t1 = load_depth(p - vec2<i32>(0, 1));
  let t2 = load_depth(p - vec2<i32>(0, 2));
  let dl = abs((2.0 * l1 - l2) - c0);
  let dr = abs((2.0 * r1 - r2) - c0);
  let db = abs((2.0 * b1 - b2) - c0);
  let dt = abs((2.0 * t1 - t2) - c0);
  let ce = get_view_position(uv, c0);
  var dpdx: vec3<f32>;
  if (dl < dr) { dpdx = ce - get_view_position(uv - vec2<f32>(1.0 / size.x, 0.0), l1); }
  else { dpdx = -ce + get_view_position(uv + vec2<f32>(1.0 / size.x, 0.0), r1); }
  var dpdy: vec3<f32>;
  if (db < dt) { dpdy = ce - get_view_position(uv + vec2<f32>(0.0, 1.0 / size.y), b1); }
  else { dpdy = -ce + get_view_position(uv - vec2<f32>(0.0, 1.0 / size.y), t1); }
  return normalize(cross(dpdx, dpdy));
}
@fragment
fn fs_gtao(in: VO) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let depth = sample_depth(uv);
  if (depth >= 1.0) { return vec4<f32>(1.0, 1.0, 1.0, 1.0); } // GTAONode: depth.greaterThanEqual(1.0).discard() over clear 0xffffff
  let view_pos = get_view_position(uv, depth);
  let view_normal = get_normal_from_depth(uv);
  let radius = au.p0.x;
  let thickness = au.p0.y;
  let samples = au.p0.z;
  let dist_exp = au.p0.w;
  let fall_off = au.p1.x;
  // noiseUv = vec2(uv.x, 1-uv.y) * resolution / noiseResolution ; DataTexture = Nearest + Repeat => texel = floor(uvFlip*resolution) mod 5
  let nuv = vec2<f32>(uv.x, 1.0 - uv.y) * au.res.xy;
  let nres = vec2<i32>(textureDimensions(noise_tex));
  let np = vec2<i32>(floor(nuv)) % nres;
  let noise = textureLoad(noise_tex, vec2<i32>((np.x + nres.x) % nres.x, (np.y + nres.y) % nres.y), 0);
  let random_vec = noise.xyz * 2.0 - 1.0;
  let tangent = normalize(vec3<f32>(random_vec.xy, 0.0));
  let bitangent = vec3<f32>(-tangent.y, tangent.x, 0.0);
  let kernel = mat3x3<f32>(tangent, bitangent, vec3<f32>(0.0, 0.0, 1.0));
  let directions = select(5.0, 3.0, samples < 30.0); // GTAONode: samples.lessThan(30).select(3, 5)
  let steps = (samples + (directions - 1.0)) / directions;
  let n_dir = i32(directions);
  let n_steps = i32(steps);
  var ao = 0.0;
  for (var i = 0; i < n_dir; i = i + 1) {
    let angle = f32(i) / directions * PI;
    var sample_dir = vec4<f32>(cos(angle), sin(angle), 0.0, 0.5 + 0.5 * noise.w);
    sample_dir = vec4<f32>(normalize(kernel * sample_dir.xyz), sample_dir.w);
    let view_dir = normalize(-view_pos);
    let slice_bitangent = normalize(cross(sample_dir.xyz, view_dir));
    let slice_tangent = cross(slice_bitangent, view_dir);
    let normal_in_slice = normalize(view_normal - slice_bitangent * dot(view_normal, slice_bitangent));
    let tangent_to_normal_in_slice = cross(normal_in_slice, slice_bitangent);
    var cos_h = vec2<f32>(dot(view_dir, tangent_to_normal_in_slice), dot(view_dir, -tangent_to_normal_in_slice));
    for (var j = 0; j < n_steps; j = j + 1) {
      let off = sample_dir.xyz * radius * sample_dir.w * pow((f32(j) + 1.0) / steps, dist_exp);
      let w = mix(1.0, 2.0 / (f32(j) + 2.0), fall_off);
      // x
      let spx = get_screen_position(view_pos + off);
      let svx = get_view_position(spx, sample_depth(spx));
      let dx = svx - view_pos;
      if (abs(dx.z) < thickness) {
        let sch = dot(view_dir, normalize(dx));
        cos_h.x = cos_h.x + max(0.0, (sch - cos_h.x) * w);
      }
      // y
      let spy = get_screen_position(view_pos - off);
      let svy = get_view_position(spy, sample_depth(spy));
      let dy = svy - view_pos;
      if (abs(dy.z) < thickness) {
        let sch = dot(view_dir, normalize(dy));
        cos_h.y = cos_h.y + max(0.0, (sch - cos_h.y) * w);
      }
    }
    let sin_h = sqrt(1.0 - cos_h * cos_h);
    let nx = dot(normal_in_slice, slice_tangent);
    let ny = dot(normal_in_slice, view_dir);
    let nxb = 0.5 * (acos(cos_h.y) - acos(cos_h.x) + (sin_h.x * cos_h.x - sin_h.y * cos_h.y));
    let nyb = 0.5 * (2.0 - cos_h.x * cos_h.x - cos_h.y * cos_h.y);
    ao = ao + (nx * nxb + ny * nyb);
  }
  ao = clamp(ao / directions, 0.0, 1.0);
  ao = pow(ao, au.p1.y); // scale
  // engine rig fade (client/kernel/lighting/post.js L98-101): dist = -viewZ ; weight = 1 - smoothstep(fadeStart, fadeEnd, dist)
  let weight = 1.0 - smoothstep(au.p1.z, au.p1.w, -view_pos.z);
  return vec4<f32>(ao, weight, 0.0, 1.0);
}
