//! GPU skinning — data-only API + one compute pre-pass for ALL skinned meshes.
//! Why compute (not vertex-shader skinning): skinned vertices are written ONCE per frame
//! into an ordinary vertex buffer → main, transparent and shadow passes (and external
//! TSL/WGSL materials) draw them with the UNCHANGED static vertex contract: no pipeline
//! permutations, no per-pass re-skinning (shadow = N cascades × re-skin otherwise).
//! Layout: all skinned meshes share ONE src storage buffer, ONE dst (STORAGE|VERTEX)
//! buffer and ONE joint palette (array<mat4x4f>) → one dispatch per frame. Each skinned
//! mesh = a normal `GpuMesh` whose vertex buffer is the shared dst and whose indices are
//! rebased by its first vertex → draw path / shadow lane need no changes.
use crate::{GpuMesh, RenderCore, nonempty, scene};
use glam::{Mat4, Quat, Vec3};
use std::collections::HashMap;
use wgpu::util::DeviceExt;

const SKIN_WGSL: &str = include_str!("skin.wgsl");
/// f32 slots per src vertex: pos3 n3 uv2 joints(2×u32 packed u16) weights4 palette_base 1 pad.
const SRC_STRIDE: usize = 16;
const WORKGROUP: u32 = 64;

struct Skin {
    inverse_bind: Vec<Mat4>,
    /// Joint world matrices (last `set_skin_pose`); identity until posed.
    pose: Vec<Mat4>,
    palette_base: u32,
}
struct SkinnedSrc {
    skin: u32,
    material_free_verts: Vec<[f32; SRC_STRIDE]>,
    indices: Vec<u32>,
    center: [f32; 3],
    /// Bind-pose AABB (shadow caster culling input; padded at upload, see `SKIN_BOUNDS_PAD`).
    lo: [f32; 3],
    hi: [f32; 3],
}

/// Bind-pose AABB padding for skinned shadow-caster culling: animation moves vertices outside the bind
/// pose, so bounds grow by this fraction of the extent plus `SKIN_BOUNDS_PAD_M` metres (approximation, not
/// a per-frame bound).
const SKIN_BOUNDS_PAD: f32 = 0.5;
const SKIN_BOUNDS_PAD_M: f32 = 1.0;

struct GpuSkin {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    bind: Option<wgpu::BindGroup>,
    palette: Option<wgpu::Buffer>,
    vertex_total: u32,
    timing: Option<(wgpu::QuerySet, wgpu::Buffer, wgpu::Buffer, f32)>,
    /// skin readback mapped by `read_skin_ms_async` (r5-adapter): the per-frame copy into it is skipped while true.
    ts_pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
pub(crate) struct SkinSystem {
    skins: HashMap<u32, Skin>,
    meshes: HashMap<u32, SkinnedSrc>,
    structure_dirty: bool,
    pose_dirty: bool,
    gpu: Option<GpuSkin>,
    pub(crate) joint_total: u32,
}

impl RenderCore {
    /// Skeleton: `inverse_bind` = joint_count column-major mat4s (glTF inverseBindMatrices).
    pub fn create_skin(&mut self, id: u32, joint_count: u32, inverse_bind: &[f32]) -> Result<(), String> {
        if inverse_bind.len() != joint_count as usize * 16 {
            return Err(format!("skin {id}: {} floats for {joint_count} joints", inverse_bind.len()));
        }
        let ibm: Vec<Mat4> = inverse_bind.chunks_exact(16).map(Mat4::from_cols_slice).collect();
        let pose = vec![Mat4::IDENTITY; ibm.len()];
        self.skin.skins.insert(id, Skin { inverse_bind: ibm, pose, palette_base: 0 });
        self.skin.structure_dirty = true;
        Ok(())
    }
    pub fn remove_skin(&mut self, id: u32) {
        self.skin.skins.remove(&id);
        self.skin.structure_dirty = true;
    }
    /// Joint WORLD matrices (joint_count col-major mat4s) for this frame. Palette =
    /// pose × inverseBind (CPU, cheap) → uploaded once before the skin dispatch.
    pub fn set_skin_pose(&mut self, id: u32, joint_matrices: &[f32]) -> Result<(), String> {
        let s = self.skin.skins.get_mut(&id).ok_or_else(|| format!("set_skin_pose: no skin {id}"))?;
        if joint_matrices.len() != s.pose.len() * 16 {
            return Err(format!("skin {id}: pose {} floats, want {}", joint_matrices.len(), s.pose.len() * 16));
        }
        for (p, m) in s.pose.iter_mut().zip(joint_matrices.chunks_exact(16)) {
            *p = Mat4::from_cols_slice(m);
        }
        self.skin.pose_dirty = true;
        Ok(())
    }
    /// Skinned mesh: like `create_mesh` + JOINTS_0 (4 u32/vertex, < 65536) + WEIGHTS_0 (4 f32).
    /// Draw it with `create_instance(.., identity)` — glTF skinned vertices are world-space.
    #[allow(clippy::too_many_arguments)]
    pub fn create_skinned_mesh(
        &mut self,
        id: u32,
        skin: u32,
        positions: &[f32],
        normals: &[f32],
        uvs: &[f32],
        joints: &[u32],
        weights: &[f32],
        indices: &[u32],
    ) -> Result<(), String> {
        let n = positions.len() / 3;
        if positions.len() % 3 != 0 || normals.len() != n * 3 || uvs.len() != n * 2 || joints.len() != n * 4 || weights.len() != n * 4 {
            return Err(format!("skinned mesh {id}: stream lengths disagree (n={n})"));
        }
        let jc = self.skin.skins.get(&skin).ok_or_else(|| format!("skinned mesh {id}: no skin {skin}"))?.pose.len();
        if let Some(bad) = joints.iter().find(|&&j| j as usize >= jc) {
            return Err(format!("skinned mesh {id}: joint {bad} >= {jc}"));
        }
        if let Some(bad) = indices.iter().find(|&&i| i as usize >= n) {
            return Err(format!("skinned mesh {id}: index {bad} >= {n}"));
        }
        let (mut lo, mut hi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
        let verts = (0..n)
            .map(|i| {
                let p = Vec3::new(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
                lo = lo.min(p);
                hi = hi.max(p);
                let j = &joints[4 * i..4 * i + 4];
                let mut v = [0f32; SRC_STRIDE];
                v[0..3].copy_from_slice(&positions[3 * i..3 * i + 3]);
                v[3..6].copy_from_slice(&normals[3 * i..3 * i + 3]);
                v[6..8].copy_from_slice(&uvs[2 * i..2 * i + 2]);
                v[8] = f32::from_bits(j[0] | (j[1] << 16));
                v[9] = f32::from_bits(j[2] | (j[3] << 16));
                v[10..14].copy_from_slice(&weights[4 * i..4 * i + 4]);
                v
            })
            .collect();
        let center = if n == 0 { [0.0; 3] } else { ((lo + hi) * 0.5).to_array() };
        self.skin.meshes.insert(id, SkinnedSrc { skin, material_free_verts: verts, indices: indices.to_vec(), center, lo: if n == 0 { [0.0; 3] } else { lo.to_array() }, hi: if n == 0 { [0.0; 3] } else { hi.to_array() } });
        self.skin.structure_dirty = true;
        Ok(())
    }
    pub fn remove_skinned_mesh(&mut self, id: u32) {
        if self.skin.meshes.remove(&id).is_some() {
            self.meshes.remove(&id);
            self.skin.structure_dirty = true;
        }
    }
    pub fn skinned_vertex_count(&self) -> u32 {
        self.skin.gpu.as_ref().map_or(0, |g| g.vertex_total)
    }
    pub fn skin_joint_count(&self) -> u32 {
        self.skin.joint_total
    }

    /// Called at the start of `encode_forward`: (re)build shared buffers on structure
    /// change, upload palette on pose change, dispatch the skin pass once.
    pub(crate) fn encode_skinning(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) {
        if self.skin.meshes.is_empty() {
            return;
        }
        if self.skin.gpu.is_none() {
            self.skin.gpu = Some(GpuSkin::new(device, queue.get_timestamp_period()));
        }
        if self.skin.structure_dirty {
            self.rebuild_skinning(device);
        }
        let sys = &mut self.skin;
        let g = sys.gpu.as_ref().expect("gpu skin");
        if sys.pose_dirty {
            let mut pal = vec![Mat4::IDENTITY; sys.joint_total as usize];
            for s in sys.skins.values() {
                for (j, (p, ibm)) in s.pose.iter().zip(&s.inverse_bind).enumerate() {
                    pal[s.palette_base as usize + j] = *p * *ibm;
                }
            }
            if let Some(b) = &g.palette {
                queue.write_buffer(b, 0, bytemuck::cast_slice(&pal.iter().map(|m| m.to_cols_array()).collect::<Vec<_>>()));
            }
            sys.pose_dirty = false;
        }
        let Some(bind) = &g.bind else { return };
        let groups = g.vertex_total.div_ceil(WORKGROUP);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("gaia-render skin"),
            timestamp_writes: g.timing.as_ref().map(|t| wgpu::ComputePassTimestampWrites {
                query_set: &t.0,
                beginning_of_pass_write_index: Some(0),
                end_of_pass_write_index: Some(1),
            }),
        });
        pass.set_pipeline(&g.pipeline);
        pass.set_bind_group(0, bind, &[]);
        pass.dispatch_workgroups(groups.min(65535), groups.div_ceil(65535), 1);
        drop(pass);
        if let Some(t) = &g.timing {
            encoder.resolve_query_set(&t.0, 0..2, &t.1, 0);
            if !g.ts_pending.load(std::sync::atomic::Ordering::Acquire) {
                encoder.copy_buffer_to_buffer(&t.1, 0, &t.2, 0, 16);
            }
        }
    }

    fn rebuild_skinning(&mut self, device: &wgpu::Device) {
        let sys = &mut self.skin;
        sys.structure_dirty = false;
        sys.pose_dirty = true;
        let mut ids: Vec<u32> = sys.skins.keys().copied().collect();
        ids.sort_unstable();
        let mut base = 0u32;
        for id in ids {
            let s = sys.skins.get_mut(&id).unwrap();
            s.palette_base = base;
            base += s.pose.len() as u32;
        }
        sys.joint_total = base;
        let mut mids: Vec<u32> = sys.meshes.keys().copied().collect();
        mids.sort_unstable();
        let mut src: Vec<[f32; SRC_STRIDE]> = Vec::new();
        let mut ranges = Vec::new();
        for id in &mids {
            let m = &sys.meshes[id];
            let Some(skin) = sys.skins.get(&m.skin) else { continue }; // skin removed → mesh not drawn
            let first = src.len() as u32;
            src.extend(m.material_free_verts.iter().map(|v| {
                let mut v = *v;
                v[14] = f32::from_bits(skin.palette_base);
                v
            }));
            ranges.push((*id, first));
        }
        let total = src.len() as u32;
        let g = sys.gpu.as_mut().unwrap();
        g.vertex_total = total;
        let src_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("skin src"),
            contents: nonempty(bytemuck::cast_slice(&src)),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let dst = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("skin dst (vertex)"),
            size: (total as u64 * std::mem::size_of::<scene::Vertex>() as u64).max(16),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::VERTEX,
            mapped_at_creation: false,
        });
        let uv1 = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("skin uv1 (zero)"),
            contents: nonempty(&vec![0u8; total as usize * 8]),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let palette = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("skin palette"),
            size: (sys.joint_total as u64 * 64).max(64),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("skin params"),
            contents: bytemuck::cast_slice(&[total, WORKGROUP * 65535, 0, 0]),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        g.bind = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("skin bind"),
            layout: &g.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: src_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: palette.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: dst.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: params.as_entire_binding() },
            ],
        }));
        g.palette = Some(palette);
        for (id, first) in ranges {
            let m = &sys.meshes[&id];
            let idx: Vec<u32> = m.indices.iter().map(|&i| i + first).collect();
            self.meshes.insert(
                id,
                GpuMesh {
                    center: m.center,
                    lo: {
                        let (lo, hi) = (glam::Vec3::from_array(m.lo), glam::Vec3::from_array(m.hi));
                        (lo - (hi - lo) * SKIN_BOUNDS_PAD - glam::Vec3::splat(SKIN_BOUNDS_PAD_M)).to_array()
                    },
                    hi: {
                        let (lo, hi) = (glam::Vec3::from_array(m.lo), glam::Vec3::from_array(m.hi));
                        (hi + (hi - lo) * SKIN_BOUNDS_PAD + glam::Vec3::splat(SKIN_BOUNDS_PAD_M)).to_array()
                    },
                    vertices: dst.clone(),
                    uv1: uv1.clone(),
                    vertex_count: m.material_free_verts.len() as u32,
                    indices: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("skinned indices (rebased)"),
                        contents: nonempty(bytemuck::cast_slice(&idx)),
                        usage: wgpu::BufferUsages::INDEX,
                    }),
                    index_count: idx.len() as u32,
                },
            );
        }
    }

    /// Non-blocking GPU ms of the last copied skin pass (works on wasm32). false = no timestamps / no skin pass yet / a sample already in flight.
    pub fn read_skin_ms_async(&self, done: impl FnOnce(Option<f64>) + wgpu::WasmNotSend + 'static) -> bool {
        use std::sync::atomic::Ordering;
        let Some(g) = self.skin.gpu.as_ref() else { return false };
        let Some(t) = g.timing.as_ref() else { return false };
        if g.bind.is_none() || g.ts_pending.swap(true, Ordering::AcqRel) {
            return false;
        }
        let (buf, pending, period) = (t.2.clone(), g.ts_pending.clone(), t.3 as f64);
        let b2 = buf.clone();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let out = r.ok().and_then(|_| {
                let ts: [u64; 2] = *bytemuck::from_bytes(&b2.slice(..).get_mapped_range().ok()?[..16]);
                Some(ts[1].saturating_sub(ts[0]) as f64 * period / 1e6)
            });
            b2.unmap();
            pending.store(false, Ordering::Release);
            done(out);
        });
        true
    }

    /// GPU ms of the last skin pass (native measurement; blocks). None = no timestamps / no skins.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn read_skin_ms_blocking(&self, device: &wgpu::Device) -> Option<f64> {
        let t = self.skin.gpu.as_ref()?.timing.as_ref()?;
        let slice = t.2.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r.is_ok());
        });
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        if !rx.recv().ok()? {
            return None;
        }
        let ts: [u64; 2] = *bytemuck::from_bytes(&slice.get_mapped_range().ok()?[..16]);
        t.2.unmap();
        Some(ts[1].saturating_sub(ts[0]) as f64 * t.3 as f64 / 1e6)
    }
}

impl GpuSkin {
    fn new(device: &wgpu::Device, period_ns: f32) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("skin.wgsl"),
            source: wgpu::ShaderSource::Wgsl(SKIN_WGSL.into()),
        });
        let st = |b, ro| wgpu::BindGroupLayoutEntry {
            binding: b,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: ro }, has_dynamic_offset: false, min_binding_size: None },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("skin layout"),
            entries: &[
                st(0, true),
                st(1, true),
                st(2, false),
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                    count: None,
                },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("skin pl"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("skin"),
            layout: Some(&pl),
            module: &module,
            entry_point: Some("skin"),
            compilation_options: Default::default(),
            cache: None,
        });
        let timing = device.features().contains(wgpu::Features::TIMESTAMP_QUERY).then(|| {
            let set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("skin ts"), ty: wgpu::QueryType::Timestamp, count: 2 });
            let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: Some("skin ts resolve"), size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
            let readback = device.create_buffer(&wgpu::BufferDescriptor { label: Some("skin ts readback"), size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            (set, resolve, readback, period_ns)
        });
        GpuSkin { pipeline, layout, bind: None, palette: None, vertex_total: 0, timing, ts_pending: Default::default() }
    }
}

// ---------------- glTF import (client of the API above) + CPU clip evaluation ----------------

#[derive(Clone, Debug, Default)]
pub struct SkinnedPrim {
    pub skin: usize,
    pub material: usize,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    pub joints: Vec<u32>,
    pub weights: Vec<f32>,
    pub indices: Vec<u32>,
}
#[derive(Clone, Debug)]
enum Channel {
    T(usize, Vec<f32>, Vec<Vec3>, bool),
    R(usize, Vec<f32>, Vec<Quat>, bool),
    S(usize, Vec<f32>, Vec<Vec3>, bool),
}
/// Node hierarchy + skins + skinned prims + ONE clip (all channels of all glTF animations
/// play together; each channel loops on the clip's max time).
#[derive(Clone, Debug, Default)]
pub struct SkinScene {
    parent: Vec<Option<usize>>,
    /// Parent-first order.
    order: Vec<usize>,
    rest: Vec<(Vec3, Quat, Vec3)>,
    pub skins: Vec<(Vec<usize>, Vec<f32>)>,
    pub prims: Vec<SkinnedPrim>,
    channels: Vec<Channel>,
    pub duration: f32,
}
/// Core ids for skinned meshes/instances/skins start here (static draws use 0..N).
pub const SKIN_ID_BASE: u32 = 1 << 24;

impl SkinScene {
    pub fn from_document(doc: &gltf::Document, buffers: &[gltf::buffer::Data], notes: &mut Vec<String>) -> Option<Self> {
        if doc.skins().len() == 0 {
            return None;
        }
        let n = doc.nodes().len();
        let mut out = SkinScene { parent: vec![None; n], ..Default::default() };
        for node in doc.nodes() {
            let (t, r, s) = node.transform().decomposed();
            out.rest.push((Vec3::from(t), Quat::from_array(r), Vec3::from(s)));
            for c in node.children() {
                out.parent[c.index()] = Some(node.index());
            }
        }
        let mut seen = vec![false; n];
        fn walk(i: usize, p: &[Option<usize>], seen: &mut [bool], order: &mut Vec<usize>) {
            if seen[i] { return; }
            if let Some(pp) = p[i] { walk(pp, p, seen, order); }
            seen[i] = true;
            order.push(i);
        }
        for i in 0..n { walk(i, &out.parent, &mut seen, &mut out.order); }
        let get = |b: gltf::Buffer| Some(&*buffers[b.index()]);
        for skin in doc.skins() {
            let joints: Vec<usize> = skin.joints().map(|j| j.index()).collect();
            let ibm: Vec<f32> = match skin.reader(get).read_inverse_bind_matrices() {
                Some(it) => it.flat_map(|m| m.into_iter().flatten()).collect(),
                None => Mat4::IDENTITY.to_cols_array().repeat(joints.len()),
            };
            out.skins.push((joints, ibm));
        }
        let default_material = doc.materials().len();
        let mut dropped = 0;
        for node in doc.nodes() {
            let (Some(skin), Some(mesh)) = (node.skin(), node.mesh()) else { continue };
            for prim in mesh.primitives() {
                let r = prim.reader(get);
                let (Some(pos), Some(j), Some(w)) = (r.read_positions(), r.read_joints(0), r.read_weights(0)) else { dropped += 1; continue };
                let positions: Vec<f32> = pos.flatten().collect();
                let nv = positions.len() / 3;
                let normals: Vec<f32> = r.read_normals().map(|x| x.flatten().collect()).unwrap_or_else(|| [0.0, 1.0, 0.0].repeat(nv));
                let uvs: Vec<f32> = r.read_tex_coords(0).map(|x| x.into_f32().flatten().collect()).unwrap_or_else(|| vec![0.0; nv * 2]);
                let indices: Vec<u32> = r.read_indices().map(|x| x.into_u32().collect()).unwrap_or_else(|| (0..nv as u32).collect());
                out.prims.push(SkinnedPrim {
                    skin: skin.index(),
                    material: prim.material().index().unwrap_or(default_material),
                    positions,
                    normals,
                    uvs,
                    joints: j.into_u16().flatten().map(u32::from).collect(),
                    weights: w.into_f32().flatten().collect(),
                    indices,
                });
            }
        }
        let mut cubic = 0;
        for anim in doc.animations() {
            for ch in anim.channels() {
                let r = ch.reader(get);
                let node = ch.target().node().index();
                let Some(times) = r.read_inputs().map(|t| t.collect::<Vec<f32>>()) else { continue };
                let interp = ch.sampler().interpolation();
                let step = interp == gltf::animation::Interpolation::Step;
                let cs = interp == gltf::animation::Interpolation::CubicSpline;
                cubic += cs as usize;
                // CUBICSPLINE: keep the value (middle of in-tangent/value/out-tangent), lerp between.
                let pick = |i: usize| if cs { i % 3 == 1 } else { true };
                if let Some(&t) = times.last() { out.duration = out.duration.max(t); }
                use gltf::animation::util::ReadOutputs as O;
                match r.read_outputs() {
                    Some(O::Translations(v)) => out.channels.push(Channel::T(node, times, v.enumerate().filter(|(i, _)| pick(*i)).map(|(_, x)| Vec3::from(x)).collect(), step)),
                    Some(O::Scales(v)) => out.channels.push(Channel::S(node, times, v.enumerate().filter(|(i, _)| pick(*i)).map(|(_, x)| Vec3::from(x)).collect(), step)),
                    Some(O::Rotations(v)) => out.channels.push(Channel::R(node, times, v.into_f32().enumerate().filter(|(i, _)| pick(*i)).map(|(_, x)| Quat::from_array(x).normalize()).collect(), step)),
                    _ => {}
                }
            }
        }
        notes.push(format!(
            "skins: {} skins, {} joints, {} skinned prims ({dropped} dropped: no JOINTS_0/WEIGHTS_0), {} anim channels, clip {:.2}s{}",
            out.skins.len(),
            out.skins.iter().map(|s| s.0.len()).sum::<usize>(),
            out.prims.len(),
            out.channels.len(),
            out.duration,
            if cubic > 0 { format!(", {cubic} CUBICSPLINE channels linearized") } else { String::new() }
        ));
        Some(out)
    }

    /// Register skins + skinned meshes + identity instances (ids from SKIN_ID_BASE).
    pub fn load_into(&self, core: &mut RenderCore) -> Result<(), String> {
        for (i, (joints, ibm)) in self.skins.iter().enumerate() {
            core.create_skin(SKIN_ID_BASE + i as u32, joints.len() as u32, ibm)?;
        }
        for (k, p) in self.prims.iter().enumerate() {
            let id = SKIN_ID_BASE + k as u32;
            core.create_skinned_mesh(id, SKIN_ID_BASE + p.skin as u32, &p.positions, &p.normals, &p.uvs, &p.joints, &p.weights, &p.indices)?;
            core.create_instance(id, id, p.material as u32, Mat4::IDENTITY.to_cols_array());
        }
        self.pose_at(core, 0.0)
    }

    /// Evaluate the clip at `t` seconds (looped) → joint world matrices → `set_skin_pose`.
    pub fn pose_at(&self, core: &mut RenderCore, t: f32) -> Result<(), String> {
        let t = if self.duration > 0.0 { t.rem_euclid(self.duration) } else { 0.0 };
        let mut local = self.rest.clone();
        fn key(times: &[f32], t: f32) -> (usize, usize, f32) {
            let i = times.partition_point(|&x| x <= t);
            if i == 0 { return (0, 0, 0.0); }
            if i >= times.len() { let l = times.len() - 1; return (l, l, 0.0); }
            let (a, b) = (times[i - 1], times[i]);
            (i - 1, i, if b > a { (t - a) / (b - a) } else { 0.0 })
        }
        for ch in &self.channels {
            match ch {
                Channel::T(n, ts, v, st) => { let (a, b, f) = key(ts, t); if b < v.len() { local[*n].0 = if *st { v[a] } else { v[a].lerp(v[b], f) }; } }
                Channel::S(n, ts, v, st) => { let (a, b, f) = key(ts, t); if b < v.len() { local[*n].2 = if *st { v[a] } else { v[a].lerp(v[b], f) }; } }
                Channel::R(n, ts, v, st) => { let (a, b, f) = key(ts, t); if b < v.len() { local[*n].1 = if *st { v[a] } else { v[a].slerp(v[b], f) }; } }
            }
        }
        let mut world = vec![Mat4::IDENTITY; local.len()];
        for &i in &self.order {
            let (tr, r, s) = local[i];
            let m = Mat4::from_scale_rotation_translation(s, r, tr);
            world[i] = match self.parent[i] { Some(p) => world[p] * m, None => m };
        }
        for (i, (joints, _)) in self.skins.iter().enumerate() {
            let pose: Vec<f32> = joints.iter().flat_map(|&j| world[j].to_cols_array()).collect();
            core.set_skin_pose(SKIN_ID_BASE + i as u32, &pose)?;
        }
        Ok(())
    }
}
