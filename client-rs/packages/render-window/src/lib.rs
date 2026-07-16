use gaia_core::{Core, GaiaPackage, PackageManifest};

pub const PACKAGE_NAME: &str = "render-window";
pub const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct RenderWindowPackage;

impl GaiaPackage for RenderWindowPackage {
    fn register(&self, core: &mut Core) {
        core.register_package(PackageManifest::new(PACKAGE_NAME, PACKAGE_VERSION));
    }
}
