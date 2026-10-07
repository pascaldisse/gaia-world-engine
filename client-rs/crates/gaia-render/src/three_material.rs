//! three.js TSL material packages run AS-IS (RENDER-API.md §6/§8).
//! Package = tsl-export.js JSON: { vertex, fragment, attributes[{name,location}],
//! bindGroups[{group,name,bindings[{binding,name,kind,uniforms[{name,semantic,value}]}]}] }.
//! - two WGSL modules (vertex + fragment), each naga-parsed + validated; bindings = union (naga reflection).
//! - uniform OFFSETS come from naga struct layout, never from the package (three's offsets are 0 until it allocates).
//! - host-supplied semantics (camera*/model*/time) filled from gaia's own frame data; others = package values.
//! - attributes mapped BY NAME onto the core's interleaved Vertex (position/normal/uv) at the builder's locations.
use std::collections::HashMap;

use glam::{Mat3, Mat4, Vec3};
use wgpu::util::DeviceExt;

/// One uniform-struct member: where it lives + what fills it.
#[derive(Clone, Debug)]
struct Member {
    offset: u32,
    /// (columns, rows) for matrices; (1, n) for vectors/scalars.
    cols: u32,
    rows: u32,
    semantic: Option<String>,
    /// package `key` (tsl-export: uniform node uuid) → live updates via set_uniforms
    key: Option<String>,
    value: Vec<f32>,
}
#[derive(Clone, Debug)]
enum Kind {
    Uniform { size: u32, members: Vec<Member> },
    Texture { dim: wgpu::TextureViewDimension, sample: wgpu::TextureSampleType },
    /// r6-tsl-2: storage buffer (TSL storage()/buffer nodes); data = host storage buffer id, `storage` map key "group.binding".
    Storage { read_only: bool },
    Sampler,
}
#[derive(Clone, Debug)]
struct Slot {
    group: u32,
    binding: u32,
    name: String,
    vis: wgpu::ShaderStages,
    kind: Kind,
}
/// Frame data the host supplies to three's built-in uniforms.
pub struct ThreeFrame {
    pub view: Mat4,
    pub proj: Mat4,
    pub camera_world: Mat4,
    pub near: f32,
    pub far: f32,
    pub time: f32,
}
pub(crate) struct ThreeMaterial {
    pipeline: wgpu::RenderPipeline,
    layouts: Vec<wgpu::BindGroupLayout>,
    slots: Vec<Slot>,
    textures: HashMap<String, u32>,
/// r6-tsl-2: storage buffers by "group.binding" -> host storage buffer id.
storage: HashMap<String, u32>,
/// r6-tsl: non-core vertex attributes, one vertex-buffer slot each (after the core Vertex slot, if any).
extra: Vec<AttrSpec>,
core_slot: Option<u32>,
/// r10-shadow-3: group index of the core's sun-CSM receiver appended after the package groups (None = package never calls gaia_sun_shadow).
shadow_group: Option<u32>,
    /// r11-pipe: content key hash (WGSL + reflected layout + vertex layout + pipeline state); equal key = interchangeable pipeline.
    key: u64,
    
    /// r11-pipe: keeps its id-order position (blended / non-default depth-colour state); everything else may be reordered by pipeline.
    ordered: bool,
}
/// One TSL vertex attribute that the core's interleaved Vertex does not carry.
struct AttrSpec {
/// data key: geometry attribute name, or `node:<uuid>` for node-held BufferAttributes (tsl-export).
key: String,
slot: u32,
items: u32,
instanced: bool,
}
/// Per (instance) GPU state: one buffer per uniform slot + bind groups.
struct InstanceGpu {
    material: u32,
    buffers: Vec<(usize, wgpu::Buffer)>,
    groups: Vec<wgpu::BindGroup>,
}
#[derive(Default)]
pub(crate) struct ThreeMaterials {
    pub(crate) mats: HashMap<u32, ThreeMaterial>,
    inst: HashMap<u32, InstanceGpu>,
    /// r11-pipe: content-keyed pipeline (+ bind group layouts) and shader-module caches; filled only when `cache.share`.
    pub(crate) cache: PipeCache,
}
#[derive(Default)]
pub(crate) struct PipeCache {
    pub(crate) share: bool,
    pipes: HashMap<String, (wgpu::RenderPipeline, Vec<wgpu::BindGroupLayout>)>,
    modules: HashMap<String, wgpu::ShaderModule>,
}
impl PipeCache {
    fn module(&mut self, device: &wgpu::Device, label: &str, src: &str) -> wgpu::ShaderModule {
        let mk = || device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(label), source: wgpu::ShaderSource::Wgsl(src.into()) });
        if !self.share { return mk(); }
        self.modules.entry(src.to_string()).or_insert_with(mk).clone()
    }
}
impl ThreeMaterials {
    pub(crate) fn new(share: bool) -> Self { Self { cache: PipeCache { share, ..Default::default() }, ..Default::default() } }
    /// r11-pipe: within each maximal run of `!ordered` draws, stable-sort by (pipeline key, material). Ordered draws (blended / non-default depth-colour state) never move.
    pub(crate) fn sort_by_pipeline(&self, list: &mut [(u32, u32, [f32; 16])]) {
        if !self.cache.share { return; }
        let free = |m: u32| self.mats.get(&m).is_some_and(|x| !x.ordered);
        let mut i = 0;
        while i < list.len() {
            if !free(list[i].1) { i += 1; continue; }
            let mut j = i;
            while j < list.len() && free(list[j].1) { j += 1; }
            list[i..j].sort_by_key(|x| (self.mats[&x.1].key, x.1));
            i = j;
        }
    }
}

fn stage_globals(src: &str, stage: wgpu::ShaderStages, out: &mut Vec<Slot>, label: &str) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(src).map_err(|e| format!("{label}: WGSL parse: {}", e.emit_to_string(src)))?;
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all())
        .validate(&module)
        .map_err(|e| format!("{label}: naga validation: {}", e.emit_to_string(src)))?;
    let gctx = module.to_ctx();
    for (_, gv) in module.global_variables.iter() {
        let Some(rb) = &gv.binding else { continue };
        if let Some(s) = out.iter_mut().find(|s| s.group == rb.group && s.binding == rb.binding) {
            s.vis |= stage;
            continue;
        }
        let ty = &module.types[gv.ty];
        let kind = match (&gv.space, &ty.inner) {
            (naga::AddressSpace::Uniform, inner) => {
                let size = inner.size(gctx);
                let mut members = Vec::new();
                if let naga::TypeInner::Struct { members: ms, .. } = inner {
                    for m in ms {
                        let (cols, rows) = match module.types[m.ty].inner {
                            naga::TypeInner::Matrix { columns, rows, .. } => (columns as u32, rows as u32),
                            naga::TypeInner::Vector { size, .. } => (1, size as u32),
                            naga::TypeInner::Scalar(_) => (1, 1),
                            ref o => return Err(format!("{label}: uniform member {:?} type {o:?} unsupported", m.name)),
                        };
                        members.push((m.name.clone().unwrap_or_default(), Member { offset: m.offset, cols, rows, semantic: None, key: None, value: vec![] }));
                    }
                }
                // names stashed in semantic slot temporarily: resolved against the package below
                Kind::Uniform {
                    size,
                    members: members.into_iter().map(|(n, mut m)| { m.semantic = Some(n); m }).collect(),
                }
            }
            (_, naga::TypeInner::Image { dim, class, arrayed, .. }) => {
                if *arrayed && !matches!(dim, naga::ImageDimension::D2) { return Err(format!("{label}: arrayed {dim:?} texture unsupported (2D arrays only)")); }
                let dim = match dim {
naga::ImageDimension::D2 if *arrayed => wgpu::TextureViewDimension::D2Array,
naga::ImageDimension::D2 => wgpu::TextureViewDimension::D2,
                    naga::ImageDimension::Cube => wgpu::TextureViewDimension::Cube,
                    naga::ImageDimension::D3 => wgpu::TextureViewDimension::D3,
                    naga::ImageDimension::D1 => wgpu::TextureViewDimension::D1,
                };
                let sample = match class {
                    naga::ImageClass::Sampled { kind: naga::ScalarKind::Float, .. } => wgpu::TextureSampleType::Float { filterable: true },
                    naga::ImageClass::Depth { .. } => wgpu::TextureSampleType::Depth,
                    o => return Err(format!("{label}: texture class {o:?} unsupported")),
                };
                Kind::Texture { dim, sample }
            }
            (_, naga::TypeInner::Sampler { comparison: false }) => Kind::Sampler,
(naga::AddressSpace::Storage { access }, _) => Kind::Storage { read_only: !access.contains(naga::StorageAccess::STORE) },
            (sp, o) => return Err(format!("{label}: binding {}.{} {sp:?} {o:?} unsupported (storage/comparison: NEXT)", rb.group, rb.binding)),
        };
        out.push(Slot { group: rb.group, binding: rb.binding, name: gv.name.clone().unwrap_or_default(), vis: stage, kind });
    }
    Ok(())
}

/// Parse + reflect + build the pipeline for one package. Textures: binding var name → core texture id.
pub(crate) fn build(
    device: &wgpu::Device,
    pkg_json: &str,
    textures: HashMap<String, u32>,
storage: HashMap<String, u32>,
color_format: wgpu::TextureFormat,
    depth_format: wgpu::TextureFormat,
receiver: &wgpu::BindGroupLayout,
    cache: &mut PipeCache,
) -> Result<ThreeMaterial, String> {
    let pkg: serde_json::Value = serde_json::from_str(pkg_json).map_err(|e| format!("three package JSON: {e}"))?;
    let s = |k: &str| pkg[k].as_str().ok_or_else(|| format!("three package: `{k}` missing"));
    let (vs, fs0) = (s("vertex")?, s("fragment")?);
    let mut slots = Vec::new();
    stage_globals(vs, wgpu::ShaderStages::VERTEX, &mut slots, "vertex")?;
    // package-only reflection: the core receiver is appended below once the group index is known; here a stub satisfies naga.
let fs_probe = if fs0.contains("gaia_sun_shadow(") { format!("{fs0}\nfn gaia_sun_shadow_core(world: vec3<f32>, cam: vec3<f32>, n: vec3<f32>, nl: f32) -> f32 {{ return 1.0; }}\n") } else { fs0.to_string() };
stage_globals(&fs_probe, wgpu::ShaderStages::FRAGMENT, &mut slots, "fragment")?;
    // package uniforms by (group, binding, member) → semantic + initial value
    let mut pv: HashMap<(u32, u32, String), (Option<String>, Option<String>, Vec<f32>)> = HashMap::new();
    for g in pkg["bindGroups"].as_array().into_iter().flatten() {
        let gi = g["group"].as_u64().unwrap_or(0) as u32;
        for b in g["bindings"].as_array().into_iter().flatten() {
            let bi = b["binding"].as_u64().unwrap_or(0) as u32;
            for u in b["uniforms"].as_array().into_iter().flatten() {
                let v = json_f32(&u["value"]);
                pv.insert((gi, bi, u["name"].as_str().unwrap_or("").to_string()), (u["semantic"].as_str().map(String::from), u["key"].as_str().map(String::from), v));
            }
        }
    }
    for sl in &mut slots {
        if let Kind::Uniform { members, .. } = &mut sl.kind {
            for m in members.iter_mut() {
                let name = m.semantic.take().unwrap_or_default();
                let (sem, key, val) = pv.remove(&(sl.group, sl.binding, name.clone())).unwrap_or((None, None, vec![]));
                m.key = key;
                // render-group members are named by three itself (cameraViewMatrix…); object members carry a package semantic
                m.semantic = sem.or_else(|| name.starts_with("camera").then(|| name.clone()));
                if m.semantic.is_none() && val.is_empty() {
                    return Err(format!("uniform {}.{} `{name}`: no value and no host semantic in package", sl.group, sl.binding));
                }
                m.value = val;
            }
        }
    }
    slots.sort_by_key(|s| (s.group, s.binding));
    let ngroups = slots.iter().map(|s| s.group + 1).max().unwrap_or(0);
    // r10-shadow-3: the package (TSL light node w/ the engine's shadow hook) calls `gaia_sun_shadow(world, cam, n, nl) -> f32`; the CORE's own
    // sun-CSM receiver (forward.wgsl: Shadow struct + bindings + shadow_cascade/sun_shadow, byte-identical source) is appended as group(ngroups).
    let shadow_group = fs0.contains("gaia_sun_shadow(").then_some(ngroups);
    let fs_owned;
    let fs: &str = if let Some(g) = shadow_group {
        fs_owned = format!("{fs0}\n{}", receiver_wgsl(g)?);
        { // the receiver's uniform struct holds arrays (stage_globals reflects scalar/vec/mat members only) → validate the combined module directly; its bind group is the core's, never package-reflected.
            let m = naga::front::wgsl::parse_str(&fs_owned).map_err(|e| format!("fragment+shadow receiver: WGSL parse: {}", e.emit_to_string(&fs_owned)))?;
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all()).validate(&m).map_err(|e| format!("fragment+shadow receiver: naga validation: {}", e.emit_to_string(&fs_owned)))?;
        }
        &fs_owned
    } else { fs0 };
    let layouts: Vec<wgpu::BindGroupLayout> = (0..ngroups)
        .map(|g| {
            let entries: Vec<wgpu::BindGroupLayoutEntry> = slots
                .iter()
                .filter(|s| s.group == g)
                .map(|s| wgpu::BindGroupLayoutEntry {
                    binding: s.binding,
                    visibility: s.vis,
                    ty: match &s.kind {
                        Kind::Uniform { .. } => wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                        Kind::Texture { dim, sample } => wgpu::BindingType::Texture { sample_type: *sample, view_dimension: *dim, multisampled: false },
                        Kind::Sampler => wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
Kind::Storage { read_only } => wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: *read_only }, has_dynamic_offset: false, min_binding_size: None },
},
                    count: None,
                })
                .collect();
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("three group"), entries: &entries })
        })
        .collect();
            // attributes: core Vertex (pos 0, normal 12, uv 24; stride 32) for position/normal/uv GEOMETRY attributes; every other attribute
        // (uv1, color, custom, node-held buffer attributes, instanced) = its own vertex slot, f32 x items, fed by set_mesh_attribute / set_instance_attribute.
        let mut core_attrs = Vec::new();
        let mut extra: Vec<AttrSpec> = Vec::new();
        let mut extra_attrs: Vec<wgpu::VertexAttribute> = Vec::new();
        for a in pkg["attributes"].as_array().into_iter().flatten() {
            let name = a["name"].as_str().unwrap_or("");
            let loc = a["location"].as_u64().ok_or("attribute without location")? as u32;
            let node_sourced = a["source"].as_str() == Some("node");
            let instanced = a["instanced"].as_bool().unwrap_or(false);
            let ty = a["type"].as_str().unwrap_or("");
            let (items, format) = match ty {
                "float" => (1, wgpu::VertexFormat::Float32),
                "vec2" => (2, wgpu::VertexFormat::Float32x2),
                "vec3" => (3, wgpu::VertexFormat::Float32x3),
                "vec4" => (4, wgpu::VertexFormat::Float32x4),
                o => return Err(format!("attribute `{name}` type `{o}` unsupported (float/vec2/vec3/vec4 only)")),
            };
            let core = if node_sourced || instanced { None } else { match name { "position" => Some((0, 3)), "normal" => Some((12, 3)), "uv" => Some((24, 2)), _ => None } };
            if let Some((off, n)) = core {
                if n != items { return Err(format!("attribute `{name}`: shader wants {ty}, core provides {n} floats")); }
                core_attrs.push(wgpu::VertexAttribute { format, offset: off, shader_location: loc });
                continue;
            }
            let key = a["key"].as_str().map(String::from).unwrap_or_else(|| name.to_string());
            extra.push(AttrSpec { key, slot: 0, items, instanced });
            extra_attrs.push(wgpu::VertexAttribute { format, offset: 0, shader_location: loc });
        }
        let core_slot = (!core_attrs.is_empty()).then_some(0u32);
        for (i, e) in extra.iter_mut().enumerate() {
            e.slot = i as u32 + core_slot.map_or(0, |_| 1);
        }
        let extra_attr_arrays: Vec<[wgpu::VertexAttribute; 1]> = extra_attrs.iter().map(|a| [*a]).collect();
        let mut vbufs: Vec<wgpu::VertexBufferLayout> = Vec::new();
        if core_slot.is_some() {
            vbufs.push(wgpu::VertexBufferLayout { array_stride: 32, step_mode: wgpu::VertexStepMode::Vertex, attributes: &core_attrs });
        }
        for (e, arr) in extra.iter().zip(&extra_attr_arrays) {
            vbufs.push(wgpu::VertexBufferLayout { array_stride: e.items as u64 * 4, step_mode: if e.instanced { wgpu::VertexStepMode::Instance } else { wgpu::VertexStepMode::Vertex }, attributes: arr });
        }
        let vbufs_opt: Vec<Option<wgpu::VertexBufferLayout>> = vbufs.into_iter().map(Some).collect();
        // WebGPU limit: maxVertexBuffers (default 8) — loud refusal beats a pipeline-creation validation abort.
        if vbufs_opt.len() > 8 {
            return Err(format!("material needs {} vertex buffers (> 8)", vbufs_opt.len()));
        }
let side = pkg["material"]["side"].as_u64().unwrap_or(0);
    let transparent = pkg["material"]["transparent"].as_bool().unwrap_or(false);
    let (write_mask, depth_write, depth_compare) = pipeline_depth_color_state(&pkg["material"]);
    // r11-pipe: content key = everything the pipeline is built from (per-material uniform VALUES / texture ids are NOT part of it).
let slot_sig: Vec<String> = slots.iter().map(|s| format!("{}.{}.{}.{}", s.group, s.binding, s.vis.bits(), match &s.kind { Kind::Uniform { .. } => "u".to_string(), Kind::Texture { dim, sample } => format!("t{dim:?}{sample:?}"), Kind::Sampler => "s".to_string(), Kind::Storage { read_only } => format!("b{read_only}") })).collect();
let key_str = format!("{vs}\u{1}{fs}\u{1}{}\u{1}{}\u{1}{slot_sig:?}{vbufs_opt:?}{side}{transparent}{}{depth_write}{depth_compare:?}{color_format:?}{depth_format:?}{shadow_group:?}", pkg["vertexEntry"].as_str().unwrap_or("main"), pkg["fragmentEntry"].as_str().unwrap_or("main"), write_mask.bits());
let key = { use std::hash::{Hash, Hasher}; let mut h = std::collections::hash_map::DefaultHasher::new(); key_str.hash(&mut h); h.finish() };
let ordered = transparent || !depth_write || write_mask != wgpu::ColorWrites::ALL || depth_compare != wgpu::CompareFunction::LessEqual;
if cache.share {
    if let Some((p, l)) = cache.pipes.get(&key_str) {
        return Ok(ThreeMaterial { pipeline: p.clone(), layouts: l.clone(), slots, textures, storage, extra, core_slot, shadow_group, key, ordered });
    }
}
let vm = cache.module(device, "three vertex", vs);
let fm = cache.module(device, "three fragment", fs);
    let mut lrefs: Vec<Option<&wgpu::BindGroupLayout>> = layouts.iter().map(Some).collect();
    if shadow_group.is_some() { lrefs.push(Some(receiver)); }
    let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("three layout"), bind_group_layouts: &lrefs, immediate_size: 0 });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("three material"),
        layout: Some(&pl),
        vertex: wgpu::VertexState {
            module: &vm,
            entry_point: Some(pkg["vertexEntry"].as_str().unwrap_or("main")),
            compilation_options: Default::default(),
            buffers: &vbufs_opt,
        },
        fragment: Some(wgpu::FragmentState {
            module: &fm,
            entry_point: Some(pkg["fragmentEntry"].as_str().unwrap_or("main")),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: color_format,
                blend: transparent.then_some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask,
            })],
        }),
        primitive: wgpu::PrimitiveState {
            front_face: wgpu::FrontFace::Ccw,
            // three: FrontSide 0 → cull back, BackSide 1 → cull front, DoubleSide 2 → none
            cull_mode: match side { 0 => Some(wgpu::Face::Back), 1 => Some(wgpu::Face::Front), _ => None },
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: depth_format,
            depth_write_enabled: Some(depth_write),
            depth_compare: Some(depth_compare),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    if cache.share { cache.pipes.insert(key_str, (pipeline.clone(), layouts.clone())); }
Ok(ThreeMaterial { pipeline, layouts, slots, textures, storage, extra, core_slot, shadow_group, key, ordered })
}

/// three material state -> (colour write mask, depth write, depth compare). colorWrite:false => empty mask (depth-only pass); depthWrite:false => no depth write
/// (blended materials never write depth, as before); depthTest:false => compare Always. Missing keys = three defaults.
pub(crate) fn pipeline_depth_color_state(material: &serde_json::Value) -> (wgpu::ColorWrites, bool, wgpu::CompareFunction) {
    let transparent = material["transparent"].as_bool().unwrap_or(false);
    let flag = |k: &str| material[k].as_bool().unwrap_or(true);
    crate::pipeline_state(flag("colorWrite"), !transparent && flag("depthWrite"), flag("depthTest"), wgpu::CompareFunction::LessEqual)
}
/// three `NoColorSpace`/linear texture (e.g. DataTexture default) → Rgba8Unorm, sampled WITHOUT sRGB decode (three semantics).
/// Single mip level (core mipgen blit is sRGB-format only) → minified linear textures alias = NEXT.
fn json_f32(v: &serde_json::Value) -> Vec<f32> {
    match v {
        serde_json::Value::Number(n) => vec![n.as_f64().unwrap_or(0.0) as f32],
        serde_json::Value::Bool(b) => vec![*b as u8 as f32],
        serde_json::Value::Array(a) => a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect(),
        _ => vec![],
    }
}
impl ThreeMaterial {
    /// Live values (tsl-export `live.update()` output): JSON `[{key, value}]`. Writes every member carrying that key (a
    /// uniform node can appear in both stages / several groups); the next prepare() packs it into the reflected buffer.
    /// Unknown key = Err (loud), nothing partially applied.
    pub(crate) fn set_uniforms(&mut self, json: &str) -> Result<usize, String> {
        let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("set_three_uniforms JSON: {e}"))?;
        let items: Vec<(String, Vec<f32>)> = v.as_array().ok_or("set_three_uniforms: array expected")?.iter()
            .map(|i| Ok((i["key"].as_str().ok_or("set_three_uniforms: item without key")?.to_string(), json_f32(&i["value"]))))
            .collect::<Result<_, String>>()?;
        self.apply_uniforms(&items.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect::<Vec<_>>())
    }
    /// r10-5: already-parsed items (batch path: shared values parsed ONCE per frame, applied to every material). Unknown key = Err, nothing applied.
    pub(crate) fn apply_uniforms(&mut self, items: &[(&str, &[f32])]) -> Result<usize, String> {
        let mut hits = vec![0usize; items.len()];
        for sl in &mut self.slots {
            if let Kind::Uniform { members, .. } = &mut sl.kind {
                for m in members.iter_mut() {
                    if let Some(k) = &m.key {
                        if let Some(j) = items.iter().position(|(ik, _)| ik == k) { m.value = items[j].1.to_vec(); hits[j] += 1; }
                    }
                }
            }
        }
        if let Some(j) = hits.iter().position(|h| *h == 0) { return Err(format!("set_three_uniforms: key {} not in package", items[j].0)); }
        Ok(items.len())
    }
}
fn pack(size: u32, members: &[Member], f: &ThreeFrame, model: Mat4) -> Vec<u8> {
    let mut out = vec![0f32; size as usize / 4];
    for m in members {
        let host: Option<Vec<f32>> = m.semantic.as_deref().and_then(|s| match s {
            "cameraViewMatrix" => Some(f.view.to_cols_array().to_vec()),
            "cameraProjectionMatrix" => Some(f.proj.to_cols_array().to_vec()),
            "cameraProjectionMatrixInverse" => Some(f.proj.inverse().to_cols_array().to_vec()),
            "cameraWorldMatrix" => Some(f.camera_world.to_cols_array().to_vec()),
            "cameraNormalMatrix" => Some(Mat3::from_mat4(f.view).inverse().transpose().to_cols_array().to_vec()),
            "cameraPosition" => Some(f.camera_world.transform_point3(Vec3::ZERO).to_array().to_vec()),
            "cameraNear" => Some(vec![f.near]),
            "cameraFar" => Some(vec![f.far]),
            "modelWorldMatrix" => Some(model.to_cols_array().to_vec()),
            "modelWorldMatrixInverse" => Some(model.inverse().to_cols_array().to_vec()),
            "modelNormalMatrix" => Some(Mat3::from_mat4(model).inverse().transpose().to_cols_array().to_vec()),
            "modelPosition" => Some(model.transform_point3(Vec3::ZERO).to_array().to_vec()),
            "time" => Some(vec![f.time]),
            _ => None,
        });
        let v = host.as_deref().unwrap_or(&m.value);
        // WGSL uniform layout: matrix columns padded to vec4 when rows == 3; vectors packed.
        let col_stride = if m.rows == 3 && m.cols > 1 { 4 } else { m.rows } as usize;
        for c in 0..m.cols as usize {
            for r in 0..m.rows as usize {
                let (src, dst) = (c * m.rows as usize + r, m.offset as usize / 4 + c * col_stride + r);
                if let (Some(x), true) = (v.get(src), dst < out.len()) {
                    out[dst] = *x;
                }
            }
        }
    }
    bytemuck::cast_slice(&out).to_vec()
}

/// Host buffer behind a TSL storage binding (shared by every material referencing the same data).
pub(crate) struct StorageBuf {
pub(crate) buffer: wgpu::Buffer,
pub(crate) size: u64,
}
/// GPU resources `prepare` resolves a package's bindings against.
pub(crate) struct Resources<'a> {
pub(crate) tex: &'a HashMap<u32, wgpu::TextureView>,
pub(crate) arrays: &'a HashMap<u32, super::ArrayTex>,
pub(crate) storage: &'a HashMap<u32, StorageBuf>,
pub(crate) white: &'a wgpu::TextureView,
pub(crate) white_array: &'a wgpu::TextureView,
pub(crate) sampler: &'a wgpu::Sampler,
}
impl ThreeMaterials {
pub(crate) fn is_three(&self, material: u32) -> bool {
        self.mats.contains_key(&material)
    }
    /// Drop every instance's cached bind groups (a storage buffer was recreated at a new size): rebuilt in the next prepare().
pub(crate) fn invalidate_bind_groups(&mut self) {
self.inst.clear();
}
pub(crate) fn bind_storage(&mut self, material: u32, key: &str, id: u32) -> Result<(), String> {
let m = self.mats.get_mut(&material).ok_or_else(|| format!("bind_three_storage: {material} is not a three material"))?;
let (g, b) = key.split_once('.').and_then(|(g, b)| Some((g.parse::<u32>().ok()?, b.parse::<u32>().ok()?))).ok_or_else(|| format!("bind_three_storage: key `{key}` is not group.binding"))?;
if !m.slots.iter().any(|s| s.group == g && s.binding == b && matches!(s.kind, Kind::Storage { .. })) { return Err(format!("bind_three_storage: {key} is not a storage binding of material {material}")); }
m.storage.insert(key.to_string(), id);
self.inst.retain(|_, i| i.material != material);
Ok(())
}
pub(crate) fn remove(&mut self, material: u32) {
        self.mats.remove(&material);
        self.inst.retain(|_, g| g.material != material);
    }
    /// Before the pass: (re)write every three instance's uniform buffers from frame data.
    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        instances: &[(u32, u32, [f32; 16])],
        frame: &ThreeFrame,
        res: &Resources,
) {
let Resources { tex, arrays, storage, white, white_array, sampler } = *res;
        for &(iid, mat_id, xf) in instances {
            let Some(mat) = self.mats.get(&mat_id) else { continue };
            let model = Mat4::from_cols_array(&xf);
if self.inst.get(&iid).is_none_or(|g| g.material != mat_id) {
// a storage slot whose host buffer does not exist yet: no instance GPU state (draw counts it skipped), retried next frame
if mat.slots.iter().any(|s| matches!(s.kind, Kind::Storage { .. }) && !mat.storage.get(&format!("{}.{}", s.group, s.binding)).is_some_and(|id| storage.contains_key(id))) { self.inst.remove(&iid); continue; }
                let mut buffers = Vec::new();
                for (k, s) in mat.slots.iter().enumerate() {
                    if let Kind::Uniform { size, members } = &s.kind {
                        buffers.push((k, device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                            label: Some("three uniform"),
                            contents: &pack(*size, members, frame, model),
                            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                        })));
                    }
                }
                let groups = mat
                    .layouts
                    .iter()
                    .enumerate()
                    .map(|(g, layout)| {
                        let entries: Vec<wgpu::BindGroupEntry> = mat
                            .slots
                            .iter()
                            .enumerate()
                            .filter(|(_, s)| s.group == g as u32)
                            .map(|(k, s)| wgpu::BindGroupEntry {
                                binding: s.binding,
                                resource: match &s.kind {
                                    Kind::Uniform { .. } => buffers.iter().find(|(i, _)| *i == k).expect("buffer").1.as_entire_binding(),
                                    Kind::Texture { dim, .. } => wgpu::BindingResource::TextureView(if *dim == wgpu::TextureViewDimension::D2Array {
mat.textures.get(&s.name).and_then(|id| arrays.get(id)).map(|a| &a.view).unwrap_or(white_array)
} else {
mat.textures.get(&s.name).and_then(|id| tex.get(id)).unwrap_or(white)
}),
Kind::Storage { .. } => storage[&mat.storage[&format!("{}.{}", s.group, s.binding)]].buffer.as_entire_binding(),
                                    Kind::Sampler => wgpu::BindingResource::Sampler(sampler),
                                },
                            })
                            .collect();
                        device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("three group"), layout, entries: &entries })
                    })
                    .collect();
                self.inst.insert(iid, InstanceGpu { material: mat_id, buffers, groups });
                continue;
            }
            let g = &self.inst[&iid];
            for (k, buf) in &g.buffers {
                if let Kind::Uniform { size, members } = &mat.slots[*k].kind {
                    queue.write_buffer(buf, 0, &pack(*size, members, frame, model));
                }
            }
        }
    }
        /// Inside the forward pass: one draw per three instance (per-object uniforms). Returns (draws, skipped): an instance is SKIPPED
    /// (counted, surfaced by the host) when its material needs a vertex attribute the mesh/instance does not provide — never drawn with garbage.
    pub(crate) fn draw(&self, pass: &mut wgpu::RenderPass<'_>, instances: &[(u32, u32, [f32; 16])], meshes: &HashMap<u32, super::GpuMesh>, inst_mesh: &HashMap<u32, u32>, inst_attrs: &HashMap<u32, HashMap<String, (wgpu::Buffer, u32)>>, receiver: &wgpu::BindGroup) -> (u32, u32, u32, u32, [u32; 4]) {
        let (mut n, mut skipped) = (0, 0);
        
        let (mut changes, mut distinct) = (0u32, std::collections::HashSet::<u64>::new());
let mut keys = std::collections::HashSet::<u64>::new();
let mut last_pid = u64::MAX;
let mut groups = std::collections::HashMap::<(u32, u32), u32>::new(); // r11-floor: (material, mesh) -> member draws; per-material uniform values are shared, only model-derived members differ
        for &(iid, mat_id, _) in instances {
            let Some(mat) = self.mats.get(&mat_id) else { continue };
let Some(g) = self.inst.get(&iid) else { skipped += 1; continue };
            let Some(gm) = inst_mesh.get(&iid).and_then(|m| meshes.get(m)) else { continue };
            let ia = inst_attrs.get(&iid);
            let mut bound: Vec<(u32, &wgpu::Buffer)> = Vec::new();
            let mut missing = false;
            for e in &mat.extra {
                let found = if e.instanced { ia.and_then(|m| m.get(&e.key)) } else { gm.attrs.get(&e.key) };
                match found {
                    Some((b, items)) if *items == e.items => bound.push((e.slot, b)),
                    _ => { missing = true; break; }
                }
            }
            if missing { skipped += 1; continue; }
            // pipeline identity: shared => the content key, else one pipeline per material
let pid = if self.cache.share { mat.key } else { mat_id as u64 };
keys.insert(mat.key);
if pid != last_pid { changes += 1; last_pid = pid; }
distinct.insert(pid);
*groups.entry((mat_id, *inst_mesh.get(&iid).unwrap_or(&0))).or_default() += 1;
            pass.set_pipeline(&mat.pipeline);
            for (i, bg) in g.groups.iter().enumerate() {
                pass.set_bind_group(i as u32, bg, &[]);
            }
            if let Some(sg) = mat.shadow_group { pass.set_bind_group(sg, receiver, &[]); }
            if let Some(cs) = mat.core_slot { pass.set_vertex_buffer(cs, gm.vertices.slice(..)); }
            for (slot, b) in &bound { pass.set_vertex_buffer(*slot, b.slice(..)); }
            pass.set_index_buffer(gm.indices.slice(..), wgpu::IndexFormat::Uint32);
            pass.draw_indexed(0..gm.index_count, 0, 0..1);
            n += 1;
        }
        let multi: Vec<u32> = groups.values().copied().filter(|&c| c > 1).collect();
(n, skipped, changes, distinct.len() as u32, [multi.len() as u32, multi.iter().sum(), groups.len() as u32, keys.len() as u32])
    }
}

/// The core's sun-CSM receiver WGSL (forward.wgsl slice, single source of truth) re-grouped to `group`, + the one entry point three's light node calls.
fn receiver_wgsl(group: u32) -> Result<String, String> {
    const FWD: &str = include_str!("forward.wgsl");
    let (a, b) = (FWD.find("// Sun cascaded shadow maps"), FWD.find("struct VsOut"));
    let (Some(a), Some(b)) = (a, b) else { return Err("forward.wgsl: shadow receiver markers moved".into()) };
    if b <= a { return Err("forward.wgsl: shadow receiver markers out of order".into()); }
    let body = FWD[a..b].replace("@group(2)", &format!("@group({group})"));
    Ok(format!("{body}\nfn gaia_sun_shadow_core(world: vec3<f32>, cam: vec3<f32>, n: vec3<f32>, nl: f32) -> f32 {{ return sun_shadow(world, cam, n, nl); }}\n"))
}

#[cfg(test)]
mod tests {
    use super::pipeline_depth_color_state as st;
    use serde_json::json;
    #[test]
    fn defaults_write_colour_and_depth_with_less_equal() {
        let (m, dw, c) = st(&json!({}));
        assert_eq!((m, dw, c), (wgpu::ColorWrites::ALL, true, wgpu::CompareFunction::LessEqual));
    }
    #[test]
    fn color_write_false_is_empty_mask_depth_still_written() {
        let (m, dw, _) = st(&json!({ "colorWrite": false, "depthWrite": true }));
        assert_eq!(m, wgpu::ColorWrites::empty());
        assert!(dw);
    }
    #[test]
    fn depth_write_false_and_transparent_drop_depth_write() {
        assert!(!st(&json!({ "depthWrite": false })).1);
        assert!(!st(&json!({ "transparent": true })).1);
    }
    #[test]
    fn depth_test_false_is_always() {
        assert_eq!(st(&json!({ "depthTest": false })).2, wgpu::CompareFunction::Always);
    }
}
