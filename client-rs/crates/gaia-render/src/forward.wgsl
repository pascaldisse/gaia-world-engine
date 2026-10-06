// Forward PBR (metallic-roughness, GGX/Smith/Schlick) — sun + N point lights.
// Uniform-only bindings (no storage buffers) so the same WGSL runs on Metal and WebGPU.
const MAX_POINT_LIGHTS: u32 = 64u;
const PI: f32 = 3.14159265;

struct PointLight { position_range: vec4<f32>, color: vec4<f32> };
struct Frame {
    view_proj: mat4x4<f32>,
    camera_pos: vec4<f32>,
    sun_dir: vec4<f32>,      // xyz = direction light travels
    sun_color: vec4<f32>,    // rgb * intensity
    ambient: vec4<f32>,      // rgb, w = exposure
    counts: vec4<u32>,       // x = point light count
    points: array<PointLight, MAX_POINT_LIGHTS>,
    ambient_ground: vec4<f32>, // hemisphere ambient: ground (down-facing) colour; `ambient.rgb` = sky (up-facing)
};
struct Material {
    base_color: vec4<f32>,
    params: vec4<f32>,       // x metallic, y roughness, z alpha cutoff (<0 = none), w has_texture
    emissive: vec4<f32>,
    flags: vec4<f32>,        // x unlit (1 = base colour only: no lights/shadow/tonemap exposure)
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var base_tex: texture_2d<f32>;
@group(1) @binding(2) var base_samp: sampler;
// Baked lightmap at TEXCOORD_1; material.emissive.w = overlay fac (0 = none).
@group(1) @binding(3) var lightmap_tex: texture_2d<f32>;
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

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>,
           @location(3) m0: vec4<f32>, @location(4) m1: vec4<f32>, @location(5) m2: vec4<f32>, @location(6) m3: vec4<f32>,
           @location(7) uv1: vec2<f32>, @location(8) color: vec4<f32>) -> VsOut {
    // per-instance model matrix (instance-step vertex buffer: no storage buffers needed)
    let model = mat4x4<f32>(m0, m1, m2, m3);
    let world = model * vec4<f32>(pos, 1.0);
    var o: VsOut;
    o.clip = frame.view_proj * world;
    o.world = world.xyz;
    // uniform-scale assumption: normal via model 3x3 (non-uniform scale = NOTES open item)
    o.normal = (model * vec4<f32>(normal, 0.0)).xyz;
    o.uv = uv;
    o.uv1 = uv1;
    o.color = color;
    return o;
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
    var base = material.base_color;
    if (material.params.w > 0.5) {
        base = base * textureSample(base_tex, base_samp, in.uv);
    }
    // glTF COLOR_0: multiplies base colour (rgb + alpha); 1.0 when the mesh has none.
    base = base * in.color;
    // DS client rule (lightmap.mjs overlayNode): Blender OVERLAY, linear inputs.
    let fac = material.emissive.w;
    if (fac > 0.0) {
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
        return base; // unlit: authored colour as-is (backdrops, sky domes, additive cards)
    }
    var n = normalize(in.normal);
    if (!front) { n = -n; }
    let v = normalize(frame.camera_pos.xyz - in.world);
    let metallic = clamp(material.params.x, 0.0, 1.0);
    let rough = clamp(material.params.y, 0.04, 1.0);
    let sun_l = -frame.sun_dir.xyz;
var color = brdf(n, v, sun_l, base.rgb, metallic, rough) * frame.sun_color.rgb
* sun_shadow(in.world, frame.camera_pos.xyz, n, max(dot(n, sun_l), 0.0));
    for (var i = 0u; i < min(frame.counts.x, MAX_POINT_LIGHTS); i = i + 1u) {
        let pl = frame.points[i];
        let d = pl.position_range.xyz - in.world;
        let dist2 = max(dot(d, d), 1e-4);
        var atten = 1.0 / dist2;
        let range = pl.position_range.w;
        if (range > 0.0) {
            let r = sqrt(dist2) / range;
            atten = atten * clamp(1.0 - r * r * r * r, 0.0, 1.0);
        }
        color = color + brdf(n, v, d * inverseSqrt(dist2), base.rgb, metallic, rough) * pl.color.rgb * atten;
    }
    // hemisphere ambient: lerp(ground, sky, 0.5 n.y + 0.5) x albedo (flat when sky == ground)
    let hemi = mix(frame.ambient_ground.rgb, frame.ambient.rgb, clamp(0.5 * n.y + 0.5, 0.0, 1.0));
    // three PhysicalLightingModel.indirect: diffuseColor = albedo * (1 - metalness); hemi/ambient E/PI is pre-divided CPU-side.
color = color + hemi * base.rgb * (1.0 - metallic) + material.emissive.rgb;
    // exposure + Reinhard; target is *Srgb so the hardware encodes.
    let e = color * frame.ambient.w;
    // alpha out: blend pipeline uses it; opaque pipeline has blend off (ignored).
    return vec4<f32>(e / (vec3<f32>(1.0) + e), base.a);
}

