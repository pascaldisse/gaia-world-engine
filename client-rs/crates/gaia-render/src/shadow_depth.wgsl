// Depth-only caster pass for one sun-shadow cascade.
// group(0) = cascade light view-proj. Opaque: vs_depth only (no fragment stage).
// Alpha-tested (glTF MASK): vs_alpha/fs_alpha + group(1) = built-in material layout.
struct Cascade { view_proj: mat4x4<f32> };
struct Material {
base_color: vec4<f32>,
params: vec4<f32>,       // x metallic, y roughness, z alpha cutoff, w has_texture
emissive: vec4<f32>,
};
@group(0) @binding(0) var<uniform> cascade: Cascade;
@group(1) @binding(0) var<uniform> material: Material;
@group(1) @binding(1) var base_tex: texture_2d<f32>;
@group(1) @binding(2) var base_samp: sampler;
struct AlphaOut {
@builtin(position) clip: vec4<f32>,
@location(0) uv: vec2<f32>,
};
@vertex
fn vs_depth(@location(0) pos: vec3<f32>,
@location(3) m0: vec4<f32>, @location(4) m1: vec4<f32>, @location(5) m2: vec4<f32>, @location(6) m3: vec4<f32>) -> @builtin(position) vec4<f32> {
let model = mat4x4<f32>(m0, m1, m2, m3);
return cascade.view_proj * (model * vec4<f32>(pos, 1.0));
}
@vertex
fn vs_alpha(@location(0) pos: vec3<f32>, @location(2) uv: vec2<f32>,
@location(3) m0: vec4<f32>, @location(4) m1: vec4<f32>, @location(5) m2: vec4<f32>, @location(6) m3: vec4<f32>) -> AlphaOut {
let model = mat4x4<f32>(m0, m1, m2, m3);
var o: AlphaOut;
o.clip = cascade.view_proj * (model * vec4<f32>(pos, 1.0));
o.uv = uv;
return o;
}
@fragment
fn fs_alpha(in: AlphaOut) {
var a = material.base_color.a;
if (material.params.w > 0.5) {
a = a * textureSampleLevel(base_tex, base_samp, in.uv, 0.0).a;
}
if (a < material.params.z) {
discard;
}
}
