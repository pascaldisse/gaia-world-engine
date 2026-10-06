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
};
struct Material {
    base_color: vec4<f32>,
    params: vec4<f32>,       // x metallic, y roughness, z alpha cutoff (<0 = none), w has_texture
    emissive: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var base_tex: texture_2d<f32>;
@group(1) @binding(2) var base_samp: sampler;
// Baked lightmap at TEXCOORD_1; material.emissive.w = overlay fac (0 = none).
@group(1) @binding(3) var lightmap_tex: texture_2d<f32>;

struct VsOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) uv1: vec2<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec3<f32>, @location(1) normal: vec3<f32>, @location(2) uv: vec2<f32>,
           @location(3) m0: vec4<f32>, @location(4) m1: vec4<f32>, @location(5) m2: vec4<f32>, @location(6) m3: vec4<f32>,
           @location(7) uv1: vec2<f32>) -> VsOut {
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
    var n = normalize(in.normal);
    if (!front) { n = -n; }
    let v = normalize(frame.camera_pos.xyz - in.world);
    let metallic = clamp(material.params.x, 0.0, 1.0);
    let rough = clamp(material.params.y, 0.04, 1.0);
    var color = brdf(n, v, -frame.sun_dir.xyz, base.rgb, metallic, rough) * frame.sun_color.rgb;
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
    color = color + frame.ambient.rgb * base.rgb + material.emissive.rgb;
    // exposure + Reinhard; target is *Srgb so the hardware encodes.
    let e = color * frame.ambient.w;
    return vec4<f32>(e / (vec3<f32>(1.0) + e), 1.0);
}

