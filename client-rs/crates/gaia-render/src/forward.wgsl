// Forward PBR (metallic-roughness, GGX/Smith/Schlick) — sun + N point lights.
// Uniform-only bindings (no storage buffers) so the same WGSL runs on Metal and WebGPU.
const MAX_POINT_LIGHTS: u32 = 64u;
const MAX_EXTRA_DIRS: u32 = 4u;
const PI: f32 = 3.14159265;

// color.w = falloff: >= 0 three decay exponent (0 flat, 2 inverse-square); < 0 DS1 ramp, begin/range = -w - 1
struct PointLight { position_range: vec4<f32>, color: vec4<f32> };
struct DirLight { dir: vec4<f32>, color: vec4<f32> };
struct Frame {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    sun_dir: vec4<f32>,      // xyz = direction light travels
    sun_color: vec4<f32>,    // rgb * intensity
    ambient: vec4<f32>,      // rgb, w = exposure
    counts: vec4<u32>,       // x = point light count
    points: array<PointLight, MAX_POINT_LIGHTS>,
    ambient_ground: vec4<f32>, // hemisphere ambient: ground (down-facing) colour; `ambient.rgb` = sky (up-facing)
    fog_color: vec4<f32>,    // rgb linear; w = mode (0 none, 1 smoothstep(near,far) [three Fog], 2 exp2 [three FogExp2])
    fog_params: vec4<f32>,   // x near, y far, z density
    cam_fwd: vec4<f32>,      // xyz camera forward (view depth for fog)
    env: vec4<f32>,          // x = IBL diffuse on (1) / off (0), y = intensity
    sh: array<vec4<f32>, 9>, // IBL diffuse irradiance, SH9, already cosine-convolved and /PI: E(n)/PI = sum Y_i(n) sh[i].rgb
    post: vec4<f32>,         // r10: x = 1 HDR scene target (linear out, exposure + tone map happen in the post resolve)
    xdir_count: vec4<u32>,   // lane dynlight: x = extra directional light count
    xdirs: array<DirLight, MAX_EXTRA_DIRS>, // extra directional lights (no shadow): dir = direction the light travels, color = rgb * intensity
};
struct Material {
    base_color: vec4<f32>,
    params: vec4<f32>,       // x metallic, y roughness, z alpha cutoff (<0 = none), w has_texture
    emissive: vec4<f32>,
    flags: vec4<f32>,        // x unlit (1 = base colour only: no lights/shadow/tonemap exposure), y emissive x base texture (three emissiveMap === map), z unlit but tone-mapped (three toneMapped:true Basic), w bitfield: 4 = scene fog NOT applied (three material.fog=false), 1 = sun shadow NOT sampled (three receiveShadow:false), 2 = probe GI NOT sampled (non-node material: hemi only), 4 = scene fog NOT applied, 8 = extra directional lights (xdirs) apply (character material)
    maps0: vec4<f32>,        // x has array base, y normal scale, z has normal map, w has roughness map
    maps1: vec4<f32>,        // x has metalness map, y has emissive map, z has AO map, w side (0 double, 1 front only, 2 back only)
};
@group(0) @binding(0) var<uniform> frame: Frame;
// ---- r6 probe GI (gi.rs): atlases read back from three's GI compute, sampled with the SAME math as client/kernel/gi/gi-open-nodes.js ----
struct GiCascade { a: vec4<f32>, b: vec4<f32> };  // a = (baseCell.xyz window min cell, spacing) · b = (dims.xyz, baseIndex)
struct Gi {
info: vec4<f32>,         // x cascade count (0 = GI off), y blendCells, z irradianceRes, w depthRes
tex: vec4<u32>,          // x irradiance tex width, y depth tex width, z mode (0 add · 1 replace)
cas: array<GiCascade, 4>,
};
@group(0) @binding(1) var<uniform> gi: Gi;
@group(0) @binding(2) var gi_irr: texture_2d<f32>;   // Rgba32Float, texel i = (i % W, i / W), rgb = irradiance E
@group(0) @binding(3) var gi_depth: texture_2d<f32>; // Rg32Float, (mean dist, mean dist^2)
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var base_tex: texture_2d<f32>;
@group(1) @binding(2) var base_samp: sampler;
// Baked lightmap at TEXCOORD_1; material.emissive.w = overlay fac (0 = none).
@group(1) @binding(3) var lightmap_tex: texture_2d<f32>;
@group(1) @binding(4) var base_array: texture_2d_array<f32>; // layer = round(uv1.x)
@group(1) @binding(5) var normal_tex: texture_2d<f32>;
@group(1) @binding(6) var rough_tex: texture_2d<f32>;    // G channel (three roughnessMap)
@group(1) @binding(7) var metal_tex: texture_2d<f32>;    // B channel (three metalnessMap)
@group(1) @binding(8) var emissive_tex: texture_2d<f32>;
@group(1) @binding(9) var ao_tex: texture_2d<f32>;       // R channel (three aoMap)
// Sun cascaded shadow maps (shadow.rs). params.x = cascade count (0 = shadows off).
struct Shadow {
vp: array<mat4x4<f32>, 4>,
splits: vec4<f32>,       // cascade far distances (view depth)
texel: vec4<f32>,        // world size of one shadow texel, per cascade
range: vec4<f32>,        // light-space depth range, per cascade
cam_fwd: vec4<f32>,
params: vec4<f32>,       // x cascades, y normal bias (texels), z depth bias (texels), w pcf radius
info: vec4<f32>,         // x 1/resolution, y cascade blend fraction
};
@group(2) @binding(0) var<uniform> shadow: Shadow;
@group(2) @binding(1) var shadow_map: texture_depth_2d_array;
@group(2) @binding(2) var shadow_samp: sampler_comparison;
fn shadow_cascade(c: i32, world: vec3<f32>, n: vec3<f32>, nl: f32) -> f32 {
let texel = shadow.texel[c];
let p = world + n * (shadow.params.y * texel * (1.0 - nl));
let clip = shadow.vp[c] * vec4<f32>(p, 1.0);
let uv = vec2<f32>(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
let z = clip.z - shadow.params.z * texel / shadow.range[c];
if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z > 1.0) {
return 1.0;
}
let r = i32(shadow.params.w);
var sum = 0.0;
for (var y = -r; y <= r; y = y + 1) {
for (var x = -r; x <= r; x = x + 1) {
sum = sum + textureSampleCompareLevel(shadow_map, shadow_samp, uv + vec2<f32>(f32(x), f32(y)) * shadow.info.x, c, z);
}
}
let w = f32(2 * r + 1);
return sum / (w * w);
}
// 1 = lit. Beyond the last cascade = lit.
fn sun_shadow(world: vec3<f32>, cam: vec3<f32>, n: vec3<f32>, nl: f32) -> f32 {
let count = i32(shadow.params.x);
if (count == 0 || nl <= 0.0) { return 1.0; }
let vd = dot(world - cam, shadow.cam_fwd.xyz);
var c = 0;
for (var i = 0; i < count - 1; i = i + 1) {
if (vd > shadow.splits[i]) { c = i + 1; }
}
if (vd > shadow.splits[c]) { return 1.0; }
var s = shadow_cascade(c, world, n, nl);
let prev = select(0.0, shadow.splits[max(c - 1, 0)], c > 0);
let band = (shadow.splits[c] - prev) * shadow.info.y;
let t = (vd - (shadow.splits[c] - band)) / max(band, 1e-4);
if (t > 0.0 && c < count - 1) {
s = mix(s, shadow_cascade(c + 1, world, n, nl), clamp(t, 0.0, 1.0));
}
return s;
}

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) uv1: vec2<f32>,
    @location(4) color: vec4<f32>,
};

// ---- gi-open-nodes.js ports (line refs = that file) ----
const GI_COVERAGE_WEIGHT_EPS: f32 = 1e-6;   // gi-reference.js COVERAGE_WEIGHT_EPS
const GI_COVERAGE_WEIGHT_FADE: f32 = 1e-3;  // gi-reference.js COVERAGE_WEIGHT_FADE
fn gi_smooth01(t: f32) -> f32 { let c = clamp(t, 0.0, 1.0); return c * c * (3.0 - 2.0 * c); }   // :79
fn gi_sign_not_zero(v: f32) -> f32 { return select(1.0, -1.0, v < 0.0); }                          // :198
fn gi_encode_oct(dir: vec3<f32>) -> vec2<f32> {                                                     // encodeOctTSL :199-203
let l1 = abs(dir.x) + abs(dir.y) + abs(dir.z);
let inv = 1.0 / max(l1, 1e-8);
let u0 = dir.x * inv;
let v0 = dir.y * inv;
let folded = dir.z < 0.0;
return vec2<f32>(select(u0, (1.0 - abs(v0)) * gi_sign_not_zero(u0), folded), select(v0, (1.0 - abs(u0)) * gi_sign_not_zero(v0), folded));
}
fn gi_oct_texel(uv: vec2<f32>, res: i32) -> i32 {                                                    // octTexel :209-212
let fr = f32(res);
let tx = clamp(i32(floor((uv.x + 1.0) / 2.0 * fr)), 0, res - 1);
let ty = clamp(i32(floor((uv.y + 1.0) / 2.0 * fr)), 0, res - 1);
return tx + res * ty;
}
fn gi_irr_at(i: i32) -> vec3<f32> {
let w = i32(gi.tex.x);
return textureLoad(gi_irr, vec2<i32>(i % w, i / w), 0).rgb;
}
fn gi_depth_at(i: i32) -> vec2<f32> {
let w = i32(gi.tex.y);
return textureLoad(gi_depth, vec2<i32>(i % w, i / w), 0).rg;
}
fn gi_pos_mod(a: i32, n: i32) -> i32 { return ((a % n) + n) % n; }  // TSL uses CELL_BIAS = 0 mod pow2 dims; exact positive mod here
// queryCascadeTSL :45-78 — one cascade, 8 corners, Chebyshev + backface + disabled-sentinel skip. returns (value.xyz, weightSum)
fn gi_query_cascade(c: GiCascade, world: vec3<f32>, normal: vec3<f32>) -> vec4<f32> {
let sp = c.a.w;
let base_cell = c.a.xyz;
let rel = world / sp - base_cell;
let base = floor(rel);
let fr = rel - base;
let irr_res = i32(gi.info.z);
let dep_res = i32(gi.info.w);
let dx = i32(c.b.x);
let dy = i32(c.b.y);
let dz = i32(c.b.z);
let nuv = gi_encode_oct(normal);
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
let slot = gi_pos_mod(i32(cell_abs.x), dx) + dx * (gi_pos_mod(i32(cell_abs.y), dy) + dy * gi_pos_mod(i32(cell_abs.z), dz));
let p_idx = slot + i32(c.b.w);
let irr = gi_irr_at(p_idx * irr_res * irr_res + gi_oct_texel(nuv, irr_res));
let d_dir = select(normalize(world - corner_world), normal, near_zero);
let md = gi_depth_at(p_idx * dep_res * dep_res + gi_oct_texel(gi_encode_oct(d_dir), dep_res));
let variance = max(md.y - md.x * md.x, 1e-4);
let d = test_dist - md.x;
let cheb = select(clamp(variance / (variance + d * d), 0.0, 1.0), 1.0, test_dist <= md.x);
let usable = md.x >= 0.0; // depth sentinel -1 = disabled / fresh probe
let w = select(0.0, tril_w * backface * cheb, usable);
total = total + irr * w;
wsum = wsum + w;
}
return vec4<f32>(total / max(wsum, 1e-6), wsum);
}
// queryCascadesCoverageTSL :95-109 (+ containsAndBorder :80-90). returns (E.xyz, coverage)
fn gi_query(world: vec3<f32>, normal: vec3<f32>) -> vec4<f32> {
let n = i32(gi.info.x);
let blend = gi.info.y;
var qv: array<vec3<f32>, 4>;
var qw: array<f32, 4>;
var inside: array<bool, 4>;
var border: array<f32, 4>;
for (var k = 0; k < n; k = k + 1) {
let c = gi.cas[k];
let q = gi_query_cascade(c, world, normal);
qv[k] = q.xyz;
qw[k] = q.w;
let rel = world / c.a.w - c.a.xyz;
let ext = c.b.xyz - vec3<f32>(1.0);
inside[k] = all(rel >= vec3<f32>(0.0)) && all(rel <= ext);
let m = min(min(min(rel.x, ext.x - rel.x), min(rel.y, ext.y - rel.y)), min(rel.z, ext.z - rel.z));
border[k] = max(0.0, m);
}
// usable(k) = inside && weightSum > EPS
var result = vec3<f32>(0.0);
let last = n - 1;
if (inside[last] && qw[last] > GI_COVERAGE_WEIGHT_EPS) { result = qv[last]; }
for (var k = n - 2; k >= 0; k = k - 1) {
let u_k = inside[k] && qw[k] > GI_COVERAGE_WEIGHT_EPS;
let u_k1 = inside[k + 1] && qw[k + 1] > GI_COVERAGE_WEIGHT_EPS;
let w_fine = select(1.0, gi_smooth01(border[k] / blend), u_k1);
if (u_k) { result = mix(result, qv[k], w_fine); }
}
var coverage = 0.0;
for (var k = 0; k < n; k = k + 1) {
let u_k = inside[k] && qw[k] > GI_COVERAGE_WEIGHT_EPS;
var cv = 0.0;
if (u_k) {
cv = gi_smooth01(qw[k] / GI_COVERAGE_WEIGHT_FADE);
if (k == last) { cv = cv * gi_smooth01(border[k] / blend); }
}
coverage = max(coverage, cv);
}
return vec4<f32>(result, coverage);
}
@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>,
           @location(3) m0: vec4<f32>, @location(4) m1: vec4<f32>, @location(5) m2: vec4<f32>, @location(6) m3: vec4<f32>,
           @location(7) uv1: vec2<f32>, @location(8) color: vec4<f32>, @location(9) icolor: vec4<f32>, @location(10) iuv: vec4<f32>) -> VsOut {
    // per-instance model matrix (instance-step vertex buffer: no storage buffers needed)
    let model = mat4x4<f32>(m0, m1, m2, m3);
    let world = model * vec4<f32>(pos, 1.0);
    var o: VsOut;
    o.clip = frame.view_proj * world;
    o.world = world.xyz;
    // uniform-scale assumption: normal via model 3x3 (non-uniform scale = NOTES open item)
    o.normal = (model * vec4<f32>(normal, 0.0)).xyz;
    o.uv = uv * iuv.zw + iuv.xy; // r19-pcol: per-instance uv window (default 0,0,1,1); uv1 (lightmap / array layer) untouched
    o.uv1 = uv1;
    o.color = color * icolor;
    return o;
}

fn sh_irradiance(n: vec3<f32>) -> vec3<f32> {
    var r = frame.sh[0].rgb * 0.282095;
    r = r + frame.sh[1].rgb * (0.488603 * n.y) + frame.sh[2].rgb * (0.488603 * n.z) + frame.sh[3].rgb * (0.488603 * n.x);
    r = r + frame.sh[4].rgb * (1.092548 * n.x * n.y) + frame.sh[5].rgb * (1.092548 * n.y * n.z);
    r = r + frame.sh[6].rgb * (0.315392 * (3.0 * n.z * n.z - 1.0)) + frame.sh[7].rgb * (1.092548 * n.x * n.z);
    r = r + frame.sh[8].rgb * (0.546274 * (n.x * n.x - n.y * n.y));
    return max(r, vec3<f32>(0.0));
}
// three fog (linear working space, scene-referred: applied before exposure/tonemap). depth = distance along camera forward.
fn apply_fog(c: vec3<f32>, world: vec3<f32>) -> vec3<f32> {
    let mode = frame.fog_color.w;
    if (mode < 0.5) { return c; }
    let d = max(dot(world - frame.camera_pos.xyz, frame.cam_fwd.xyz), 0.0);
    var f = 0.0;
    if (mode < 1.5) { f = smoothstep(frame.fog_params.x, frame.fog_params.y, d); }
    else { let k = frame.fog_params.z * d; f = 1.0 - exp(-k * k); }
    return mix(c, frame.fog_color.rgb, clamp(f, 0.0, 1.0));
}
fn d_ggx(nh: f32, a: f32) -> f32 {
    let a2 = a * a;
    let d = nh * nh * (a2 - 1.0) + 1.0;
    return a2 / (PI * d * d);
}
fn v_smith(nv: f32, nl: f32, a: f32) -> f32 {
    let k = a * 0.5;
    return 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k));
}
fn brdf(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, albedo: vec3<f32>, metallic: f32, rough: f32) -> vec3<f32> {
    let h = normalize(v + l);
    let nl = max(dot(n, l), 0.0);
    let nv = max(dot(n, v), 1e-4);
    let nh = max(dot(n, h), 0.0);
    let vh = max(dot(v, h), 0.0);
    let a = max(rough * rough, 0.002);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let f = f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - vh, 5.0);
    let spec = d_ggx(nh, a) * v_smith(nv, nl, a) * f;
    let diffuse = (vec3<f32>(1.0) - f) * (1.0 - metallic) * albedo / PI;
    return (diffuse + spec) * nl;
}

@fragment
fn fs_main(in: VsOut, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
    // derivatives first (uniform control flow): cotangent frame for normal mapping (no tangent attribute)
    let dp1 = dpdx(in.world); let dp2 = dpdy(in.world); let duv1 = dpdx(in.uv); let duv2 = dpdy(in.uv);
    let side = material.maps1.w;
    if ((side > 0.5 && side < 1.5 && !front) || (side > 1.5 && front)) { discard; }
    var base = material.base_color;
    var emis = material.emissive.rgb;
    if (material.params.w > 0.5) {
        let texel = textureSample(base_tex, base_samp, in.uv);
        base = base * texel;
        if (material.flags.y > 0.5) { emis = emis * texel.rgb; } // three emissiveMap: totalEmissive = emissive x emissiveMap.rgb
    }
    if (material.maps0.x > 0.5) {
    base = base * textureSample(base_array, base_samp, in.uv, i32(in.uv1.x + 0.5));
    }
    // glTF COLOR_0: multiplies base colour (rgb + alpha); 1.0 when the mesh has none.
    base = base * in.color;
    // DS client rule (lightmap.mjs overlayNode): Blender OVERLAY, linear inputs.
    let fac = material.emissive.w;
    if (fac > 0.0 && material.maps0.x < 0.5) {
        let l = textureSample(lightmap_tex, base_samp, in.uv1).rgb;
        let a = base.rgb;
        let tm = 1.0 - fac;
        let lo = a * (tm + 2.0 * fac * l);
        let hi = vec3<f32>(1.0) - (tm + 2.0 * fac * (vec3<f32>(1.0) - l)) * (vec3<f32>(1.0) - a);
        base = vec4<f32>(select(lo, hi, a >= vec3<f32>(0.5)), base.a);
    }
    if (material.params.z >= 0.0 && base.a < material.params.z) {
        discard;
    }
    if (material.flags.x > 0.5) {
        let cu = select(apply_fog(base.rgb, in.world), base.rgb, (u32(material.flags.w + 0.5) & 4u) != 0u); // r18: bit 4 = material.fog=false
        if (material.flags.z > 0.5) { // unlit but tone-mapped (three MeshBasicMaterial toneMapped:true): exposure + Reinhard, no lighting
            if (frame.post.x > 0.5) { return vec4<f32>(cu, base.a); }
        let eu = cu * frame.ambient.w;
            return vec4<f32>(eu / (vec3<f32>(1.0) + eu), base.a);
        }
        return vec4<f32>(cu, base.a); // unlit: authored colour as-is (backdrops, sky domes, additive cards)
    }
    var n = normalize(in.normal);
    if (!front) { n = -n; }
    if (material.maps0.z > 0.5) {
    let tn = textureSample(normal_tex, base_samp, in.uv).xyz * 2.0 - 1.0;
    let dp2perp = cross(dp2, n); let dp1perp = cross(n, dp1);
    let t = dp2perp * duv1.x + dp1perp * duv2.x;
    let b = dp2perp * duv1.y + dp1perp * duv2.y;
    let inv = inverseSqrt(max(max(dot(t, t), dot(b, b)), 1e-12));
    n = normalize(t * inv * tn.x * material.maps0.y + b * inv * tn.y * material.maps0.y + n * tn.z);
    }
    let v = normalize(frame.camera_pos.xyz - in.world);
    var m0 = material.params.x;
    var r0 = material.params.y;
    if (material.maps0.w > 0.5) { r0 = r0 * textureSample(rough_tex, base_samp, in.uv).g; }
    if (material.maps1.x > 0.5) { m0 = m0 * textureSample(metal_tex, base_samp, in.uv).b; }
    let metallic = clamp(m0, 0.0, 1.0);
    let rough = clamp(r0, 0.04, 1.0);
    let sun_l = -frame.sun_dir.xyz;
var color = brdf(n, v, sun_l, base.rgb, metallic, rough) * frame.sun_color.rgb
* select(sun_shadow(in.world, frame.camera_pos.xyz, n, max(dot(n, sun_l), 0.0)), 1.0, (u32(material.flags.w + 0.5) & 1u) != 0u);
    for (var i = 0u; i < min(frame.counts.x, MAX_POINT_LIGHTS); i = i + 1u) {
        let pl = frame.points[i];
        let d = pl.position_range.xyz - in.world;
        let dist2 = max(dot(d, d), 1e-4);
        let dist = sqrt(dist2);
        let range = pl.position_range.w;
        let fo = pl.color.w;
        var atten = 1.0;
        if (fo < 0.0) { // DS1 point ramp (docs/DS-LIGHTING-SHADERS.md s5): sat((R - d) * s), s = 1 / (R - begin)
            let ramp_begin = (-fo - 1.0) * range;
            atten = clamp((range - dist) / max(range - ramp_begin, 1e-4), 0.0, 1.0);
        } else { // three getDistanceAttenuation: 1 / max(d^decay, 0.01) x (range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1)
            atten = 1.0 / max(pow(dist, fo), 0.01);
            if (range > 0.0) {
                let r = dist / range;
                let w = clamp(1.0 - r * r * r * r, 0.0, 1.0);
                atten = atten * w * w;
            }
        }
        color = color + brdf(n, v, d / dist, base.rgb, metallic, rough) * pl.color.rgb * atten;
    }
    // extra directionals light ONLY materials flagged chr_light (flags.w bit 8): DS1 chr LightBank is character-only
    for (var i = 0u; i < select(0u, min(frame.xdir_count.x, MAX_EXTRA_DIRS), (u32(material.flags.w + 0.5) & 8u) != 0u); i = i + 1u) { // lane dynlight: extra directional lights (DS1 character LightBank dirs 1,2), unshadowed
        let xl = frame.xdirs[i];
        color = color + brdf(n, v, -xl.dir.xyz, base.rgb, metallic, rough) * xl.color.rgb;
    }
    // hemisphere ambient: lerp(ground, sky, 0.5 n.y + 0.5) x albedo (flat when sky == ground)
    let hemi = mix(frame.ambient_ground.rgb, frame.ambient.rgb, clamp(0.5 * n.y + 0.5, 0.0, 1.0));
    var ao = 1.0;
    if (material.maps1.z > 0.5) { ao = textureSample(ao_tex, base_samp, in.uv).r; }
    var em = emis;
    if (material.maps1.y > 0.5) { em = em * textureSample(emissive_tex, base_samp, in.uv).rgb; }
    // three PhysicalLightingModel.indirect: diffuseColor = albedo * (1 - metalness); hemi/ambient E/PI is pre-divided CPU-side. AO (aoMap.r) scales indirect diffuse only.
    var irr = hemi; // shader units = E / PI
    if (gi.info.x > 0.5 && (u32(material.flags.w + 0.5) & 2u) == 0u) { // flags.w bit 2 = no_gi (three attaches GI to NodeMaterials only)
        let q = gi_query(in.world, n);
        let g = q.xyz / PI;
        // ambient 'replace' (gi-open-nodes.js :116-117 ambientReplaceTSL + the hemi light's own +hemi): net E = hemi + c*(gi - hemi) = mix(hemi, gi, c); 'add': hemi + gi
        irr = select(hemi + g, mix(hemi, g, q.w), gi.tex.z == 1u);
    }
    color = color + irr * base.rgb * (1.0 - metallic) * ao + em;
    // IBL diffuse (scene.environment): SH9 irradiance x albedo x (1 - metallic). Specular IBL not implemented.
    if (frame.env.x > 0.5) { color = color + sh_irradiance(n) * frame.env.y * base.rgb * (1.0 - metallic) * ao; }
    color = select(apply_fog(color, in.world), color, (u32(material.flags.w + 0.5) & 4u) != 0u); // r18: bit 4 = material.fog=false
    // exposure + Reinhard; target is *Srgb so the hardware encodes.
    if (frame.post.x > 0.5) { return vec4<f32>(color, base.a); }
    let e = color * frame.ambient.w;
    // alpha out: blend pipeline uses it; opaque pipeline has blend off (ignored).
    return vec4<f32>(e / (vec3<f32>(1.0) + e), base.a);
}

