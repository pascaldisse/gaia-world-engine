//! lane nt-gi: GPU-free validation of the native probe-GI compute shader (naga parse + full validation). `cargo run -p gaia-render --example gi_compute_validate`.
//! Prints the entry points + the Params uniform size; exits non-zero on any parse/validation error. Does NOT run the shader (no device).
fn main() {
    let src = include_str!("../src/gi_compute.wgsl");
    let module = match naga::front::wgsl::parse_str(src) {
        Ok(m) => m,
        Err(e) => { eprintln!("{}", e.emit_to_string(src)); std::process::exit(1) }
    };
    let info = match naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::all()).validate(&module) {
        Ok(i) => i,
        Err(e) => { eprintln!("{}", e.emit_to_string(src)); std::process::exit(1) }
    };
    let _ = info;
    for (_, t) in module.types.iter() {
        if let (Some(n), naga::TypeInner::Struct { span, .. }) = (&t.name, &t.inner) { if n == "Params" { println!("uniform Params span = {span} bytes (gi_compute.rs GcUniform must match)"); } }
    }
    for ep in &module.entry_points { println!("entry {} stage={:?} workgroup={:?}", ep.name, ep.stage, ep.workgroup_size); }
    for (_, g) in module.global_variables.iter() {
        if let (Some(name), Some(b)) = (&g.name, &g.binding) { println!("binding @group({}) @binding({}) {} {:?}", b.group, b.binding, name, g.space); }
    }
}
