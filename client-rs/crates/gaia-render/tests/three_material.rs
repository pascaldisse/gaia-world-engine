//! Proof: three r180 TSL packages (tsl-export.js JSON) render as-is on a cube. Packages from
//! $R3_PKG_DIR (default <worktree>/.scratch/r3); skips when absent. Writes <name>.native.ppm next to them.
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
fn three_tsl_packages_render_as_is() {
    let dir = std::env::var("R3_PKG_DIR").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../../.scratch/r3").into());
    let Ok(rd) = std::fs::read_dir(&dir) else { eprintln!("skip: no {dir}"); return };
    let (device, queue) = device();
    let size = 256u32;
    for e in rd.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") { continue }
        let name = path.file_stem().unwrap().to_string_lossy().to_string();
        let pkg = std::fs::read_to_string(&path).unwrap();
        let mut opts = RenderOptions::default();
        opts.render_height = size;
        let mut core = RenderCore::new(&device, &queue, opts);
        core.create_texture(&device, &queue, 1, 2, 2, &[200u8; 16]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&pkg).unwrap();
        let mut tex = HashMap::new();
        for g in v["bindGroups"].as_array().unwrap() {
            for b in g["bindings"].as_array().unwrap() {
                if b["kind"].as_str().unwrap_or("").starts_with("texture") { tex.insert(b["name"].as_str().unwrap().to_string(), 1u32); }
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
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut enc = device.create_command_encoder(&Default::default());
        core.render(&device, &queue, &mut enc, &view, UpscaleSize { width: size, height: size });
        let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (size * size * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size * 4), rows_per_image: None } }, out.size());
        queue.submit(Some(enc.finish()));
        if let Some(err) = pollster::block_on(scope.pop()) { panic!("{name}: validation: {err}") }
        rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
        let mut ppm = format!("P6 {size} {size} 255\n").into_bytes();
        for c in px.chunks(4) { ppm.extend([c[2], c[1], c[0]]); }
        std::fs::write(format!("{dir}/{name}.native.ppm"), ppm).unwrap();
        let lit = px.chunks(4).filter(|c| c[..3] != px[..3]).count();
        println!("THREE-NATIVE {name}: draws={} covered_px={lit}/{}", core.last_draw_calls, size * size);
        if lit < 1000 { println!("THREE-NATIVE {name}: NOT VISIBLE — judge vs three r180 ground truth (tools/render-wasm/three-ref.html), not by coverage"); }
    }
}
