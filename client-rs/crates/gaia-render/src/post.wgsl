// r10 post: three r180 PostProcessing parity. HDR scene (Rgba16Float, linear, NO exposure/tonemap) -> BloomNode (UnrealBloom port) -> + scene -> exposure + tone map -> sRGB view.
// Order in three: scenePass(HDR) -> outputNode = scene + bloom -> renderOutput(toneMapping, exposure, sRGB). Bloom sees UN-exposed linear HDR (exposure is part of the tone map fn).
struct PostU {
    tone: vec4<f32>,   // x exposure, y three tone-mapping constant (0 None 1 Linear 2 Reinhard 3 Cineon 4 ACESFilmic 6 AgX 7 Neutral), z bloom on (0/1), w bloom strength
    bloom: vec4<f32>,  // x radius, y threshold, z smoothWidth, w unused
    blur: vec4<f32>,   // xy = direction * invSize (target texel), z kernelRadius, w unused (blur passes only)
};
@group(0) @binding(0) var<uniform> pu: PostU;
@group(0) @binding(1) var t0: texture_2d<f32>;
@group(0) @binding(2) var t1: texture_2d<f32>;
@group(0) @binding(3) var t2: texture_2d<f32>;
@group(0) @binding(4) var t3: texture_2d<f32>;
@group(0) @binding(5) var t4: texture_2d<f32>;
@group(0) @binding(6) var t5: texture_2d<f32>;
@group(0) @binding(7) var samp: sampler;
struct VO { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> VO {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: VO;
    o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
    o.uv = vec2<f32>(p.x, 1.0 - p.y);
    return o;
}
// BloomNode luminosityHighPass: mix(vec4(0), texel, smoothstep(threshold, threshold + smoothWidth, luminance(rgb)))
@fragment
fn fs_highpass(in: VO) -> @location(0) vec4<f32> {
    let texel = textureSampleLevel(t0, samp, in.uv, 0.0) * pu.bloom.w; // bloom.w = host eye-adaptation multiplier (before bloom, like three expMul)
    let v = dot(texel.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let a = smoothstep(pu.bloom.y, pu.bloom.y + pu.bloom.z, v);
    return texel * a;
}
// BloomNode separable gaussian (three PR 31528 coefficients): sigma = k/3, c(i) = 0.39894 exp(-0.5 i^2/sigma^2)/sigma, taps i = 1..k-1
@fragment
fn fs_blur(in: VO) -> @location(0) vec4<f32> {
    let k = i32(pu.blur.z + 0.5);
    let sigma = pu.blur.z / 3.0;
    var sum = textureSampleLevel(t0, samp, in.uv, 0.0).rgb * (0.39894 / sigma);
    for (var i = 1; i < k; i = i + 1) {
        let x = f32(i);
        let w = 0.39894 * exp(-0.5 * x * x / (sigma * sigma)) / sigma;
        let off = pu.blur.xy * x;
        sum = sum + (textureSampleLevel(t0, samp, in.uv + off, 0.0).rgb + textureSampleLevel(t0, samp, in.uv - off, 0.0).rgb) * w;
    }
    return vec4<f32>(sum, 1.0);
}
fn lerp_bloom(f: f32, r: f32) -> f32 { return mix(f, 1.2 - f, r); }
// ---- three ToneMappingFunctions.js (r180), exposure folded in like three ----
fn tm_linear(c: vec3<f32>, e: f32) -> vec3<f32> { return clamp(c * e, vec3<f32>(0.0), vec3<f32>(1.0)); }
fn tm_reinhard(c: vec3<f32>, e: f32) -> vec3<f32> { let x = c * e; return clamp(x / (x + vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0)); }
fn tm_cineon(c: vec3<f32>, e: f32) -> vec3<f32> {
    let x = max(c * e - vec3<f32>(0.004), vec3<f32>(0.0));
    let a = x * (x * 6.2 + vec3<f32>(0.5));
    let b = x * (x * 6.2 + vec3<f32>(1.7)) + vec3<f32>(0.06);
    return pow(a / b, vec3<f32>(2.2));
}
fn rrt_odt_fit(v: vec3<f32>) -> vec3<f32> {
    let a = v * (v + vec3<f32>(0.0245786)) - vec3<f32>(0.000090537);
    let b = v * (0.983729 * v + vec3<f32>(0.4329510)) + vec3<f32>(0.238081);
    return a / b;
}
fn tm_aces(c: vec3<f32>, e: f32) -> vec3<f32> {
    // rows as printed in three's source (sRGB => XYZ => D65_2_D60 => AP1 => RRT_SAT); WGSL mat3x3 ctor = columns
    let m_in = mat3x3<f32>(vec3<f32>(0.59719, 0.07600, 0.02840), vec3<f32>(0.35458, 0.90834, 0.13383), vec3<f32>(0.04823, 0.01566, 0.83777));
    let m_out = mat3x3<f32>(vec3<f32>(1.60475, -0.10208, -0.00327), vec3<f32>(-0.53108, 1.10813, -0.07276), vec3<f32>(-0.07367, -0.00605, 1.07602));
    var x = c * e / 0.6;
    x = m_in * x;
    x = rrt_odt_fit(x);
    x = m_out * x;
    return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
}
fn agx_contrast(x: vec3<f32>) -> vec3<f32> {
    let x2 = x * x; let x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - vec3<f32>(0.00232);
}
fn tm_agx(c: vec3<f32>, e: f32) -> vec3<f32> {
    let to2020 = mat3x3<f32>(vec3<f32>(0.6274, 0.0691, 0.0164), vec3<f32>(0.3293, 0.9195, 0.0880), vec3<f32>(0.0433, 0.0113, 0.8956));
    let from2020 = mat3x3<f32>(vec3<f32>(1.6605, -0.1246, -0.0182), vec3<f32>(-0.5876, 1.1329, -0.1006), vec3<f32>(-0.0728, -0.0083, 1.1187));
    let inset = mat3x3<f32>(vec3<f32>(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3<f32>(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3<f32>(0.0482516061458583, 0.101439036467562, 0.811302368396859));
    let outset = mat3x3<f32>(vec3<f32>(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3<f32>(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3<f32>(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
    let min_ev = -12.47393; let max_ev = 4.026069;
    var x = c * e;
    x = to2020 * x;
    x = inset * x;
    x = max(x, vec3<f32>(1e-10));
    x = log2(x);
    x = (x - vec3<f32>(min_ev)) / (max_ev - min_ev);
    x = clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
    x = agx_contrast(x);
    x = outset * x;
    x = pow(max(vec3<f32>(0.0), x), vec3<f32>(2.2));
    x = from2020 * x;
    return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
}
fn tm_neutral(c: vec3<f32>, e: f32) -> vec3<f32> {
    let start = 0.8 - 0.04; let desat = 0.15;
    var x = c * e;
    let m = min(x.r, min(x.g, x.b));
    let off = select(0.04, m - 6.25 * m * m, m < 0.08);
    x = x - vec3<f32>(off);
    let peak = max(x.r, max(x.g, x.b));
    if (peak < start) { return x; }
    let d = 1.0 - start;
    let new_peak = 1.0 - d * d / (peak + d - start);
    x = x * (new_peak / peak);
    let g = 1.0 - 1.0 / (desat * (peak - new_peak) + 1.0);
    return mix(x, vec3<f32>(new_peak), g);
}
fn tone_map(c: vec3<f32>, mode: u32, e: f32) -> vec3<f32> {
    switch (mode) {
        case 1u: { return tm_linear(c, e); }
        case 2u: { return tm_reinhard(c, e); }
        case 3u: { return tm_cineon(c, e); }
        case 4u: { return tm_aces(c, e); }
        case 6u: { return tm_agx(c, e); }
        case 7u: { return tm_neutral(c, e); }
        default: { return c; } // NoToneMapping (three: exposure not applied either)
    }
}
// t0 = HDR scene, t1..t5 = blurred mips 0..4 (vertical targets). Output target is *Srgb: hardware encodes (= three's linear->sRGB output transform).
@fragment
fn fs_resolve(in: VO) -> @location(0) vec4<f32> {
    let s = textureSampleLevel(t0, samp, in.uv, 0.0);
    var c = s.rgb * pu.bloom.w;
    if (pu.tone.z > 0.5) {
        let r = pu.bloom.x;
        var sum = lerp_bloom(1.0, r) * textureSampleLevel(t1, samp, in.uv, 0.0).rgb;
        sum = sum + lerp_bloom(0.8, r) * textureSampleLevel(t2, samp, in.uv, 0.0).rgb;
        sum = sum + lerp_bloom(0.6, r) * textureSampleLevel(t3, samp, in.uv, 0.0).rgb;
        sum = sum + lerp_bloom(0.4, r) * textureSampleLevel(t4, samp, in.uv, 0.0).rgb;
        sum = sum + lerp_bloom(0.2, r) * textureSampleLevel(t5, samp, in.uv, 0.0).rgb;
        c = c + sum * pu.tone.w;
    }
    return vec4<f32>(tone_map(c, u32(pu.tone.y + 0.5), pu.tone.x), 1.0);
}

// r10 eye adaptation meter: 8x8 cells, 8x8 taps each, mean log2(luma) of the RAW HDR scene (pre ae multiplier, like three autoexposure.js stage 0)
@fragment
fn fs_meter(in: VO) -> @location(0) vec4<f32> {
    let cell = floor(in.pos.xy);
    var acc = 0.0;
    for (var j = 0; j < 8; j = j + 1) {
        for (var i = 0; i < 8; i = i + 1) {
            let uv = (cell + (vec2<f32>(f32(i), f32(j)) + 0.5) / 8.0) / 8.0;
            let c = textureSampleLevel(t0, samp, uv, 0.0).rgb;
            let l = max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-4);
            acc = acc + clamp(log2(l), -13.287712, 14.0);
        }
    }
    return vec4<f32>(acc / 64.0, 0.0, 0.0, 1.0);
}
