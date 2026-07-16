use crate::component::{
    component_default, ComponentColumn, ComponentDescriptor, ComponentId, ComponentType,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

pub const DEFAULT_ARCHETYPE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Entity {
    pub index: u32,
    pub generation: u32,
}

#[derive(Clone, Debug, Default)]
pub struct QuerySpec {
    pub all: Vec<ComponentId>,
    pub any: Vec<ComponentId>,
    pub none: Vec<ComponentId>,
    pub include_disabled: bool,
}

#[derive(Clone)]
struct Location {
    archetype: Vec<ComponentId>,
    row: usize,
}
struct Slot {
    generation: u32,
    location: Option<Location>,
}
struct Archetype {
    types: Vec<ComponentId>,
    entities: Vec<Entity>,
    columns: HashMap<ComponentId, ComponentColumn>,
    capacity: usize,
}
impl Archetype {
    fn new(
        types: Vec<ComponentId>,
        capacity: usize,
        registry: &HashMap<ComponentId, ComponentType>,
    ) -> Self {
        let columns = types
            .iter()
            .map(|id| (*id, ComponentColumn::new(&registry[id], capacity)))
            .collect();
        Self {
            types,
            entities: Vec::with_capacity(capacity),
            columns,
            capacity,
        }
    }
    fn reserve(&mut self) {
        if self.entities.len() < self.capacity {
            return;
        }
        self.capacity *= 2;
        for column in self.columns.values_mut() {
            column.grow(self.capacity);
        }
    }
}

pub struct EcsWorld {
    initial_capacity: usize,
    next_component: ComponentId,
    components: HashMap<ComponentId, ComponentType>,
    component_names: HashMap<String, ComponentId>,
    archetypes: HashMap<Vec<ComponentId>, Archetype>,
    slots: Vec<Slot>,
    free: Vec<u32>,
    gaia_to_ecs: HashMap<String, Entity>,
    ecs_to_gaia: HashMap<Entity, String>,
    resources: HashMap<String, Value>,
    pub structural_version: u64,
}
impl Default for EcsWorld {
    fn default() -> Self {
        Self::new(Default::default())
    }
}
#[derive(Clone, Copy, Debug)]
pub struct WorldOptions {
    pub initial_capacity: usize,
}
impl Default for WorldOptions {
    fn default() -> Self {
        Self {
            initial_capacity: DEFAULT_ARCHETYPE_CAPACITY,
        }
    }
}

impl EcsWorld {
    pub fn new(options: WorldOptions) -> Self {
        let mut world = Self {
            initial_capacity: options.initial_capacity.max(1),
            next_component: 1,
            components: HashMap::new(),
            component_names: HashMap::new(),
            archetypes: HashMap::new(),
            slots: vec![],
            free: vec![],
            gaia_to_ecs: HashMap::new(),
            ecs_to_gaia: HashMap::new(),
            resources: HashMap::new(),
            structural_version: 0,
        };
        world.ensure_archetype(vec![]);
        world
    }
    pub fn register_component(
        &mut self,
        descriptor: ComponentDescriptor,
    ) -> Result<ComponentId, String> {
        if descriptor.name.is_empty() {
            return Err("component name must be non-empty".into());
        }
        if self.component_names.contains_key(&descriptor.name) {
            return Err(format!("duplicate component {}", descriptor.name));
        }
        let id = self.next_component;
        self.next_component += 1;
        self.component_names.insert(descriptor.name.clone(), id);
        self.components.insert(id, ComponentType { id, descriptor });
        Ok(id)
    }
    pub fn register_component_json(&mut self, descriptor: &str) -> Result<ComponentId, String> {
        serde_json::from_str(descriptor)
            .map_err(|error| error.to_string())
            .and_then(|value| self.register_component(value))
    }
    pub fn component_id(&self, name: &str) -> Option<ComponentId> {
        self.component_names.get(name).copied()
    }
    pub fn component(&self, id: ComponentId) -> Option<&ComponentType> {
        self.components.get(&id)
    }
    pub fn create_entity(
        &mut self,
        components: Vec<(ComponentId, Value)>,
    ) -> Result<Entity, String> {
        let values: HashMap<_, _> = components.into_iter().collect();
        for id in values.keys() {
            self.require_component_type(*id)?;
        }
        let entity = self.allocate_entity();
        let types = normalized_types(values.keys().copied());
        let row = self.append(&types, entity, &values)?;
        self.slots[entity.index as usize].location = Some(Location {
            archetype: types,
            row,
        });
        self.structural_version += 1;
        Ok(entity)
    }
    pub fn create_entity_default(&mut self, types: Vec<ComponentId>) -> Result<Entity, String> {
        self.create_entity(
            types
                .into_iter()
                .map(|id| {
                    (
                        id,
                        component_default(
                            self.components
                                .get(&id)
                                .expect("component checked by create"),
                        ),
                    )
                })
                .collect(),
        )
    }
    pub fn exists(&self, entity: Entity) -> bool {
        self.slots
            .get(entity.index as usize)
            .is_some_and(|slot| slot.generation == entity.generation && slot.location.is_some())
    }
    pub fn destroy_entity(&mut self, entity: Entity) -> Result<(), String> {
        let location = self.location(entity)?.clone();
        self.remove_row(&location.archetype, location.row)?;
        self.slots[entity.index as usize].location = None;
        self.slots[entity.index as usize].generation =
            self.slots[entity.index as usize].generation.wrapping_add(1);
        self.free.push(entity.index);
        if let Some(id) = self.ecs_to_gaia.remove(&entity) {
            self.gaia_to_ecs.remove(&id);
        }
        self.structural_version += 1;
        Ok(())
    }
    pub fn has_component(&self, entity: Entity, component: ComponentId) -> bool {
        self.location(entity)
            .map(|location| location.archetype.binary_search(&component).is_ok())
            .unwrap_or(false)
    }
    pub fn get_component(&self, entity: Entity, component: ComponentId) -> Result<Value, String> {
        let location = self.location(entity)?;
        let ty = self.require_component_type(component)?;
        self.archetypes[&location.archetype]
            .columns
            .get(&component)
            .map(|column| column.get(ty, location.row))
            .ok_or_else(|| format!("entity {:?} lacks {}", entity, ty.name()))
    }
    pub fn set_component(
        &mut self,
        entity: Entity,
        component: ComponentId,
        value: Value,
    ) -> Result<(), String> {
        let location = self.location(entity)?.clone();
        let ty = self.require_component_type(component)?.clone();
        let column = self
            .archetypes
            .get_mut(&location.archetype)
            .unwrap()
            .columns
            .get_mut(&component)
            .ok_or_else(|| format!("entity {:?} lacks {}", entity, ty.name()))?;
        column.set(&ty, location.row, Some(&value));
        Ok(())
    }
    /// Reads one typed SoA field without materializing the rest of its component.
    pub fn get_component_field(
        &self,
        entity: Entity,
        component: ComponentId,
        field: &str,
    ) -> Result<Value, String> {
        let location = self.location(entity)?;
        let ty = self.require_component_type(component)?;
        if ty.descriptor.buffer {
            return Err(format!("{} is a buffer component", ty.name()));
        }
        self.archetypes[&location.archetype]
            .columns
            .get(&component)
            .and_then(|column| column.fields.get(field))
            .map(|column| column.get(location.row))
            .ok_or_else(|| format!("entity {:?} lacks {}.{}", entity, ty.name(), field))
    }
    /// Writes one typed SoA field without materializing the rest of its component.
    pub fn set_component_field(
        &mut self,
        entity: Entity,
        component: ComponentId,
        field: &str,
        value: Value,
    ) -> Result<(), String> {
        let location = self.location(entity)?.clone();
        let ty = self.require_component_type(component)?.clone();
        if ty.descriptor.buffer {
            return Err(format!("{} is a buffer component", ty.name()));
        }
        self.archetypes
            .get_mut(&location.archetype)
            .unwrap()
            .columns
            .get_mut(&component)
            .and_then(|column| column.fields.get_mut(field))
            .map(|column| column.set(location.row, &value))
            .ok_or_else(|| format!("entity {:?} lacks {}.{}", entity, ty.name(), field))
    }
    pub fn add_component(
        &mut self,
        entity: Entity,
        component: ComponentId,
        value: Value,
    ) -> Result<(), String> {
        let location = self.location(entity)?.clone();
        self.require_component_type(component)?;
        if location.archetype.binary_search(&component).is_ok() {
            return Err(format!(
                "entity {:?} already has component {}",
                entity, component
            ));
        }
        let mut target = location.archetype;
        target.push(component);
        self.move_entity(
            entity,
            normalized_types(target),
            HashMap::from([(component, value)]),
        )
    }
    pub fn remove_component(
        &mut self,
        entity: Entity,
        component: ComponentId,
    ) -> Result<(), String> {
        let location = self.location(entity)?.clone();
        if location.archetype.binary_search(&component).is_err() {
            return Err(format!("entity {:?} lacks component {}", entity, component));
        }
        self.move_entity(
            entity,
            location
                .archetype
                .into_iter()
                .filter(|id| *id != component)
                .collect(),
            HashMap::new(),
        )
    }
    pub fn set_component_enabled(
        &mut self,
        entity: Entity,
        component: ComponentId,
        enabled: bool,
    ) -> Result<(), String> {
        let location = self.location(entity)?.clone();
        let ty = self.require_component_type(component)?;
        if !ty.descriptor.enableable {
            return Err(format!("{} is not enableable", ty.name()));
        }
        self.archetypes
            .get_mut(&location.archetype)
            .unwrap()
            .columns
            .get_mut(&component)
            .unwrap()
            .enabled
            .as_mut()
            .unwrap()[location.row] = enabled;
        Ok(())
    }
    pub fn is_component_enabled(
        &self,
        entity: Entity,
        component: ComponentId,
    ) -> Result<bool, String> {
        let location = self.location(entity)?;
        let column = self.archetypes[&location.archetype]
            .columns
            .get(&component)
            .ok_or_else(|| format!("entity {:?} lacks component {}", entity, component))?;
        Ok(column
            .enabled
            .as_ref()
            .map(|values| values[location.row])
            .unwrap_or(true))
    }
    pub fn query(&self, spec: &QuerySpec) -> Vec<Entity> {
        self.archetypes
            .values()
            .flat_map(|archetype| {
                if !spec
                    .all
                    .iter()
                    .all(|id| archetype.types.binary_search(id).is_ok())
                    || (!spec.any.is_empty()
                        && !spec
                            .any
                            .iter()
                            .any(|id| archetype.types.binary_search(id).is_ok()))
                    || spec
                        .none
                        .iter()
                        .any(|id| archetype.types.binary_search(id).is_ok())
                {
                    return vec![];
                }
                archetype
                    .entities
                    .iter()
                    .enumerate()
                    .filter(|(row, _)| {
                        spec.include_disabled
                            || spec.all.iter().all(|id| {
                                archetype.columns[id]
                                    .enabled
                                    .as_ref()
                                    .map(|values| values[*row])
                                    .unwrap_or(true)
                            })
                    })
                    .map(|(_, entity)| *entity)
                    .collect()
            })
            .collect()
    }
    pub fn set_resource(&mut self, key: impl Into<String>, value: Value) {
        self.resources.insert(key.into(), value);
    }
    pub fn resource(&self, key: &str) -> Option<&Value> {
        self.resources.get(key)
    }
    pub fn bind_gaia_id(&mut self, id: impl Into<String>, entity: Entity) -> Result<(), String> {
        self.location(entity)?;
        let id = id.into();
        if let Some(old) = self.gaia_to_ecs.insert(id.clone(), entity) {
            self.ecs_to_gaia.remove(&old);
        }
        if let Some(old) = self.ecs_to_gaia.insert(entity, id.clone()) {
            self.gaia_to_ecs.remove(&old);
        }
        Ok(())
    }
    pub fn entity_for_gaia(&self, id: &str) -> Option<Entity> {
        self.gaia_to_ecs
            .get(id)
            .copied()
            .filter(|entity| self.exists(*entity))
    }
    pub fn gaia_id_for(&self, entity: Entity) -> Option<&str> {
        self.ecs_to_gaia.get(&entity).map(String::as_str)
    }
    fn allocate_entity(&mut self) -> Entity {
        if let Some(index) = self.free.pop() {
            let slot = &self.slots[index as usize];
            Entity {
                index,
                generation: slot.generation,
            }
        } else {
            let index = self.slots.len() as u32;
            self.slots.push(Slot {
                generation: 0,
                location: None,
            });
            Entity {
                index,
                generation: 0,
            }
        }
    }
    fn ensure_archetype(&mut self, types: Vec<ComponentId>) {
        if !self.archetypes.contains_key(&types) {
            let archetype = Archetype::new(types.clone(), self.initial_capacity, &self.components);
            self.archetypes.insert(types, archetype);
        }
    }
    fn append(
        &mut self,
        types: &[ComponentId],
        entity: Entity,
        values: &HashMap<ComponentId, Value>,
    ) -> Result<usize, String> {
        self.ensure_archetype(types.to_vec());
        let components = &self.components;
        let archetype = self.archetypes.get_mut(types).unwrap();
        archetype.reserve();
        let row = archetype.entities.len();
        archetype.entities.push(entity);
        for id in types {
            let ty = components
                .get(id)
                .ok_or_else(|| format!("unknown component {}", id))?;
            archetype
                .columns
                .get_mut(id)
                .unwrap()
                .set(ty, row, values.get(id));
        }
        Ok(row)
    }
    fn move_entity(
        &mut self,
        entity: Entity,
        target: Vec<ComponentId>,
        added: HashMap<ComponentId, Value>,
    ) -> Result<(), String> {
        let source = self.location(entity)?.clone();
        let mut values = added;
        for id in &target {
            if !values.contains_key(id) && source.archetype.binary_search(id).is_ok() {
                values.insert(*id, self.get_component(entity, *id)?);
            }
        }
        let enabled: HashMap<_, _> = source
            .archetype
            .iter()
            .filter_map(|id| {
                self.is_component_enabled(entity, *id)
                    .ok()
                    .map(|state| (*id, state))
            })
            .collect();
        let target_row = self.append(&target, entity, &values)?;
        for (id, state) in enabled {
            if target.binary_search(&id).is_ok() && self.components[&id].descriptor.enableable {
                self.archetypes
                    .get_mut(&target)
                    .unwrap()
                    .columns
                    .get_mut(&id)
                    .unwrap()
                    .enabled
                    .as_mut()
                    .unwrap()[target_row] = state;
            }
        }
        self.remove_row(&source.archetype, source.row)?;
        self.slots[entity.index as usize].location = Some(Location {
            archetype: target,
            row: target_row,
        });
        self.structural_version += 1;
        Ok(())
    }
    fn remove_row(&mut self, key: &[ComponentId], row: usize) -> Result<(), String> {
        let archetype = self.archetypes.get_mut(key).unwrap();
        let last = archetype.entities.len() - 1;
        let moved = (row != last).then_some(archetype.entities[last]);
        archetype.entities.swap_remove(row);
        for column in archetype.columns.values_mut() {
            column.swap_remove(row, last);
        }
        if let Some(entity) = moved {
            self.slots[entity.index as usize]
                .location
                .as_mut()
                .unwrap()
                .row = row;
        }
        Ok(())
    }
    fn location(&self, entity: Entity) -> Result<&Location, String> {
        self.slots
            .get(entity.index as usize)
            .filter(|slot| slot.generation == entity.generation)
            .and_then(|slot| slot.location.as_ref())
            .ok_or_else(|| format!("entity {:?} does not exist", entity))
    }
    fn require_component_type(&self, id: ComponentId) -> Result<&ComponentType, String> {
        self.components
            .get(&id)
            .ok_or_else(|| format!("unknown component {}", id))
    }
}
fn normalized_types(ids: impl IntoIterator<Item = ComponentId>) -> Vec<ComponentId> {
    ids.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
