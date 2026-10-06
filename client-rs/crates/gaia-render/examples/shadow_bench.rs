//! Headless shadow proof/bench: glb → gaia-render → PPM + GPU ms table.
//! env: GAIA_GLB, GAIA_CAMERA=x,y,z,yaw,pitch (deg; default = glb camera), GAIA_SHADOWS=0|1,
//! GAIA_SHADOW_CACHE=0|1, GAIA_SHADOW_DYNAMIC_PCT (0..100 of instances forced dynamic),
//! GAIA_SUN=dx,dy,dz[,intensity], GAIA_SUN_SWEEP=deg/frame (moves the sun every frame),
//! GAIA_SKIN_CAST=0 (skinned instances do not cast), GAIA_ANIM_TIME=<s> (re-pose clip), GAIA_CAM_LOOK=ex,ey,ez,tx,ty,tz, GAIA_FRAMES (60), GAIA_OUT (ppm path), GAIA_HEIGHT (720), GAIA_RES, GAIA_CASCADES, GAIA_MAXDIST.
use gaia_render::*;
use glam::{Mat4, Vec3};

fn env<T: std::str::FromStr>(k: &str, d: T) -> T {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}
fn floats(k: &str) -> Option<Vec<f32>> {
    std::env::var(k).ok().map(|v| v.split(',').map(|x| x.trim().parse().expect(k)).collect())
}

fn main() {
    let path = std::env::var("GAIA_GLB").expect("GAIA_GLB");
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    let feats = adapter.features() & RenderCore::OPTIONAL_FEATURES;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        required_features: feats,
        ..Default::default()
    }))
    .expect("device");
    let h: u32 = env("GAIA_HEIGHT", 720);
    let (w, hh) = (h * 16 / 9, h);
    let mut so = ShadowOptions::default();
    so.enabled = env::<u32>("GAIA_SHADOWS", 1) != 0;
    so.cache = env::<u32>("GAIA_SHADOW_CACHE", 1) != 0;
    so.resolution = env("GAIA_RES", so.resolution);
    so.cascades = env("GAIA_CASCADES", so.cascades);
    so.max_distance = env("GAIA_MAXDIST", so.max_distance);
    so.normal_bias = env("GAIA_NORMAL_BIAS", so.normal_bias);
    so.depth_bias = env("GAIA_DEPTH_BIAS", so.depth_bias);
    so.pcf_radius = env("GAIA_PCF", so.pcf_radius);
    so.import_max_caster_diagonal = env("GAIA_NOCAST_DIAG", so.import_max_caster_diagonal);
    let scene = SceneData::from_path(std::path::Path::new(&path)).expect("load");
    eprintln!("bounds {:?} .. {:?} sun {:?} camera {:?} draws {}", scene.bounds_min, scene.bounds_max, scene.sun, scene.camera.map(|c| c.world.w_axis), scene.draws.len());
    let mut core = RenderCore::new(&device, &queue, RenderOptions { render_height: hh, shadows: so, exposure: env("GAIA_EXPOSURE", 1.0), ..Default::default() });
    load_scene_into(&mut core, &device, &queue, &scene).expect("scene");
    // GAIA_HIDE_DRAWS=lo-hi : remove static draw instances lo..=hi (pick by bisection: which draw covers a pixel)
    if let Ok(r) = std::env::var("GAIA_HIDE_DRAWS") {
        let (lo, hi) = r.split_once('-').map(|(a, b)| (a.parse::<u32>().unwrap(), b.parse::<u32>().unwrap())).expect("lo-hi");
        for i in lo..=hi.min(scene.draws.len() as u32 - 1) { core.remove_instance(i); if hi - lo < 8 { let d = &scene.draws[i as usize]; eprintln!("draw {i}: material {} verts {}", d.material, d.vertex_count); } }
        eprintln!("hid draws {lo}..={hi} of {}", scene.draws.len());
    }
    if env::<u32>("GAIA_SKIN_CAST", 1) == 0 {
// A/B proof: skinned characters (ids >= SKIN_ID_BASE) stop casting
let n = scene.skins.as_ref().map_or(0, |s| s.prims.len() as u32);
for k in 0..n { core.set_instance_cast_shadow(skin::SKIN_ID_BASE + k, false); }
}
let pct: u32 = env("GAIA_SHADOW_DYNAMIC_PCT", 0);
    if pct > 0 {
        for i in 0..scene.draws.len() as u32 {
            if (i * 100 / scene.draws.len() as u32) % 100 < pct && i % (100 / pct.max(1)).max(1) == 0 {
                core.set_instance_static(i, false);
            }
        }
    }
    let mut sun = scene.sun.map(|s| (s.direction, s.color, s.intensity)).unwrap_or((Vec3::new(-0.3, -1.0, -0.2), Vec3::ONE, 3.0));
    if let Some(v) = floats("GAIA_SUN") {
        sun.0 = Vec3::new(v[0], v[1], v[2]).normalize();
        if v.len() > 3 { sun.2 = v[3]; }
    }
    core.set_sun(sun.0.to_array(), sun.1.to_array(), sun.2);
    if let (Some(sk), Some(t)) = (&scene.skins, std::env::var("GAIA_ANIM_TIME").ok().and_then(|v| v.parse::<f32>().ok())) {
sk.pose_at(&mut core, t).expect("pose_at"); // load_scene_into poses at t=0; GAIA_ANIM_TIME=<s> re-poses
}
if let Some(v) = floats("GAIA_CAM_LOOK") {
// ex,ey,ez,tx,ty,tz (same as render-window)
let view = Mat4::look_at_rh(Vec3::new(v[0], v[1], v[2]), Vec3::new(v[3], v[4], v[5]), Vec3::Y);
core.set_camera(view.inverse().to_cols_array(), 60f32.to_radians(), 0.1, None);
}
if let Some(c) = floats("GAIA_CAMERA") {
        let m = Mat4::from_translation(Vec3::new(c[0], c[1], c[2])) * Mat4::from_rotation_y(c[3].to_radians()) * Mat4::from_rotation_x(c[4].to_radians());
        core.set_camera(m.to_cols_array(), 60f32.to_radians(), 0.1, None);
    }
    let out = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d { width: w, height: hh, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8UnormSrgb,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = out.create_view(&Default::default());
    let size = UpscaleSize { width: w, height: hh };
    let frames: u32 = env("GAIA_FRAMES", 60);
    let sweep: f32 = env("GAIA_SUN_SWEEP", 0.0);
    let (mut tot, mut sh, mut cpu) = (vec![], vec![], vec![]);
    let mut last_stats = ShadowStats::default();
    let mut sd = sun.0;
    for f in 0..frames {
        if sweep != 0.0 {
            sd = glam::Quat::from_rotation_y(sweep.to_radians()) * sd;
            core.set_sun(sd.to_array(), sun.1.to_array(), sun.2);
        }
        let t0 = std::time::Instant::now();
        let mut enc = device.create_command_encoder(&Default::default());
        core.render(&device, &queue, &mut enc, &view, size);
        let rb = core.encode_timing_readback(&mut enc);
        queue.submit(Some(enc.finish()));
        cpu.push(t0.elapsed().as_secs_f64() * 1e3);
        if rb && f >= 3 {
            if let Some(t) = core.read_timings_blocking(&device) {
                tot.push(t.total_ms);
                sh.push(t.shadow_ms);
            }
        } else {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
        }
        if f == frames - 1 { last_stats = core.shadow_stats().clone(); }
    }
    let med = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.total_cmp(b)); if v.is_empty() { f64::NAN } else { v[v.len() / 2] } };
    println!("RESULT shadows={} cache={} dyn%={} sweep={} frames={} total_ms_med={:.3} shadow_ms_med={:.3} cpu_encode_ms_med={:.3} main_draws={}",
        core.shadow_options().enabled, core.shadow_options().cache, pct, sweep, frames, med(&mut tot), med(&mut sh), med(&mut cpu), core.last_draw_calls);
    let s = &last_stats;
    println!("STATS(last frame) splits={:?} static_rerendered={:?} static_draws={:?} dynamic_draws={:?} static_inst={:?} dyn_inst={:?} copies={} passes={} total_shadow_draws={} cull_ms={:.3}",
        &s.split_distances[..s.cascades.max(1)], &s.static_rerendered[..s.cascades.max(1)], &s.static_draws[..s.cascades.max(1)], &s.dynamic_draws[..s.cascades.max(1)], &s.static_instances[..s.cascades.max(1)], &s.dynamic_instances[..s.cascades.max(1)], s.copies, s.passes, s.total_draws, s.cpu_cull_ms);
    if let Ok(p) = std::env::var("GAIA_OUT") {
        let bpr = (w * 4).next_multiple_of(256);
        let buf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (bpr * hh) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(hh) } }, wgpu::Extent3d { width: w, height: hh, depth_or_array_layers: 1 });
        queue.submit(Some(enc.finish()));
        let sl = buf.slice(..);
        sl.map_async(wgpu::MapMode::Read, |_| {});
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        let data = sl.get_mapped_range().unwrap();
        let mut ppm = format!("P6\n{w} {hh}\n255\n").into_bytes();
        let mut sum = 0u64;
        for y in 0..hh as usize {
            for x in 0..w as usize {
                let o = y * bpr as usize + x * 4;
                ppm.extend_from_slice(&[data[o + 2], data[o + 1], data[o]]);
                sum += data[o] as u64 + data[o + 1] as u64 + data[o + 2] as u64;
            }
        }
        std::fs::write(&p, ppm).unwrap();
        println!("wrote {p} mean_lum={:.2}", sum as f64 / (w as f64 * hh as f64 * 3.0));
    }
}
