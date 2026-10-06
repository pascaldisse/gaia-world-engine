//! Visibility groups end-to-end on a synthetic glb: node extras (`gaia.visibilityGroups`) → SceneData → instances → pixels.
//! 2x2 quads: A top-left red draw[50] · B top-right green draw[3,130] (bit>127) · C bottom-left blue NO groups · D bottom-right yellow draw[3] but parentNode=A (follows A).
use gaia_render::*;
use serde_json::json;

const SIZE: u32 = 256;

fn synthetic_glb() -> Vec<u8> {
    // one unit quad mesh (x,y in -0.8..0.8, z=0), CCW facing +Z; shared by 4 nodes
    let pos: [[f32; 3]; 4] = [[-0.8, -0.8, 0.0], [0.8, -0.8, 0.0], [0.8, 0.8, 0.0], [-0.8, 0.8, 0.0]];
    let nrm = [[0.0f32, 0.0, 1.0]; 4];
    let idx: [u16; 6] = [0, 1, 2, 0, 2, 3];
    let mut bin: Vec<u8> = Vec::new();
    for p in pos { for v in p { bin.extend(v.to_le_bytes()); } }
    for n in nrm { for v in n { bin.extend(v.to_le_bytes()); } }
    for i in idx { bin.extend(i.to_le_bytes()); }
    while bin.len() % 4 != 0 { bin.push(0); }
    let mat = |e: [f32; 3]| json!({ "pbrMetallicRoughness": { "baseColorFactor": [0, 0, 0, 1], "metallicFactor": 0, "roughnessFactor": 1 }, "emissiveFactor": e });
    let node = |name: &str, x: f32, y: f32, m: u32, extras: serde_json::Value| {
        let mut n = json!({ "name": name, "translation": [x, y, -4.0], "mesh": m });
        if !extras.is_null() { n["extras"] = extras; }
        n
    };
    let meshes = (0..4).map(|m| json!({ "primitives": [{ "attributes": { "POSITION": 0, "NORMAL": 1 }, "indices": 2, "material": m }] })).collect::<Vec<_>>();
    let doc = json!({
        "asset": { "version": "2.0" },
        "scene": 0, "scenes": [{ "nodes": [0, 1, 2, 3, 4] }],
        "nodes": [
            node("A", -1.0, 1.0, 0, json!({ "gaia": { "visibilityGroups": { "draw": [50] } } })),
            node("B", 1.0, 1.0, 1, json!({ "gaia": { "visibilityGroups": { "draw": [3, 130] } } })),
            node("C", -1.0, -1.0, 2, serde_json::Value::Null),
            node("D", 1.0, -1.0, 3, json!({ "gaia": { "visibilityGroups": { "draw": [3], "parentNode": 0 } } })),
            json!({ "name": "cam", "camera": 0 })
        ],
        "cameras": [{ "type": "perspective", "perspective": { "yfov": 1.0471976, "znear": 0.1, "zfar": 50 } }],
        "meshes": meshes,
        "materials": [mat([1.0, 0.0, 0.0]), mat([0.0, 1.0, 0.0]), mat([0.0, 0.0, 1.0]), mat([1.0, 1.0, 0.0])],
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-0.8, -0.8, 0], "max": [0.8, 0.8, 0] },
            { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC3" },
            { "bufferView": 2, "componentType": 5123, "count": 6, "type": "SCALAR" }
        ],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
            { "buffer": 0, "byteOffset": 48, "byteLength": 48 },
            { "buffer": 0, "byteOffset": 96, "byteLength": 12 }
        ],
        "buffers": [{ "byteLength": bin.len() }]
    });
    let mut js = serde_json::to_vec(&doc).unwrap();
    while js.len() % 4 != 0 { js.push(b' '); }
    let total = 12 + 8 + js.len() + 8 + bin.len();
    let mut out = Vec::new();
    out.extend(0x46546c67u32.to_le_bytes());
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((js.len() as u32).to_le_bytes());
    out.extend(0x4e4f534au32.to_le_bytes());
    out.extend(js);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(0x004e4942u32.to_le_bytes());
    out.extend(bin);
    out
}

fn device() -> (wgpu::Device, wgpu::Queue) {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    pollster::block_on(adapter.request_device(&Default::default())).expect("device")
}

fn render_px(device: &wgpu::Device, queue: &wgpu::Queue, core: &mut RenderCore, out: &wgpu::Texture) -> Vec<u8> {
    let view = out.create_view(&Default::default());
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let mut enc = device.create_command_encoder(&Default::default());
    core.render(device, queue, &mut enc, &view, UpscaleSize { width: SIZE, height: SIZE });
    let rb = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (SIZE * SIZE * 4) as u64, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    enc.copy_texture_to_buffer(out.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &rb, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(SIZE * 4), rows_per_image: None } }, out.size());
    queue.submit(Some(enc.finish()));
    if let Some(err) = pollster::block_on(scope.pop()) { panic!("validation: {err}") }
    rb.slice(..).map_async(wgpu::MapMode::Read, |_| {});
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let v = rb.slice(..).get_mapped_range().unwrap().to_vec();
    v
}

/// BGRA px at the centre of quad (cx,cy) in {-1,1}.
fn probe(px: &[u8], cx: f32, cy: f32) -> [u8; 3] {
    let ndc = 1.0 / (4.0 * (30f32).to_radians().tan());
    let x = (SIZE as f32 / 2.0 * (1.0 + cx * ndc)) as usize;
    let y = (SIZE as f32 / 2.0 * (1.0 - cy * ndc)) as usize;
    let o = (y * SIZE as usize + x) * 4;
    [px[o + 2], px[o + 1], px[o]] // rgb
}
const RED: usize = 0;
const GREEN: usize = 1;
const BLUE: usize = 2;
fn lit(px: [u8; 3], ch: usize) -> bool { px[ch] > 120 && (0..3).filter(|c| *c != ch).all(|c| px[c] < 60) }
fn yellow(px: [u8; 3]) -> bool { px[0] > 120 && px[1] > 120 && px[2] < 60 }
fn dark(px: [u8; 3]) -> bool { px.iter().all(|c| *c < 90) }

#[test]
fn groups_cull_main_pass_pixels_and_draws() {
    let glb = synthetic_glb();
    if let Ok(p) = std::env::var("GAIA_TEST_DUMP") { std::fs::write(&p, &glb).unwrap(); }
    let scene = SceneData::from_slice(&glb).expect("load");
    assert_eq!(scene.draws.len(), 4);
    assert_eq!(scene.node_groups.len(), 3);
    assert_eq!(scene.effective_node_groups(3), vec![50], "D follows its parent A, own [3] ignored");
    assert_eq!(scene.effective_node_groups(1), vec![3, 130]);
    assert!(scene.effective_node_groups(2).is_empty());

    let (device, queue) = device();
    let mut opts = RenderOptions::default();
    opts.render_height = SIZE;
    opts.shadows.enabled = false;
    opts.clear_color = [0.0, 0.0, 0.0, 1.0];
    opts.ambient = [0.0; 3];
    let mut core = RenderCore::new(&device, &queue, opts);
    load_scene_into(&mut core, &device, &queue, &scene).expect("scene");
    let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });

    // culling off (default): everything drawn
    let px = render_px(&device, &queue, &mut core, &out);
    assert_eq!(core.last_draw_calls, 4, "4 batches, no culling");
    assert!(lit(probe(&px, -1.0, 1.0), RED) && lit(probe(&px, 1.0, 1.0), GREEN) && lit(probe(&px, -1.0, -1.0), BLUE) && yellow(probe(&px, 1.0, -1.0)), "all four visible: {:?}", [probe(&px, -1.0, 1.0), probe(&px, 1.0, 1.0), probe(&px, -1.0, -1.0), probe(&px, 1.0, -1.0)]);

    // active {50}: A + D(follows A) + C(no groups); B hidden
    core.set_active_groups(&GroupMask::from_bits(&[50]).0);
    let px = render_px(&device, &queue, &mut core, &out);
    assert_eq!((core.last_draw_calls, core.last_group_hidden), (3, 1));
    assert!(lit(probe(&px, -1.0, 1.0), RED) && dark(probe(&px, 1.0, 1.0)) && lit(probe(&px, -1.0, -1.0), BLUE) && yellow(probe(&px, 1.0, -1.0)));

    // active {130} (bit > 127): only B (+C); A hidden and D follows A → hidden although own groups say [3]
    core.set_active_groups(&GroupMask::from_bits(&[130]).0);
    let px = render_px(&device, &queue, &mut core, &out);
    assert_eq!((core.last_draw_calls, core.last_group_hidden), (2, 2));
    assert!(dark(probe(&px, -1.0, 1.0)) && lit(probe(&px, 1.0, 1.0), GREEN) && lit(probe(&px, -1.0, -1.0), BLUE) && dark(probe(&px, 1.0, -1.0)));

    // union {3, 50}: A, B, D, C all drawn
    core.set_active_groups_union(&[&GroupMask::from_bits(&[3]).0, &GroupMask::from_bits(&[50]).0]);
    render_px(&device, &queue, &mut core, &out);
    assert_eq!((core.last_draw_calls, core.last_group_hidden), (4, 0));

    // empty active set hides every grouped instance, keeps the ungrouped one
    core.set_active_groups(&[]);
    let px = render_px(&device, &queue, &mut core, &out);
    assert_eq!((core.last_draw_calls, core.last_group_hidden), (1, 3));
    assert!(lit(probe(&px, -1.0, -1.0), BLUE) && dark(probe(&px, -1.0, 1.0)));

    // cleared → back to everything
    core.clear_active_groups();
    render_px(&device, &queue, &mut core, &out);
    assert_eq!((core.last_draw_calls, core.last_group_hidden), (4, 0));
}

#[test]
fn groups_cull_shadow_casters() {
    let glb = synthetic_glb();
    let scene = SceneData::from_slice(&glb).expect("load");
    let (device, queue) = device();
    let mut opts = RenderOptions::default();
    opts.render_height = SIZE;
    opts.shadows.cache = false; // static casters redrawn every frame → stats show them
    let mut core = RenderCore::new(&device, &queue, opts.clone());
    load_scene_into(&mut core, &device, &queue, &scene).expect("scene");
    let out = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: SIZE, height: SIZE, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8UnormSrgb, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC, view_formats: &[] });
    let total = |core: &RenderCore| core.shadow_stats().static_instances.iter().sum::<u32>();
    render_px(&device, &queue, &mut core, &out);
    let all = total(&core);
    assert!(all > 0, "casters present with culling off");
    core.set_active_groups(&GroupMask::from_bits(&[50]).0); // B hidden
    render_px(&device, &queue, &mut core, &out);
    let culled = total(&core);
    assert!(culled < all, "hidden instance leaves the shadow maps: {culled} < {all}");
    // option off: hidden instances still cast
    opts.groups_cull_shadows = false;
    let mut core2 = RenderCore::new(&device, &queue, opts);
    load_scene_into(&mut core2, &device, &queue, &scene).expect("scene");
    render_px(&device, &queue, &mut core2, &out);
    let all2 = total(&core2);
    core2.set_active_groups(&GroupMask::from_bits(&[50]).0);
    render_px(&device, &queue, &mut core2, &out);
    assert_eq!(total(&core2), all2, "groups_cull_shadows=false keeps hidden casters");
}
