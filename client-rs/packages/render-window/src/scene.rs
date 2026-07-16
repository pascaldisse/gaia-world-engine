use bytemuck::{Pod, Zeroable};
use gaia_core::{
    EcsWorld, Environment, Mesh, MeshPart, NumberOrNumbers, QuerySpec, Spawn, Transform,
};
use glam::{EulerRot, Mat3, Mat4, Quat, Vec3};
use serde_json::Number;

pub const WORLD_SHADER: &str = include_str!("world.wgsl");

#[derive(Clone, Debug)]
pub struct SceneParameters {
    pub fov_y_degrees: f32,
    pub near: f32,
    pub far: f32,
    pub sky_top: String,
    pub sky_horizon: String,
    pub mesh_color: String,
    pub radial_segments: u32,
    pub camera_position: [f32; 3],
    pub camera_yaw: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    pub eye: Vec3,
    pub yaw: f32,
    pub fov_y_radians: f32,
    pub near: f32,
    pub far: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct FrameUniform {
    pub view_projection: [f32; 16],
    pub sky_top: [f32; 4],
    pub sky_horizon: [f32; 4],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct Vertex {
    pub position: [f32; 3],
    pub normal: [f32; 3],
    pub color: [f32; 3],
    pub emissive: f32,
}

impl Vertex {
    pub fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<Self>() as u64,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 0,
                    shader_location: 0,
                },
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 12,
                    shader_location: 1,
                },
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32x3,
                    offset: 24,
                    shader_location: 2,
                },
                wgpu::VertexAttribute {
                    format: wgpu::VertexFormat::Float32,
                    offset: 36,
                    shader_location: 3,
                },
            ],
        }
    }
}

pub struct RenderScene {
    pub camera: Camera,
    pub sky_top: [f32; 4],
    pub sky_horizon: [f32; 4],
    pub vertices: Vec<Vertex>,
}

impl RenderScene {
    pub fn from_ecs(world: &EcsWorld, parameters: &SceneParameters) -> Result<Self, String> {
        if !(parameters.fov_y_degrees > 0.0 && parameters.fov_y_degrees < 180.0) {
            return Err("GAIA_NATIVE_FOV must be between 0 and 180 degrees".into());
        }
        if parameters.near <= 0.0 || parameters.far <= parameters.near {
            return Err("GAIA_NATIVE_NEAR must be positive and less than GAIA_NATIVE_FAR".into());
        }
        if parameters.radial_segments < 3 {
            return Err("GAIA_NATIVE_RADIAL_SEGMENTS must be at least 3".into());
        }

        let spawn = first_component::<Spawn>(world, "spawn")?;
        let eye = spawn
            .as_ref()
            .and_then(|spawn| vec3(spawn.position.as_ref()))
            .unwrap_or(Vec3::from_array(parameters.camera_position));
        let yaw = spawn
            .as_ref()
            .and_then(|spawn| number(spawn.yaw.as_ref()))
            .unwrap_or(parameters.camera_yaw);
        let camera = Camera {
            eye,
            yaw,
            fov_y_radians: parameters.fov_y_degrees.to_radians(),
            near: parameters.near,
            far: parameters.far,
        };

        let environment = first_component::<Environment>(world, "environment")?;
        let sky_top = environment
            .as_ref()
            .and_then(|environment| environment.sky.as_ref())
            .and_then(|sky| sky.top.as_deref())
            .unwrap_or(&parameters.sky_top);
        let sky_horizon = environment
            .as_ref()
            .and_then(|environment| environment.sky.as_ref())
            .and_then(|sky| sky.horizon.as_deref())
            .unwrap_or(&parameters.sky_horizon);
        let sky_top = linear_rgba(sky_top)?;
        let sky_horizon = linear_rgba(sky_horizon)?;
        let default_color = linear_rgb(&parameters.mesh_color)?;

        let render_components = world
            .component_id("transform")
            .zip(world.component_id("mesh"));
        let mut entities = render_components
            .map(|(transform, mesh)| {
                world.query(&QuerySpec {
                    all: vec![transform, mesh],
                    ..Default::default()
                })
            })
            .unwrap_or_default();
        entities.sort_by(|a, b| world.gaia_id_for(*a).cmp(&world.gaia_id_for(*b)));

        let mut primitives = Vec::<RenderPrimitive>::new();
        for entity in entities {
            let (transform_id, mesh_id) = render_components.expect("render query has components");
            let id = world.gaia_id_for(entity).unwrap_or("<unbound>");
            let transform: Transform =
                serde_json::from_value(world.get_component(entity, transform_id)?)
                    .map_err(|error| format!("entity {id:?} transform: {error}"))?;
            let mesh: Mesh = serde_json::from_value(world.get_component(entity, mesh_id)?)
                .map_err(|error| format!("entity {id:?} mesh: {error}"))?;
            let parts = parts_of(mesh).map_err(|error| format!("entity {id:?} mesh: {error}"))?;
            let entity_model = transform_matrix(
                vec3(transform.position.as_ref()).unwrap_or(Vec3::ZERO),
                vec3(transform.rotation.as_ref()).unwrap_or(Vec3::ZERO),
                scale(transform.scale.as_ref()),
            );
            for (index, part) in parts.iter().enumerate() {
                append_part(
                    &mut primitives,
                    part,
                    entity_model,
                    camera.eye,
                    default_color,
                    parameters.radial_segments,
                )
                .map_err(|error| format!("entity {id:?} mesh part {index}: {error}"))?;
            }
        }

        // W1 has no depth attachment: convex primitives use a deterministic painter pass.
        // Keep each primitive contiguous; W2 replaces this ordering with the ruled depth buffer.
        primitives.sort_by(|a, b| b.distance_squared.total_cmp(&a.distance_squared));
        let vertices = primitives
            .into_iter()
            .flat_map(|primitive| primitive.vertices)
            .collect();

        Ok(Self {
            camera,
            sky_top,
            sky_horizon,
            vertices,
        })
    }

    pub fn frame_uniform(&self, width: u32, height: u32) -> FrameUniform {
        let aspect = width as f32 / height.max(1) as f32;
        let direction = Vec3::new(-self.camera.yaw.sin(), 0.0, -self.camera.yaw.cos());
        let view = Mat4::look_to_rh(Vec3::ZERO, direction, Vec3::Y);
        let projection = Mat4::perspective_rh(
            self.camera.fov_y_radians,
            aspect,
            self.camera.near,
            self.camera.far,
        );
        FrameUniform {
            view_projection: (projection * view).to_cols_array(),
            sky_top: self.sky_top,
            sky_horizon: self.sky_horizon,
        }
    }
}

#[derive(Clone, Copy)]
struct PrimitiveVertex {
    position: Vec3,
    normal: Vec3,
}

struct RenderPrimitive {
    vertices: Vec<Vertex>,
    distance_squared: f32,
}

fn first_component<T: serde::de::DeserializeOwned>(
    world: &EcsWorld,
    name: &str,
) -> Result<Option<T>, String> {
    let Some(component) = world.component_id(name) else {
        return Ok(None);
    };
    let mut entities = world.query(&QuerySpec {
        all: vec![component],
        ..Default::default()
    });
    entities.sort_by(|a, b| world.gaia_id_for(*a).cmp(&world.gaia_id_for(*b)));
    entities
        .first()
        .map(|entity| {
            serde_json::from_value(world.get_component(*entity, component)?)
                .map_err(|error| format!("component {name:?}: {error}"))
        })
        .transpose()
}

fn parts_of(mesh: Mesh) -> Result<Vec<MeshPart>, String> {
    if let Some(parts) = mesh.parts {
        return Ok(parts);
    }
    if mesh.extra.contains_key("shape") {
        return serde_json::from_value(serde_json::Value::Object(mesh.extra))
            .map(|part| vec![part])
            .map_err(|error| error.to_string());
    }
    Ok(Vec::new())
}

fn append_part(
    output: &mut Vec<RenderPrimitive>,
    part: &MeshPart,
    entity_model: Mat4,
    camera_eye: Vec3,
    default_color: [f32; 3],
    default_segments: u32,
) -> Result<(), String> {
    let position = vec3(part.position.as_ref()).unwrap_or(Vec3::ZERO);
    let rotation = vec3(part.rotation.as_ref()).unwrap_or(Vec3::ZERO);
    let model = entity_model * transform_matrix(position, rotation, scale(part.scale.as_ref()));
    let determinant = Mat3::from_mat4(model).determinant();
    if !determinant.is_finite() || determinant.abs() < f32::EPSILON {
        return Err("transform scale must be finite and non-zero".into());
    }
    let normal_matrix = Mat3::from_mat4(model).inverse().transpose();
    let segments = part.radial_segments.unwrap_or(default_segments).max(3);
    let primitive = match part.shape.as_deref().unwrap_or("box") {
        "box" => box_triangles(dimensions(part.size.as_ref(), [1.0, 1.0, 1.0])?),
        "sphere" => sphere_triangles(
            positive(number(part.radius.as_ref()).unwrap_or(0.5), "radius")?,
            segments,
        ),
        "cylinder" => {
            let radius = positive(number(part.radius.as_ref()).unwrap_or(0.5), "radius")?;
            let top = non_negative(
                number(part.radius_top.as_ref()).unwrap_or(radius),
                "radiusTop",
            )?;
            let bottom = non_negative(
                number(part.radius_bottom.as_ref()).unwrap_or(radius),
                "radiusBottom",
            )?;
            let height = positive(number(part.height.as_ref()).unwrap_or(1.0), "height")?;
            frustum_triangles(top, bottom, height, segments, true)
        }
        "cone" => {
            let radius = positive(number(part.radius.as_ref()).unwrap_or(0.5), "radius")?;
            let height = positive(number(part.height.as_ref()).unwrap_or(1.0), "height")?;
            frustum_triangles(0.0, radius, height, segments, true)
        }
        shape => return Err(format!("unsupported W1 primitive {shape:?}")),
    };

    let emissive = part.emissive.is_some();
    let color = match part.emissive.as_deref().or(part.color.as_deref()) {
        Some(color) => linear_rgb(color)?,
        None => default_color,
    };
    let vertices = primitive
        .into_iter()
        .flatten()
        .map(|vertex| {
            let world_position = model.transform_point3(vertex.position);
            let relative = world_position - camera_eye;
            let normal = (normal_matrix * vertex.normal).normalize_or_zero();
            Vertex {
                position: relative.to_array(),
                normal: normal.to_array(),
                color,
                emissive: f32::from(emissive),
            }
        })
        .collect();
    let center = model.transform_point3(Vec3::ZERO) - camera_eye;
    output.push(RenderPrimitive {
        vertices,
        distance_squared: center.length_squared(),
    });
    Ok(())
}

fn box_triangles(size: Vec3) -> Vec<[PrimitiveVertex; 3]> {
    let half = size * 0.5;
    let faces = [
        (
            Vec3::X * half.x,
            Vec3::NEG_Z * half.z,
            Vec3::Y * half.y,
            Vec3::X,
        ),
        (
            Vec3::NEG_X * half.x,
            Vec3::Z * half.z,
            Vec3::Y * half.y,
            Vec3::NEG_X,
        ),
        (
            Vec3::Y * half.y,
            Vec3::X * half.x,
            Vec3::NEG_Z * half.z,
            Vec3::Y,
        ),
        (
            Vec3::NEG_Y * half.y,
            Vec3::X * half.x,
            Vec3::Z * half.z,
            Vec3::NEG_Y,
        ),
        (
            Vec3::Z * half.z,
            Vec3::X * half.x,
            Vec3::Y * half.y,
            Vec3::Z,
        ),
        (
            Vec3::NEG_Z * half.z,
            Vec3::NEG_X * half.x,
            Vec3::Y * half.y,
            Vec3::NEG_Z,
        ),
    ];
    let mut triangles = Vec::with_capacity(12);
    for (center, u, v, normal) in faces {
        let a = PrimitiveVertex {
            position: center - u - v,
            normal,
        };
        let b = PrimitiveVertex {
            position: center + u - v,
            normal,
        };
        let c = PrimitiveVertex {
            position: center + u + v,
            normal,
        };
        let d = PrimitiveVertex {
            position: center - u + v,
            normal,
        };
        triangles.extend([[a, b, c], [a, c, d]]);
    }
    triangles
}

fn sphere_triangles(radius: f32, segments: u32) -> Vec<[PrimitiveVertex; 3]> {
    let stacks = (segments / 2).max(2);
    let mut triangles = Vec::with_capacity((segments * stacks * 2) as usize);
    let point = |latitude: u32, longitude: u32| {
        let theta = std::f32::consts::PI * latitude as f32 / stacks as f32;
        let phi = std::f32::consts::TAU * longitude as f32 / segments as f32;
        let normal = Vec3::new(
            theta.sin() * phi.sin(),
            theta.cos(),
            theta.sin() * phi.cos(),
        );
        PrimitiveVertex {
            position: normal * radius,
            normal,
        }
    };
    for latitude in 0..stacks {
        for longitude in 0..segments {
            let next = longitude + 1;
            let a = point(latitude, longitude);
            let b = point(latitude + 1, longitude);
            let c = point(latitude + 1, next);
            let d = point(latitude, next);
            if latitude > 0 {
                triangles.push([a, b, c]);
            }
            if latitude + 1 < stacks {
                triangles.push([a, c, d]);
            }
        }
    }
    triangles
}

fn frustum_triangles(
    top_radius: f32,
    bottom_radius: f32,
    height: f32,
    segments: u32,
    capped: bool,
) -> Vec<[PrimitiveVertex; 3]> {
    let mut triangles = Vec::with_capacity((segments * 4) as usize);
    let half = height * 0.5;
    let slope = (bottom_radius - top_radius) / height;
    let ring = |angle: f32, radius: f32, y: f32| {
        let radial = Vec3::new(angle.sin(), 0.0, angle.cos());
        PrimitiveVertex {
            position: radial * radius + Vec3::Y * y,
            normal: Vec3::new(radial.x, slope, radial.z).normalize(),
        }
    };
    for segment in 0..segments {
        let a = std::f32::consts::TAU * segment as f32 / segments as f32;
        let b = std::f32::consts::TAU * (segment + 1) as f32 / segments as f32;
        let bottom_a = ring(a, bottom_radius, -half);
        let bottom_b = ring(b, bottom_radius, -half);
        let top_a = ring(a, top_radius, half);
        let top_b = ring(b, top_radius, half);
        triangles.push([bottom_a, bottom_b, top_b]);
        if top_radius > 0.0 {
            triangles.push([bottom_a, top_b, top_a]);
        }
        if capped && top_radius > 0.0 {
            let center = PrimitiveVertex {
                position: Vec3::Y * half,
                normal: Vec3::Y,
            };
            let mut edge_a = top_a;
            let mut edge_b = top_b;
            edge_a.normal = Vec3::Y;
            edge_b.normal = Vec3::Y;
            triangles.push([center, edge_a, edge_b]);
        }
        if capped && bottom_radius > 0.0 {
            let center = PrimitiveVertex {
                position: Vec3::NEG_Y * half,
                normal: Vec3::NEG_Y,
            };
            let mut edge_a = bottom_a;
            let mut edge_b = bottom_b;
            edge_a.normal = Vec3::NEG_Y;
            edge_b.normal = Vec3::NEG_Y;
            triangles.push([center, edge_b, edge_a]);
        }
    }
    triangles
}

fn transform_matrix(position: Vec3, rotation: Vec3, scale: Vec3) -> Mat4 {
    Mat4::from_scale_rotation_translation(
        scale,
        Quat::from_euler(EulerRot::XYZ, rotation.x, rotation.y, rotation.z),
        position,
    )
}

fn dimensions(value: Option<&Vec<Number>>, default: [f32; 3]) -> Result<Vec3, String> {
    let size = vec3(value).unwrap_or(Vec3::from_array(default));
    if !size.is_finite() || size.min_element() <= 0.0 {
        return Err("box size must contain three positive finite numbers".into());
    }
    Ok(size)
}

fn vec3(value: Option<&Vec<Number>>) -> Option<Vec3> {
    let value = value?;
    (value.len() == 3).then(|| {
        Vec3::new(
            number(value.first()).unwrap_or(0.0),
            number(value.get(1)).unwrap_or(0.0),
            number(value.get(2)).unwrap_or(0.0),
        )
    })
}

fn scale(value: Option<&NumberOrNumbers>) -> Vec3 {
    match value {
        Some(NumberOrNumbers::Number(value)) => Vec3::splat(number(Some(value)).unwrap_or(1.0)),
        Some(NumberOrNumbers::Numbers(value)) => vec3(Some(value)).unwrap_or(Vec3::ONE),
        None => Vec3::ONE,
    }
}

fn number(value: Option<&Number>) -> Option<f32> {
    value.and_then(Number::as_f64).map(|value| value as f32)
}

fn positive(value: f32, name: &str) -> Result<f32, String> {
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(format!("{name} must be positive and finite"))
    }
}

fn non_negative(value: f32, name: &str) -> Result<f32, String> {
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(format!("{name} must be non-negative and finite"))
    }
}

fn linear_rgba(hex: &str) -> Result<[f32; 4], String> {
    let [r, g, b] = linear_rgb(hex)?;
    Ok([r, g, b, 1.0])
}

fn linear_rgb(hex: &str) -> Result<[f32; 3], String> {
    let hex = hex
        .strip_prefix('#')
        .ok_or_else(|| format!("color {hex:?} must start with #"))?;
    let bytes = match hex.len() {
        3 => [
            u8::from_str_radix(&hex[0..1].repeat(2), 16),
            u8::from_str_radix(&hex[1..2].repeat(2), 16),
            u8::from_str_radix(&hex[2..3].repeat(2), 16),
        ],
        6 => [
            u8::from_str_radix(&hex[0..2], 16),
            u8::from_str_radix(&hex[2..4], 16),
            u8::from_str_radix(&hex[4..6], 16),
        ],
        _ => return Err(format!("color #{hex} must contain 3 or 6 hex digits")),
    };
    let bytes = bytes.map(|value| value.map_err(|_| format!("invalid hex color #{hex}")));
    let [r, g, b] = [bytes[0].clone()?, bytes[1].clone()?, bytes[2].clone()?];
    Ok([srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b)])
}

fn srgb_to_linear(channel: u8) -> f32 {
    let value = channel as f32 / 255.0;
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}
