struct Frame {
  view_projection: mat4x4<f32>,
  sky_top: vec4<f32>,
  sky_horizon: vec4<f32>,
};
@group(0) @binding(0) var<uniform> frame: Frame;

struct SkyOut {
  @builtin(position) position: vec4<f32>,
  @location(0) height: f32,
};

@vertex
fn sky_vs(@builtin(vertex_index) index: u32) -> SkyOut {
  var points = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  let point = points[index];
  var out: SkyOut;
  out.position = vec4<f32>(point, 1.0, 1.0);
  out.height = point.y * 0.5 + 0.5;
  return out;
}

@fragment
fn sky_fs(in: SkyOut) -> @location(0) vec4<f32> {
  return mix(frame.sky_horizon, frame.sky_top, clamp(in.height, 0.0, 1.0));
}

struct MeshIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec3<f32>,
  @location(3) emissive: f32,
};

struct MeshOut {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) color: vec3<f32>,
  @location(2) emissive: f32,
};

@vertex
fn mesh_vs(in: MeshIn) -> MeshOut {
  var out: MeshOut;
  out.position = frame.view_projection * vec4<f32>(in.position, 1.0);
  out.normal = in.normal;
  out.color = in.color;
  out.emissive = in.emissive;
  return out;
}

// W1-only scaffolding → one deletable function; W4's integrator replaces it.
fn scaffold_hemisphere_shade(normal: vec3<f32>) -> f32 {
  let n = normalize(normal);
  let hemisphere = n.y * 0.5 + 0.5;
  return clamp(0.55 + 0.45 * hemisphere + 0.12 * n.x, 0.4, 1.0);
}

@fragment
fn mesh_fs(in: MeshOut) -> @location(0) vec4<f32> {
  if (in.emissive > 0.5) {
    return vec4<f32>(in.color, 1.0);
  }
  return vec4<f32>(in.color * scaffold_hemisphere_shade(in.normal), 1.0);
}
