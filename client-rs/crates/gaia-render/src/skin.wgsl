// One dispatch skins every skinned vertex: src (16 f32/vertex) x palette -> dst (scene::Vertex, 8 f32).
// src: pos3 n3 uv2 | joints packed u16x2 (2 slots) | weights4 | palette_base (u32 bits) | pad
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read> palette: array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
// x = vertex count, y = invocations per dispatch row (64 * 65535)
@group(0) @binding(3) var<uniform> params: vec4<u32>;

@compute @workgroup_size(64)
fn skin(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x + gid.y * params.y;
    if (i >= params.x) { return; }
    let s = i * 16u;
    let j01 = bitcast<u32>(src[s + 8u]);
    let j23 = bitcast<u32>(src[s + 9u]);
    let base = bitcast<u32>(src[s + 14u]);
    var w = vec4<f32>(src[s + 10u], src[s + 11u], src[s + 12u], src[s + 13u]);
    let sum = w.x + w.y + w.z + w.w;
    if (sum <= 0.0) { w = vec4<f32>(1.0, 0.0, 0.0, 0.0); } else { w = w / sum; }
    let m = palette[base + (j01 & 0xffffu)] * w.x
          + palette[base + (j01 >> 16u)] * w.y
          + palette[base + (j23 & 0xffffu)] * w.z
          + palette[base + (j23 >> 16u)] * w.w;
    let p = m * vec4<f32>(src[s], src[s + 1u], src[s + 2u], 1.0);
    let n = normalize((m * vec4<f32>(src[s + 3u], src[s + 4u], src[s + 5u], 0.0)).xyz + vec3<f32>(0.0, 0.0, 1e-12));
    let d = i * 8u;
    dst[d] = p.x; dst[d + 1u] = p.y; dst[d + 2u] = p.z;
    dst[d + 3u] = n.x; dst[d + 4u] = n.y; dst[d + 5u] = n.z;
    dst[d + 6u] = src[s + 6u]; dst[d + 7u] = src[s + 7u];
}
