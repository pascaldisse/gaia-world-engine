//! glTF 2.0 → flat GPU-ready scene. Static: node transforms are baked into vertices.
//! Contract (scene-export lane): POSITION/NORMAL/TEXCOORD_0, u32 indices, PBR
//! metallic-roughness, KHR_lights_punctual sun + points, one camera node.
//! Anything outside the contract that is cheap to accept (u16 indices, no camera,
//! no lights) is accepted and REPORTED in `SceneData::notes` — never silent.
use glam::{Mat3, Mat4, Vec3};

#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub uv: [f32; 2],
}

#[derive(Clone, Debug)]
pub struct Draw {
    /// This primitive's own vertex range in `SceneData::vertices` (indices are global).
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub first_index: u32,
    pub index_count: u32,
    pub material: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AlphaMode {
    Opaque,
    Mask(f32),
    /// Drawn as opaque in this core (no sorted transparency pass yet) — counted in notes.
    Blend,
}

#[derive(Clone, Debug)]
pub struct Material {
    pub base_color_factor: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub base_color_texture: Option<usize>,
    pub alpha: AlphaMode,
    pub emissive: [f32; 3],
    /// Baked light from `material.extras.lightmap` (scene-export): image index, texCoord, fac.
    pub lightmap: Option<Lightmap>,
    /// Engine render flags from `material.extras.gaia` (scene-export `materialFlags`).
    pub flags: crate::MaterialFlags,
}

/// DS1 baked lightmap, applied as the DS client does (nari-world-companion
/// client/ds-world/lightmap.mjs `overlayNode`, default path): albedo := Blender
/// OVERLAY(albedo, lightmap, fac) in linear, then normal scene lighting on top.
#[derive(Clone, Copy, Debug)]
pub struct Lightmap {
    pub image: usize,
    pub tex_coord: u32,
    pub fac: f32,
}

#[derive(Clone, Debug)]
pub struct Rgba8Image {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub struct CameraData {
    /// world-from-camera transform (glTF camera looks down its local -Z).
    pub world: Mat4,
    pub yfov: f32,
    pub znear: f32,
    /// None = infinite far plane (glTF allows it).
    pub zfar: Option<f32>,
}

#[derive(Clone, Copy, Debug)]
pub struct DirectionalLight {
    /// Unit vector the light TRAVELS along (world space).
    pub direction: Vec3,
    pub color: Vec3,
    pub intensity: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct PointLight {
    pub position: Vec3,
    pub color: Vec3,
    pub intensity: f32,
    /// 0 = unbounded (glTF: range absent).
    pub range: f32,
}

#[derive(Clone, Debug, Default)]
pub struct SceneData {
    pub vertices: Vec<Vertex>,
    /// TEXCOORD_1 per vertex (parallel to `vertices`; zero when absent).
    pub uv1: Vec<[f32; 2]>,
    pub indices: Vec<u32>,
    pub draws: Vec<Draw>,
    pub materials: Vec<Material>,
    pub images: Vec<Rgba8Image>,
    pub camera: Option<CameraData>,
    pub sun: Option<DirectionalLight>,
    pub points: Vec<PointLight>,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
    /// Contract deviations accepted while loading (u16 indices, no camera, ...).
    pub notes: Vec<String>,
    /// Skinned nodes (NOT baked into `draws`) + skins + clip; None = file has no skins.
    pub skins: Option<crate::skin::SkinScene>,
}

pub type LoadError = String;

impl SceneData {
    /// Self-contained .glb (or .gltf with data: URIs) from memory — works on wasm32.
    pub fn from_slice(bytes: &[u8]) -> Result<Self, LoadError> {
        let (doc, buffers, images) =
            gltf::import_slice(bytes).map_err(|e| format!("gltf import: {e}"))?;
        Self::from_document(&doc, &buffers, &images)
    }

    /// .glb or .gltf with external buffers/images from disk (native only).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn from_path(path: &std::path::Path) -> Result<Self, LoadError> {
        let (doc, buffers, images) =
            gltf::import(path).map_err(|e| format!("gltf import {}: {e}", path.display()))?;
        Self::from_document(&doc, &buffers, &images)
    }

    pub fn from_document(
        doc: &gltf::Document,
        buffers: &[gltf::buffer::Data],
        images: &[gltf::image::Data],
    ) -> Result<Self, LoadError> {
        let mut out = SceneData {
            bounds_min: Vec3::splat(f32::MAX),
            bounds_max: Vec3::splat(f32::MIN),
            ..Default::default()
        };
        for image in images {
            out.images.push(to_rgba8(image)?);
        }
        for material in doc.materials() {
            let pbr = material.pbr_metallic_roughness();
            out.materials.push(Material {
                base_color_factor: pbr.base_color_factor(),
                metallic: pbr.metallic_factor(),
                roughness: pbr.roughness_factor(),
                base_color_texture: pbr
                    .base_color_texture()
                    .map(|info| info.texture().source().index()),
                alpha: match material.alpha_mode() {
                    gltf::material::AlphaMode::Opaque => AlphaMode::Opaque,
                    gltf::material::AlphaMode::Mask => {
                        AlphaMode::Mask(material.alpha_cutoff().unwrap_or(0.5))
                    }
                    gltf::material::AlphaMode::Blend => AlphaMode::Blend,
                },
                emissive: material.emissive_factor(),
                lightmap: parse_lightmap(&doc, material.extras()),
                flags: parse_flags(material.extras()),
            });
        }
        // glTF default material for primitives without one.
        let default_material = out.materials.len();
        out.materials.push(Material {
            base_color_factor: [1.0; 4],
            metallic: 1.0,
            roughness: 1.0,
            base_color_texture: None,
            alpha: AlphaMode::Opaque,
            emissive: [0.0; 3],
            lightmap: None,
            flags: Default::default(),
        });
        let scene = doc
            .default_scene()
            .or_else(|| doc.scenes().next())
            .ok_or("gltf has no scene")?;
        let mut u16_prims = 0usize;
        let mut blend_prims = 0usize;
        for node in scene.nodes() {
            visit(
                &node,
                Mat4::IDENTITY,
                buffers,
                &mut out,
                default_material,
                &mut u16_prims,
                &mut blend_prims,
            )?;
        }
        out.skins = crate::skin::SkinScene::from_document(doc, buffers, &mut out.notes);
        if u16_prims > 0 {
            out.notes
                .push(format!("{u16_prims} primitive(s) had non-u32 indices (widened)"));
        }
        if blend_prims > 0 {
            out.notes
                .push(format!("{blend_prims} BLEND primitive(s) drawn opaque (no sorted pass)"));
        }
        if out.camera.is_none() {
            out.notes.push("no camera node — fitted to bounds".into());
        }
        if out.sun.is_none() {
            out.notes
                .push("no KHR_lights_punctual directional — default sun used".into());
        }
        if out.vertices.is_empty() {
            out.bounds_min = Vec3::ZERO;
            out.bounds_max = Vec3::ZERO;
        }
        Ok(out)
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
}

fn visit(
    node: &gltf::Node,
    parent: Mat4,
    buffers: &[gltf::buffer::Data],
    out: &mut SceneData,
    default_material: usize,
    u16_prims: &mut usize,
    blend_prims: &mut usize,
) -> Result<(), LoadError> {
    let world = parent * Mat4::from_cols_array_2d(&node.transform().matrix());
    if let Some(camera) = node.camera()
        && out.camera.is_none()
    {
        if let gltf::camera::Projection::Perspective(p) = camera.projection() {
            out.camera = Some(CameraData {
                world,
                yfov: p.yfov(),
                znear: p.znear(),
                zfar: p.zfar(),
            });
        }
    }
    if let Some(light) = node.light() {
        let color = Vec3::from_array(light.color());
        match light.kind() {
            gltf::khr_lights_punctual::Kind::Directional => {
                if out.sun.is_none() {
                    out.sun = Some(DirectionalLight {
                        direction: world.transform_vector3(Vec3::NEG_Z).normalize_or_zero(),
                        color,
                        intensity: light.intensity(),
                    });
                }
            }
            gltf::khr_lights_punctual::Kind::Point => out.points.push(PointLight {
                position: world.transform_point3(Vec3::ZERO),
                color,
                intensity: light.intensity(),
                range: light.range().unwrap_or(0.0),
            }),
            gltf::khr_lights_punctual::Kind::Spot { .. } => {
                out.notes.push("spot light ignored (not in contract)".into())
            }
        }
    }
    if let Some(mesh) = node.mesh().filter(|_| node.skin().is_none()) {
        let normal_matrix = Mat3::from_mat4(world).inverse().transpose();
        for prim in mesh.primitives() {
            if prim.mode() != gltf::mesh::Mode::Triangles {
                out.notes
                    .push(format!("non-triangle primitive skipped in mesh {:?}", mesh.name()));
                continue;
            }
            let reader = prim.reader(|b| buffers.get(b.index()).map(|d| &d.0[..]));
            let Some(positions) = reader.read_positions() else {
                continue;
            };
            let positions: Vec<[f32; 3]> = positions.collect();
            let normals: Vec<[f32; 3]> = reader
                .read_normals()
                .map(|n| n.collect())
                .unwrap_or_else(|| vec![[0.0, 1.0, 0.0]; positions.len()]);
            let uvs: Vec<[f32; 2]> = reader
                .read_tex_coords(0)
                .map(|t| t.into_f32().collect())
                .unwrap_or_else(|| vec![[0.0, 0.0]; positions.len()]);
            let uv1: Vec<[f32; 2]> = reader
                .read_tex_coords(1)
                .map(|t| t.into_f32().collect())
                .unwrap_or_else(|| vec![[0.0, 0.0]; positions.len()]);
            out.uv1.extend_from_slice(&uv1);
            let base = out.vertices.len() as u32;
            for i in 0..positions.len() {
                let p = world.transform_point3(Vec3::from_array(positions[i]));
                out.bounds_min = out.bounds_min.min(p);
                out.bounds_max = out.bounds_max.max(p);
                let n = (normal_matrix * Vec3::from_array(normals[i])).normalize_or_zero();
                out.vertices.push(Vertex {
                    position: p.to_array(),
                    normal: n.to_array(),
                    uv: uvs[i],
                });
            }
            let first_index = out.indices.len() as u32;
            match reader.read_indices() {
                Some(indices) => {
                    if !matches!(indices, gltf::mesh::util::ReadIndices::U32(_)) {
                        *u16_prims += 1;
                    }
                    out.indices.extend(indices.into_u32().map(|i| i + base));
                }
                None => out.indices.extend((0..positions.len() as u32).map(|i| i + base)),
            }
            // Mirrored transforms flip winding; keep CCW front faces.
            if world.determinant() < 0.0 {
                for tri in out.indices[first_index as usize..].chunks_exact_mut(3) {
                    tri.swap(1, 2);
                }
            }
            let material = prim.material().index().unwrap_or(default_material);
            if out.materials[material].alpha == AlphaMode::Blend {
                *blend_prims += 1;
            }
            out.draws.push(Draw {
                first_vertex: base,
                vertex_count: positions.len() as u32,
                first_index,
                index_count: out.indices.len() as u32 - first_index,
                material,
            });
        }
    }
    for child in node.children() {
        visit(
            &child,
            world,
            buffers,
            out,
            default_material,
            u16_prims,
            blend_prims,
        )?;
    }
    Ok(())
}

fn to_rgba8(image: &gltf::image::Data) -> Result<Rgba8Image, LoadError> {
    use gltf::image::Format;
    let n = (image.width * image.height) as usize;
    let src = &image.pixels;
    let pixels = match image.format {
        Format::R8G8B8A8 => src.clone(),
        Format::R8G8B8 => src.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        Format::R8G8 => src.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        Format::R8 => src.iter().flat_map(|&v| [v, v, v, 255]).collect(),
        other => return Err(format!("image format {other:?} not supported for base color")),
    };
    debug_assert_eq!(pixels.len(), n * 4);
    Ok(Rgba8Image {
        width: image.width,
        height: image.height,
        pixels,
    })
}

/// `extras.gaia = {blend:"alpha"|"additive"|"subtractive", unlit, depthWrite, renderOrder, castShadow}`.
fn parse_flags(extras: &gltf::json::Extras) -> crate::MaterialFlags {
    let mut f = crate::MaterialFlags::default();
    let Some(v) = extras.as_ref().and_then(|r| serde_json::from_str::<serde_json::Value>(r.get()).ok()) else { return f };
    let Some(g) = v.get("gaia") else { return f };
    f.blend = match g.get("blend").and_then(|b| b.as_str()) {
        Some("additive") => Some(crate::BlendKind::Additive),
        Some("subtractive") => Some(crate::BlendKind::Subtractive),
        Some("alpha") => Some(crate::BlendKind::Alpha),
        _ => None,
    };
    f.unlit = g.get("unlit").and_then(|b| b.as_bool()).unwrap_or(false);
    f.depth_write = g.get("depthWrite").and_then(|b| b.as_bool());
    f.render_order = g.get("renderOrder").and_then(|b| b.as_i64()).unwrap_or(0) as i32;
    f.cast_shadow = g.get("castShadow").and_then(|b| b.as_bool());
    f
}

/// `extras.lightmap = {texture, texCoord, fac, blend:"overlay"}` → Lightmap (image index).
fn parse_lightmap(doc: &gltf::Document, extras: &gltf::json::Extras) -> Option<Lightmap> {
    let raw = extras.as_ref()?;
    let v: serde_json::Value = serde_json::from_str(raw.get()).ok()?;
    let lm = v.get("lightmap")?;
    let tex = lm.get("texture")?.as_u64()? as usize;
    let image = doc.textures().nth(tex)?.source().index();
    Some(Lightmap {
        image,
        tex_coord: lm.get("texCoord").and_then(|t| t.as_u64()).unwrap_or(1) as u32,
        fac: lm.get("fac").and_then(|f| f.as_f64()).unwrap_or(0.5) as f32,
    })
}
