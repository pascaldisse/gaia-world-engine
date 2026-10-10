//! lane nt-dyninst: DYNAMIC instance blocks.
//!
//! A block whose data changes every frame (FFX particle batches: count + transforms + colours differ per frame) used to dirty the
//! WORLD instance list: `rebuild_instances` re-sorted every instance + block and re-created 4 GPU buffers per frame.
//! A dynamic block instead lives outside that list:
//!   * own persistent vertex buffers (transforms / colours / uv windows), capacity-doubling, filled by `queue.write_buffer` of `[0, count)` only;
//!   * own draw batch (`Batch.dyn_block`), appended after the static batches every frame;
//!   * own shadow casters appended after the static casters (only when the block's data/flags changed).
//! Static world instances are therefore never re-sorted / re-uploaded because a dynamic block changed.
//! Promotion: `RenderOptions.dynamic_block_frames` consecutive frames with an update (0 = off), or explicit `set_instance_block_dynamic`.
//! Demotion (auto-promoted only): no update for `RenderOptions.dynamic_block_idle_frames` rendered frames (0 = never).
use super::*;

/// Explicit mode: let usage decide (promotion by update streak).
pub const DYN_AUTO: u32 = 0;
/// Explicit mode: always dynamic (adapter saw DynamicDrawUsage).
pub const DYN_FORCE_DYNAMIC: u32 = 1;
/// Explicit mode: never dynamic.
pub const DYN_FORCE_STATIC: u32 = 2;

/// Persistent GPU side of one dynamic block (grow-only capacity, in instances).
pub(crate) struct DynGpu {
    pub cap: usize,
    pub transforms: wgpu::Buffer,
    pub colors: wgpu::Buffer,
    pub uvs: wgpu::Buffer,
}

#[derive(Default)]
pub(crate) struct DynState {
    /// DYN_AUTO / DYN_FORCE_DYNAMIC / DYN_FORCE_STATIC
    pub mode: u32,
    /// true = outside the world list (own buffers + batch)
    pub active: bool,
    /// consecutive rendered frames with an update
    pub streak: u32,
    /// `RenderCore.frame_no` of the last update
    pub last_update: Option<u64>,
    pub tf_dirty: bool,
    pub col_dirty: bool,
    pub uv_dirty: bool,
    /// instances of the uv buffer holding written data (stale tail beyond must be rewritten when the count grows)
    pub uv_written: usize,
    pub gpu: Option<DynGpu>,
}

/// Observability of the dynamic path (cumulative counters are never reset).
#[derive(Default, Clone, Debug)]
pub struct DynBlockStats {
    /// dynamic blocks / instances / bytes `write_buffer`d in the last frame
    pub blocks: u32,
    pub instances: u32,
    pub bytes_written: u64,
    /// persistent GPU buffers (re)allocated for dynamic blocks (growth only)
    pub buffer_allocs: u64,
    /// full world-list rebuilds (`rebuild_instances`)
    pub rebuilds: u64,
    /// world instance buffers (re)created (capacity growth only; a rebuild itself is `queue.write_buffer`)
    pub world_buffer_allocs: u64,
    pub promotions: u64,
    pub demotions: u64,
}

pub(crate) enum Touch {
    /// transforms/colours replaced (`update_instance_block`)
    Data,
    Uv,
    /// shadow/static/shadow_only flags
    Flags,
}

/// World AABB of a mesh-space AABB under `t` (column-major).
pub(crate) fn world_aabb(lo: Vec3, hi: Vec3, t: &[f32; 16]) -> (Vec3, Vec3) {
    let m = Mat4::from_cols_array(t);
    let (mut wlo, mut whi) = (Vec3::splat(f32::MAX), Vec3::splat(f32::MIN));
    for i in 0..8 {
        let c = Vec3::new(if i & 1 == 0 { lo.x } else { hi.x }, if i & 2 == 0 { lo.y } else { hi.y }, if i & 4 == 0 { lo.z } else { hi.z });
        let w = m.transform_point3(c);
        wlo = wlo.min(w);
        whi = whi.max(w);
    }
    (wlo, whi)
}

impl RenderCore {
    /// Explicit dynamic hint (adapter: three `DynamicDrawUsage`). `mode` = DYN_AUTO | DYN_FORCE_DYNAMIC | DYN_FORCE_STATIC.
    pub fn set_instance_block_dynamic(&mut self, id: u32, mode: u32) {
        let Some(b) = self.blocks.get_mut(&id) else { return };
        if b.dynm.mode == mode {
            return; // no-op re-assertion: never dirty anything
        }
        b.dynm.mode = mode;
        let want = match mode {
            DYN_FORCE_DYNAMIC => true,
            DYN_FORCE_STATIC => false,
            _ => b.dynm.active,
        };
        self.block_set_active(id, want);
    }

    /// Dynamic blocks currently on the cheap path (diagnostics).
    pub fn dynamic_block_count(&self) -> usize {
        self.blocks.values().filter(|b| b.dynm.active).count()
    }
    pub fn dyn_block_stats(&self) -> &DynBlockStats {
        &self.dyn_stats
    }
    /// Wire form of `DynBlockStats`: [dynamic blocks, dynamic instances, bytes written last frame, buffer allocs (cum), world rebuilds (cum), promotions (cum), demotions (cum), world buffer allocs (cum)].
    pub fn dyn_block_stats_vec(&self) -> Vec<u32> {
        let s = &self.dyn_stats;
        let c = |v: u64| v.min(u32::MAX as u64) as u32;
        vec![s.blocks, s.instances, c(s.bytes_written), c(s.buffer_allocs), c(s.rebuilds), c(s.promotions), c(s.demotions), c(s.world_buffer_allocs)]
    }

    /// Flip block `id` into/out of the dynamic path; one world-list rebuild (it leaves/joins the sorted list).
    fn block_set_active(&mut self, id: u32, want: bool) {
        let Some(b) = self.blocks.get_mut(&id) else { return };
        if b.dynm.active == want {
            return;
        }
        b.dynm.active = want;
        b.dynm.tf_dirty = true;
        b.dynm.col_dirty = true;
        b.dynm.uv_dirty = true;
        b.dynm.uv_written = 0;
        if want {
            self.dyn_stats.promotions += 1;
        } else {
            b.dynm.gpu = None; // free the persistent buffers
            b.dynm.streak = 0;
            self.dyn_stats.demotions += 1;
        }
        if b.is_static {
            self.static_gen += 1; // static casters moved between the world list and the dynamic tail
        }
        self.instances_dirty = true;
        self.dyn_casters_dirty = true;
    }

    /// Record that block `id` changed. Dynamic blocks mark only their own upload; everything else dirties the world list.
    pub(crate) fn block_touch(&mut self, id: u32, kind: Touch) {
        let frame_no = self.frame_no;
        let promote_after = self.opts.dynamic_block_frames;
        let Some(b) = self.blocks.get_mut(&id) else { return };
        let mut want = b.dynm.active;
        match kind {
            Touch::Data => {
                match b.dynm.last_update {
                    Some(l) if l == frame_no => {}
                    Some(l) if frame_no == l + 1 => b.dynm.streak += 1,
                    _ => b.dynm.streak = 1,
                }
                b.dynm.last_update = Some(frame_no);
                b.dynm.tf_dirty = true;
                b.dynm.col_dirty = true;
                want = match b.dynm.mode {
                    DYN_FORCE_DYNAMIC => true,
                    DYN_FORCE_STATIC => false,
                    _ => b.dynm.active || (promote_after > 0 && b.dynm.streak >= promote_after),
                };
            }
            Touch::Uv => b.dynm.uv_dirty = true,
            Touch::Flags => {}
        }
        if b.dynm.active {
            self.dyn_casters_dirty = true; // transforms / flags changed -> dynamic casters stale
        } else {
            self.instances_dirty = true;
        }
        if want != self.blocks[&id].dynm.active {
            self.block_set_active(id, want);
        }
    }

    /// Before the world-list rebuild: auto-promoted blocks that stopped updating go back to the static list.
    pub(crate) fn dyn_demote_idle(&mut self) {
        let idle = self.opts.dynamic_block_idle_frames as u64;
        if idle == 0 {
            return;
        }
        let f = self.frame_no;
        let stale: Vec<u32> = self
            .blocks
            .iter()
            .filter(|(_, b)| b.dynm.active && b.dynm.mode == DYN_AUTO && b.dynm.last_update.is_some_and(|l| f.saturating_sub(l) > idle))
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.block_set_active(id, false);
        }
    }

    /// After `rebuild_instances`: upload dirty dynamic blocks ([0,count) only), (re)build their batches and casters. No per-frame
    /// `create_buffer*`: buffers are created only when a block's count outgrows its capacity (doubling).
    pub(crate) fn sync_dynamic_blocks(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
        self.batches.truncate(self.static_batch_len);
        let mut order = std::mem::take(&mut self.dyn_order);
        order.clear();
        order.extend(self.blocks.iter().filter(|(_, b)| b.dynm.active).map(|(id, _)| *id));
        {
            let blocks = &self.blocks;
            order.sort_by_key(|id| (blocks[id].mesh, blocks[id].material, *id));
        }
        let min_cap = self.opts.dynamic_block_min_capacity.max(1) as usize;
        let mut scratch = std::mem::take(&mut self.dyn_scratch);
        let (mut bytes, mut inst, mut allocs) = (0u64, 0u32, 0u64);
        for id in order.iter() {
            let b = self.blocks.get_mut(id).expect("dyn order");
            let n = b.transforms.len();
            if n == 0 {
                continue;
            }
            if b.dynm.gpu.as_ref().is_none_or(|g| g.cap < n) {
                let cap = b.dynm.gpu.as_ref().map_or(min_cap, |g| g.cap * 2).max(n).max(min_cap).next_power_of_two();
                let mk = |label: &'static str, stride: usize| {
                    device.create_buffer(&wgpu::BufferDescriptor { label: Some(label), size: (cap * stride) as u64, usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })
                };
                b.dynm.gpu = Some(DynGpu { cap, transforms: mk("dyn block transforms", 64), colors: mk("dyn block colours", 16), uvs: mk("dyn block uv windows", 16) });
                b.dynm.tf_dirty = true;
                b.dynm.col_dirty = true;
                b.dynm.uv_dirty = true;
                b.dynm.uv_written = 0;
                allocs += 3;
            }
            if n > b.dynm.uv_written {
                b.dynm.uv_dirty = true; // buffer tail beyond the last written count is stale
            }
            let g = b.dynm.gpu.as_ref().expect("dyn gpu");
            if b.dynm.tf_dirty {
                queue.write_buffer(&g.transforms, 0, bytemuck::cast_slice(&b.transforms[..n]));
                bytes += (n * 64) as u64;
            }
            if b.dynm.col_dirty {
                if b.colors.len() >= n {
                    queue.write_buffer(&g.colors, 0, bytemuck::cast_slice(&b.colors[..n]));
                } else {
                    scratch.clear();
                    scratch.extend_from_slice(&b.colors[..b.colors.len().min(n)]);
                    scratch.resize(n, [1.0; 4]);
                    queue.write_buffer(&g.colors, 0, bytemuck::cast_slice(&scratch));
                }
                bytes += (n * 16) as u64;
            }
            if b.dynm.uv_dirty {
                if b.uvs.len() >= n {
                    queue.write_buffer(&g.uvs, 0, bytemuck::cast_slice(&b.uvs[..n]));
                } else {
                    scratch.clear();
                    scratch.extend_from_slice(&b.uvs[..b.uvs.len().min(n)]);
                    scratch.resize(n, [0.0, 0.0, 1.0, 1.0]);
                    queue.write_buffer(&g.uvs, 0, bytemuck::cast_slice(&scratch));
                }
                b.dynm.uv_written = n;
                bytes += (n * 16) as u64;
            }
            b.dynm.tf_dirty = false;
            b.dynm.col_dirty = false;
            b.dynm.uv_dirty = false;
            inst += n as u32;
            if !b.shadow_only && self.meshes.contains_key(&b.mesh) {
                self.batches.push(Batch { mesh: b.mesh, material: b.material, range: 0..n as u32, dyn_block: Some(*id) });
            }
        }
        self.dyn_scratch = scratch;
        if self.dyn_casters_dirty {
            self.dyn_casters_dirty = false;
            self.casters.truncate(self.static_caster_len);
            let max_diag = self.opts.shadows.import_max_caster_diagonal;
            for id in order.iter() {
                let b = &self.blocks[id];
                if !b.cast_shadow {
                    continue;
                }
                let (lo, hi) = self.meshes.get(&b.mesh).map(|m| (Vec3::from_array(m.lo), Vec3::from_array(m.hi))).unwrap_or((Vec3::ZERO, Vec3::ZERO));
                for t in b.transforms.iter() {
                    let (wlo, whi) = world_aabb(lo, hi, t);
                    if max_diag <= 0.0 || wlo.distance(whi) <= max_diag {
                        self.casters.push(shadow::Caster { mesh: b.mesh, material: b.material, transform: *t, is_static: b.is_static, lo: wlo, hi: whi });
                    }
                }
            }
        }
        self.dyn_stats.blocks = order.len() as u32;
        self.dyn_stats.instances = inst;
        self.dyn_stats.bytes_written = bytes;
        self.dyn_stats.buffer_allocs += allocs;
        self.dyn_order = order;
        self.frame_no += 1;
    }
}
