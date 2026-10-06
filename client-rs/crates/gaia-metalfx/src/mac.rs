use std::fmt;

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::Message;
use objc2_metal::{
    MTLCommandBuffer, MTLCommandQueue, MTLDevice, MTLPixelFormat, MTLTexture, MTLTextureUsage,
};
use objc2_metal_fx::{
    MTLFXSpatialScaler, MTLFXSpatialScalerBase, MTLFXSpatialScalerColorProcessingMode,
    MTLFXSpatialScalerDescriptor, MTLFXTemporalScaler, MTLFXTemporalScalerBase,
    MTLFXTemporalScalerDescriptor,
};
use wgpu::hal::api::Metal;


#[derive(Debug)]
pub enum MetalFxError {
    NotMetalBackend(&'static str),
    Unsupported(&'static str),
    UnsupportedFormat(wgpu::TextureFormat),
    BadUsage { which: &'static str, needed: u64, has: u64 },
    BadSize { which: &'static str, expected: (u32, u32), got: (u32, u32) },
    CreateFailed(&'static str),
    NoCommandBuffer,
}

impl fmt::Display for MetalFxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotMetalBackend(w) => write!(f, "MetalFX: {w} is not on the wgpu Metal backend"),
            Self::Unsupported(w) => write!(f, "MetalFX: {w} reports supportsDevice == NO on this GPU"),
            Self::UnsupportedFormat(fm) => write!(f, "MetalFX: no MTLPixelFormat mapping for {fm:?}"),
            Self::BadUsage { which, needed, has } => write!(
                f,
                "MetalFX: {which} texture MTLTextureUsage {has:#x} lacks required {needed:#x}"
            ),
            Self::BadSize { which, expected, got } => {
                write!(f, "MetalFX: {which} size {got:?} != scaler {expected:?}")
            }
            Self::CreateFailed(w) => write!(f, "MetalFX: {w} creation returned nil"),
            Self::NoCommandBuffer => write!(f, "MetalFX: queue returned no command buffer"),
        }
    }
}
impl std::error::Error for MetalFxError {}

pub fn mtl_format(f: wgpu::TextureFormat) -> Result<MTLPixelFormat, MetalFxError> {
    use wgpu::TextureFormat as T;
    Ok(match f {
        T::Rgba8Unorm => MTLPixelFormat::RGBA8Unorm,
        T::Rgba8UnormSrgb => MTLPixelFormat::RGBA8Unorm_sRGB,
        T::Bgra8Unorm => MTLPixelFormat::BGRA8Unorm,
        T::Bgra8UnormSrgb => MTLPixelFormat::BGRA8Unorm_sRGB,
        T::Rgba16Float => MTLPixelFormat::RGBA16Float,
        T::Rg11b10Ufloat => MTLPixelFormat::RG11B10Float,
        T::Rgb10a2Unorm => MTLPixelFormat::RGB10A2Unorm,
        T::Rg16Float => MTLPixelFormat::RG16Float,
        T::Depth32Float => MTLPixelFormat::Depth32Float,
        T::Depth16Unorm => MTLPixelFormat::Depth16Unorm,
        other => return Err(MetalFxError::UnsupportedFormat(other)),
    })
}

fn raw_device(device: &wgpu::Device) -> Result<Retained<ProtocolObject<dyn MTLDevice>>, MetalFxError> {
    let hal = unsafe { device.as_hal::<Metal>() }.ok_or(MetalFxError::NotMetalBackend("device"))?;
    Ok(hal.raw_device().clone())
}

fn raw_queue(queue: &wgpu::Queue) -> Result<Retained<ProtocolObject<dyn MTLCommandQueue>>, MetalFxError> {
    let hal = unsafe { queue.as_hal::<Metal>() }.ok_or(MetalFxError::NotMetalBackend("queue"))?;
    Ok(hal.as_raw().retain())
}

fn raw_texture(t: &wgpu::Texture, which: &'static str) -> Result<Retained<ProtocolObject<dyn MTLTexture>>, MetalFxError> {
    let hal = unsafe { t.as_hal::<Metal>() }.ok_or(MetalFxError::NotMetalBackend(which))?;
    Ok(hal.raw_handle().retain())
}

fn check_tex(
    t: &ProtocolObject<dyn MTLTexture>,
    which: &'static str,
    needed: MTLTextureUsage,
    size: (u32, u32),
) -> Result<(), MetalFxError> {
    let has = t.usage();
    if !has.contains(needed) {
        return Err(MetalFxError::BadUsage { which, needed: needed.0 as u64, has: has.0 as u64 });
    }
    let got = (t.width() as u32, t.height() as u32);
    if got != size {
        return Err(MetalFxError::BadSize { which, expected: size, got });
    }
    Ok(())
}

/// GPU time of one committed command buffer (Metal GPUStartTime/GPUEndTime).
pub struct GpuTiming {
    cb: Retained<ProtocolObject<dyn MTLCommandBuffer>>,
}
impl GpuTiming {
    /// Blocks until the command buffer completes; returns GPU ms.
    pub fn wait_ms(&self) -> f64 {
        self.cb.waitUntilCompleted();
        (self.cb.GPUEndTime() - self.cb.GPUStartTime()) * 1000.0
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ScalerConfig {
    pub input_size: (u32, u32),
    pub output_size: (u32, u32),
    pub color_format: wgpu::TextureFormat,
    pub output_format: wgpu::TextureFormat,
}

// ---------------------------------------------------------------- spatial

pub struct SpatialUpscaler {
    cfg: ScalerConfig,
    scaler: Retained<ProtocolObject<dyn MTLFXSpatialScaler>>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    color_usage: MTLTextureUsage,
    output_usage: MTLTextureUsage,
    last: Option<GpuTiming>,
}

impl SpatialUpscaler {
    pub fn is_supported(device: &wgpu::Device) -> Result<bool, MetalFxError> {
        let d = raw_device(device)?;
        Ok(unsafe { MTLFXSpatialScalerDescriptor::supportsDevice(&d) })
    }

    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, cfg: ScalerConfig) -> Result<Self, MetalFxError> {
        let d = raw_device(device)?;
        if !unsafe { MTLFXSpatialScalerDescriptor::supportsDevice(&d) } {
            return Err(MetalFxError::Unsupported("MTLFXSpatialScaler"));
        }
        let desc = unsafe { MTLFXSpatialScalerDescriptor::new() };
        let srgb_like = matches!(
            cfg.color_format,
            wgpu::TextureFormat::Rgba8UnormSrgb | wgpu::TextureFormat::Bgra8UnormSrgb
        );
        unsafe {
            desc.setColorTextureFormat(mtl_format(cfg.color_format)?);
            desc.setOutputTextureFormat(mtl_format(cfg.output_format)?);
            desc.setInputWidth(cfg.input_size.0 as usize);
            desc.setInputHeight(cfg.input_size.1 as usize);
            desc.setOutputWidth(cfg.output_size.0 as usize);
            desc.setOutputHeight(cfg.output_size.1 as usize);
            // 8-bit UNORM display-referred content → Perceptual; float HDR → HDR mode.
            desc.setColorProcessingMode(match cfg.color_format {
                wgpu::TextureFormat::Rgba16Float | wgpu::TextureFormat::Rg11b10Ufloat => {
                    MTLFXSpatialScalerColorProcessingMode::HDR
                }
                _ if srgb_like => MTLFXSpatialScalerColorProcessingMode::Linear,
                _ => MTLFXSpatialScalerColorProcessingMode::Perceptual,
            });
        }
        let scaler = unsafe { desc.newSpatialScalerWithDevice(&d) }
            .ok_or(MetalFxError::CreateFailed("MTLFXSpatialScaler"))?;
        let (color_usage, output_usage) = unsafe { (scaler.colorTextureUsage(), scaler.outputTextureUsage()) };
        Ok(Self { cfg, scaler, queue: raw_queue(queue)?, color_usage, output_usage, last: None })
    }

    /// MTLTextureUsage bits the scaler demands (for choosing wgpu usages).
    pub fn required_usages(&self) -> (u64, u64) {
        (self.color_usage.0 as u64, self.output_usage.0 as u64)
    }

    pub fn config(&self) -> ScalerConfig {
        self.cfg
    }

    /// Timing handle of the most recent `upscale` (None before first call).
    pub fn last_timing(&self) -> Option<&GpuTiming> {
        self.last.as_ref()
    }
}

impl SpatialUpscaler {
    /// Commit the upscale in its own MTLCommandBuffer; `input` must be submitted already.
    pub fn upscale(&mut self, input: &wgpu::Texture, output: &wgpu::Texture) -> Result<(), MetalFxError> {
        let i = raw_texture(input, "input")?;
        let o = raw_texture(output, "output")?;
        check_tex(&i, "input", self.color_usage, self.cfg.input_size)?;
        check_tex(&o, "output", self.output_usage, self.cfg.output_size)?;
        let cb = self.queue.commandBuffer().ok_or(MetalFxError::NoCommandBuffer)?;
        unsafe {
            self.scaler.setColorTexture(Some(&i));
            self.scaler.setOutputTexture(Some(&o));
            self.scaler.setInputContentWidth(self.cfg.input_size.0 as usize);
            self.scaler.setInputContentHeight(self.cfg.input_size.1 as usize);
            self.scaler.encodeToCommandBuffer(&cb);
        }
        cb.commit();
        self.last = Some(GpuTiming { cb });
        Ok(())
    }
}

// ---------------------------------------------------------------- temporal

/// Per-frame temporal inputs. Jitter in INPUT pixels, range [-0.5, 0.5].
/// Motion vectors in input pixels unless `motion_scale` says otherwise.
pub struct TemporalFrame<'a> {
    pub depth: &'a wgpu::Texture,
    pub motion: &'a wgpu::Texture,
    pub jitter: (f32, f32),
    pub motion_scale: (f32, f32),
    pub reset: bool,
}

pub struct TemporalUpscaler {
    cfg: ScalerConfig,
    scaler: Retained<ProtocolObject<dyn MTLFXTemporalScaler>>,
    queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    usages: [MTLTextureUsage; 4], // color, depth, motion, output
    last: Option<GpuTiming>,
}

impl TemporalUpscaler {
    pub fn is_supported(device: &wgpu::Device) -> Result<bool, MetalFxError> {
        let d = raw_device(device)?;
        Ok(unsafe { MTLFXTemporalScalerDescriptor::supportsDevice(&d) })
    }

    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        cfg: ScalerConfig,
        depth_format: wgpu::TextureFormat,
        motion_format: wgpu::TextureFormat,
        depth_reversed: bool,
    ) -> Result<Self, MetalFxError> {
        let d = raw_device(device)?;
        if !unsafe { MTLFXTemporalScalerDescriptor::supportsDevice(&d) } {
            return Err(MetalFxError::Unsupported("MTLFXTemporalScaler"));
        }
        let desc = unsafe { MTLFXTemporalScalerDescriptor::new() };
        unsafe {
            desc.setColorTextureFormat(mtl_format(cfg.color_format)?);
            desc.setOutputTextureFormat(mtl_format(cfg.output_format)?);
            desc.setDepthTextureFormat(mtl_format(depth_format)?);
            desc.setMotionTextureFormat(mtl_format(motion_format)?);
            desc.setInputWidth(cfg.input_size.0 as usize);
            desc.setInputHeight(cfg.input_size.1 as usize);
            desc.setOutputWidth(cfg.output_size.0 as usize);
            desc.setOutputHeight(cfg.output_size.1 as usize);
            desc.setAutoExposureEnabled(true);
        }
        let scaler = unsafe { desc.newTemporalScalerWithDevice(&d) }
            .ok_or(MetalFxError::CreateFailed("MTLFXTemporalScaler"))?;
        unsafe { scaler.setDepthReversed(depth_reversed) };
        let usages = unsafe {
            [
                scaler.colorTextureUsage(),
                scaler.depthTextureUsage(),
                scaler.motionTextureUsage(),
                scaler.outputTextureUsage(),
            ]
        };
        Ok(Self { cfg, scaler, queue: raw_queue(queue)?, usages, last: None })
    }

    pub fn last_timing(&self) -> Option<&GpuTiming> {
        self.last.as_ref()
    }

    pub fn upscale_frame(
        &mut self,
        input: &wgpu::Texture,
        output: &wgpu::Texture,
        frame: &TemporalFrame<'_>,
    ) -> Result<(), MetalFxError> {
        let c = raw_texture(input, "color")?;
        let dp = raw_texture(frame.depth, "depth")?;
        let mv = raw_texture(frame.motion, "motion")?;
        let o = raw_texture(output, "output")?;
        check_tex(&c, "color", self.usages[0], self.cfg.input_size)?;
        check_tex(&dp, "depth", self.usages[1], self.cfg.input_size)?;
        check_tex(&mv, "motion", self.usages[2], self.cfg.input_size)?;
        check_tex(&o, "output", self.usages[3], self.cfg.output_size)?;
        let cb = self.queue.commandBuffer().ok_or(MetalFxError::NoCommandBuffer)?;
        unsafe {
            self.scaler.setColorTexture(Some(&c));
            self.scaler.setDepthTexture(Some(&dp));
            self.scaler.setMotionTexture(Some(&mv));
            self.scaler.setOutputTexture(Some(&o));
            self.scaler.setInputContentWidth(self.cfg.input_size.0 as usize);
            self.scaler.setInputContentHeight(self.cfg.input_size.1 as usize);
            self.scaler.setJitterOffsetX(frame.jitter.0);
            self.scaler.setJitterOffsetY(frame.jitter.1);
            self.scaler.setMotionVectorScaleX(frame.motion_scale.0);
            self.scaler.setMotionVectorScaleY(frame.motion_scale.1);
            self.scaler.setReset(frame.reset);
            self.scaler.encodeToCommandBuffer(&cb);
        }
        cb.commit();
        self.last = Some(GpuTiming { cb });
        Ok(())
    }
}

/// wgpu lazily zero-initialises textures it has never seen written. MetalFX
/// writes `output` OUTSIDE wgpu's tracking, so the first wgpu read (copy /
/// sample) of a never-wgpu-written output would be zero-cleared OVER the
/// MetalFX result. Call once per output texture (before the first upscale):
/// a clear pass marks it initialised. Requires RENDER_ATTACHMENT usage, which
/// MetalFX demands on the output anyway.
pub fn mark_output_initialized(device: &wgpu::Device, queue: &wgpu::Queue, output: &wgpu::Texture) {
    let view = output.create_view(&Default::default());
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("metalfx-output-init") });
    drop(enc.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("metalfx-output-init"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &view,
            resolve_target: None,
            depth_slice: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    }));
    queue.submit([enc.finish()]);
}

// ------------------------------------------------- gaia-render integration
/// `gaia_render::Upscaler` (Queue mode) backed by `MTLFXSpatialScaler`.
/// Scaler is rebuilt on every `resize` (MetalFX sizes are fixed at creation).
pub struct MetalFxSpatial {
    queue: wgpu::Queue,
    output_format: wgpu::TextureFormat,
    scaler: Option<SpatialUpscaler>,
    error: Option<String>,
    initialized_output: Option<wgpu::Texture>,
}
// Metal objects (MTLFXSpatialScaler, MTLCommandQueue/Buffer) are thread-safe to
// hand between threads; the renderer uses this from exactly one render thread.
unsafe impl Send for MetalFxSpatial {}
impl MetalFxSpatial {
    /// Loud Err when the device is not Metal or MetalFX spatial is unsupported.
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue, output_format: wgpu::TextureFormat) -> Result<Self, MetalFxError> {
        if !SpatialUpscaler::is_supported(device)? {
            return Err(MetalFxError::Unsupported("MTLFXSpatialScaler"));
        }
        // MetalFX spatial rejects every sRGB format (format_probe) → raw UNORM storage;
        // the caller's output texture must be created in this format (sRGB view allowed).
        let output_format = output_format.remove_srgb_suffix();
        mtl_format(output_format)?;
        Ok(Self { queue: queue.clone(), output_format, scaler: None, error: None, initialized_output: None })
    }
}
impl gaia_render::Upscaler for MetalFxSpatial {
    fn name(&self) -> &str {
        "metalfx-spatial"
    }
    fn submit_mode(&self) -> gaia_render::UpscaleSubmit {
        gaia_render::UpscaleSubmit::Queue
    }
    fn output_usage(&self) -> wgpu::TextureUsages {
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING
    }
    fn resize(&mut self, device: &wgpu::Device, input: gaia_render::UpscaleSize, output: gaia_render::UpscaleSize) {
        let cfg = ScalerConfig {
            input_size: (input.width, input.height),
            output_size: (output.width, output.height),
            color_format: gaia_render::INTERNAL_STORAGE_FORMAT,
            output_format: self.output_format,
        };
        match SpatialUpscaler::new(device, &self.queue, cfg) {
            Ok(s) => {
                self.scaler = Some(s);
                self.error = None;
            }
            Err(e) => {
                self.scaler = None;
                self.error = Some(e.to_string());
            }
        }
        self.initialized_output = None;
    }
    fn upscale(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        input: gaia_render::UpscaleInput<'_>,
        output: &wgpu::Texture,
    ) -> Result<(), gaia_render::UpscaleError> {
        if let Some(e) = &self.error {
            return Err(gaia_render::UpscaleError(e.clone()));
        }
        let scaler = self.scaler.as_mut().ok_or_else(|| gaia_render::UpscaleError("metalfx-spatial: upscale before resize".into()))?;
        if self.initialized_output.as_ref() != Some(output) {
            mark_output_initialized(device, queue, output); // §TRAP: wgpu lazy zero-init
            self.initialized_output = Some(output.clone());
        }
        scaler.upscale(input.color, output).map_err(|e| gaia_render::UpscaleError(e.to_string()))
    }
    fn last_gpu_ms_blocking(&self) -> Option<f64> {
        self.scaler.as_ref()?.last_timing().map(|t| t.wait_ms())
    }
}
