//! Which (color, output) formats MTLFXSpatialScaler accepts on this GPU (nil = rejected).
#[cfg(target_os = "macos")]
fn main() {
    use gaia_metalfx::{ScalerConfig, SpatialUpscaler};
    use wgpu::TextureFormat as T;
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::METAL, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).unwrap();
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let fs = [T::Rgba8Unorm, T::Rgba8UnormSrgb, T::Bgra8Unorm, T::Bgra8UnormSrgb, T::Rgba16Float];
    for c in fs {
        for o in fs {
            let cfg = ScalerConfig { input_size: (1152, 720), output_size: (2560, 1600), color_format: c, output_format: o };
            let r = SpatialUpscaler::new(&device, &queue, cfg).map(|_| ()).map_err(|e| e.to_string());
            println!("{c:?} -> {o:?}: {r:?}");
        }
    }
}
#[cfg(not(target_os = "macos"))]
fn main() {}
