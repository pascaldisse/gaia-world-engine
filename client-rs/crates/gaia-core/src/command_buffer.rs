use crate::{ComponentId, EcsWorld, Entity};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DeferredEntity(u32);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntityTarget {
    Entity(Entity),
    Deferred(DeferredEntity),
}
impl From<Entity> for EntityTarget {
    fn from(value: Entity) -> Self {
        Self::Entity(value)
    }
}
impl From<DeferredEntity> for EntityTarget {
    fn from(value: DeferredEntity) -> Self {
        Self::Deferred(value)
    }
}

enum Command {
    Create {
        deferred: DeferredEntity,
        components: Vec<(ComponentId, Value)>,
    },
    Destroy(EntityTarget),
    Add(EntityTarget, ComponentId, Value),
    Remove(EntityTarget, ComponentId),
    Set(EntityTarget, ComponentId, Value),
    Enable(EntityTarget, ComponentId, bool),
}

pub struct EntityCommandBuffer {
    commands: Vec<Command>,
    next_deferred: u32,
}
impl Default for EntityCommandBuffer {
    fn default() -> Self {
        Self::new()
    }
}
impl EntityCommandBuffer {
    pub fn new() -> Self {
        Self {
            commands: vec![],
            next_deferred: 0,
        }
    }
    pub fn create_entity(&mut self, components: Vec<(ComponentId, Value)>) -> DeferredEntity {
        let deferred = DeferredEntity(self.next_deferred);
        self.next_deferred += 1;
        self.commands.push(Command::Create {
            deferred,
            components,
        });
        deferred
    }
    pub fn destroy_entity(&mut self, entity: impl Into<EntityTarget>) {
        self.commands.push(Command::Destroy(entity.into()));
    }
    pub fn add_component(
        &mut self,
        entity: impl Into<EntityTarget>,
        component: ComponentId,
        value: Value,
    ) {
        self.commands
            .push(Command::Add(entity.into(), component, value));
    }
    pub fn remove_component(&mut self, entity: impl Into<EntityTarget>, component: ComponentId) {
        self.commands
            .push(Command::Remove(entity.into(), component));
    }
    pub fn set_component(
        &mut self,
        entity: impl Into<EntityTarget>,
        component: ComponentId,
        value: Value,
    ) {
        self.commands
            .push(Command::Set(entity.into(), component, value));
    }
    pub fn set_component_enabled(
        &mut self,
        entity: impl Into<EntityTarget>,
        component: ComponentId,
        enabled: bool,
    ) {
        self.commands
            .push(Command::Enable(entity.into(), component, enabled));
    }
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
    pub fn playback(
        &mut self,
        world: &mut EcsWorld,
    ) -> Result<HashMap<DeferredEntity, Entity>, String> {
        let mut deferred = HashMap::new();
        for command in self.commands.drain(..) {
            let resolve = |target: EntityTarget, map: &HashMap<DeferredEntity, Entity>| match target
            {
                EntityTarget::Entity(entity) => Some(entity),
                EntityTarget::Deferred(entity) => map.get(&entity).copied(),
            };
            match command {
                Command::Create {
                    deferred: placeholder,
                    components,
                } => {
                    deferred.insert(placeholder, world.create_entity(components)?);
                }
                Command::Destroy(target) => world.destroy_entity(
                    resolve(target, &deferred).ok_or("unresolved deferred entity")?,
                )?,
                Command::Add(target, type_id, value) => world.add_component(
                    resolve(target, &deferred).ok_or("unresolved deferred entity")?,
                    type_id,
                    value,
                )?,
                Command::Remove(target, type_id) => world.remove_component(
                    resolve(target, &deferred).ok_or("unresolved deferred entity")?,
                    type_id,
                )?,
                Command::Set(target, type_id, value) => world.set_component(
                    resolve(target, &deferred).ok_or("unresolved deferred entity")?,
                    type_id,
                    value,
                )?,
                Command::Enable(target, type_id, enabled) => world.set_component_enabled(
                    resolve(target, &deferred).ok_or("unresolved deferred entity")?,
                    type_id,
                    enabled,
                )?,
            }
        }
        Ok(deferred)
    }
}

/// Explicit structural apply-point; queues buffers and replays in creation order.
pub struct EcbPlaybackBoundary {
    pub name: String,
    pending: Vec<EntityCommandBuffer>,
    pub playback_count: u64,
}
impl EcbPlaybackBoundary {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            pending: vec![],
            playback_count: 0,
        }
    }
    pub fn create_command_buffer(&mut self) -> &mut EntityCommandBuffer {
        self.pending.push(EntityCommandBuffer::new());
        self.pending.last_mut().unwrap()
    }
    pub fn playback(&mut self, world: &mut EcsWorld) -> Result<(), String> {
        for buffer in &mut self.pending {
            buffer.playback(world)?;
        }
        self.playback_count += self.pending.len() as u64;
        self.pending.clear();
        Ok(())
    }
}
