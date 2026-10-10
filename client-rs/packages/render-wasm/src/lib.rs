//! render-wasm — gaia-render in the browser (WebGPU canvas). Data-only API: typed arrays in,
//! integer handles (>0) out. Mirrors crates/gaia-render/NOTES.md; the JS adapter is
//! client/kernel/render-api/wgpu-backend.js. wasm32-only (empty lib on native targets).
//!
//! All render semantics live in `gaia_render_host::Session` (shared with the native Metal host, which drives the same
//! calls from the GaiaRenderNative command stream); this file is the wasm-bindgen skin: JS value conversion, id
//! allocation, the canvas surface + present. `tools/gen-render-native.mjs` derives the native proxy from this impl's
//! signatures (`self.id("kind")` marks an id-allocating create) — keep new exports in that shape.
#![cfg(target_arch = "wasm32")]
use gaia_render::MaterialBinding;
use gaia_render_host::{Commands, Session, device_descriptor, render_options_from_json};
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
    web_sys::window().and_then(|w| w.performance()).map(|p| p.now()).unwrap_or(0.0)
}
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&JsValue::from_str(&format!("render-wasm panic: {info}")));
    }));
}
/// JS value -> serde_json (typed arrays become plain arrays; undefined -> Null).
fn js_to_json(v: &JsValue) -> Result<serde_json::Value, JsError> {
    if v.is_undefined() || v.is_null() {
        return Ok(serde_json::Value::Null);
    }
    let replacer = js_sys::Function::new_with_args("_k,x", "return ArrayBuffer.isView(x) ? Array.from(x) : x");
    let s = js_sys::JSON::stringify_with_replacer(v, &replacer.into()).map_err(|_| err("options: not JSON-serializable"))?;
    serde_json::from_str(&String::from(s)).map_err(err)
}
#[wasm_bindgen]
pub struct GaiaRender {
    canvas: web_sys::HtmlCanvasElement,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    device: wgpu::Device,
    queue: wgpu::Queue,
    s: Session,
    next: HashMap<&'static str, u32>,
}
#[wasm_bindgen]
impl GaiaRender {
    /// `options` (all optional): renderHeight, exposure, ambient[3], clearColor[4], lightIntensityScale, pipeShare, pipeSort, hdrScene, toneMapping, shadows{..}.
    pub async fn create(canvas: web_sys::HtmlCanvasElement, options: JsValue) -> Result<GaiaRender, JsError> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = instance.create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone())).map_err(err)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .map_err(err)?;
        let (desc, _feats) = device_descriptor(&adapter);
        let (device, queue) = adapter.request_device(&desc).await.map_err(err)?;
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
        let opts = render_options_from_json(&js_to_json(&options)?, view_format);
        let s = Session::new(device.clone(), queue.clone(), opts, (w, h));
        Ok(GaiaRender { canvas, surface, config, view_format, device, queue, s, next: HashMap::new() })
    }
    fn id(&mut self, kind: &'static str) -> u32 {
        let n = self.next.entry(kind).or_insert(0);
        *n += 1;
        *n
    }
    // ---- meshes ----
    /// normals/uvs must be present (JS adapter zero-fills); lengths validated → throws.
    #[wasm_bindgen(js_name = createMesh)]
    pub fn create_mesh(&mut self, positions: &[f32], normals: &[f32], uvs: &[f32], indices: &[u32]) -> Result<u32, JsError> {
        let id = self.id("mesh");
        self.s.create_mesh(id, positions, normals, uvs, indices).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = destroyMesh)]
    pub fn destroy_mesh(&mut self, id: u32) {
        let _ = self.s.destroy_mesh(id);
    }
    // ---- skinning (gaia-render skin.rs) ----
    #[wasm_bindgen(js_name = createSkin)]
    pub fn create_skin(&mut self, joint_count: u32, inverse_bind: &[f32]) -> Result<u32, JsError> {
        let id = self.id("skin");
        self.s.create_skin(id, joint_count, inverse_bind).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = setSkinPose)]
    pub fn set_skin_pose(&mut self, id: u32, joint_matrices: &[f32]) -> Result<(), JsError> {
        self.s.set_skin_pose(id, joint_matrices).map_err(err)
    }
    #[wasm_bindgen(js_name = destroySkin)]
    pub fn destroy_skin(&mut self, id: u32) {
        let _ = self.s.destroy_skin(id);
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
        self.s.create_skinned_mesh(id, skin, positions, normals, uvs, joints, weights, indices).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = destroySkinnedMesh)]
    pub fn destroy_skinned_mesh(&mut self, id: u32) {
        let _ = self.s.destroy_skinned_mesh(id);
    }
    // ---- textures (RGBA8) ----
    #[wasm_bindgen(js_name = createTexture)]
    pub fn create_texture(&mut self, width: u32, height: u32, rgba: &[u8]) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.s.create_texture(id, width, height, rgba).map_err(err)?;
        Ok(id)
    }
    /// r13-bc: block-compressed 2D texture. `mips` = concatenated mip chain (see gaia-render create_texture_compressed); flip_y = data is GL-order (three flipY=false).
    #[wasm_bindgen(js_name = createTextureCompressed)]
    pub fn create_texture_compressed(&mut self, gl_format: u32, width: u32, height: u32, mip_count: u32, data: &[u8], srgb: bool, flip_y: bool) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.s.create_texture_compressed(id, gl_format, width, height, mip_count, data, srgb, flip_y).map_err(err)?;
        Ok(id)
    }
    /// r13-bc: [gpu_native, cpu_no_bc_feature, cpu_bc1rgb_punchthrough, cpu_unaligned_or_unflippable, cpu_single_mip(+gpu mipgen), refused]
    #[wasm_bindgen(js_name = compressedStats)]
    pub fn compressed_stats(&self) -> Vec<u32> {
        self.s.core.bc_stats.to_vec()
    }
    /// r4 (lampas/r4-uniforms): RGBA8 sampled without sRGB decode (three colorSpace != srgb).
    #[wasm_bindgen(js_name = createTextureLinear)]
    pub fn create_texture_linear(&mut self, width: u32, height: u32, rgba: &[u8]) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.s.create_texture_linear(id, width, height, rgba).map_err(err)?;
        Ok(id)
    }
    /// Array texture: `layers` RGBA8 images (layer-major) + GPU mips per layer. srgb=false = linear sampling.
    #[wasm_bindgen(js_name = createTextureArray)]
    pub fn create_texture_array(&mut self, width: u32, height: u32, layers: u32, rgba: &[u8], srgb: bool) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.s.create_texture_array(id, width, height, layers, rgba, srgb).map_err(err)?;
        Ok(id)
    }
    /// r12-water: cube texture, 6 faces (+X -X +Y -Y +Z -Z, face-major RGBA8, size x size) + GPU mips per face. srgb=false = linear sampling.
    #[wasm_bindgen(js_name = createTextureCube)]
    pub fn create_texture_cube(&mut self, size: u32, faces: &[u8], srgb: bool) -> Result<u32, JsError> {
        let id = self.id("texture");
        self.s.create_texture_cube(id, size, faces, srgb).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = updateTextureLayer)]
    pub fn update_texture_layer(&mut self, id: u32, layer: u32, rgba: &[u8]) -> Result<(), JsError> {
        self.s.update_texture_layer(id, layer, rgba).map_err(err)
    }
    /// ids: 0 = none. side 0 double / 1 front only / 2 back only.
    #[wasm_bindgen(js_name = setMaterialMaps)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_material_maps(&mut self, id: u32, array: u32, normal: u32, roughness: u32, metalness: u32, emissive: u32, ao: u32, normal_scale: f32, side: u32) {
        let _ = self.s.set_material_maps(id, array, normal, roughness, metalness, emissive, ao, normal_scale, side);
    }
    /// TEXCOORD_1 per vertex (2 floats/vertex). With an array material, uv1.x = array layer.
    #[wasm_bindgen(js_name = setMeshUv1)]
    pub fn set_mesh_uv1(&mut self, id: u32, uv1: &[f32]) -> Result<(), JsError> {
        self.s.set_mesh_uv1(id, uv1).map_err(err)
    }
    /// COLOR_0 per vertex (rgba, linear, 4 floats/vertex): multiplies base colour rgb + alpha.
    #[wasm_bindgen(js_name = setMeshColors)]
    pub fn set_mesh_colors(&mut self, id: u32, rgba: &[f32]) -> Result<(), JsError> {
        self.s.set_mesh_colors(id, rgba).map_err(err)
    }
    /// blend: 0 opaque/none, 1 alpha, 2 additive, 3 subtractive, 4 multiply, 5 premultiplied. depth_write: -1 default, 0/1. cast_shadow: -1 default, 0/1.
    #[wasm_bindgen(js_name = setMaterialFlags)]
    pub fn set_material_flags(&mut self, id: u32, blend: u32, unlit: bool, depth_write: i32, render_order: i32, cast_shadow: i32) {
        let _ = self.s.set_material_flags(id, blend, unlit, depth_write, render_order, cast_shadow);
    }
    /// unlit materials: apply exposure + Reinhard (three toneMapped:true). Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialUnlitToneMapped)]
    pub fn set_material_unlit_tone_mapped(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_unlit_tone_mapped(id, on);
    }
    /// three receiveShadow:false (per material): sun shadow map not sampled. Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialNoReceiveShadow)]
    pub fn set_material_no_receive_shadow(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_no_receive_shadow(id, on);
    }
    /// three did not attach probe GI to this (non-node) material: hemisphere ambient only. Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialNoGi)]
    pub fn set_material_no_gi(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_no_gi(id, on);
    }
    /// lampas L-wgpu-tex: material lit by the extra directional lights (setExtraDirs) -- character materials only (three userData.dsChrLight). Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialChrLight)]
    pub fn set_material_chr_light(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_chr_light(id, on);
    }
    /// three material.fog=false: scene fog skipped for this material. Call after setMaterialFlags.
    #[wasm_bindgen(js_name = setMaterialNoFog)]
    pub fn set_material_no_fog(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_no_fog(id, on);
    }
    /// three colorWrite:false (depth-only / occluder mesh): empty colour write mask, depth per depthWrite. Call after setMaterialFlags (which resets it).
    #[wasm_bindgen(js_name = setMaterialNoColorWrite)]
    pub fn set_material_no_color_write(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_no_color_write(id, on);
    }
    /// three depthTest:false: depth compare ALWAYS (draws over nearer geometry). Call after setMaterialFlags (which resets it).
    #[wasm_bindgen(js_name = setMaterialNoDepthTest)]
    pub fn set_material_no_depth_test(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_no_depth_test(id, on);
    }
    /// three FrontSide material: shadow caster pass culls back faces (r9). Call after setMaterialFlags (which resets it).
    #[wasm_bindgen(js_name = setMaterialShadowCullBack)]
    pub fn set_material_shadow_cull_back(&mut self, id: u32, on: bool) {
        let _ = self.s.set_material_shadow_cull_back(id, on);
    }
    #[wasm_bindgen(js_name = destroyTexture)]
    pub fn destroy_texture(&mut self, id: u32) {
        let _ = self.s.destroy_texture(id);
    }
    // ---- materials ----
    /// built-in PBR. base_color_texture 0 = none; alpha_cutoff < 0 = opaque. Linear colors.
    #[wasm_bindgen(js_name = createMaterial)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_material(&mut self, base_color: &[f32], metallic: f32, roughness: f32, base_color_texture: u32, alpha_cutoff: f32, emissive: &[f32]) -> Result<u32, JsError> {
        let id = self.id("material");
        self.s.create_material(id, base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive).map_err(err)?;
        Ok(id)
    }
    /// create == update in the core: re-describe an existing material handle.
    #[wasm_bindgen(js_name = updateMaterial)]
    #[allow(clippy::too_many_arguments)]
    pub fn update_material(&mut self, id: u32, base_color: &[f32], metallic: f32, roughness: f32, base_color_texture: u32, alpha_cutoff: f32, emissive: &[f32]) -> Result<(), JsError> {
        self.s.update_material(id, base_color, metallic, roughness, base_color_texture, alpha_cutoff, emissive).map_err(err)
    }
    /// External WGSL material (see gaia-render NOTES contract). `bindings` = JS array of
    /// `{kind:'uniform'|'texture'|'sampler', binding, data?:Uint8Array, vertex?:bool, texture?:id}`.
    #[wasm_bindgen(js_name = createShaderMaterial)]
    pub fn create_shader_material(&mut self, wgsl: String, vertex_entry: String, fragment_entry: String, bindings: Array) -> Result<u32, JsError> {
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
                "texture" => MaterialBinding::Texture { binding, texture: get(&b, "texture").as_f64().unwrap_or(0.0) as u32 },
                "sampler" => MaterialBinding::Sampler { binding },
                k => return Err(err(format!("unknown binding kind '{k}'"))),
            });
        }
        let id = self.id("material");
        self.s.create_shader_material(id, &wgsl, &vertex_entry, &fragment_entry, &out).map_err(err)?;
        Ok(id)
    }
    /// three r180 TSL package (tsl-export.js JSON, as-is) → material id. `texture_names[i]` = WGSL binding var
    /// name (package `bindGroups[].bindings[].name`), `texture_ids[i]` = id from createTexture. gaia-render NOTES 'Round 3'.
    #[wasm_bindgen(js_name = createThreeMaterial)]
    pub fn create_three_material(&mut self, package_json: String, texture_names: Array, texture_ids: &[u32]) -> Result<u32, JsError> {
        let names: Vec<String> = texture_names.iter().map(|n| n.as_string().unwrap_or_default()).collect();
        let id = self.id("material");
        self.s.create_three_material(id, &package_json, &names, texture_ids).map_err(err)?;
        Ok(id)
    }
    /// r6-tsl-2: storage buffer for TSL storage()/buffer nodes (raw bytes, any element type) -> id.
    #[wasm_bindgen(js_name = createStorageBuffer)]
    pub fn create_storage_buffer(&mut self, bytes: &[u8]) -> u32 {
        let id = self.id("storage");
        let _ = self.s.create_storage_buffer(id, bytes);
        id
    }
    #[wasm_bindgen(js_name = updateStorageBuffer)]
    pub fn update_storage_buffer(&mut self, id: u32, bytes: &[u8]) -> Result<(), JsError> {
        self.s.update_storage_buffer(id, bytes).map_err(err)
    }
    #[wasm_bindgen(js_name = destroyStorageBuffer)]
    pub fn destroy_storage_buffer(&mut self, id: u32) {
        let _ = self.s.destroy_storage_buffer(id);
    }
    /// Point a three material's storage binding ("group.binding" key) at a storage buffer id.
    #[wasm_bindgen(js_name = bindThreeStorage)]
    pub fn bind_three_storage(&mut self, material: u32, key: &str, id: u32) -> Result<(), JsError> {
        self.s.bind_three_storage(material, key, id).map_err(err)
    }
    /// seconds fed to three `time` semantic uniforms.
    #[wasm_bindgen(js_name = setThreeTime)]
    pub fn set_three_time(&mut self, seconds: f32) {
        let _ = self.s.set_three_time(seconds);
    }
    /// r4 (lampas/r4-uniforms): live three uniform values, JSON `[{key,value}]` from tsl-export `pkg.live.update()`.
    #[wasm_bindgen(js_name = setThreeUniforms)]
    pub fn set_three_uniforms(&mut self, material: u32, json: &str) -> Result<u32, JsValue> {
        self.s.core.set_three_uniforms(material, json).map(|n| n as u32).map_err(|e| JsValue::from_str(&e))
    }
    /// r10-5: batched live uniforms, one call per frame (see RenderCore::set_three_uniforms_batch).
    #[wasm_bindgen(js_name = setThreeUniformsBatch)]
    pub fn set_three_uniforms_batch(&mut self, json: &str) -> Result<u32, JsValue> {
        self.s.core.set_three_uniforms_batch(json).map(|n| n as u32).map_err(|e| JsValue::from_str(&e))
    }
    /// r6-tsl: extra named per-vertex attribute (uv1, colour, custom, node buffer attribute: `node:<uuid>`) for TSL materials.
    #[wasm_bindgen(js_name = setMeshAttribute)]
    pub fn set_mesh_attribute(&mut self, mesh: u32, name: &str, item_size: u32, data: &[f32]) -> Result<(), JsError> {
        self.s.set_mesh_attribute(mesh, name, item_size, data).map_err(err)
    }
    /// r6-tsl: per-instance attribute value (one element) for TSL materials (expanded InstancedMesh rows).
    #[wasm_bindgen(js_name = setInstanceAttribute)]
    pub fn set_instance_attribute(&mut self, instance: u32, name: &str, item_size: u32, data: &[f32]) -> Result<(), JsError> {
        self.s.set_instance_attribute(instance, name, item_size, data).map_err(err)
    }
    /// r6-tsl: three instances SKIPPED in the last frame (material needs an attribute the mesh/instance lacks).
    #[wasm_bindgen(js_name = threeSkipped)]
    pub fn three_skipped(&self) -> u32 {
        self.s.core.three_skipped
    }
    #[wasm_bindgen(js_name = destroyMaterial)]
    pub fn destroy_material(&mut self, id: u32) {
        let _ = self.s.destroy_material(id);
    }
    // ---- instances (world mat4, column-major; hierarchy is the JS adapter's job) ----
    #[wasm_bindgen(js_name = createInstance)]
    pub fn create_instance(&mut self, mesh: u32, material: u32, mat4: &[f32]) -> Result<u32, JsError> {
        let id = self.id("instance");
        self.s.create_instance(id, mesh, material, mat4).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = updateInstance)]
    pub fn update_instance(&mut self, id: u32, mat4: &[f32]) -> Result<(), JsError> {
        self.s.update_instance(id, mat4).map_err(err)
    }
    #[wasm_bindgen(js_name = removeInstance)]
    pub fn remove_instance(&mut self, id: u32) {
        let _ = self.s.remove_instance(id);
    }
    // ---- native instance blocks (InstancedMesh): mats = count×16 local mat4s, colors = count×colorStride (0/3/4; empty = white), world = node matrixWorld (premultiplied in core) ----
    #[wasm_bindgen(js_name = createInstanceBlock)]
    pub fn create_instance_block(&mut self, mesh: u32, material: u32, mats: &[f32], colors: &[f32], color_stride: u32, count: u32, world: &[f32]) -> Result<u32, JsError> {
        let id = self.id("instance block");
        self.s.create_instance_block(id, mesh, material, mats, colors, color_stride, count, world).map_err(err)?;
        Ok(id)
    }
    #[wasm_bindgen(js_name = updateInstanceBlock)]
    pub fn update_instance_block(&mut self, id: u32, mats: &[f32], colors: &[f32], color_stride: u32, count: u32, world: &[f32]) -> Result<(), JsError> {
        self.s.update_instance_block(id, mats, colors, color_stride, count, world).map_err(err)
    }
    /// r19-pcol: per-instance uv window, 4 floats/instance (offsetU, offsetV, scaleU, scaleV); empty = identity. Flipbook / atlas.
    #[wasm_bindgen(js_name = setInstanceBlockUvs)]
    pub fn set_instance_block_uvs(&mut self, id: u32, uvs: &[f32]) {
        let _ = self.s.set_instance_block_uvs(id, uvs);
    }
    #[wasm_bindgen(js_name = setInstanceBlockFlags)]
    pub fn set_instance_block_flags(&mut self, id: u32, cast_shadow: bool, is_static: bool) {
        let _ = self.s.set_instance_block_flags(id, cast_shadow, is_static);
    }
    #[wasm_bindgen(js_name = setInstanceBlockShadowOnly)]
    pub fn set_instance_block_shadow_only(&mut self, id: u32, only: bool) {
        let _ = self.s.set_instance_block_shadow_only(id, only);
    }
    /// lane nt-dyninst: explicit dynamic-path hint for a block (three `DynamicDrawUsage`): 0 = auto (update-streak promotion), 1 = dynamic, 2 = static.
    #[wasm_bindgen(js_name = setInstanceBlockDynamic)]
    pub fn set_instance_block_dynamic(&mut self, id: u32, mode: u32) {
        let _ = self.s.set_instance_block_dynamic(id, mode);
    }
    /// lane nt-dyninst: [dynamic blocks, dynamic instances, bytes written last frame, dyn buffer allocs (cum), world-list rebuilds (cum), promotions (cum), demotions (cum)].
    #[wasm_bindgen(js_name = dynBlockStats)]
    pub fn dyn_block_stats(&self) -> Vec<u32> {
        self.s.core.dyn_block_stats_vec()
    }
    #[wasm_bindgen(js_name = removeInstanceBlock)]
    pub fn remove_instance_block(&mut self, id: u32) {
        let _ = self.s.remove_instance_block(id);
    }
    #[wasm_bindgen(js_name = drawnInstanceCount)]
    pub fn drawn_instance_count(&self) -> usize {
        self.s.core.drawn_instance_count()
    }
    #[wasm_bindgen(js_name = instanceCount)]
    pub fn instance_count(&self) -> usize {
        self.s.core.instance_count()
    }
    // ---- shadows (gaia-render shadow.rs) ----
    /// instances default DYNAMIC (redrawn into the live layer every frame); static = cached per cascade until moved/changed.
    #[wasm_bindgen(js_name = setInstanceStatic)]
    pub fn set_instance_static(&mut self, id: u32, is_static: bool) {
        let _ = self.s.set_instance_static(id, is_static);
    }
    // ---- visibility groups (gaia-render groups.rs): u32 bitset words, word w bit b = group 32w+b ----
    /// Instance group mask (empty = no groups = always drawn).
    #[wasm_bindgen(js_name = setInstanceGroups)]
    pub fn set_instance_groups(&mut self, id: u32, words: &[u32]) {
        let _ = self.s.set_instance_groups(id, words);
    }
    /// Instance follows `parent` instance's effective mask (u32::MAX = detach).
    #[wasm_bindgen(js_name = setInstanceGroupParent)]
    pub fn set_instance_group_parent(&mut self, id: u32, parent: u32) {
        let _ = self.s.set_instance_group_parent(id, parent);
    }
    /// ACTIVE group set (union is the caller's OR). Drawn iff instance mask ∩ active ≠ ∅; no groups = always drawn. Main + shadow passes.
    #[wasm_bindgen(js_name = setActiveGroups)]
    pub fn set_active_groups(&mut self, words: &[u32]) {
        let _ = self.s.set_active_groups(words);
    }
    /// Group culling OFF (default).
    #[wasm_bindgen(js_name = clearActiveGroups)]
    pub fn clear_active_groups(&mut self) {
        let _ = self.s.clear_active_groups();
    }
    /// Instances excluded by group culling at the last instance rebuild.
    #[wasm_bindgen(js_name = lastGroupHidden)]
    pub fn last_group_hidden(&self) -> u32 {
        self.s.core.last_group_hidden
    }
    #[wasm_bindgen(js_name = setInstanceShadowOnly)]
    pub fn set_instance_shadow_only(&mut self, id: u32, only: bool) {
        let _ = self.s.set_instance_shadow_only(id, only);
    }
    #[wasm_bindgen(js_name = setInstanceCastShadow)]
    pub fn set_instance_cast_shadow(&mut self, id: u32, cast: bool) {
        let _ = self.s.set_instance_cast_shadow(id, cast);
    }
    /// Re-create the shadow system with `opts` (object, camelCase ShadowOptions keys; omitted keys keep current values). Heavy (reallocates maps).
    #[wasm_bindgen(js_name = setShadowOptions)]
    pub fn set_shadow_options(&mut self, opts: JsValue) {
        if let Ok(v) = js_to_json(&opts) {
            let _ = self.s.set_shadow_options(&v);
        }
    }
    /// Last frame's shadow work: {enabled,cascades,passes,copies,totalDraws,cpuCullMs,staticRerendered:[..],staticDraws:[..],dynamicDraws:[..]}.
    #[wasm_bindgen(js_name = shadowStats)]
    pub fn shadow_stats(&self) -> JsValue {
        js_sys::JSON::parse(&self.s.shadow_stats_json().to_string()).unwrap_or(JsValue::NULL)
    }
    // ---- camera + lights ----
    /// `world` = camera-to-world mat4. zfar <= 0 → infinite far plane.
    #[wasm_bindgen(js_name = setCamera)]
    pub fn set_camera(&mut self, world: &[f32], yfov: f32, znear: f32, zfar: f32) -> Result<(), JsError> {
        self.s.set_camera(world, yfov, znear, zfar).map_err(err)
    }
    /// direction = where the light travels (the JS adapter negates the interface's toward-light vector).
    #[wasm_bindgen(js_name = setSun)]
    pub fn set_sun(&mut self, direction: &[f32], color: &[f32], intensity: f32) -> Result<(), JsError> {
        self.s.set_sun(direction, color, intensity).map_err(err)
    }
    /// hemisphere (+ folded ambient) irradiance E in three units (colour x intensity, linear): sky = up-facing, ground = down-facing. 3 floats each.
    #[wasm_bindgen(js_name = setHemisphereIrradiance)]
    pub fn set_hemisphere_irradiance(&mut self, sky: &[f32], ground: &[f32]) -> Result<(), JsError> {
        self.s.set_hemisphere_irradiance(sky, ground).map_err(err)
    }
    /// r6 probe GI: host readback of three's GI atlases. irradiance = 4 f32/texel (vec3 storage padded to vec4), depth = 2 f32/texel (mean, mean^2),
    /// params = [cascadeCount, blendCells, irradianceRes, depthRes, mode(0 add|1 replace), 0,0,0, then per cascade 8: baseCell.xyz, spacing, dims.xyz, baseIndex].
    #[wasm_bindgen(js_name = setGiProbes)]
    pub fn set_gi_probes(&mut self, irradiance: &[f32], depth: &[f32], params: &[f32]) -> Result<(), JsError> {
        self.s.set_gi_probes(irradiance, depth, params).map_err(err)
    }
    /// GI off.
    #[wasm_bindgen(js_name = clearGiProbes)]
    pub fn clear_gi_probes(&mut self) {
        let _ = self.s.clear_gi_probes();
    }
    /// three scene fog (mode, linear-rgb colour, near, far, density).
    /// lane nt-gi: NATIVE probe GI — gaia-render computes the atlases itself (gi_compute.rs/.wgsl), the page holds no GPU state and reads nothing back.
    /// cfg = JSON from GIOpen.nativeConfig(). The atlas buffers are bound to TSL materials through the reserved storage ids (gi-native.js GI_STORAGE = gaia-render GI_STORAGE_*_ID).
    #[wasm_bindgen(js_name = giComputeInit)]
    pub fn gi_compute_init(&mut self, cfg_json: &str) -> Result<(), JsError> {
        self.s.gi_compute_init(cfg_json).map_err(err)
    }
    /// one dirty brick range of the CPU voxel window (u32 words from `start`)
    #[wasm_bindgen(js_name = giComputeVoxels)]
    pub fn gi_compute_voxels(&mut self, start: u32, words: &[u32]) -> Result<(), JsError> {
        self.s.gi_compute_voxels(start, words).map_err(err)
    }
    /// frame = GI_FRAME_LEN f32 (gi-native.js GI_FRAME / gi_compute.rs GF_*); fresh = global probe indices that entered a window (depth sentinel)
    #[wasm_bindgen(js_name = giComputeStep)]
    pub fn gi_compute_step(&mut self, frame: &[f32], fresh: &[u32]) -> Result<(), JsError> {
        self.s.gi_compute_step(frame, fresh).map_err(err)
    }
    #[wasm_bindgen(js_name = giComputeDestroy)]
    pub fn gi_compute_destroy(&mut self) {
        let _ = self.s.gi_compute_destroy();
    }
    /// [steps, dispatchedProbes, voxelRangeWrites, freshProbes, irrRows, depthRows, renderTimeErrors]
    #[wasm_bindgen(js_name = giComputeStats)]
    pub fn gi_compute_stats(&self) -> Vec<f64> {
        self.s.core.gi_compute_stats().to_vec()
    }
    #[wasm_bindgen(js_name = setFog)]
    pub fn set_fog(&mut self, mode: u32, color: &[f32], near: f32, far: f32, density: f32) -> Result<(), JsError> {
        self.s.set_fog(mode, color, near, far, density).map_err(err)
    }
    #[wasm_bindgen(js_name = setEnvironmentSh)]
    pub fn set_environment_sh(&mut self, sh: &[f32], intensity: f32) -> Result<(), JsError> {
        self.s.set_environment_sh(sh, intensity).map_err(err)
    }
    #[wasm_bindgen(js_name = clearEnvironment)]
    pub fn clear_environment(&mut self) {
        let _ = self.s.clear_environment();
    }
    #[wasm_bindgen(js_name = setBackgroundCube)]
    pub fn set_background_cube(&mut self, size: u32, faces: &[u8], srgb: bool, intensity: f32) -> Result<(), JsError> {
        self.s.set_background_cube(size, faces, srgb, intensity).map_err(err)
    }
    #[wasm_bindgen(js_name = setBackgroundTexture)]
    pub fn set_background_texture(&mut self, width: u32, height: u32, rgba: &[u8], srgb: bool, equirect: bool, intensity: f32) -> Result<(), JsError> {
        self.s.set_background_texture(width, height, rgba, srgb, equirect, intensity).map_err(err)
    }
    #[wasm_bindgen(js_name = clearBackgroundTexture)]
    pub fn clear_background_texture(&mut self) {
        let _ = self.s.clear_background_texture();
    }
    /// r10: three renderer.toneMapping constant (needs the core built with options.hdrScene = 1).
    #[wasm_bindgen(js_name = setToneMapping)]
    pub fn set_tone_mapping(&mut self, mode: u32) -> Result<(), JsError> {
        self.s.set_tone_mapping(mode).map_err(err)
    }
    /// r10: three renderer.toneMappingExposure.
    #[wasm_bindgen(js_name = setExposure)]
    pub fn set_exposure(&mut self, e: f32) {
        let _ = self.s.set_exposure(e);
    }
    /// r10: three BloomNode params (strength, radius, threshold, smoothWidth); `strength < 0` = bloom off. Needs options.hdrScene = 1.
    #[wasm_bindgen(js_name = setBloom)]
    pub fn set_bloom(&mut self, strength: f32, radius: f32, threshold: f32, smooth_width: f32) -> Result<(), JsError> {
        self.s.set_bloom(strength, radius, threshold, smooth_width).map_err(err)
    }
    /// r12-post: three GTAONode + engine rig composite; `on=false` = off. Needs options.hdrScene = 1. Normals reconstructed from depth.
    #[wasm_bindgen(js_name = setGtao)]
    #[allow(clippy::too_many_arguments)]
    pub fn set_gtao(&mut self, on: bool, radius: f32, thickness: f32, samples: f32, distance_exponent: f32, distance_fall_off: f32, scale: f32, resolution_scale: f32, intensity: f32, fade_start: f32, fade_end: f32) -> Result<(), JsError> {
        self.s.set_gtao(on, radius, thickness, samples, distance_exponent, distance_fall_off, scale, resolution_scale, intensity, fade_start, fade_end).map_err(err)
    }
    /// r18-tone: 16 f32 column-major display-referred colour matrix (DS1 ColAdj shape) applied after tone map; empty/len!=16 = off.
    #[wasm_bindgen(js_name = setColorGrade)]
    pub fn set_color_grade(&mut self, m: &[f32]) -> Result<(), JsError> {
        self.s.set_color_grade(m).map_err(err)
    }
    /// r10: eye adaptation. `on` = run the GPU meter; `mul` = host-adapted linear multiplier (scene before bloom/tone map).
    #[wasm_bindgen(js_name = setAutoExposure)]
    pub fn set_auto_exposure(&mut self, on: bool, mul: f32) -> Result<(), JsError> {
        self.s.set_auto_exposure(on, mul).map_err(err)
    }
    /// r10: newest 8x8 grid (64 f32, mean log2 luminance per cell, raw HDR) or empty when none arrived since the last call. Call once per frame after render().
    #[wasm_bindgen(js_name = autoExposureGrid)]
    pub fn auto_exposure_grid(&mut self) -> Vec<f32> {
        self.s.core.auto_exposure_grid().unwrap_or_default()
    }
    #[wasm_bindgen(js_name = hdrScene)]
    pub fn hdr_scene(&self) -> bool {
        self.s.core.hdr_scene()
    }
    #[wasm_bindgen(js_name = setBackgroundColor)]
    pub fn set_background_color(&mut self, rgb: &[f32]) -> Result<(), JsError> {
        self.s.set_background_color(rgb).map_err(err)
    }
    /// raw frame clear colour (linear rgb + a), not tone-mapped.
    #[wasm_bindgen(js_name = setClearColor)]
    pub fn set_clear_color(&mut self, rgba: &[f32]) -> Result<(), JsError> {
        self.s.set_clear_color(rgba).map_err(err)
    }
    /// packed 9 f32 / light: x y z range r g b intensity falloff (>= 0 three decay, < 0 DS1 ramp: begin/range = -falloff - 1). Returns lights drawn (max 64).
    #[wasm_bindgen(js_name = setPointLights)]
    pub fn set_point_lights(&mut self, packed: &[f32]) -> usize {
        self.s.core.set_point_lights(packed)
    }
    /// lane dynlight: extra directional lights beyond the primary sun, packed 7 f32: dir xyz (direction the light travels), rgb, intensity. No shadows. Returns count kept (max 4).
    #[wasm_bindgen(js_name = setExtraDirs)]
    pub fn set_extra_dirs(&mut self, packed: &[f32]) -> usize {
        self.s.core.set_extra_dirs(packed)
    }
    // ---- frame ----
    #[wasm_bindgen(js_name = setRenderHeight)]
    pub fn set_render_height(&mut self, h: u32) {
        let _ = self.s.set_render_height(h);
    }
    /// r11-pipe: [11] = distinct content keys among drawn three materials (== [7] when shared). r11: [draws, pipeline changes, instanced draws, single-instance draws, instances (builtin path), shader-material draws] of the last main pass.
    #[wasm_bindgen(js_name = passStats)]
    pub fn pass_stats(&self) -> Vec<u32> {
        self.s.core.last_pass_stats.to_vec()
    }
    #[wasm_bindgen(js_name = drawCalls)]
    pub fn draw_calls(&self) -> u32 {
        self.s.core.last_draw_calls
    }
    /// device has TIMESTAMP_QUERY (readback: renderGpuTimed → gaia-render request_timings_async).
    #[wasm_bindgen(js_name = hasTimestamps)]
    pub fn has_timestamps(&self) -> bool {
        self.s.has_timestamps
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
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(self.view_format), ..Default::default() });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.s.output = (w, h);
        self.s.render(&mut encoder, &view);
        let copied = timing && self.s.core.encode_timing_readback(&mut encoder);
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
            let asked = drawn
                && copied
                && self.s.core.request_timings_async(move |t| {
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
            let asked = self.s.core.read_skin_ms_async(move |v| {
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
        let i = self.s.core.internal_size().unwrap_or(gaia_render::UpscaleSize { width: 0, height: 0 });
        Float32Array::from(&[self.config.width as f32, self.config.height as f32, i.width as f32, i.height as f32][..])
    }
}
