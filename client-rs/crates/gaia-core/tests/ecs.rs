use gaia_core::*;
use serde::Deserialize;
use serde_json::json;
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};

#[test]
fn dynamic_component_soa_roundtrip_query_and_gaia_map() {
    let mut world = EcsWorld::default();
    let transform = world.register_component_json(r#"{"name":"Transform","fields":{"position":"vec3","speed":{"type":"f32","default":1},"visible":"bool"}}"#).unwrap();
    let tag = world
        .register_component_json(r#"{"name":"Tag","enableable":true,"fields":{"kind":"u32"}}"#)
        .unwrap();
    let entity = world
        .create_entity(vec![
            (
                transform,
                json!({"position":[1.0, 2.0, 3.0], "visible":true}),
            ),
            (tag, json!({"kind":7})),
        ])
        .unwrap();
    assert_eq!(
        world.get_component(entity, transform).unwrap(),
        json!({"position":[1.0, 2.0, 3.0], "speed":1.0, "visible":true})
    );
    world
        .set_component(
            entity,
            transform,
            json!({"position":[4.0, 5.0, 6.0], "speed":2.5, "visible":false}),
        )
        .unwrap();
    world
        .set_component_field(entity, transform, "speed", json!(3.5))
        .unwrap();
    assert_eq!(
        world
            .get_component_field(entity, transform, "speed")
            .unwrap(),
        json!(3.5)
    );
    world.bind_gaia_id("car:1", entity).unwrap();
    assert_eq!(world.entity_for_gaia("car:1"), Some(entity));
    assert_eq!(
        world.query(&QuerySpec {
            all: vec![transform, tag],
            ..Default::default()
        }),
        vec![entity]
    );
    world.set_component_enabled(entity, tag, false).unwrap();
    assert!(world
        .query(&QuerySpec {
            all: vec![tag],
            ..Default::default()
        })
        .is_empty());
    assert_eq!(
        world.query(&QuerySpec {
            all: vec![tag],
            include_disabled: true,
            ..Default::default()
        }),
        vec![entity]
    );
    assert_eq!(
        world.get_component(entity, transform).unwrap()["position"],
        json!([4.0, 5.0, 6.0])
    );
}

#[test]
fn command_buffer_replays_in_record_order_at_explicit_boundary() {
    let mut world = EcsWorld::default();
    let health = world
        .register_component_json(r#"{"name":"Health","fields":{"value":"i32"}}"#)
        .unwrap();
    let mut boundary = EcbPlaybackBoundary::new("EndSimulationEntityCommandBufferSystem");
    let buffer = boundary.create_command_buffer();
    let deferred = buffer.create_entity(vec![(health, json!({"value":1}))]);
    buffer.set_component(deferred, health, json!({"value":9}));
    assert!(world
        .query(&QuerySpec {
            all: vec![health],
            ..Default::default()
        })
        .is_empty());
    boundary.playback(&mut world).unwrap();
    let entity = world.query(&QuerySpec {
        all: vec![health],
        ..Default::default()
    })[0];
    assert_eq!(
        world.get_component(entity, health).unwrap(),
        json!({"value":9})
    );
    assert_eq!(boundary.playback_count, 1);
}

#[test]
fn fixed_group_accumulator_clamps_and_preserves_fraction() {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let mut scheduler = Scheduler::new(
        EcsWorld::default(),
        ScheduleOptions {
            fixed_delta: Some(0.1),
            max_fixed_steps: Some(2),
        },
    );
    let output = trace.clone();
    scheduler
        .add_system(
            "fixed",
            move |_, context| {
                output
                    .borrow_mut()
                    .push((context.fixed, context.delta_time, context.elapsed_time))
            },
            ItemOptions {
                parent: Some(FIXED.into()),
                ..Default::default()
            },
        )
        .unwrap();
    scheduler.tick(0.35).unwrap();
    assert_eq!(trace.borrow().len(), 2);
    assert!(trace
        .borrow()
        .iter()
        .all(|(fixed, delta, _)| *fixed && (*delta - 0.1).abs() < f64::EPSILON));
    assert!((scheduler.fixed_alpha(None) - 0.5).abs() < 1e-9);
}

#[derive(Deserialize)]
struct SourceModel {
    groups: Vec<ModelGroup>,
    systems: Vec<ModelSystem>,
}
#[derive(Deserialize)]
struct ModelGroup {
    name: String,
    parent: String,
    #[serde(default)]
    before: Vec<String>,
    #[serde(default)]
    after: Vec<String>,
    #[serde(rename = "orderFirst")]
    order_first: bool,
    #[serde(rename = "orderLast")]
    order_last: bool,
}
#[derive(Deserialize)]
struct ModelSystem {
    key: String,
    name: String,
    group: String,
    #[serde(default)]
    before: Vec<String>,
    #[serde(default)]
    after: Vec<String>,
    #[serde(rename = "orderFirst")]
    order_first: bool,
    #[serde(rename = "orderLast")]
    order_last: bool,
}
#[derive(Deserialize)]
struct Snapshot {
    orders: HashMap<String, Vec<SnapshotItem>>,
}
#[derive(Deserialize)]
struct SnapshotItem {
    name: String,
}

#[test]
fn dotscity_compiled_order_conforms_to_reference_snapshot() {
    let model: SourceModel =
        serde_json::from_str(include_str!("fixtures/dotscity-source-model.json")).unwrap();
    let snapshot: Snapshot =
        serde_json::from_str(include_str!("fixtures/compiled-order.snapshot.json")).unwrap();
    let mut scheduler = Scheduler::new(EcsWorld::default(), ScheduleOptions::default());
    let model_group_names: HashSet<_> = model
        .groups
        .iter()
        .map(|group| group.name.as_str())
        .collect();
    let roots: HashSet<_> = [INITIALIZATION, SIMULATION, FIXED, PRESENTATION]
        .into_iter()
        .collect();
    let external: HashSet<_> = model
        .groups
        .iter()
        .map(|group| group.parent.as_str())
        .chain(model.systems.iter().map(|system| system.group.as_str()))
        .filter(|name| !model_group_names.contains(name) && !roots.contains(name))
        .collect();
    for (name, parent) in [
        ("TransformSystemGroup", Some(SIMULATION)),
        ("LateSimulationSystemGroup", Some(SIMULATION)),
        ("PhysicsSystemGroup", Some(FIXED)),
        ("PhysicsInitializeGroup", Some("PhysicsSystemGroup")),
        ("PhysicsSimulationGroup", Some("PhysicsSystemGroup")),
        ("ExportPhysicsWorld", Some("PhysicsSystemGroup")),
        ("GhostInputSystemGroup", None),
        ("PredictedSimulationSystemGroup", None),
        ("PredictedFixedStepSimulationSystemGroup", None),
        ("BakingSystemGroup", None),
        ("PostBakingSystemGroup", None),
    ] {
        scheduler
            .add_group(
                name,
                ItemOptions {
                    parent: parent.map(str::to_owned),
                    ..Default::default()
                },
            )
            .unwrap();
    }
    for name in external {
        if scheduler.add_group(name, ItemOptions::default()).is_err() {}
    }
    // Scheduler identities must be global (scheduler.js); inventory has duplicate display
    // names. Keep source keys as identities and expand same-group display-name constraints,
    // exactly as dotscity/groups.js' attributed graph does before producing this snapshot.
    let mut labels: HashMap<String, String> = HashMap::new();
    let mut children: HashMap<String, HashMap<String, Vec<String>>> = HashMap::new();
    for group in &model.groups {
        children
            .entry(group.parent.clone())
            .or_default()
            .entry(group.name.clone())
            .or_default()
            .push(group.name.clone());
    }
    for system in &model.systems {
        labels.insert(system.key.clone(), system.name.clone());
        children
            .entry(system.group.clone())
            .or_default()
            .entry(system.name.clone())
            .or_default()
            .push(system.key.clone());
    }
    let resolve = |parent: &str, names: &[String]| -> Vec<String> {
        names
            .iter()
            .flat_map(|name| {
                children
                    .get(parent)
                    .and_then(|by_name| by_name.get(name))
                    .cloned()
                    .unwrap_or_else(|| vec![name.clone()])
            })
            .collect()
    };
    for group in &model.groups {
        scheduler
            .add_group(
                &group.name,
                ItemOptions {
                    parent: Some(group.parent.clone()),
                    before: resolve(&group.parent, &group.before),
                    after: resolve(&group.parent, &group.after),
                    order_first: group.order_first,
                    order_last: group.order_last,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    for (name, group, first, last) in [
        (
            "BeginInitializationEntityCommandBufferSystem",
            INITIALIZATION,
            true,
            false,
        ),
        (
            "EndInitializationEntityCommandBufferSystem",
            INITIALIZATION,
            false,
            true,
        ),
        (
            "BeginSimulationEntityCommandBufferSystem",
            SIMULATION,
            true,
            false,
        ),
        (
            "EndSimulationEntityCommandBufferSystem",
            SIMULATION,
            false,
            true,
        ),
        (
            "BeginPresentationEntityCommandBufferSystem",
            PRESENTATION,
            true,
            false,
        ),
    ] {
        scheduler
            .add_system(
                name,
                |_, _| {},
                ItemOptions {
                    parent: Some(group.into()),
                    order_first: first,
                    order_last: last,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    for system in &model.systems {
        scheduler
            .add_system(
                &system.key,
                |_, _| {},
                ItemOptions {
                    parent: Some(system.group.clone()),
                    before: resolve(&system.group, &system.before),
                    after: resolve(&system.group, &system.after),
                    order_first: system.order_first,
                    order_last: system.order_last,
                    ..Default::default()
                },
            )
            .unwrap();
    }
    for (group, expected) in snapshot.orders {
        let actual = scheduler
            .ordered_names(&group)
            .unwrap()
            .into_iter()
            .map(|name| labels.get(&name).cloned().unwrap_or(name))
            .collect::<Vec<_>>();
        assert_eq!(
            actual,
            expected
                .into_iter()
                .map(|item| item.name)
                .collect::<Vec<_>>(),
            "group {group}"
        );
    }
}
