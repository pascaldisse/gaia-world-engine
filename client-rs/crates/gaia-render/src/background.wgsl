// scene.background Texture / CubeTexture / equirect: fullscreen triangle drawn FIRST inside the forward pass (no depth write, depth Always).
// three tone-maps its background like any fragment (r6 S4 measurement) -> exposure + Reinhard here, same operator as forward.wgsl.
struct BG {
    inv_vp: mat4x4<f32>,
    cam: vec4<f32>,
    params: vec4<f32>,   // x mode (1 cube, 2 equirect, 3 screen-aligned 2D), y intensity, z exposure
};
@group(0) @binding(0) var<uniform> bg: BG;
@group(0) @binding(1) var cube_tex: texture_cube<f32>;
@group(0) @binding(2) var flat_tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) ndc: vec2<f32> };
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VO {
    let x = f32((i << 1u) & 2u);
    let y = f32(i & 2u);
    var o: VO;
    o.ndc = vec2<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0);
    o.pos = vec4<f32>(o.ndc, 1.0, 1.0);
    return o;
}
@fragment
fn fs_main(in: VO) -> @location(0) vec4<f32> {
    let p = bg.inv_vp * vec4<f32>(in.ndc, 0.5, 1.0);
    let d = normalize(p.xyz / p.w - bg.cam.xyz);
    var c = vec3<f32>(0.0);
    let mode = bg.params.x;
    if (mode < 1.5) {
        // three flips x for image-backed CubeTextures (CubeTextureNode flipEnvMap = -1)
        c = textureSampleLevel(cube_tex, samp, vec3<f32>(-d.x, d.y, d.z), 0.0).rgb;
    } else if (mode < 2.5) {
        // three equirectUV: u = atan2(z, x)/2PI + .5, v = asin(y)/PI + .5 (v up); texture rows are top-first here
        let u = atan2(d.z, d.x) * 0.15915494 + 0.5;
        let v = 0.5 - asin(clamp(d.y, -1.0, 1.0)) * 0.31830989;
        c = textureSampleLevel(flat_tex, samp, vec2<f32>(u, v), 0.0).rgb;
    } else {
        c = textureSampleLevel(flat_tex, samp, vec2<f32>(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5), 0.0).rgb;
    }
    let e = c * bg.params.y * bg.params.z;
    if (bg.params.w > 0.5) { return vec4<f32>(c * bg.params.y, 1.0); } // r10 HDR scene: linear out
    return vec4<f32>(e / (vec3<f32>(1.0) + e), 1.0);
}
