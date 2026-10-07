//! r4 proof: live three uniforms (set_three_uniforms) + lit TSL packages. Cases = <name>.r4.json {package, frames:[[{key,value}]]}
//! from .scratch/r4/dump.mjs ($R4_DIR, default <worktree>/.scratch/r4; skips when absent). ONE core/material per case, frames
//! rendered in sequence with each frame's changed values applied → <name>.f<i>.native.ppm.
use gaia_render::*;
use std::collections::HashMap;

fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}
/// three BoxGeometry(1,1,1) layout: 6 faces (+x,-x,+y,-y,+z,-z), 4 verts, uv (0,1)(1,1)(0,0)(1,0), tris (a,b,d)(b,c,d).
fn cube() -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<u32>) {
    let (mut p, mut n, mut t, mut i) = (vec![], vec![], vec![], vec![]);
    // (u axis, v axis, w axis, udir, vdir, wsign) as three's buildPlane('z','y','x',-1,-1, +x) etc.
    let planes: [(usize, usize, usize, f32, f32, f32); 6] = [(2, 1, 0, -1., -1., 1.), (2, 1, 0, 1., -1., -1.), (0, 2, 1, 1., 1., 1.), (0, 2, 1, 1., -1., -1.), (0, 1, 2, 1., -1., 1.), (0, 1, 2, -1., -1., -1.)];
    for (u, v, w, ud, vd, ws) in planes {
        let base = (p.len() / 3) as u32;
        for iy in 0..2 {
            for ix in 0..2 {
                let mut q = [0f32; 3];
                q[u] = (ix as f32 - 0.5) * ud;
                q[v] = (iy as f32 - 0.5) * vd;
                q[w] = 0.5 * ws;
                p.extend(q);
                let mut nn = [0f32; 3];
                nn[w] = ws;
                n.extend(nn);
                t.extend([ix as f32, 1.0 - iy as f32]);
            }
        }
        let (a, b, c, d) = (base, base + 2, base + 3, base + 1);
        i.extend([a, b, d, b, c, d]);
    }
    (p, n, t, i)
}

#[test]
fn three_live_uniforms_and_lights() {
    let dir = std::env::var("R4_DIR").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.scratch/r4").into());
    let Ok(rd) = std::fs::read_dir(&dir) else { eprintln!("skip: no {dir}"); return };
    let (device, queue) = device();
    let size = 256u32;
    let mut files: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(".r4.json")).collect();
    files.sort();
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().trim_end_matches(".r4.json").to_string();
        let case: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let pkg = case["package"].to_string();
        let mut opts = RenderOptions::default();
        opts.render_height = size;
        let mut core = RenderCore::new(&device, &queue, opts);
        core.create_texture(&device, &queue, 1, 2, 2, &[200u8; 16]).unwrap();
        core.create_texture_linear(&device, &queue, 2, 2, 2, &[200u8; 16]).unwrap();
        let mut tex = HashMap::new();
        for g in case["package"]["bindGroups"].as_array().unwrap() {
            for b in g["bindings"].as_array().unwrap() {
                if b["kind"].as_str().unwrap_or("").starts_with("texture") { tex.insert(b["name"].as_str().unwrap().to_string(), if b["colorSpace"].as_str() == Some("srgb") { 1u32 } else { 2 }); }
            }
        }
        core.create_three_material(&device, 9, &pkg, tex).unwrap_or_else(|e| panic!("{name}: {e}"));
        let (p, n, t, i) = cube();
        core.create_mesh(&device, 1, &p, &n, &t, &i).unwrap();
        core.create_instance(1, 1, 9, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        let eye = glam::Vec3::new(1.5, 1.2, 2.5);
        core.set_camera(glam::Mat4::look_at_rh(eye, glam::Vec3::ZERO, glam::Vec3::Y).inverse().to_cols_array(), 50f32.to_radians(), 0.1, Some(100.0));
        let out = device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8UnormSrgb,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = out.create_view(&Default::default());
        for (fi, changed) in case["frames"].as_array().unwrap().iter().enumerate() {
            if !changed.as_array().unwrap().is_empty() { core.set_three_uniforms(9, &changed.to_string()).unwrap_or_else(|e| panic!("{name} f{fi}: {e}")); }
            // r10-5: batched path (shared table + index list) must accept the same payload and report 1 material; identical values re-applied = same pixels.
            if !changed.as_array().unwrap().is_empty() {
                let n = changed.as_array().unwrap().len();
                let batch = serde_json::json!({ "s": changed, "m": [[9, (0..n).collect::<Vec<_>>()]] });
                assert_eq!(core.set_three_uniforms_batch(&batch.to_string()).unwrap_or_else(|e| panic!("{name} f{fi} batch: {e}")), 1);
                let bad = serde_json::json!({ "s": [{"key": "no-such-key", "value": 1.0}], "m": [[9, [0]]] });
                assert!(core.set_three_uniforms_batch(&bad.to_string()).is_err(), "unknown key must be loud");
            }
            let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let mut enc = device.create_command_encoder(&Default::default());
            core.render(&device, &queue, &mut enc, &view, UpscaleSize { width: size, height: size });
            let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (size * size * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
            enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size * 4), rows_per_image: None } }, out.size());
            queue.submit(Some(enc.finish()));
            if let Some(err) = pollster::block_on(scope.pop()) { panic!("{name} f{fi}: validation: {err}") }
            rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
            let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
            let mut ppm = format!("P6 {size} {size} 255\n").into_bytes();
            for c in px.chunks(4) { ppm.extend([c[2], c[1], c[0]]); }
            std::fs::write(format!("{dir}/{name}.f{fi}.native.ppm"), ppm).unwrap();
            let lit = px.chunks(4).filter(|c| c[..3] != px[..3]).count();
            println!("THREE-R4 {name} f{fi}: changed={} draws={} covered_px={lit}", changed.as_array().unwrap().len(), core.last_draw_calls);
        }
    }
}

/// r10-5: batch API fails LOUD (never silently drops): bad JSON, wrong shape, unknown material, bad shared index. Valid-but-empty batch = Ok(0).
#[test]
fn r10_batch_malformed_is_loud() {
    let (device, queue) = device();
    let mut core = RenderCore::new(&device, &queue, RenderOptions::default());
    assert_eq!(core.set_three_uniforms_batch(r#"{"s":[],"m":[]}"#), Ok(0));
    assert!(core.set_three_uniforms_batch("not json").is_err());
    assert!(core.set_three_uniforms_batch(r#"{"s":[]}"#).is_err());
    assert!(core.set_three_uniforms_batch(r#"{"s":[{"key":"k","value":1}],"m":[[77,[0]]]}"#).unwrap_err().contains("not a three material"));
    assert!(core.set_three_uniforms_batch(r#"{"s":[],"m":[[77,[3]]]}"#).unwrap_err().contains("out of range"));
}
