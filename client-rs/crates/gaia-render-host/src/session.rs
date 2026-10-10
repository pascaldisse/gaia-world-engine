//! Session = device + queue + RenderCore + the `Commands` impl. ALL render-wasm semantics live here once
//! (blend-kind mapping, 0/-1 sentinels, option parsing, group-parent MAX, ...): the native Host decodes the
//! stream into these calls, render-wasm's `#[wasm_bindgen]` methods delegate to them. Target-agnostic.
use crate::commands::{CmdResult, Commands};
use gaia_render::{
    BlendKind, BloomParams, GtaoParams, MaterialBinding, MaterialDesc, MaterialFlags, MaterialMaps, RenderCore, RenderOptions,
    ShaderMaterialDesc, ShadowOptions, UpscaleSize,
};
use serde_json::{Value, json};
use std::collections::HashMap;

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

/// Device request shared by the browser and native hosts: `RenderCore::OPTIONAL_FEATURES` the adapter has +
/// the adapter's real buffer limits (80 MB scenes: not the 256 MB default floor). Returns (descriptor, granted features).
pub fn device_descriptor(adapter: &wgpu::Adapter) -> (wgpu::DeviceDescriptor<'static>, wgpu::Features) {
    let feats = adapter.features() & RenderCore::OPTIONAL_FEATURES;
    let lim = adapter.limits();
    (
        wgpu::DeviceDescriptor {
            required_features: feats,
            required_limits: wgpu::Limits {
                max_buffer_size: lim.max_buffer_size,
                max_storage_buffer_binding_size: lim.max_storage_buffer_binding_size,
                ..wgpu::Limits::default()
            },
            ..Default::default()
        },
        feats,
    )
}

fn jf(o: &Value, k: &str) -> Option<f32> {
    o.get(k)?.as_f64().map(|v| v as f32)
}
fn jb(o: &Value, k: &str) -> Option<bool> {
    o.get(k)?.as_bool()
}
fn jvec(o: &Value, k: &str, n: usize) -> Option<Vec<f32>> {
    let a: Vec<f32> = o.get(k)?.as_array()?.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect();
    (a.len() == n).then_some(a)
}

/// JSON object -> ShadowOptions over `b` (every key optional; unknown keys ignored). Keys = ShadowOptions fields, camelCase.
pub fn shadow_options_from_json(o: &Value, mut b: ShadowOptions) -> ShadowOptions {
    if !o.is_object() {
        return b;
    }
    if let Some(v) = jb(o, "enabled") { b.enabled = v; }
    if let Some(v) = jf(o, "cascades") { b.cascades = v as u32; }
    if let Some(v) = jf(o, "resolution") { b.resolution = v as u32; }
    if let Some(v) = jf(o, "maxDistance") { b.max_distance = v; }
    if let Some(v) = jf(o, "splitLambda") { b.split_lambda = v; }
    if let Some(a) = o.get("splits").and_then(Value::as_array) { b.splits = a.iter().filter_map(Value::as_f64).map(|x| x as f32).collect(); }
    if let Some(v) = jf(o, "normalBias") { b.normal_bias = v; }
    if let Some(v) = jf(o, "depthBias") { b.depth_bias = v; }
    if let Some(v) = jf(o, "slopeBias") { b.slope_bias = v; }
    if let Some(v) = jf(o, "constantBias") { b.constant_bias = v as i32; }
    if let Some(v) = jf(o, "pcfRadius") { b.pcf_radius = v as u32; }
    if let Some(v) = jf(o, "blend") { b.blend = v; }
    if let Some(v) = jb(o, "cache") { b.cache = v; }
    if let Some(v) = jf(o, "casterMargin") { b.caster_margin = v; }
    if let Some(v) = jb(o, "alphaTestCasters") { b.alpha_test_casters = v; }
    if let Some(v) = jf(o, "importMaxCasterDiagonal") { b.import_max_caster_diagonal = v; }
    b
}

/// `create(canvas, options)` options (all optional): renderHeight, pipeShare, pipeSort, exposure, hdrScene, toneMapping,
/// lightIntensityScale, ambient[3], clearColor[4], dynamicBlockFrames / dynamicBlockIdleFrames / dynamicBlockMinCapacity (instance-block dynamic path), shadows{..}. `output_format` = the (sRGB view) format of the target.
pub fn render_options_from_json(o: &Value, output_format: wgpu::TextureFormat) -> RenderOptions {
    let mut opts = RenderOptions { output_format, ..RenderOptions::default() };
    if let Some(v) = jf(o, "renderHeight") { opts.render_height = v as u32; }
    if let Some(v) = jb(o, "pipeShare") { opts.pipe_share = v; }
    if let Some(v) = jb(o, "pipeSort") { opts.pipe_sort = v; }
    if let Some(v) = jf(o, "exposure") { opts.exposure = v; }
    if let Some(v) = o.get("hdrScene") { opts.hdr_scene = v.as_bool().unwrap_or_else(|| v.as_f64().is_some_and(|x| x > 0.5)); } // number (legacy callers) or bool
    if let Some(v) = jf(o, "toneMapping") { opts.tone_mapping = v as u32; }
    if let Some(v) = jf(o, "lightIntensityScale") { opts.light_intensity_scale = v; }
    if let Some(v) = jvec(o, "ambient", 3) { opts.ambient = [v[0], v[1], v[2]]; }
    if let Some(v) = jvec(o, "clearColor", 4) { opts.clear_color = [v[0] as f64, v[1] as f64, v[2] as f64, v[3] as f64]; }
    if let Some(v) = jf(o, "dynamicBlockFrames") { opts.dynamic_block_frames = v as u32; }
    if let Some(v) = jf(o, "dynamicBlockIdleFrames") { opts.dynamic_block_idle_frames = v as u32; }
    if let Some(v) = jf(o, "dynamicBlockMinCapacity") { opts.dynamic_block_min_capacity = v as u32; }
    if let Some(sh) = o.get("shadows") { opts.shadows = shadow_options_from_json(sh, opts.shadows.clone()); }
    opts
}

fn mat16(m: &[f32]) -> Result<[f32; 16], String> {
    <[f32; 16]>::try_from(m).map_err(|_| "mat4 needs 16 floats".to_string())
}
fn arr<const N: usize>(m: &[f32], what: &str) -> Result<[f32; N], String> {
    <[f32; N]>::try_from(m).map_err(|_| format!("{what}: needs {N} floats"))
}

pub struct Session {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub core: RenderCore,
    pub has_timestamps: bool,
    /// output (target view) size in px; the host keeps it current.
    pub output: (u32, u32),
}

impl Session {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue, opts: RenderOptions, output: (u32, u32)) -> Self {
        let has_timestamps = device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let core = RenderCore::new(&device, &queue, opts);
        Self { device, queue, core, has_timestamps, output }
    }
    /// Encode one frame into `encoder` (render-wasm `render_inner` minus the surface acquire/submit/present).
    pub fn render(&mut self, encoder: &mut wgpu::CommandEncoder, target: &wgpu::TextureView) {
        let (w, h) = (self.output.0.max(1), self.output.1.max(1));
        self.core.render(&self.device, &self.queue, encoder, target, UpscaleSize { width: w, height: h });
    }
    fn write_material(&mut self, id: u32, base_color: &[f32], metallic: f32, roughness: f32, tex: u32, alpha_cutoff: f32, emissive: &[f32]) -> CmdResult {
        // emissive: 3 floats, or 4 with [3] = 1 -> emissive x base texture (three emissiveMap === map)
        if base_color.len() != 4 || !(emissive.len() == 3 || emissive.len() == 4) {
            return Err("createMaterial: base_color needs 4 floats, emissive 3 (or 4: [3]=emissive-from-base flag)".into());
        }
        self.core.create_material(
            &self.device,
            id,
            MaterialDesc {
                base_color: [base_color[0], base_color[1], base_color[2], base_color[3]],
                metallic,
                roughness,
                base_color_texture: (tex != 0).then_some(tex),
                alpha_cutoff: (alpha_cutoff >= 0.0).then_some(alpha_cutoff),
                emissive: [emissive[0], emissive[1], emissive[2]],
                emissive_from_base: emissive.get(3).is_some_and(|f| *f > 0.5),
            },
        );
        Ok(())
    }
    /// Re-create the shadow system from JSON (omitted keys keep current values). Heavy (reallocates maps).
    pub fn apply_shadow_options(&mut self, opts: &Value) {
        let cur = self.core.shadow_options().clone();
        let n = shadow_options_from_json(opts, cur);
        self.core.set_shadow_options(&self.device, n);
    }
    /// shadowStats as JSON (same keys as render-wasm's JS object).
    pub fn shadow_stats_json(&self) -> Value {
        let s = self.core.shadow_stats();
        json!({
            "enabled": s.enabled, "cascades": s.cascades, "passes": s.passes, "copies": s.copies, "totalDraws": s.total_draws, "cpuCullMs": s.cpu_cull_ms,
            "staticRerendered": s.static_rerendered.iter().map(|&b| b as u8 as f64).collect::<Vec<_>>(),
            "staticDraws": s.static_draws.iter().map(|&b| b as f64).collect::<Vec<_>>(),
            "dynamicDraws": s.dynamic_draws.iter().map(|&b| b as f64).collect::<Vec<_>>(),
            "staticInstances": s.static_instances.iter().map(|&b| b as f64).collect::<Vec<_>>(),
            "dynamicInstances": s.dynamic_instances.iter().map(|&b| b as f64).collect::<Vec<_>>(),
        })
    }
}

impl Commands for Session {
    fn create_mesh(&mut self, id: u32, positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]) -> CmdResult {
        self.core.create_mesh(&self.device, id, positions, normals, uvs, indices).map_err(e)
    }
    fn destroy_mesh(&mut self, id: u32) -> CmdResult {
        self.core.remove_mesh(id);
        Ok(())
    }
    fn create_skin(&mut self, id: u32, joint_count: u32, inverse_bind: &[f32]) -> CmdResult {
        self.core.create_skin(id, joint_count, inverse_bind).map_err(e)
    }
    fn set_skin_pose(&mut self, id: u32, joint_matrices: &[f32]) -> CmdResult {
        self.core.set_skin_pose(id, joint_matrices).map_err(e)
    }
    fn destroy_skin(&mut self, id: u32) -> CmdResult {
        self.core.remove_skin(id);
        Ok(())
    }
    fn create_skinned_mesh(&mut self, id: u32, skin: u32, positions: &[f32], normals: &[f32], uvs: &[f32], joints: &[u32], weights: &[f32], indices: &[u32]) -> CmdResult {
        self.core.create_skinned_mesh(id, skin, positions, normals, uvs, joints, weights, indices).map_err(e)
    }
    fn destroy_skinned_mesh(&mut self, id: u32) -> CmdResult {
        self.core.remove_skinned_mesh(id);
        Ok(())
    }
    fn create_texture(&mut self, id: u32, width: u32, height: u32, rgba: &[u8]) -> CmdResult {
        self.core.create_texture(&self.device, &self.queue, id, width, height, rgba).map_err(e)
    }
    fn create_texture_compressed(&mut self, id: u32, gl_format: u32, width: u32, height: u32, mip_count: u32, data: &[u8], srgb: bool, flip_y: bool) -> CmdResult {
        self.core.create_texture_compressed(&self.device, &self.queue, id, gl_format, width, height, mip_count, data, srgb, flip_y).map_err(e)
    }
    fn create_texture_linear(&mut self, id: u32, width: u32, height: u32, rgba: &[u8]) -> CmdResult {
        self.core.create_texture_linear(&self.device, &self.queue, id, width, height, rgba).map_err(e)
    }
    fn create_texture_array(&mut self, id: u32, width: u32, height: u32, layers: u32, rgba: &[u8], srgb: bool) -> CmdResult {
        self.core.create_texture_array(&self.device, &self.queue, id, width, height, layers, rgba, srgb).map_err(e)
    }
    fn create_texture_cube(&mut self, id: u32, size: u32, faces: &[u8], srgb: bool) -> CmdResult {
        self.core.create_texture_cube(&self.device, &self.queue, id, size, faces, srgb).map_err(e)
    }
    fn update_texture_layer(&mut self, id: u32, layer: u32, rgba: &[u8]) -> CmdResult {
        self.core.update_texture_layer(&self.device, &self.queue, id, layer, rgba).map_err(e)
    }
    /// ids: 0 = none. side 0 double / 1 front only / 2 back only.
    fn set_material_maps(&mut self, id: u32, array: u32, normal: u32, roughness: u32, metalness: u32, emissive: u32, ao: u32, normal_scale: f32, side: u32) -> CmdResult {
        let o = |v: u32| (v != 0).then_some(v);
        self.core.set_material_maps(&self.device, id, MaterialMaps { array: o(array), normal: o(normal), roughness: o(roughness), metalness: o(metalness), emissive: o(emissive), ao: o(ao), normal_scale, side });
        Ok(())
    }
    fn set_mesh_uv1(&mut self, id: u32, uv1: &[f32]) -> CmdResult {
        self.core.set_mesh_uv1(&self.device, id, uv1).map_err(e)
    }
    fn set_mesh_colors(&mut self, id: u32, rgba: &[f32]) -> CmdResult {
        self.core.set_mesh_colors(&self.device, id, rgba).map_err(e)
    }
    /// blend: 0 opaque/none, 1 alpha, 2 additive, 3 subtractive, 4 multiply, 5 premultiplied. depth_write / cast_shadow: -1 default, 0/1.
    fn set_material_flags(&mut self, id: u32, blend: u32, unlit: bool, depth_write: i32, render_order: i32, cast_shadow: i32) -> CmdResult {
        let b = match blend { 1 => Some(BlendKind::Alpha), 2 => Some(BlendKind::Additive), 3 => Some(BlendKind::Subtractive), 4 => Some(BlendKind::Multiply), 5 => Some(BlendKind::Premultiplied), _ => None };
        self.core.set_material_blend(id, blend != 0);
        self.core.set_material_flags(&self.device, id, MaterialFlags { blend: b, unlit, depth_write: (depth_write >= 0).then_some(depth_write != 0), render_order, cast_shadow: (cast_shadow >= 0).then_some(cast_shadow != 0), ..Default::default() });
        Ok(())
    }
    fn set_material_unlit_tone_mapped(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_unlit_tone_mapped(&self.device, id, on);
        Ok(())
    }
    fn set_material_no_receive_shadow(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_no_receive_shadow(&self.device, id, on);
        Ok(())
    }
    fn set_material_no_gi(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_no_gi(&self.device, id, on);
        Ok(())
    }
    fn set_material_chr_light(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_chr_light(&self.device, id, on);
        Ok(())
    }
    fn set_material_no_fog(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_no_fog(&self.device, id, on);
        Ok(())
    }
    fn set_material_no_color_write(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_no_color_write(&self.device, id, on);
        Ok(())
    }
    fn set_material_no_depth_test(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_no_depth_test(&self.device, id, on);
        Ok(())
    }
    fn set_material_shadow_cull_back(&mut self, id: u32, on: bool) -> CmdResult {
        self.core.set_material_shadow_cull_back(id, on);
        Ok(())
    }
    fn destroy_texture(&mut self, id: u32) -> CmdResult {
        self.core.remove_texture(id);
        Ok(())
    }
    fn create_material(&mut self, id: u32, base_color: &[f32], metallic: f32, roughness: f32, base_color_texture: u32, alpha_cutoff: f32, emissive: &[f32]) -> CmdResult {
        self.write_material(id, base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive)
    }
    /// create == update in the core: re-describe an existing material handle.
    fn update_material(&mut self, id: u32, base_color: &[f32], metallic: f32, roughness: f32, base_color_texture: u32, alpha_cutoff: f32, emissive: &[f32]) -> CmdResult {
        self.write_material(id, base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive)
    }
    fn create_shader_material(&mut self, id: u32, wgsl: &str, vertex_entry: &str, fragment_entry: &str, bindings: &[MaterialBinding]) -> CmdResult {
        self.core
            .create_shader_material(&self.device, id, &ShaderMaterialDesc { wgsl: wgsl.to_owned(), vertex_entry: vertex_entry.to_owned(), fragment_entry: fragment_entry.to_owned(), bindings: bindings.to_vec() })
            .map_err(e)
    }
    fn create_three_material(&mut self, id: u32, package_json: &str, texture_names: &[String], texture_ids: &[u32]) -> CmdResult {
        if texture_names.len() != texture_ids.len() {
            return Err("createThreeMaterial: texture_names/texture_ids length mismatch".into());
        }
        let tex: HashMap<String, u32> = texture_names.iter().cloned().zip(texture_ids.iter().copied()).collect();
        self.core.create_three_material(&self.device, id, package_json, tex).map_err(e)
    }
    fn create_storage_buffer(&mut self, id: u32, bytes: &[u8]) -> CmdResult {
        self.core.create_storage_buffer(&self.device, &self.queue, id, bytes);
        Ok(())
    }
    fn update_storage_buffer(&mut self, id: u32, bytes: &[u8]) -> CmdResult {
        self.core.update_storage_buffer(&self.device, &self.queue, id, bytes).map_err(e)
    }
    fn destroy_storage_buffer(&mut self, id: u32) -> CmdResult {
        self.core.destroy_storage_buffer(id);
        Ok(())
    }
    fn bind_three_storage(&mut self, material: u32, key: &str, id: u32) -> CmdResult {
        self.core.bind_three_storage(material, key, id).map_err(e)
    }
    fn set_three_time(&mut self, seconds: f32) -> CmdResult {
        self.core.set_three_time(seconds);
        Ok(())
    }
    fn set_three_uniforms(&mut self, material: u32, json: &str) -> CmdResult {
        self.core.set_three_uniforms(material, json).map(|_| ()).map_err(e)
    }
    fn set_three_uniforms_batch(&mut self, json: &str) -> CmdResult {
        self.core.set_three_uniforms_batch(json).map(|_| ()).map_err(e)
    }
    fn set_mesh_attribute(&mut self, mesh: u32, name: &str, item_size: u32, data: &[f32]) -> CmdResult {
        self.core.set_mesh_attribute(&self.device, mesh, name, item_size, data).map_err(e)
    }
    fn set_instance_attribute(&mut self, instance: u32, name: &str, item_size: u32, data: &[f32]) -> CmdResult {
        self.core.set_instance_attribute(&self.device, instance, name, item_size, data).map_err(e)
    }
    fn destroy_material(&mut self, id: u32) -> CmdResult {
        self.core.remove_material(id);
        Ok(())
    }
    fn create_instance(&mut self, id: u32, mesh: u32, material: u32, mat4: &[f32]) -> CmdResult {
        let m = mat16(mat4)?;
        self.core.create_instance(id, mesh, material, m);
        Ok(())
    }
    fn update_instance(&mut self, id: u32, mat4: &[f32]) -> CmdResult {
        self.core.update_instance(id, mat16(mat4)?);
        Ok(())
    }
    fn remove_instance(&mut self, id: u32) -> CmdResult {
        self.core.remove_instance(id);
        Ok(())
    }
    /// mats = count x 16 local mat4s, colors = count x colorStride (0/3/4; empty = white), world = node matrixWorld (premultiplied in core).
    fn create_instance_block(&mut self, id: u32, mesh: u32, material: u32, mats: &[f32], colors: &[f32], color_stride: u32, count: u32, world: &[f32]) -> CmdResult {
        let w = mat16(world)?;
        self.core.create_instance_block(id, mesh, material, mats, colors, color_stride as usize, count as usize, w);
        Ok(())
    }
    fn update_instance_block(&mut self, id: u32, mats: &[f32], colors: &[f32], color_stride: u32, count: u32, world: &[f32]) -> CmdResult {
        let w = mat16(world)?;
        self.core.update_instance_block(id, mats, colors, color_stride as usize, count as usize, w);
        Ok(())
    }
    fn set_instance_block_uvs(&mut self, id: u32, uvs: &[f32]) -> CmdResult {
        self.core.set_instance_block_uvs(id, uvs);
        Ok(())
    }
    fn set_instance_block_flags(&mut self, id: u32, cast_shadow: bool, is_static: bool) -> CmdResult {
        self.core.set_instance_block_flags(id, cast_shadow, is_static);
        Ok(())
    }
    fn set_instance_block_dynamic(&mut self, id: u32, mode: u32) -> CmdResult {
        self.core.set_instance_block_dynamic(id, mode);
        Ok(())
    }
    fn set_instance_block_shadow_only(&mut self, id: u32, only: bool) -> CmdResult {
        self.core.set_instance_block_shadow_only(id, only);
        Ok(())
    }
    fn remove_instance_block(&mut self, id: u32) -> CmdResult {
        self.core.remove_instance_block(id);
        Ok(())
    }
    fn set_instance_static(&mut self, id: u32, is_static: bool) -> CmdResult {
        self.core.set_instance_static(id, is_static);
        Ok(())
    }
    fn set_instance_groups(&mut self, id: u32, words: &[u32]) -> CmdResult {
        self.core.set_instance_groups(id, words);
        Ok(())
    }
    /// parent u32::MAX = detach.
    fn set_instance_group_parent(&mut self, id: u32, parent: u32) -> CmdResult {
        self.core.set_instance_group_parent(id, if parent == u32::MAX { None } else { Some(parent) });
        Ok(())
    }
    fn set_active_groups(&mut self, words: &[u32]) -> CmdResult {
        self.core.set_active_groups(words);
        Ok(())
    }
    fn clear_active_groups(&mut self) -> CmdResult {
        self.core.clear_active_groups();
        Ok(())
    }
    fn set_instance_shadow_only(&mut self, id: u32, only: bool) -> CmdResult {
        self.core.set_instance_shadow_only(id, only);
        Ok(())
    }
    fn set_instance_cast_shadow(&mut self, id: u32, cast: bool) -> CmdResult {
        self.core.set_instance_cast_shadow(id, cast);
        Ok(())
    }
    fn set_shadow_options(&mut self, opts: &Value) -> CmdResult {
        self.apply_shadow_options(opts);
        Ok(())
    }
    /// `world` = camera-to-world mat4. zfar <= 0 -> infinite far plane.
    fn set_camera(&mut self, world: &[f32], yfov: f32, znear: f32, zfar: f32) -> CmdResult {
        self.core.set_camera(mat16(world)?, yfov, znear, (zfar > 0.0).then_some(zfar));
        Ok(())
    }
    /// direction = where the light travels.
    fn set_sun(&mut self, direction: &[f32], color: &[f32], intensity: f32) -> CmdResult {
        self.core.set_sun(arr::<3>(direction, "setSun direction")?, arr::<3>(color, "setSun color")?, intensity);
        Ok(())
    }
    fn set_hemisphere_irradiance(&mut self, sky: &[f32], ground: &[f32]) -> CmdResult {
        self.core.set_hemisphere_irradiance(arr::<3>(sky, "setHemisphereIrradiance sky")?, arr::<3>(ground, "setHemisphereIrradiance ground")?);
        Ok(())
    }
    fn set_gi_probes(&mut self, irradiance: &[f32], depth: &[f32], params: &[f32]) -> CmdResult {
        self.core.set_gi_probes(&self.device, &self.queue, irradiance, depth, params).map_err(e)
    }
    fn gi_compute_init(&mut self, cfg_json: &str) -> CmdResult {
        self.core.gi_compute_init(&self.device, &self.queue, cfg_json).map_err(e)
    }
    fn gi_compute_voxels(&mut self, start: u32, words: &[u32]) -> CmdResult {
        self.core.gi_compute_voxels(&self.queue, start, words).map_err(e)
    }
    fn gi_compute_step(&mut self, frame: &[f32], fresh: &[u32]) -> CmdResult {
        self.core.gi_compute_step(&self.queue, frame, fresh).map_err(e)
    }
    fn gi_compute_destroy(&mut self) -> CmdResult {
        self.core.gi_compute_destroy(&self.device, &self.queue);
        Ok(())
    }
    fn gi_compute_stats(&mut self) -> Value {
        json!(self.core.gi_compute_stats().to_vec())
    }
    fn clear_gi_probes(&mut self) -> CmdResult {
        self.core.clear_gi_probes(&self.queue);
        Ok(())
    }
    fn set_fog(&mut self, mode: u32, color: &[f32], near: f32, far: f32, density: f32) -> CmdResult {
        self.core.set_fog(mode, arr::<3>(color, "setFog color")?, near, far, density);
        Ok(())
    }
    fn set_environment_sh(&mut self, sh: &[f32], intensity: f32) -> CmdResult {
        self.core.set_environment_sh(sh, intensity).map_err(e)
    }
    fn clear_environment(&mut self) -> CmdResult {
        self.core.clear_environment();
        Ok(())
    }
    fn set_background_cube(&mut self, size: u32, faces: &[u8], srgb: bool, intensity: f32) -> CmdResult {
        self.core.set_background_cube(&self.device, &self.queue, size, faces, srgb, intensity).map_err(e)
    }
    fn set_background_texture(&mut self, width: u32, height: u32, rgba: &[u8], srgb: bool, equirect: bool, intensity: f32) -> CmdResult {
        self.core.set_background_texture(&self.device, &self.queue, width, height, rgba, srgb, equirect, intensity).map_err(e)
    }
    fn clear_background_texture(&mut self) -> CmdResult {
        self.core.clear_background_texture();
        Ok(())
    }
    fn set_tone_mapping(&mut self, mode: u32) -> CmdResult {
        self.core.set_tone_mapping(mode).map_err(e)
    }
    fn set_exposure(&mut self, ex: f32) -> CmdResult {
        self.core.set_exposure(ex);
        Ok(())
    }
    /// `strength < 0` = bloom off.
    fn set_bloom(&mut self, strength: f32, radius: f32, threshold: f32, smooth_width: f32) -> CmdResult {
        let b = (strength >= 0.0).then_some(BloomParams { strength, radius, threshold, smooth_width });
        self.core.set_bloom(b).map_err(e)
    }
    fn set_gtao(&mut self, on: bool, radius: f32, thickness: f32, samples: f32, distance_exponent: f32, distance_fall_off: f32, scale: f32, resolution_scale: f32, intensity: f32, fade_start: f32, fade_end: f32) -> CmdResult {
        let g = on.then_some(GtaoParams { radius, thickness, samples, distance_exponent, distance_fall_off, scale, resolution_scale, intensity, fade_start, fade_end });
        self.core.set_gtao(g).map_err(e)
    }
    /// 16 f32 column-major colour matrix; len != 16 = off.
    fn set_color_grade(&mut self, m: &[f32]) -> CmdResult {
        let g = (m.len() == 16).then(|| {
            let mut o = [[0.0f32; 4]; 4];
            for c in 0..4 {
                for r in 0..4 {
                    o[c][r] = m[c * 4 + r];
                }
            }
            o
        });
        self.core.set_color_grade(g).map_err(e)
    }
    fn set_auto_exposure(&mut self, on: bool, mul: f32) -> CmdResult {
        self.core.set_auto_exposure(on, mul).map_err(e)
    }
    fn set_background_color(&mut self, rgb: &[f32]) -> CmdResult {
        self.core.set_background_color(arr::<3>(rgb, "setBackgroundColor")?);
        Ok(())
    }
    fn set_clear_color(&mut self, rgba: &[f32]) -> CmdResult {
        let a = arr::<4>(rgba, "setClearColor")?;
        self.core.set_clear_color([a[0] as f64, a[1] as f64, a[2] as f64, a[3] as f64]);
        Ok(())
    }
    fn set_point_lights(&mut self, packed: &[f32]) -> CmdResult {
        self.core.set_point_lights(packed);
        Ok(())
    }
    fn set_extra_dirs(&mut self, packed: &[f32]) -> CmdResult {
        self.core.set_extra_dirs(packed);
        Ok(())
    }
    fn set_render_height(&mut self, h: u32) -> CmdResult {
        self.core.set_render_height(h);
        Ok(())
    }
    /// Frame boundary marker: the Host (not the Session) turns this into "a frame is pending".
    fn frame_commit(&mut self) -> CmdResult {
        Ok(())
    }

    // ---- queries ----
    fn compressed_stats(&mut self) -> Value {
        json!(self.core.bc_stats.to_vec())
    }
    fn dyn_block_stats(&mut self) -> Value {
        json!(self.core.dyn_block_stats_vec())
    }
    fn three_skipped(&mut self) -> Value {
        json!(self.core.three_skipped)
    }
    fn drawn_instance_count(&mut self) -> Value {
        json!(self.core.drawn_instance_count())
    }
    fn instance_count(&mut self) -> Value {
        json!(self.core.instance_count())
    }
    fn last_group_hidden(&mut self) -> Value {
        json!(self.core.last_group_hidden)
    }
    fn shadow_stats(&mut self) -> Value {
        self.shadow_stats_json()
    }
    /// drain: newest 8x8 grid (64 f32) or empty when none arrived since the last call.
    fn auto_exposure_grid(&mut self) -> Value {
        json!(self.core.auto_exposure_grid().unwrap_or_default())
    }
    fn hdr_scene(&mut self) -> Value {
        json!(self.core.hdr_scene())
    }
    fn pass_stats(&mut self) -> Value {
        json!(self.core.last_pass_stats.to_vec())
    }
    fn draw_calls(&mut self) -> Value {
        json!(self.core.last_draw_calls)
    }
    fn has_timestamps(&mut self) -> Value {
        json!(self.has_timestamps)
    }
    /// [outW, outH, intW, intH]
    fn sizes(&mut self) -> Value {
        let i = self.core.internal_size().unwrap_or(UpscaleSize { width: 0, height: 0 });
        json!([self.output.0, self.output.1, i.width, i.height])
    }
}
