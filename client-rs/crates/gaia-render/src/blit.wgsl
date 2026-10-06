// ---- default Upscaler: bilinear blit (fullscreen triangle) ----
@group(0) @binding(0) var blit_src: texture_2d<f32>;
@group(0) @binding(1) var blit_samp: sampler;
struct BlitOut { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn blit_vs(@builtin(vertex_index) i: u32) -> BlitOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: BlitOut;
    o.clip = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2<f32>(p.x, 1.0 - p.y);
    return o;
}
@fragment
fn blit_fs(in: BlitOut) -> @location(0) vec4<f32> {
    return textureSample(blit_src, blit_samp, in.uv);
}
