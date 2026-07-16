use crate::{ComponentDescriptor, EcsWorld, EntityDoc, EntityMap, FieldSpec, WorldMeta};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

/// One authored world materialized into the ECS. Scene files remain the source of truth.
#[derive(Clone, Debug)]
pub struct LoadedWorld {
    pub path: PathBuf,
    pub scenes: Vec<String>,
    pub entity_count: usize,
    pub meta: Option<WorldMeta>,
}

/// Parse GAIA scene documents through the protocol types, then create one ECS entity per
/// authored entity. Component names stay data-driven; the core does not own a game vocabulary.
pub fn load_world_dir(path: impl AsRef<Path>, world: &mut EcsWorld) -> Result<LoadedWorld, String> {
    let path = path.as_ref();
    if !path.is_dir() {
        return Err(format!(
            "GAIA world directory does not exist: {}",
            path.display()
        ));
    }

    let meta_path = path.join("world.json");
    let meta = if meta_path.exists() {
        Some(read_json::<WorldMeta>(&meta_path)?)
    } else {
        None
    };
    let scenes = match &meta {
        Some(meta) if !meta.scenes.is_empty() => meta.scenes.keys().cloned().collect(),
        Some(_) => return Err(format!("{} declares no scenes", meta_path.display())),
        None if path.join("scenes/main.json").is_file() => vec!["main".to_owned()],
        None => {
            return Err(format!(
                "{} has neither world.json nor scenes/main.json",
                path.display()
            ));
        }
    };

    let mut authored = BTreeMap::<String, EntityDoc>::new();
    for scene in &scenes {
        validate_scene_name(scene)?;
        let scene_path = path.join("scenes").join(format!("{scene}.json"));
        let entities = read_json::<EntityMap>(&scene_path)?;
        for (id, entity) in entities {
            if authored.insert(id.clone(), entity).is_some() {
                return Err(format!("duplicate GAIA entity id {id:?}"));
            }
        }
    }

    let component_values = authored
        .into_iter()
        .map(|(id, entity)| {
            let mut object = serde_json::to_value(entity)
                .map_err(|error| format!("serialize entity {id:?}: {error}"))?
                .as_object()
                .cloned()
                .ok_or_else(|| format!("entity {id:?} is not a component object"))?;
            object.remove("prefab");
            Ok((id, object))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let names = component_values
        .iter()
        .flat_map(|(_, components)| components.keys().cloned())
        .collect::<BTreeSet<_>>();
    for name in names {
        if world.component_id(&name).is_none() {
            world.register_component(ComponentDescriptor {
                name,
                fields: BTreeMap::<String, FieldSpec>::new(),
                enableable: false,
                buffer: true,
                default: None,
            })?;
        }
    }

    for (id, components) in &component_values {
        let values = components
            .iter()
            .map(|(name, value)| {
                world
                    .component_id(name)
                    .map(|component| (component, value.clone()))
                    .ok_or_else(|| format!("component {name:?} was not registered"))
            })
            .collect::<Result<Vec<(u32, Value)>, String>>()?;
        let entity = world.create_entity(values)?;
        world.bind_gaia_id(id, entity)?;
    }

    world.set_resource(
        "gaia.world.path",
        Value::String(path.to_string_lossy().into_owned()),
    );
    world.set_resource("gaia.world.scenes", json!(scenes));

    Ok(LoadedWorld {
        path: path.to_path_buf(),
        scenes,
        entity_count: component_values.len(),
        meta,
    })
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let source =
        fs::read_to_string(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&source).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn validate_scene_name(scene: &str) -> Result<(), String> {
    if scene.is_empty()
        || Path::new(scene)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!("invalid scene name {scene:?}"));
    }
    Ok(())
}
