//! render-wasm — gaia-render in the browser (WebGPU canvas). Data-only API: typed arrays in,
//! integer handles (>0) out. Mirrors crates/gaia-render/NOTES.md; the JS adapter is
//! client/kernel/render-api/wgpu-backend.js. wasm32-only (empty lib on native targets).
#![cfg(target_arch = "wasm32")]

use gaia_render::{
    MaterialBinding, MaterialDesc, RenderCore, RenderOptions, ShaderMaterialDesc, UpscaleSize,
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
        if let Some(v) = opt_f32(&options, "exposure") {
            opts.exposure = v;
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
        if base_color.len() != 4 || emissive.len() != 3 {
            return Err(err("createMaterial: base_color needs 4 floats, emissive 3"));
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
    /// seconds fed to three `time` semantic uniforms.
    #[wasm_bindgen(js_name = setThreeTime)]
    pub fn set_three_time(&mut self, seconds: f32) {
        self.core.set_three_time(seconds);
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
    #[wasm_bindgen(js_name = instanceCount)]
    pub fn instance_count(&self) -> usize {
        self.core.instance_count()
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
                        for (k, x) in [("scene", t.scene_ms), ("upscale", t.upscale_ms), ("total", t.total_ms)] {
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
