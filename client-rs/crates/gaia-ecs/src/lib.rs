//! GAIA reference ECS port: runtime component schemas, archetype/SoA storage,
//! generational entities, deferred structural playback, and DAG scheduler.
pub mod command_buffer;
pub mod component;
pub mod scheduler;
pub mod world;

pub use command_buffer::{DeferredEntity, EcbPlaybackBoundary, EntityCommandBuffer, EntityTarget};
pub use component::{
    component_default, ComponentDescriptor, ComponentId, ComponentType, FieldDescriptor, FieldSpec,
    FieldType,
};
pub use scheduler::{
    ItemOptions, ScheduleOptions, Scheduler, SystemContext, DEFAULT_FIXED_DELTA,
    DEFAULT_MAX_FIXED_STEPS, FIXED, INITIALIZATION, PRESENTATION, SIMULATION,
};
pub use world::{EcsWorld, Entity, QuerySpec, WorldOptions, DEFAULT_ARCHETYPE_CAPACITY};
