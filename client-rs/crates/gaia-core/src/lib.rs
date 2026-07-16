//! DreamForge's Terry-sized core: ECS, data protocol, scheduler, and packages.

pub mod command_buffer;
pub mod component;
pub mod protocol;
pub mod scheduler;
pub mod world;
pub mod world_loading;

pub use command_buffer::{DeferredEntity, EcbPlaybackBoundary, EntityCommandBuffer, EntityTarget};
pub use component::{
    component_default, ComponentDescriptor, ComponentId, ComponentType, FieldDescriptor, FieldSpec,
    FieldType,
};
pub use protocol::*;
pub use scheduler::{
    ItemOptions, ScheduleOptions, Scheduler, SystemContext, DEFAULT_FIXED_DELTA,
    DEFAULT_MAX_FIXED_STEPS, FIXED, INITIALIZATION, PRESENTATION, SIMULATION,
};
pub use world::{EcsWorld, Entity, QuerySpec, WorldOptions, DEFAULT_ARCHETYPE_CAPACITY};
pub use world_loading::{load_world_dir, LoadedWorld};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PACKAGE_MANIFEST_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageManifest {
    pub manifest_version: u32,
    pub name: String,
    pub version: String,
}

impl PackageManifest {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            manifest_version: PACKAGE_MANIFEST_VERSION,
            name: name.into(),
            version: version.into(),
        }
    }
}

pub trait GaiaPackage {
    fn register(&self, core: &mut Core);
}

pub struct Core {
    pub world: EcsWorld,
    packages: BTreeMap<String, PackageManifest>,
}

impl Default for Core {
    fn default() -> Self {
        Self::new(WorldOptions::default())
    }
}

impl Core {
    pub fn new(options: WorldOptions) -> Self {
        Self {
            world: EcsWorld::new(options),
            packages: BTreeMap::new(),
        }
    }

    pub fn install(&mut self, package: &dyn GaiaPackage) {
        package.register(self);
    }

    pub fn register_package(&mut self, manifest: PackageManifest) {
        self.packages.insert(manifest.name.clone(), manifest);
    }

    pub fn package(&self, name: &str) -> Option<&PackageManifest> {
        self.packages.get(name)
    }

    pub fn packages(&self) -> impl Iterator<Item = &PackageManifest> {
        self.packages.values()
    }
}

#[cfg(test)]
mod package_tests {
    use super::*;

    struct TestPackage;

    impl GaiaPackage for TestPackage {
        fn register(&self, core: &mut Core) {
            core.register_package(PackageManifest::new("test", "1.2.3"));
        }
    }

    #[test]
    fn package_registers_versioned_manifest() {
        let mut core = Core::default();
        core.install(&TestPackage);
        assert_eq!(core.package("test").unwrap().version, "1.2.3");
        assert_eq!(
            core.package("test").unwrap().manifest_version,
            PACKAGE_MANIFEST_VERSION
        );
    }
}
