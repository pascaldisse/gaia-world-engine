//! r6 lighting on a real device: hemisphere/ambient irradiance (three r180 units) + clear colour = scene.background.
//! Expected values are computed from three's math: out = Reinhard(E/PI * albedo * (1-metal) * exposure) -> sRGB encode (target is *Srgb).
use gaia_render::*;

pub fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}

/// render 64x64, return BGRA8 bytes (sRGB-encoded)
fn shoot(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore) -> Vec<u8> {
    let size = 64u32;
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
    core.render(device, queue, &mut enc, &view, UpscaleSize { width: size, height: size });
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (size * size * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size * 4), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    if let Some(err) = pollster::block_on(scope.pop()) { panic!("validation: {err}") }
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let px = rb.slice(..).get_mapped_range().unwrap().to_vec();
    px
}

fn centre(px: &[u8]) -> [u8; 3] {
    let i = (32 * 64 + 32) * 4;
    [px[i + 2], px[i + 1], px[i]] // BGRA -> RGB
}

fn srgb(l: f32) -> f32 {
    let l = l.clamp(0.0, 1.0);
    if l <= 0.003_130_8 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 }
}

fn expect_rgb(linear_e: [f32; 3]) -> [u8; 3] {
    let f = |e: f32| (srgb(e / (1.0 + e)) * 255.0).round() as u8;
    [f(linear_e[0]), f(linear_e[1]), f(linear_e[2])]
}

fn close(a: [u8; 3], b: [u8; 3], tol: i32) -> bool {
    (0..3).all(|i| (a[i] as i32 - b[i] as i32).abs() <= tol)
}

/// quad in the XZ plane at y=0 facing +Y (normal up), camera `eye` looking at origin
fn plane_scene(device: &wgpu::Device, queue: &wgpu::Queue, metallic: f32, eye: glam::Vec3, normal_y: f32) -> RenderCore {
    plane_scene_at(device, queue, metallic, eye, normal_y, glam::Vec3::ZERO)
}

/// same, quad centred at `at` (camera looks at it)
fn plane_scene_at(device: &wgpu::Device, queue: &wgpu::Queue, metallic: f32, eye: glam::Vec3, normal_y: f32, at: glam::Vec3) -> RenderCore {
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(device, queue, opts);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 0.0); // sun off: ambient only
    core.create_material(device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    let s = 4.0;
    let pos = [-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s];
    let n = [0., normal_y, 0., 0., normal_y, 0., 0., normal_y, 0., 0., normal_y, 0.];
    let idx: [u32; 6] = if normal_y > 0.0 { [0, 2, 1, 0, 3, 2] } else { [0, 1, 2, 0, 2, 3] };
    core.create_mesh(device, 1, &pos, &n, &[0.0; 8], &idx).unwrap();
    core.create_instance(1, 1, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., at.x, at.y, at.z, 1.]);
    core.set_camera(glam::Mat4::look_at_rh(eye, at, glam::Vec3::Z).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core
}

#[test]
fn hemisphere_irradiance_matches_three_lambert() {
    let (device, queue) = device();
    let pi = std::f32::consts::PI;
    // up-facing plane seen from above: n.y = 1 -> weight 1 -> sky. E_sky = (2pi, pi, 0.5pi)  => shader term (E/pi * albedo 0.5) = (1, .5, .25)
    let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_hemisphere_irradiance([2.0 * pi, pi, 0.5 * pi], [0.1, 0.1, 0.1]);
    let up = centre(&shoot(&device, &queue, &mut core));
    let want = expect_rgb([1.0, 0.5, 0.25]);
    assert!(close(up, want, 2), "up-facing sky: got {up:?} want {want:?}");
    // ground: same quad flipped (normal -Y), seen from below: weight 0 -> ground colour E=(pi, pi, pi) -> (.5,.5,.5)... x albedo .5/1 = .25? E/pi*alb = 0.5
    let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, -6.0, 0.01), -1.0);
    core.set_hemisphere_irradiance([2.0 * pi, pi, 0.5 * pi], [pi, pi, pi]);
    let down = centre(&shoot(&device, &queue, &mut core));
    let want = expect_rgb([0.5, 0.5, 0.5]);
    assert!(close(down, want, 2), "down-facing ground: got {down:?} want {want:?}");
    // flat ambient (AmbientLight folded by the adapter: sky == ground)
    let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_hemisphere_irradiance([pi, pi, pi], [pi, pi, pi]);
    assert!(close(centre(&shoot(&device, &queue, &mut core)), expect_rgb([0.5; 3]), 2));
    // metallic = 1: three diffuseColor = albedo * (1 - metalness) = 0 -> no ambient diffuse (no env map)
    let mut core = plane_scene(&device, &queue, 1.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_hemisphere_irradiance([2.0 * pi; 3], [2.0 * pi; 3]);
    let m = centre(&shoot(&device, &queue, &mut core));
    assert!(m == [0, 0, 0], "metal ambient must be 0, got {m:?}");
}

#[test]
fn clear_colour_is_scene_background() {
    let (device, queue) = device();
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(&device, &queue, opts);
    core.set_camera(glam::Mat4::IDENTITY.to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    core.set_clear_color([0.2, 0.4, 0.6, 1.0]);
    let px = centre(&shoot(&device, &queue, &mut core));
    let want = [(srgb(0.2) * 255.0).round() as u8, (srgb(0.4) * 255.0).round() as u8, (srgb(0.6) * 255.0).round() as u8];
    assert!(close(px, want, 1), "clear: got {px:?} want {want:?}");
}

/// r7: three emissiveMap === map -> totalEmissive = emissive x map.rgb (raw texel: no base_color factor, no vertex colour). Hemi zero + sun off => only the emissive term remains.
#[test]
fn emissive_from_base_multiplies_texel_not_flat() {
let (device, queue) = device();
let emis = [0.4f32, 0.2, 0.1];
let texel = 128.0 / 255.0; // linear texture: sampled value is 128/255 = 0.502 (no sRGB decode)
for (flag, k) in [(true, texel), (false, 1.0)] {
let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
core.set_hemisphere_irradiance([0.0; 3], [0.0; 3]);
core.create_texture_linear(&device, &queue, 7, 2, 2, &[128u8; 16]).unwrap();
// base_color 0.5 factor on purpose: must NOT scale the emissive term
core.create_material(&device, 1, MaterialDesc { base_color: [0.5, 0.5, 0.5, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: Some(7), alpha_cutoff: None, emissive: emis, emissive_from_base: flag });
let got = centre(&shoot(&device, &queue, &mut core));
let want = expect_rgb([emis[0] * k, emis[1] * k, emis[2] * k]);
assert!(close(got, want, 2), "emissive_from_base={flag}: got {got:?} want {want:?}");
}
}
// ---------------------------------------------------------------------------------------------------------------------------
// r6 S3 probe GI. Synthetic atlases (res 4/4) with per-probe constant irradiance; expected values = gi-open-nodes.js math done by hand.
const PI: f32 = std::f32::consts::PI;
const IRR_RES: usize = 4;
const DEP_RES: usize = 4;

/// cascade 0: spacing 1, dims 4^3, base cell (-1,-2,-4) (window x[-1,2] y[-2,1] z[-4,-1]); cascade 1: spacing 4, dims 8^3, base (-4,-4,-4), baseIndex 64.
fn gi_params(mode: f32, shift: f32) -> Vec<f32> {
    let mut p = vec![2.0, 1.5, IRR_RES as f32, DEP_RES as f32, mode, 0.0, 0.0, 0.0];
    p.extend([-1.0 + shift, -2.0, -4.0, 1.0, 4.0, 4.0, 4.0, 0.0]);
    p.extend([-4.0 + shift, -4.0, -4.0, 4.0, 8.0, 8.0, 8.0, 64.0]);
    p
}
const E_PROBES: usize = 64 + 512;
/// probe `i` irradiance (e, e/2, e/4), e = pi * (0.05 + 0.03 i)
fn e_of(i: usize) -> f32 { PI * (0.05 + 0.03 * i as f32) }
fn atlases(disabled: &[usize]) -> (Vec<f32>, Vec<f32>) {
    let mut irr = Vec::new();
    let mut dep = Vec::new();
    for p in 0..E_PROBES {
        for _ in 0..IRR_RES * IRR_RES { let e = e_of(p); irr.extend([e, e * 0.5, e * 0.25, 0.0]); }
        for _ in 0..DEP_RES * DEP_RES { if disabled.contains(&p) { dep.extend([-1.0, -1.0]); } else { dep.extend([100.0, 1.0e4]); } }
    }
    (irr, dep)
}
fn gi_pixel(params: Vec<f32>, disabled: &[usize], hemi_e: f32, at: glam::Vec3) -> [u8; 3] {
    let (device, queue) = device();
    let mut core = plane_scene_at(&device, &queue, 0.0, at + glam::Vec3::new(0.0, 6.0, 0.01), 1.0, at);
    core.set_hemisphere_irradiance([hemi_e; 3], [hemi_e; 3]);
    let (irr, dep) = atlases(disabled);
    core.set_gi_probes(&device, &queue, &irr, &dep, &params).expect("set_gi_probes");
    centre(&shoot(&device, &queue, &mut core))
}
// quad centre (0.5,-0.5,-2.5) = centre of cascade-0 cell (0,-1,-3): 4 probes above the surface (cells x{0,1} y0 z{-3,-2}) = slots 16,17,32,33, equal weight
const AT: glam::Vec3 = glam::Vec3::new(0.5, -0.5, -2.5);
fn avg(ids: &[usize]) -> [f32; 3] { let e = ids.iter().map(|&i| e_of(i)).sum::<f32>() / ids.len() as f32; [e, e * 0.5, e * 0.25] }
fn lit(e: [f32; 3], albedo: f32) -> [u8; 3] { expect_rgb([e[0] / PI * albedo, e[1] / PI * albedo, e[2] / PI * albedo]) }

#[test]
fn gi_replace_inside_window_samples_toroidal_slots_trilinear() {
    let got = gi_pixel(gi_params(1.0, 0.0), &[], PI, AT);
    let want = lit(avg(&[16, 17, 32, 33]), 0.5);
    assert!(close(got, want, 1), "GI replace: got {got:?} want {want:?}");
}

#[test]
fn gi_disabled_probe_sentinel_is_skipped() {
    let got = gi_pixel(gi_params(1.0, 0.0), &[17], PI, AT);
    let want = lit(avg(&[16, 32, 33]), 0.5);
    assert!(close(got, want, 1), "disabled probe 17: got {got:?} want {want:?}");
}

#[test]
fn gi_outside_every_cascade_falls_back_to_hemisphere() {
    // windows shifted 1000 cells away: coverage 0 -> net = hemi (E = pi -> 1/pi*pi*albedo .5 = 0.5)
    let got = gi_pixel(gi_params(1.0, 1000.0), &[], PI, AT);
    let want = expect_rgb([0.5; 3]);
    assert!(close(got, want, 1), "outside windows: got {got:?} want {want:?}");
}

#[test]
fn gi_add_mode_adds_to_hemisphere() {
    let got = gi_pixel(gi_params(0.0, 0.0), &[], PI, AT);
    let g = avg(&[16, 17, 32, 33]);
    let want = expect_rgb([(1.0 + g[0] / PI) * 0.5, (1.0 + g[1] / PI) * 0.5, (1.0 + g[2] / PI) * 0.5]);
    assert!(close(got, want, 1), "GI add: got {got:?} want {want:?}");
}

#[test]
fn background_color_is_tone_mapped_like_three() {
    // measured vs three r180 WebGPURenderer + ReinhardToneMapping (exposure 1): background 0x9ec0e8 → (138,158,178)±2 on screen = Reinhard(linear) then sRGB
    let (device, queue) = device();
    let mut opts = RenderOptions::default();
    opts.render_height = 64;
    let mut core = RenderCore::new(&device, &queue, opts);
    core.set_camera(glam::Mat4::IDENTITY.to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
    let lin = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    let c = [lin(0x9e as f32 / 255.0), lin(0xc0 as f32 / 255.0), lin(0xe8 as f32 / 255.0)];
    core.set_background_color(c);
    let px = centre(&shoot(&device, &queue, &mut core));
    assert!(close(px, expect_rgb(c), 1), "bg: got {px:?} want {:?}", expect_rgb(c));
    assert!(close(px, [138, 158, 178], 3), "bg vs three-measured: {px:?}");
}

// ---------------------------------------------------------------------------------------------------------------------------
// r8 sky: unlit (three MeshBasic) + blend + depthWrite + order flags (Eden sky domes). Unlit ignores sun/hemi; tone flag = exposure+Reinhard.
fn unlit_scene(device: &wgpu::Device, queue: &wgpu::Queue, base: [f32; 4], flags: MaterialFlags, tone: bool) -> RenderCore {
    let mut core = plane_scene(device, queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
    core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 5.0); // lights on: unlit must ignore them
    core.set_hemisphere_irradiance([3.0; 3], [3.0; 3]);
    core.create_material(device, 1, MaterialDesc { base_color: base, metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
    if flags.blend.is_some() {
        core.set_material_blend(1, true);
    }
    core.set_material_flags(device, 1, flags);
    core.set_material_unlit_tone_mapped(device, 1, tone);
    core
}

#[test]
fn unlit_ignores_lights_and_honours_tone_map_flag() {
    let (device, queue) = device();
    let f = MaterialFlags { unlit: true, ..Default::default() };
    let mut raw = unlit_scene(&device, &queue, [0.5, 0.25, 0.1, 1.0], f, false);
    let got = centre(&shoot(&device, &queue, &mut raw));
    let want = [(srgb(0.5) * 255.0).round() as u8, (srgb(0.25) * 255.0).round() as u8, (srgb(0.1) * 255.0).round() as u8];
    assert!(close(got, want, 1), "unlit raw: got {got:?} want {want:?}");
    let mut tm = unlit_scene(&device, &queue, [0.5, 0.25, 0.1, 1.0], f, true);
    let got = centre(&shoot(&device, &queue, &mut tm));
    let want = expect_rgb([0.5, 0.25, 0.1]);
    assert!(close(got, want, 1), "unlit tone-mapped: got {got:?} want {want:?}");
}

#[test]
fn unlit_alpha_blend_over_background_blends_after_tone_map() {
    // core blends the tone-mapped fragment over the (tone-mapped) clear in the linear sRGB target: out = a*T(src) + (1-a)*T(bg)
    let (device, queue) = device();
    let t = |e: f32| e / (1.0 + e);
    let (a, src, bg) = (0.4f32, 0.8f32, 0.3f32);
    let f = MaterialFlags { unlit: true, blend: Some(BlendKind::Alpha), depth_write: Some(false), ..Default::default() };
    let mut core = unlit_scene(&device, &queue, [src, src, src, a], f, true);
    core.set_background_color([bg; 3]);
    let got = centre(&shoot(&device, &queue, &mut core));
    let l = a * t(src) + (1.0 - a) * t(bg);
    let want = [(srgb(l) * 255.0).round() as u8; 3];
    assert!(close(got, want, 2), "unlit blend: got {got:?} want {want:?}");
}

#[test]
fn render_order_draws_lower_first() {
    // two coplanar unlit alpha-blended quads, depth_write off: the one with the HIGHER render_order lands on top (opaque a=1 hides the other)
    let (device, queue) = device();
    for (ro_red, want_red) in [(5, true), (-5, false)] {
        let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
        core.create_material(&device, 1, MaterialDesc { base_color: [1.0, 0.0, 0.0, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
        core.create_material(&device, 2, MaterialDesc { base_color: [0.0, 0.0, 1.0, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
        let s = 4.0;
        let pos = [-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s];
        let n = [0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.];
        core.create_mesh(&device, 2, &pos, &n, &[0.0; 8], &[0, 2, 1, 0, 3, 2]).unwrap();
        core.create_instance(2, 2, 2, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        for (id, ro) in [(1u32, ro_red), (2u32, 0)] {
            core.set_material_blend(id, true);
            core.set_material_flags(&device, id, MaterialFlags { unlit: true, blend: Some(BlendKind::Alpha), depth_write: Some(false), render_order: ro, ..Default::default() });
        }
        let got = centre(&shoot(&device, &queue, &mut core));
        let red = got[0] > 100 && got[2] < 50;
        assert_eq!(red, want_red, "render_order red={ro_red}: got {got:?}");
    }
}

#[test]
fn no_receive_shadow_flag_skips_sun_shadow_sampling() {
    // receiver plane y=0, caster plane y=2 straight above (same footprint), sun straight down: centre is in shadow unless the receiver material opts out (three receiveShadow:false)
    let (device, queue) = device();
    let mut got = vec![];
    for no_recv in [false, true] {
        let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
        core.set_sun([0.0, -1.0, 0.0], [1.0, 1.0, 1.0], 3.0);
        core.set_hemisphere_irradiance([0.0; 3], [0.0; 3]);
        core.create_material(&device, 2, MaterialDesc { base_color: [0.1, 0.1, 0.1, 1.0], metallic: 0.0, roughness: 1.0, base_color_texture: None, alpha_cutoff: None, emissive: [0.0; 3], emissive_from_base: false });
        let s = 1.0; // small caster: centre of the view only, camera sees past it? it is ABOVE: camera at y=6 sees the caster on top → put camera below-side instead
        let pos = [-s, 2.0, -s, s, 2.0, -s, s, 2.0, s, -s, 2.0, s];
        let n = [0., -1., 0., 0., -1., 0., 0., -1., 0., 0., -1., 0.];
        core.create_mesh(&device, 2, &pos, &n, &[0.0; 8], &[0, 1, 2, 0, 2, 3]).unwrap();
        core.create_instance(2, 2, 2, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        core.set_instance_cast_shadow(2, true);
        core.set_instance_cast_shadow(1, false);
        core.set_material_flags(&device, 1, MaterialFlags::default());
        core.set_material_no_receive_shadow(&device, 1, no_recv);
        // look from a grazing angle so the caster (y=2, |x|<1) does not hide the receiver centre: eye off to the side, low
        core.set_camera(glam::Mat4::look_at_rh(glam::Vec3::new(5.0, 1.0, 0.0), glam::Vec3::ZERO, glam::Vec3::Y).inverse().to_cols_array(), 40f32.to_radians(), 0.1, Some(100.0));
        got.push(centre(&shoot(&device, &queue, &mut core)));
    }
    eprintln!("no_receive: shadowed {:?} vs opt-out {:?}", got[0], got[1]);
    assert!(got[0][0] < got[1][0] / 2, "shadowed {:?} vs no-receive {:?}", got[0], got[1]);
}

/// r8 S3: a SKINNED draw (identity palette) must be lit exactly like the same static quad: sun + hemisphere + emissive + GI all reach the skinned path.
#[test]
fn skinned_draw_is_lit_like_static_draw() {
    let (device, queue) = device();
    let mut px = vec![];
    for skinned in [false, true] {
        let mut core = plane_scene(&device, &queue, 0.0, glam::Vec3::new(0.0, 6.0, 0.01), 1.0);
        core.set_sun([0.3, -1.0, 0.2], [1.0, 0.9, 0.8], 2.0);
        core.set_hemisphere_irradiance([1.5, 1.8, 2.4], [0.3, 0.2, 0.1]);
        core.create_material(&device, 1, MaterialDesc { base_color: [0.6, 0.5, 0.4, 1.0], metallic: 0.0, roughness: 0.8, base_color_texture: None, alpha_cutoff: None, emissive: [0.05, 0.02, 0.0], emissive_from_base: false });
        if skinned {
            core.remove_instance(1);
            let s = 4.0;
            let pos = [-s, 0., -s, s, 0., -s, s, 0., s, -s, 0., s];
            let n = [0., 1., 0., 0., 1., 0., 0., 1., 0., 0., 1., 0.];
            core.create_skin(5, 1, &glam::Mat4::IDENTITY.to_cols_array()).unwrap();
            core.set_skin_pose(5, &glam::Mat4::IDENTITY.to_cols_array()).unwrap();
            core.create_skinned_mesh(9, 5, &pos, &n, &[0.0; 8], &[0; 16], &[1.0, 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0.], &[0, 2, 1, 0, 3, 2]).unwrap();
            core.create_instance(9, 9, 1, [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]);
        }
        px.push(centre(&shoot(&device, &queue, &mut core)));
    }
    eprintln!("skinned parity: static {:?} skinned {:?}", px[0], px[1]);
    assert!(close(px[0], px[1], 1), "static {:?} vs skinned {:?}", px[0], px[1]);
}
