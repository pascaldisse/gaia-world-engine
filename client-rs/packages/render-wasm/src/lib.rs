//! render-wasm — gaia-render in the browser (WebGPU canvas). Data-only API: typed arrays in,
//! integer handles (>0) out. Mirrors crates/gaia-render/NOTES.md; the JS adapter is
//! client/kernel/render-api/wgpu-backend.js. wasm32-only (empty lib on native targets).
#![cfg(target_arch = "wasm32")]

use gaia_render::{
    MaterialBinding, BlendKind, MaterialDesc, MaterialFlags, MaterialMaps, RenderCore, RenderOptions, ShaderMaterialDesc, ShadowOptions, UpscaleSize,
};
use js_sys::{Array, Float32Array, Promise, Reflect, Uint8Array};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

fn err<E: std::fmt::Display>(e: E) -> JsError {
    JsError::new(&e.to_string())
}

/// wasm32-unknown-unknown is single threaded; wgpu's `on_submitted_work_done` wants `Send`.
struct SendWrap<T>(T);
unsafe impl<T> Send for SendWrap<T> {}

fn now_ms() -> f64 {
    web_sys::window()
        .and_then(|w| w.performance())
        .map(|p| p.now())
        .unwrap_or(0.0)
}

#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&JsValue::from_str(&format!("render-wasm panic: {info}")));
    }));
}

fn opt_f32(o: &JsValue, k: &str) -> Option<f32> {
    Reflect::get(o, &JsValue::from_str(k)).ok()?.as_f64().map(|v| v as f32)
}
fn opt_vec(o: &JsValue, k: &str, n: usize) -> Option<Vec<f32>> {
    let v = Reflect::get(o, &JsValue::from_str(k)).ok()?;
    if v.is_undefined() || v.is_null() {
        return None;
    }
    let a: Vec<f32> = Array::from(&v).iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect();
    (a.len() == n).then_some(a)
}

/// JS object → ShadowOptions over `base` (every key optional; unknown keys ignored). Keys = gaia-render ShadowOptions fields, camelCase.
fn shadow_opts(o: &JsValue, mut b: ShadowOptions) -> ShadowOptions {
if !o.is_object() {
return b;
}
let bo = |k: &str| Reflect::get(o, &JsValue::from_str(k)).ok().and_then(|v| v.as_bool());
let f = |k: &str| opt_f32(o, k);
if let Some(v) = bo("enabled") { b.enabled = v; }
if let Some(v) = f("cascades") { b.cascades = v as u32; }
if let Some(v) = f("resolution") { b.resolution = v as u32; }
if let Some(v) = f("maxDistance") { b.max_distance = v; }
if let Some(v) = f("splitLambda") { b.split_lambda = v; }
if let Ok(v) = Reflect::get(o, &JsValue::from_str("splits")) { if !v.is_undefined() && !v.is_null() { b.splits = Array::from(&v).iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect(); } }
if let Some(v) = f("normalBias") { b.normal_bias = v; }
if let Some(v) = f("depthBias") { b.depth_bias = v; }
if let Some(v) = f("slopeBias") { b.slope_bias = v; }
if let Some(v) = f("constantBias") { b.constant_bias = v as i32; }
if let Some(v) = f("pcfRadius") { b.pcf_radius = v as u32; }
if let Some(v) = f("blend") { b.blend = v; }
if let Some(v) = bo("cache") { b.cache = v; }
if let Some(v) = f("casterMargin") { b.caster_margin = v; }
if let Some(v) = bo("alphaTestCasters") { b.alpha_test_casters = v; }
if let Some(v) = f("importMaxCasterDiagonal") { b.import_max_caster_diagonal = v; }
b
}
#[wasm_bindgen]
pub struct GaiaRender {
    canvas: web_sys::HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    device: wgpu::Device,
    queue: wgpu::Queue,
    core: RenderCore,
    next: HashMap<&'static str, u32>,
    has_timestamps: bool,
}

#[wasm_bindgen]
impl GaiaRender {
    /// `options` (all optional): renderHeight, exposure, ambient[3], clearColor[4], lightIntensityScale.
    pub async fn create(
        canvas: web_sys::HtmlCanvasElement,
        options: JsValue,
    ) -> Result<GaiaRender, JsError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance
            .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
            .map_err(err)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .map_err(err)?;
        let feats = adapter.features() & RenderCore::OPTIONAL_FEATURES;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                required_features: feats,
                // 80 MB scenes: take the adapter's real buffer limits, not the 256 MB default floor.
                required_limits: wgpu::Limits {
                    max_buffer_size: adapter.limits().max_buffer_size,
                    max_storage_buffer_binding_size: adapter.limits().max_storage_buffer_binding_size,
                    ..wgpu::Limits::default()
                },
                ..Default::default()
            })
            .await
            .map_err(err)?;
        let caps = surface.get_capabilities(&adapter);
        // canvas formats are non-sRGB on the web; render through the sRGB view of the same format.
        let base = [wgpu::TextureFormat::Bgra8Unorm, wgpu::TextureFormat::Rgba8Unorm]
            .into_iter()
            .find(|f| caps.formats.contains(f))
            .ok_or_else(|| err("no bgra8/rgba8 canvas format"))?;
        let view_format = base.add_srgb_suffix();
        let (w, h) = (canvas.width().max(1), canvas.height().max(1));
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: base,
            width: w,
            height: h,
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![view_format],
            color_space: wgpu::SurfaceColorSpace::Auto,
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let mut opts = RenderOptions {
            output_format: view_format,
            ..RenderOptions::default()
        };
        if let Some(v) = opt_f32(&options, "renderHeight") {
            opts.render_height = v as u32;
        }
        if let Some(v) = Reflect::get(&options, &JsValue::from_str("pipeShare")).ok().and_then(|v| v.as_bool()) {
            opts.pipe_share = v;
        }
        if let Some(v) = Reflect::get(&options, &JsValue::from_str("pipeSort")).ok().and_then(|v| v.as_bool()) {
            opts.pipe_sort = v;
        }
        if let Some(v) = opt_f32(&options, "exposure") {
            opts.exposure = v;
        }
        if let Some(v) = opt_f32(&options, "hdrScene") {
            opts.hdr_scene = v > 0.5;
        }
        if let Some(v) = opt_f32(&options, "toneMapping") {
            opts.tone_mapping = v as u32;
        }
        if let Some(v) = opt_f32(&options, "lightIntensityScale") {
            opts.light_intensity_scale = v;
        }
        if let Some(v) = opt_vec(&options, "ambient", 3) {
            opts.ambient = [v[0], v[1], v[2]];
        }
        if let Some(v) = opt_vec(&options, "clearColor", 4) {
            opts.clear_color = [v[0] as f64, v[1] as f64, v[2] as f64, v[3] as f64];
        }
        if let Ok(sh) = Reflect::get(&options, &JsValue::from_str("shadows")) {
opts.shadows = shadow_opts(&sh, opts.shadows.clone());
}
let core = RenderCore::new(&device, &queue, opts);
        Ok(GaiaRender {
            canvas,
            surface,
            config,
            view_format,
            device,
            queue,
            core,
            next: HashMap::new(),
            has_timestamps: feats.contains(wgpu::Features::TIMESTAMP_QUERY),
        })
    }

    fn id(&mut self, kind: &'static str) -> u32 {
        let n = self.next.entry(kind).or_insert(0);
        *n += 1;
        *n
    }

    // ---- meshes ----
    /// normals/uvs must be present (JS adapter zero-fills); lengths validated → throws.
    #[wasm_bindgen(js_name = createMesh)]
    pub fn create_mesh(
        &mut self,
        positions: &[f32],
        normals: &[f32],
        uvs: &[f32],
        indices: &[u32],
    ) -> Result<u32, JsError> {
        let id = self.id("mesh");
        self.core
            .create_mesh(&self.device, id, positions, normals, uvs, indices)
            .map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = destroyMesh)]
    pub fn destroy_mesh(&mut self, id: u32) {
        self.core.remove_mesh(id);
    }

    // ---- skinning (gaia-render skin.rs) ----
    #[wasm_bindgen(js_name = createSkin)]
    pub fn create_skin(&mut self, joint_count: u32, inverse_bind: &[f32]) -> Result<u32, JsError> {
        let id = self.id("skin");
        self.core.create_skin(id, joint_count, inverse_bind).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = setSkinPose)]
    pub fn set_skin_pose(&mut self, id: u32, joint_matrices: &[f32]) -> Result<(), JsError> {
        self.core.set_skin_pose(id, joint_matrices).map_err(err)
    }
    #[wasm_bindgen(js_name = destroySkin)]
    pub fn destroy_skin(&mut self, id: u32) {
        self.core.remove_skin(id);
    }
    /// Skinned mesh shares the mesh id space (draw via createInstance with identity mat4).
    #[wasm_bindgen(js_name = createSkinnedMesh)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_skinned_mesh(
        &mut self,
        skin: u32,
        positions: &[f32],
        normals: &[f32],
        uvs: &[f32],
        joints: &[u32],
        weights: &[f32],
        indices: &[u32],
    ) -> Result<u32, JsError> {
        let id = self.id("mesh");
        self.core
            .create_skinned_mesh(id, skin, positions, normals, uvs, joints, weights, indices)
            .map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = destroySkinnedMesh)]
    pub fn destroy_skinned_mesh(&mut self, id: u32) {
        self.core.remove_skinned_mesh(id);
    }

    // ---- textures (RGBA8) ----
    #[wasm_bindgen(js_name = createTexture)]
    pub fn create_texture(&mut self, width: u32, height: u32, rgba: &[u8]) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.core
            .create_texture(&self.device, &self.queue, id, width, height, rgba)
            .map_err(err)?;
        Ok(id)
    }
    /// r4 (lampas/r4-uniforms): RGBA8 sampled without sRGB decode (three colorSpace != srgb).
    #[wasm_bindgen(js_name = createTextureLinear)]
    pub fn create_texture_linear(&mut self, width: u32, height: u32, rgba: &[u8]) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.core.create_texture_linear(&self.device, &self.queue, id, width, height, rgba).map_err(err)?;
        Ok(id)
    }
    /// Array texture: `layers` RGBA8 images (layer-major) + GPU mips per layer. srgb=false = linear sampling.
    #[wasm_bindgen(js_name = createTextureArray)]
    pub fn create_texture_array(&mut self, width: u32, height: u32, layers: u32, rgba: &[u8], srgb: bool) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.core.create_texture_array(&self.device, &self.queue, id, width, height, layers, rgba, srgb).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = updateTextureLayer)]
    pub fn update_texture_layer(&mut self, id: u32, layer: u32, rgba: &[u8]) -> Result<(), JsError> {
        self.core.update_texture_layer(&self.device, &self.queue, id, layer, rgba).map_err(err)
    }
    /// ids: 0 = none. side 0 double / 1 front only / 2 back only.
    #[wasm_bindgen(js_name = setMaterialMaps)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_material_maps(&mut self, id: u32, array: u32, normal: u32, roughness: u32, metalness: u32, emissive: u32, ao: u32, normal_scale: f32, side: u32) {
        let o = |v: u32| (v != 0).then_some(v);
        self.core.set_material_maps(&self.device, id, MaterialMaps { array: o(array), normal: o(normal), roughness: o(roughness), metalness: o(metalness), emissive: o(emissive), ao: o(ao), normal_scale, side });
    }
    /// TEXCOORD_1 per vertex (2 floats/vertex). With an array material, uv1.x = array layer.
    #[wasm_bindgen(js_name = setMeshUv1)]
    pub fn set_mesh_uv1(&mut self, id: u32, uv1: &[f32]) -> Result<(), JsError> {
        self.core.set_mesh_uv1(&self.device, id, uv1).map_err(err)
    }
    /// COLOR_0 per vertex (rgba, linear, 4 floats/vertex): multiplies base colour rgb + alpha.
    #[wasm_bindgen(js_name = setMeshColors)]
    pub fn set_mesh_colors(&mut self, id: u32, rgba: &[f32]) -> Result<(), JsError> {
        self.core.set_mesh_colors(&self.device, id, rgba).map_err(err)
    }
        /// blend: 0 opaque/none, 1 alpha, 2 additive, 3 subtractive. depth_write: -1 default, 0/1. cast_shadow: -1 default, 0/1.
    #[wasm_bindgen(js_name = setMaterialFlags)]
    pub fn set_material_flags(&mut self, id: u32, blend: u32, unlit: bool, depth_write: i32, render_order: i32, cast_shadow: i32) {
        let b = match blend { 1 => Some(BlendKind::Alpha), 2 => Some(BlendKind::Additive), 3 => Some(BlendKind::Subtractive), _ => None };
        self.core.set_material_blend(id, blend != 0);
        self.core.set_material_flags(&self.device, id, MaterialFlags { blend: b, unlit, depth_write: (depth_write >= 0).then_some(depth_write != 0), render_order, cast_shadow: (cast_shadow >= 0).then_some(cast_shadow != 0), ..Default::default() });
    }
    /// unlit materials: apply exposure + Reinhard (three toneMapped:true). Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialUnlitToneMapped)]
    pub fn set_material_unlit_tone_mapped(&mut self, id: u32, on: bool) {
        self.core.set_material_unlit_tone_mapped(&self.device, id, on);
    }
    /// three receiveShadow:false (per material): sun shadow map not sampled. Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialNoReceiveShadow)]
    pub fn set_material_no_receive_shadow(&mut self, id: u32, on: bool) {
        self.core.set_material_no_receive_shadow(&self.device, id, on);
    }
/// three did not attach probe GI to this (non-node) material: hemisphere ambient only. Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialNoGi)]
    pub fn set_material_no_gi(&mut self, id: u32, on: bool) {
        self.core.set_material_no_gi(&self.device, id, on);
    }
    
    /// three colorWrite:false (depth-only / occluder mesh): empty colour write mask, depth per depthWrite. Call after setMaterialFlags (which resets it).
    #[wasm_bindgen(js_name = setMaterialNoColorWrite)]
    pub fn set_material_no_color_write(&mut self, id: u32, on: bool) {
        self.core.set_material_no_color_write(&self.device, id, on);
    }
    /// three depthTest:false: depth compare ALWAYS (draws over nearer geometry). Call after setMaterialFlags (which resets it).
    #[wasm_bindgen(js_name = setMaterialNoDepthTest)]
    pub fn set_material_no_depth_test(&mut self, id: u32, on: bool) {
        self.core.set_material_no_depth_test(&self.device, id, on);
    }
    /// three FrontSide material: shadow caster pass culls back faces (r9). Call after setMaterialFlags (which resets it).
    #[wasm_bindgen(js_name = setMaterialShadowCullBack)]
    pub fn set_material_shadow_cull_back(&mut self, id: u32, on: bool) {
        self.core.set_material_shadow_cull_back(id, on);
    }
#[wasm_bindgen(js_name = destroyTexture)]
    pub fn destroy_texture(&mut self, id: u32) {
        self.core.remove_texture(id);
    }

    // ---- materials ----
    /// built-in PBR. base_color_texture 0 = none; alpha_cutoff < 0 = opaque. Linear colors.
    #[wasm_bindgen(js_name = createMaterial)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_material(
        &mut self,
        base_color: &[f32],
        metallic: f32,
        roughness: f32,
        base_color_texture: u32,
        alpha_cutoff: f32,
        emissive: &[f32],
    ) -> Result<u32, JsError> {
        let id = self.id("material");
        self.write_material(id, base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive)?;
        Ok(id)
    }
    /// create == update in the core: re-describe an existing material handle.
    #[wasm_bindgen(js_name = updateMaterial)]
    #[allow(clippy::too_many_arguments)]
    pub fn update_material(
        &mut self,
        id: u32,
        base_color: &[f32],
        metallic: f32,
        roughness: f32,
        base_color_texture: u32,
        alpha_cutoff: f32,
        emissive: &[f32],
    ) -> Result<(), JsError> {
        self.write_material(id, base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive)
    }
    #[allow(clippy::too_many_arguments)]
    fn write_material(
        &mut self,
        id: u32,
        base_color: &[f32],
        metallic: f32,
        roughness: f32,
        base_color_texture: u32,
        alpha_cutoff: f32,
        emissive: &[f32],
    ) -> Result<(), JsError> {
        // emissive: 3 floats, or 4 with [3] = 1 -> emissive x base texture (three emissiveMap === map)
        if base_color.len() != 4 || !(emissive.len() == 3 || emissive.len() == 4) {
            return Err(err("createMaterial: base_color needs 4 floats, emissive 3 (or 4: [3]=emissive-from-base flag)"));
        }
        self.core.create_material(
            &self.device,
            id,
            MaterialDesc {
                base_color: [base_color[0], base_color[1], base_color[2], base_color[3]],
                metallic,
                roughness,
                base_color_texture: (base_color_texture != 0).then_some(base_color_texture),
                alpha_cutoff: (alpha_cutoff >= 0.0).then_some(alpha_cutoff),
                emissive: [emissive[0], emissive[1], emissive[2]],
                emissive_from_base: emissive.get(3).is_some_and(|f| *f > 0.5),
            },
        );
        Ok(())
    }
    /// External WGSL material (see gaia-render NOTES contract). `bindings` = JS array of
    /// `{kind:'uniform'|'texture'|'sampler', binding, data?:Uint8Array, vertex?:bool, texture?:id}`.
    #[wasm_bindgen(js_name = createShaderMaterial)]
    pub fn create_shader_material(
        &mut self,
        wgsl: String,
        vertex_entry: String,
        fragment_entry: String,
        bindings: Array,
    ) -> Result<u32, JsError> {
        let get = |o: &JsValue, k: &str| Reflect::get(o, &JsValue::from_str(k)).unwrap_or(JsValue::UNDEFINED);
        let mut out = Vec::new();
        for b in bindings.iter() {
            let binding = get(&b, "binding").as_f64().ok_or_else(|| err("binding: number required"))? as u32;
            let kind = get(&b, "kind").as_string().unwrap_or_default();
            out.push(match kind.as_str() {
                "uniform" => MaterialBinding::Uniform {
                    binding,
                    data: Uint8Array::new(&get(&b, "data")).to_vec(),
                    visibility_vertex: get(&b, "vertex").as_bool().unwrap_or(false),
                },
                "texture" => MaterialBinding::Texture {
                    binding,
                    texture: get(&b, "texture").as_f64().unwrap_or(0.0) as u32,
                },
                "sampler" => MaterialBinding::Sampler { binding },
                k => return Err(err(format!("unknown binding kind '{k}'"))),
            });
        }
        let id = self.id("material");
        self.core
            .create_shader_material(
                &self.device,
                id,
                &ShaderMaterialDesc { wgsl, vertex_entry, fragment_entry, bindings: out },
            )
            .map_err(err)?;
        Ok(id)
    }
    /// three r180 TSL package (tsl-export.js JSON, as-is) → material id. `texture_names[i]` = WGSL binding var
    /// name (package `bindGroups[].bindings[].name`), `texture_ids[i]` = id from createTexture. gaia-render NOTES 'Round 3'.
    #[wasm_bindgen(js_name = createThreeMaterial)]
    pub fn create_three_material(&mut self, package_json: String, texture_names: Array, texture_ids: &[u32]) -> Result<u32, JsError> {
        if texture_names.length() as usize != texture_ids.len() {
            return Err(err("createThreeMaterial: texture_names/texture_ids length mismatch"));
        }
        let tex: HashMap<String, u32> = texture_names.iter().zip(texture_ids).map(|(n, &i)| (n.as_string().unwrap_or_default(), i)).collect();
        let id = self.id("material");
        self.core.create_three_material(&self.device, id, &package_json, tex).map_err(err)?;
        Ok(id)
    }
        /// r6-tsl-2: storage buffer for TSL storage()/buffer nodes (raw bytes, any element type) -> id.
    #[wasm_bindgen(js_name = createStorageBuffer)]
    pub fn create_storage_buffer(&mut self, bytes: &[u8]) -> u32 {
        let id = self.id("storage");
        self.core.create_storage_buffer(&self.device, &self.queue, id, bytes);
        id
    }
    #[wasm_bindgen(js_name = updateStorageBuffer)]
    pub fn update_storage_buffer(&mut self, id: u32, bytes: &[u8]) -> Result<(), JsError> {
        self.core.update_storage_buffer(&self.device, &self.queue, id, bytes).map_err(err)
    }
    #[wasm_bindgen(js_name = destroyStorageBuffer)]
    pub fn destroy_storage_buffer(&mut self, id: u32) {
        self.core.destroy_storage_buffer(id);
    }
    /// Point a three material's storage binding ("group.binding" key) at a storage buffer id.
    #[wasm_bindgen(js_name = bindThreeStorage)]
    pub fn bind_three_storage(&mut self, material: u32, key: &str, id: u32) -> Result<(), JsError> {
        self.core.bind_three_storage(material, key, id).map_err(err)
    }
    /// seconds fed to three `time` semantic uniforms.
    #[wasm_bindgen(js_name = setThreeTime)]
    pub fn set_three_time(&mut self, seconds: f32) {
        self.core.set_three_time(seconds);
    }
    /// r4 (lampas/r4-uniforms): live three uniform values, JSON `[{key,value}]` from tsl-export `pkg.live.update()`.
    #[wasm_bindgen(js_name = setThreeUniforms)]
    pub fn set_three_uniforms(&mut self, material: u32, json: &str) -> Result<u32, JsValue> {
        self.core.set_three_uniforms(material, json).map(|n| n as u32).map_err(|e| JsValue::from_str(&e))
    }
    /// r10-5: batched live uniforms, one call per frame (see RenderCore::set_three_uniforms_batch).
    #[wasm_bindgen(js_name = setThreeUniformsBatch)]
    pub fn set_three_uniforms_batch(&mut self, json: &str) -> Result<u32, JsValue> {
        self.core.set_three_uniforms_batch(json).map(|n| n as u32).map_err(|e| JsValue::from_str(&e))
    }
    /// r6-tsl: extra named per-vertex attribute (uv1, colour, custom, node buffer attribute: `node:<uuid>`) for TSL materials.
    #[wasm_bindgen(js_name = setMeshAttribute)]
    pub fn set_mesh_attribute(&mut self, mesh: u32, name: &str, item_size: u32, data: &[f32]) -> Result<(), JsError> {
        self.core.set_mesh_attribute(&self.device, mesh, name, item_size, data).map_err(err)
    }
    /// r6-tsl: per-instance attribute value (one element) for TSL materials (expanded InstancedMesh rows).
    #[wasm_bindgen(js_name = setInstanceAttribute)]
    pub fn set_instance_attribute(&mut self, instance: u32, name: &str, item_size: u32, data: &[f32]) -> Result<(), JsError> {
        self.core.set_instance_attribute(&self.device, instance, name, item_size, data).map_err(err)
    }
    /// r6-tsl: three instances SKIPPED in the last frame (material needs an attribute the mesh/instance lacks).
    #[wasm_bindgen(js_name = threeSkipped)]
    pub fn three_skipped(&self) -> u32 {
        self.core.three_skipped
    }

    #[wasm_bindgen(js_name = destroyMaterial)]
    pub fn destroy_material(&mut self, id: u32) {
        self.core.remove_material(id);
    }

    // ---- instances (world mat4, column-major; hierarchy is the JS adapter's job) ----
    #[wasm_bindgen(js_name = createInstance)]
    pub fn create_instance(&mut self, mesh: u32, material: u32, mat4: &[f32]) -> Result<u32, JsError> {
        let m = mat16(mat4)?;
        let id = self.id("instance");
        self.core.create_instance(id, mesh, material, m);
        Ok(id)
    }
    #[wasm_bindgen(js_name = updateInstance)]
    pub fn update_instance(&mut self, id: u32, mat4: &[f32]) -> Result<(), JsError> {
        self.core.update_instance(id, mat16(mat4)?);
        Ok(())
    }
    #[wasm_bindgen(js_name = removeInstance)]
    pub fn remove_instance(&mut self, id: u32) {
        self.core.remove_instance(id);
    }
    // ---- native instance blocks (InstancedMesh): mats = count×16 local mat4s, colors = count×colorStride (0/3/4; empty = white), world = node matrixWorld (premultiplied in core) ----
    #[wasm_bindgen(js_name = createInstanceBlock)]
    pub fn create_instance_block(&mut self, mesh: u32, material: u32, mats: &[f32], colors: &[f32], color_stride: u32, count: u32, world: &[f32]) -> Result<u32, JsError> {
        let w = mat16(world)?;
        let id = self.id("instance block");
        self.core.create_instance_block(id, mesh, material, mats, colors, color_stride as usize, count as usize, w);
        Ok(id)
    }
    #[wasm_bindgen(js_name = updateInstanceBlock)]
    pub fn update_instance_block(&mut self, id: u32, mats: &[f32], colors: &[f32], color_stride: u32, count: u32, world: &[f32]) -> Result<(), JsError> {
        let w = mat16(world)?;
        self.core.update_instance_block(id, mats, colors, color_stride as usize, count as usize, w);
        Ok(())
    }
    #[wasm_bindgen(js_name = setInstanceBlockFlags)]
    pub fn set_instance_block_flags(&mut self, id: u32, cast_shadow: bool, is_static: bool) {
        self.core.set_instance_block_flags(id, cast_shadow, is_static);
    }
    #[wasm_bindgen(js_name = setInstanceBlockShadowOnly)]
    pub fn set_instance_block_shadow_only(&mut self, id: u32, only: bool) {
        self.core.set_instance_block_shadow_only(id, only);
    }
    #[wasm_bindgen(js_name = removeInstanceBlock)]
    pub fn remove_instance_block(&mut self, id: u32) {
        self.core.remove_instance_block(id);
    }
    #[wasm_bindgen(js_name = drawnInstanceCount)]
    pub fn drawn_instance_count(&self) -> usize {
        self.core.drawn_instance_count()
    }
    #[wasm_bindgen(js_name = instanceCount)]
    pub fn instance_count(&self) -> usize {
        self.core.instance_count()
    }

    // ---- shadows (gaia-render shadow.rs) ----
/// instances default DYNAMIC (redrawn into the live layer every frame); static = cached per cascade until moved/changed.
#[wasm_bindgen(js_name = setInstanceStatic)]
pub fn set_instance_static(&mut self, id: u32, is_static: bool) {
self.core.set_instance_static(id, is_static);
}
// ---- visibility groups (gaia-render groups.rs): u32 bitset words, word w bit b = group 32w+b ----
/// Instance group mask (empty = no groups = always drawn).
#[wasm_bindgen(js_name = setInstanceGroups)]
pub fn set_instance_groups(&mut self, id: u32, words: &[u32]) {
self.core.set_instance_groups(id, words);
}
/// Instance follows `parent` instance's effective mask (u32::MAX = detach).
#[wasm_bindgen(js_name = setInstanceGroupParent)]
pub fn set_instance_group_parent(&mut self, id: u32, parent: u32) {
self.core.set_instance_group_parent(id, if parent == u32::MAX { None } else { Some(parent) });
}
/// ACTIVE group set (union is the caller's OR). Drawn iff instance mask ∩ active ≠ ∅; no groups = always drawn. Main + shadow passes.
#[wasm_bindgen(js_name = setActiveGroups)]
pub fn set_active_groups(&mut self, words: &[u32]) {
self.core.set_active_groups(words);
}
/// Group culling OFF (default).
#[wasm_bindgen(js_name = clearActiveGroups)]
pub fn clear_active_groups(&mut self) {
self.core.clear_active_groups();
}
/// Instances excluded by group culling at the last instance rebuild.
#[wasm_bindgen(js_name = lastGroupHidden)]
pub fn last_group_hidden(&self) -> u32 {
self.core.last_group_hidden
}
#[wasm_bindgen(js_name = setInstanceShadowOnly)]
pub fn set_instance_shadow_only(&mut self, id: u32, only: bool) {
self.core.set_instance_shadow_only(id, only);
}
#[wasm_bindgen(js_name = setInstanceCastShadow)]
pub fn set_instance_cast_shadow(&mut self, id: u32, cast: bool) {
self.core.set_instance_cast_shadow(id, cast);
}
/// Re-create the shadow system with `opts` (object, camelCase ShadowOptions keys; omitted keys keep current values). Heavy (reallocates maps).
#[wasm_bindgen(js_name = setShadowOptions)]
pub fn set_shadow_options(&mut self, opts: JsValue) {
let cur = self.core.shadow_options().clone();
let n = shadow_opts(&opts, cur);
self.core.set_shadow_options(&self.device, n);
}
/// Last frame's shadow work: {enabled,cascades,passes,copies,totalDraws,cpuCullMs,staticRerendered:[..],staticDraws:[..],dynamicDraws:[..]}.
#[wasm_bindgen(js_name = shadowStats)]
pub fn shadow_stats(&self) -> JsValue {
let s = self.core.shadow_stats();
let o = js_sys::Object::new();
let set = |k: &str, v: JsValue| { let _ = Reflect::set(&o, &JsValue::from_str(k), &v); };
set("enabled", s.enabled.into());
set("cascades", JsValue::from_f64(s.cascades as f64));
set("passes", JsValue::from_f64(s.passes as f64));
set("copies", JsValue::from_f64(s.copies as f64));
set("totalDraws", JsValue::from_f64(s.total_draws as f64));
set("cpuCullMs", JsValue::from_f64(s.cpu_cull_ms));
let arr = |it: Vec<f64>| -> JsValue { it.into_iter().map(JsValue::from_f64).collect::<Array>().into() };
set("staticRerendered", arr(s.static_rerendered.iter().map(|&b| b as u8 as f64).collect()));
set("staticDraws", arr(s.static_draws.iter().map(|&b| b as f64).collect()));
set("dynamicDraws", arr(s.dynamic_draws.iter().map(|&b| b as f64).collect()));
set("staticInstances", arr(s.static_instances.iter().map(|&b| b as f64).collect()));
set("dynamicInstances", arr(s.dynamic_instances.iter().map(|&b| b as f64).collect()));
o.into()
}
// ---- camera + lights ----
    /// `world` = camera-to-world mat4. zfar <= 0 → infinite far plane.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, world: &[f32], yfov: f32, znear: f32, zfar: f32) -> Result<(), JsError> {
        self.core.set_camera(mat16(world)?, yfov, znear, (zfar > 0.0).then_some(zfar));
        Ok(())
    }
    /// direction = where the light travels (the JS adapter negates the interface's toward-light vector).
    #[wasm_bindgen(js_name = setSun)]
    pub fn set_sun(&mut self, direction: &[f32], color: &[f32], intensity: f32) -> Result<(), JsError> {
        if direction.len() != 3 || color.len() != 3 {
            return Err(err("setSun: direction/color need 3 floats"));
        }
        self.core.set_sun([direction[0], direction[1], direction[2]], [color[0], color[1], color[2]], intensity);
        Ok(())
    }
    /// hemisphere (+ folded ambient) irradiance E in three units (colour x intensity, linear): sky = up-facing, ground = down-facing. 3 floats each.
    #[wasm_bindgen(js_name = setHemisphereIrradiance)]
    pub fn set_hemisphere_irradiance(&mut self, sky: &[f32], ground: &[f32]) -> Result<(), JsError> {
        if sky.len() != 3 || ground.len() != 3 {
            return Err(err("setHemisphereIrradiance: sky/ground need 3 floats"));
        }
        self.core.set_hemisphere_irradiance([sky[0], sky[1], sky[2]], [ground[0], ground[1], ground[2]]);
        Ok(())
    }
    /// r6 probe GI: host readback of three's GI atlases. irradiance = 4 f32/texel (vec3 storage padded to vec4), depth = 2 f32/texel (mean, mean^2),
    /// params = [cascadeCount, blendCells, irradianceRes, depthRes, mode(0 add|1 replace), 0,0,0, then per cascade 8: baseCell.xyz, spacing, dims.xyz, baseIndex].
    #[wasm_bindgen(js_name = setGiProbes)]
    pub fn set_gi_probes(&mut self, irradiance: &[f32], depth: &[f32], params: &[f32]) -> Result<(), JsError> {
        self.core.set_gi_probes(&self.device, &self.queue, irradiance, depth, params).map_err(err)
    }
    /// GI off.
    #[wasm_bindgen(js_name = clearGiProbes)]
    pub fn clear_gi_probes(&mut self) {
        self.core.clear_gi_probes(&self.queue);
    }
    /// three scene.background Color (linear rgb): tone-mapped like three does (Reinhard x exposure) → clear colour.
    #[wasm_bindgen(js_name = setFog)]
    pub fn set_fog(&mut self, mode: u32, color: &[f32], near: f32, far: f32, density: f32) -> Result<(), JsError> {
        if color.len() != 3 {
            return Err(err("setFog: color needs 3 floats"));
        }
        self.core.set_fog(mode, [color[0], color[1], color[2]], near, far, density);
        Ok(())
    }
    #[wasm_bindgen(js_name = setEnvironmentSh)]
    pub fn set_environment_sh(&mut self, sh: &[f32], intensity: f32) -> Result<(), JsError> {
        self.core.set_environment_sh(sh, intensity).map_err(err)
    }
    #[wasm_bindgen(js_name = clearEnvironment)]
    pub fn clear_environment(&mut self) {
        self.core.clear_environment();
    }
    #[wasm_bindgen(js_name = setBackgroundCube)]
    pub fn set_background_cube(&mut self, size: u32, faces: &[u8], srgb: bool, intensity: f32) -> Result<(), JsError> {
        self.core.set_background_cube(&self.device, &self.queue, size, faces, srgb, intensity).map_err(err)
    }
    #[wasm_bindgen(js_name = setBackgroundTexture)]
    pub fn set_background_texture(&mut self, width: u32, height: u32, rgba: &[u8], srgb: bool, equirect: bool, intensity: f32) -> Result<(), JsError> {
        self.core.set_background_texture(&self.device, &self.queue, width, height, rgba, srgb, equirect, intensity).map_err(err)
    }
    #[wasm_bindgen(js_name = clearBackgroundTexture)]
    pub fn clear_background_texture(&mut self) {
        self.core.clear_background_texture();
    }
    /// r10: three renderer.toneMapping constant (needs the core built with options.hdrScene = 1).
    #[wasm_bindgen(js_name = setToneMapping)]
    pub fn set_tone_mapping(&mut self, mode: u32) -> Result<(), JsError> {
        self.core.set_tone_mapping(mode).map_err(|e| err(&e))
    }
    /// r10: three renderer.toneMappingExposure.
    #[wasm_bindgen(js_name = setExposure)]
    pub fn set_exposure(&mut self, e: f32) {
        self.core.set_exposure(e);
    }
    /// r10: three BloomNode params (strength, radius, threshold, smoothWidth); `strength < 0` = bloom off. Needs options.hdrScene = 1.
    #[wasm_bindgen(js_name = setBloom)]
    pub fn set_bloom(&mut self, strength: f32, radius: f32, threshold: f32, smooth_width: f32) -> Result<(), JsError> {
        let b = (strength >= 0.0).then_some(gaia_render::BloomParams { strength, radius, threshold, smooth_width });
        self.core.set_bloom(b).map_err(|e| err(&e))
    }
    /// r10: eye adaptation. `on` = run the GPU meter; `mul` = host-adapted linear multiplier (scene before bloom/tone map).
    #[wasm_bindgen(js_name = setAutoExposure)]
    pub fn set_auto_exposure(&mut self, on: bool, mul: f32) -> Result<(), JsError> {
        self.core.set_auto_exposure(on, mul).map_err(|e| err(&e))
    }
    /// r10: newest 8x8 grid (64 f32, mean log2 luminance per cell, raw HDR) or empty when none arrived since the last call. Call once per frame after render().
    #[wasm_bindgen(js_name = autoExposureGrid)]
    pub fn auto_exposure_grid(&mut self) -> Vec<f32> {
        self.core.auto_exposure_grid().unwrap_or_default()
    }
    #[wasm_bindgen(js_name = hdrScene)]
    pub fn hdr_scene(&self) -> bool {
        self.core.hdr_scene()
    }
    #[wasm_bindgen(js_name = setBackgroundColor)]
    pub fn set_background_color(&mut self, rgb: &[f32]) -> Result<(), JsError> {
    if rgb.len() != 3 {
    return Err(err("setBackgroundColor: needs 3 floats"));
    }
    self.core.set_background_color([rgb[0], rgb[1], rgb[2]]);
    Ok(())
    }
    /// raw frame clear colour (linear rgb + a), not tone-mapped.
    #[wasm_bindgen(js_name = setClearColor)]
    pub fn set_clear_color(&mut self, rgba: &[f32]) -> Result<(), JsError> {
        if rgba.len() != 4 {
            return Err(err("setClearColor: needs 4 floats"));
        }
        self.core.set_clear_color([rgba[0] as f64, rgba[1] as f64, rgba[2] as f64, rgba[3] as f64]);
        Ok(())
    }
    /// packed 8 f32 / light: x y z range r g b intensity (index 7). Returns lights drawn (max 64).
    #[wasm_bindgen(js_name = setPointLights)]
    pub fn set_point_lights(&mut self, packed: &[f32]) -> usize {
        self.core.set_point_lights(packed)
    }

    // ---- frame ----
    #[wasm_bindgen(js_name = setRenderHeight)]
    pub fn set_render_height(&mut self, h: u32) {
        self.core.set_render_height(h);
    }
    /// r11-pipe: [11] = distinct content keys among drawn three materials (== [7] when shared). r11: [draws, pipeline changes, instanced draws, single-instance draws, instances (builtin path), shader-material draws] of the last main pass.
    #[wasm_bindgen(js_name = passStats)]
    pub fn pass_stats(&self) -> Vec<u32> {
        self.core.last_pass_stats.to_vec()
    }
    #[wasm_bindgen(js_name = drawCalls)]
    pub fn draw_calls(&self) -> u32 {
        self.core.last_draw_calls
    }
    /// device has TIMESTAMP_QUERY (readback: renderGpuTimed → gaia-render request_timings_async).
    #[wasm_bindgen(js_name = hasTimestamps)]
    pub fn has_timestamps(&self) -> bool {
        self.has_timestamps
    }

    /// Reconfigures the surface when canvas.width/height changed, encodes + submits one frame.
    /// Returns false when no surface texture was available this tick.
    pub fn render(&mut self) -> Result<bool, JsError> {
        self.render_inner(false).map(|(drawn, _)| drawn)
    }
    /// encode + submit; `timing` → also copy this frame's timestamps (false if a readback is still mapped).
    fn render_inner(&mut self, timing: bool) -> Result<(bool, bool), JsError> {
        let (w, h) = (self.canvas.width().max(1), self.canvas.height().max(1));
        if (w, h) != (self.config.width, self.config.height) {
            self.config.width = w;
            self.config.height = h;
            self.surface.configure(&self.device, &self.config);
        }
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                return Ok((false, false));
            }
            _ => return Ok((false, false)),
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor {
            format: Some(self.view_format),
            ..Default::default()
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.core.render(&self.device, &self.queue, &mut encoder, &view, UpscaleSize { width: w, height: h });
        let copied = timing && self.core.encode_timing_readback(&mut encoder);
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        Ok((true, copied))
    }
    /// `render()` + Promise of GPU TIMESTAMP ms for this frame: {scene, upscale, total} (pure GPU time, unlike renderTimed).
    /// Resolves null when no frame / no TIMESTAMP_QUERY / previous sample still mapped (one sample in flight).
    #[wasm_bindgen(js_name = renderGpuTimed)]
    pub fn render_gpu_timed(&mut self) -> Result<Promise, JsError> {
        let (drawn, copied) = self.render_inner(true)?;
        Ok(Promise::new(&mut |resolve, _| {
            let r = SendWrap(resolve.clone());
            let asked = drawn && copied && self.core.request_timings_async(move |t| {
                let r = r;
                let v = match t {
                    Some(t) => {
                        let o = js_sys::Object::new();
                        for (k, x) in [("scene", t.scene_ms), ("upscale", t.upscale_ms), ("shadow", t.shadow_ms), ("span", t.span_ms), ("total", t.total_ms)] {
                            let _ = Reflect::set(&o, &JsValue::from_str(k), &JsValue::from_f64(x));
                        }
                        o.into()
                    }
                    None => JsValue::NULL,
                };
                let _ = r.0.call1(&JsValue::NULL, &v);
            });
            if !asked {
                let _ = resolve.call1(&JsValue::NULL, &JsValue::NULL);
            }
        }))
    }

    /// r5-adapter: Promise of the last skin compute pass GPU ms (null when no skins / no timestamps / a sample in flight). Call right after renderGpuTimed.
    #[wasm_bindgen(js_name = skinGpuMs)]
    pub fn skin_gpu_ms(&mut self) -> Promise {
        Promise::new(&mut |resolve, _| {
            let r = SendWrap(resolve.clone());
            let asked = self.core.read_skin_ms_async(move |v| {
                let r = r;
                let _ = r.0.call1(&JsValue::NULL, &v.map(JsValue::from_f64).unwrap_or(JsValue::NULL));
            });
            if !asked {
                let _ = resolve.call1(&JsValue::NULL, &JsValue::NULL);
            }
        })
    }
    /// `render()` + a Promise resolving to ms from submit until the GPU queue reports the work done
    /// (wall clock: GPU + queue latency — NOT pure GPU time; see NOTES). Resolves -1 if no frame.
    #[wasm_bindgen(js_name = renderTimed)]
    pub fn render_timed(&mut self) -> Result<Promise, JsError> {
        let t0 = now_ms();
        let drawn = self.render()?;
        Ok(Promise::new(&mut |resolve, _| {
            if !drawn {
                let _ = resolve.call1(&JsValue::NULL, &JsValue::from_f64(-1.0));
                return;
            }
            let r = SendWrap(resolve);
            self.queue.on_submitted_work_done(move || {
                let r = r;
                let _ = r.0.call1(&JsValue::NULL, &JsValue::from_f64(now_ms() - t0));
            });
        }))
    }

    /// Current canvas-sized output + internal render size, as [outW, outH, intW, intH].
    #[wasm_bindgen(js_name = sizes)]
    pub fn sizes(&self) -> Float32Array {
        let i = self.core.internal_size().unwrap_or(UpscaleSize { width: 0, height: 0 });
        Float32Array::from(&[self.config.width as f32, self.config.height as f32, i.width as f32, i.height as f32][..])
    }
}

fn mat16(m: &[f32]) -> Result<[f32; 16], JsError> {
    <[f32; 16]>::try_from(m).map_err(|_| err("mat4 needs 16 floats"))
}
