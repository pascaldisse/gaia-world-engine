//! Test pattern @ IN → MetalFX spatial → OUT, readback PNG + GPU timing.
//! Args: [out_dir] [iters]  (defaults: ./.scratch, 30). Sizes via env
//! GAIA_MFX_IN=1108x720 GAIA_MFX_OUT=3024x1964.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("gaia-metalfx spatial_bench: macOS only");
}

#[cfg(target_os = "macos")]
fn main() {
    use gaia_metalfx::{ScalerConfig, SpatialUpscaler, TemporalUpscaler, Upscaler};

    fn parse(s: &str) -> (u32, u32) {
        let (w, h) = s.split_once('x').expect("WxH");
        (w.parse().unwrap(), h.parse().unwrap())
    }
    let input_size = parse(&std::env::var("GAIA_MFX_IN").unwrap_or("1108x720".into()));
    let output_size = parse(&std::env::var("GAIA_MFX_OUT").unwrap_or("3024x1964".into()));
    let mut args = std::env::args().skip(1);
    let out_dir = std::path::PathBuf::from(args.next().unwrap_or(".scratch".into()));
    let iters: usize = args.next().map(|s| s.parse().unwrap()).unwrap_or(30);
    std::fs::create_dir_all(&out_dir).unwrap();

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::METAL,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .expect("metal adapter");
    println!("adapter: {}", adapter.get_info().name);
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).expect("device");

    println!("supportsDevice spatial={} temporal={}",
        SpatialUpscaler::is_supported(&device).unwrap(),
        TemporalUpscaler::is_supported(&device).unwrap());

    let fmt = wgpu::TextureFormat::Rgba8Unorm;
    let cfg = ScalerConfig { input_size, output_size, color_format: fmt, output_format: fmt };
    let mut up = SpatialUpscaler::new(&device, &queue, cfg).unwrap_or_else(|e| panic!("{e}"));
    let (cu, ou) = up.required_usages();
    println!("scaler requires MTLTextureUsage color={cu:#x} output={ou:#x} (1=ShaderRead 2=ShaderWrite 4=RenderTarget)");

    let tex = |label, (w, h): (u32, u32), usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: fmt,
            usage,
            view_formats: &[],
        })
    };
    use wgpu::TextureUsages as U;
    let input = tex("mfx-in", input_size, U::RENDER_ATTACHMENT | U::TEXTURE_BINDING | U::COPY_SRC);
    let output = tex("mfx-out", output_size,
        U::RENDER_ATTACHMENT | U::TEXTURE_BINDING | U::STORAGE_BINDING | U::COPY_SRC);

    // Test pattern: checkerboard + thin lines + circles + gradient (aliasing-sensitive).
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("pattern"),
        source: wgpu::ShaderSource::Wgsl(r#"
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let p = pos.xy;
    let c = (u32(p.x / 32.0) + u32(p.y / 32.0)) % 2u;
    var col = select(vec3<f32>(0.15), vec3<f32>(0.85), c == 1u);
    col = mix(col, vec3<f32>(p.x / 1108.0, p.y / 720.0, 0.5), 0.35);
    if (u32(p.x) % 97u == 0u || u32(p.y) % 89u == 0u) { col = vec3<f32>(1.0, 0.1, 0.1); }
    let d = length(p - vec2<f32>(554.0, 360.0));
    if (abs(fract(d / 24.0) - 0.5) < 0.04) { col = vec3<f32>(0.0, 0.0, 0.0); }
    let diag = abs(p.x - p.y * 1.5389) ;
    if (diag < 0.7) { col = vec3<f32>(0.1, 1.0, 0.2); }
    return vec4<f32>(col, 1.0);
}
"#.into()),
    });
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("pattern"),
        layout: None,
        vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState {
            module: &shader, entry_point: Some("fs"),
            targets: &[Some(fmt.into())], compilation_options: Default::default(),
        }),
        primitive: Default::default(),
        depth_stencil: None,
        multisample: Default::default(),
        multiview_mask: None,
        cache: None,
    });
    let view = input.create_view(&Default::default());
    let mut enc = device.create_command_encoder(&Default::default());
    {
        let mut rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("pattern"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        rp.set_pipeline(&pipe);
        rp.draw(0..3, 0..1);
    }
    queue.submit([enc.finish()]);
    gaia_metalfx::mark_output_initialized(&device, &queue, &output);

    // Warm-up + timed runs (each its own command buffer, GPUStart/EndTime).
    let mut ms = Vec::with_capacity(iters);
    for k in 0..iters + 3 {
        up.upscale(&queue, &input, &output).unwrap_or_else(|e| panic!("{e}"));
        let t = up.last_timing().unwrap().wait_ms();
        if k >= 3 { ms.push(t); }
    }
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let med = ms[ms.len() / 2];
    println!("spatial {}x{} -> {}x{}: GPU ms median={:.3} min={:.3} max={:.3} (n={})",
        input_size.0, input_size.1, output_size.0, output_size.1, med, ms[0], ms[ms.len() - 1], ms.len());

    // Readback both.
    let save = |t: &wgpu::Texture, (w, h): (u32, u32), name: &str| {
        let bpr = (w * 4 + 255) / 256 * 256;
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: None, size: (bpr * h) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            t.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &buf, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(bpr), rows_per_image: Some(h) } },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        queue.submit([enc.finish()]);
        buf.slice(..).map_async(wgpu::MapMode::Read, |r| r.unwrap());
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let data = buf.slice(..).get_mapped_range().expect("map range");
        let mut px = Vec::with_capacity((w * h * 4) as usize);
        for row in 0..h { let s = (row * bpr) as usize; px.extend_from_slice(&data[s..s + (w * 4) as usize]); }
        let path = out_dir.join(name);
        let f = std::io::BufWriter::new(std::fs::File::create(&path).unwrap());
        let mut e = png::Encoder::new(f, w, h);
        e.set_color(png::ColorType::Rgba);
        e.set_depth(png::BitDepth::Eight);
        e.write_header().unwrap().write_image_data(&px).unwrap();
        let nonzero = px.chunks(4).filter(|p| p[0] | p[1] | p[2] != 0).count();
        println!("wrote {} ({} non-black px of {})", path.display(), nonzero, w * h);
    };
    // Temporal probe: zero motion, cleared depth, static jitter sequence.
    {
        use gaia_metalfx::TemporalFrame;
        let mut tu = TemporalUpscaler::new(&device, &queue, cfg, wgpu::TextureFormat::Depth32Float, wgpu::TextureFormat::Rg16Float, false)
            .unwrap_or_else(|e| panic!("{e}"));
        let mk = |label, f, usage| device.create_texture(&wgpu::TextureDescriptor { label: Some(label),
            size: wgpu::Extent3d { width: input_size.0, height: input_size.1, depth_or_array_layers: 1 },
            mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: f, usage, view_formats: &[] });
        let depth = mk("depth", wgpu::TextureFormat::Depth32Float, U::RENDER_ATTACHMENT | U::TEXTURE_BINDING);
        let motion = mk("motion", wgpu::TextureFormat::Rg16Float, U::RENDER_ATTACHMENT | U::TEXTURE_BINDING);
        let tout = tex("mfx-tout", output_size, U::RENDER_ATTACHMENT | U::TEXTURE_BINDING | U::STORAGE_BINDING | U::COPY_SRC);
        let mut enc = device.create_command_encoder(&Default::default());
        { let dv = depth.create_view(&Default::default()); let mv = motion.create_view(&Default::default());
          let _rp = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &mv, resolve_target: None, depth_slice: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store } })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &dv,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
            ..Default::default() }); }
        queue.submit([enc.finish()]);
        gaia_metalfx::mark_output_initialized(&device, &queue, &tout);
        let jit = [(0.0f32, -0.1666), (-0.25, 0.1666), (0.25, -0.3888), (-0.375, -0.0555)];
        let mut tms = Vec::new();
        for k in 0..iters + 3 {
            let f = TemporalFrame { depth: &depth, motion: &motion, jitter: jit[k % 4], motion_scale: (1.0, 1.0), reset: k == 0 };
            tu.upscale_frame(&input, &tout, &f).unwrap_or_else(|e| panic!("{e}"));
            let t = tu.last_timing().unwrap().wait_ms();
            if k >= 3 { tms.push(t); }
        }
        tms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("temporal {}x{} -> {}x{}: GPU ms median={:.3} min={:.3} max={:.3} (n={})",
            input_size.0, input_size.1, output_size.0, output_size.1, tms[tms.len() / 2], tms[0], tms[tms.len() - 1], tms.len());
        save(&tout, output_size, "metalfx_temporal_output.png");
    }
    save(&input, input_size, "metalfx_input.png");
    save(&output, output_size, "metalfx_spatial_output.png");
}
