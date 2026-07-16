use gaia_core::{load_world_dir, EcsWorld, QuerySpec};
use std::path::{Path, PathBuf};

fn naruko_world() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../worlds/naruko")
}

#[test]
fn naruko_blank_page_parses_and_populates_expected_entities() {
    let path = naruko_world();
    assert!(
        !path.join("world.json").exists(),
        "Naruko must exercise blank-page loading"
    );

    let mut ecs = EcsWorld::default();
    let loaded = load_world_dir(&path, &mut ecs).expect("load Naruko through GAIA protocol");

    assert_eq!(loaded.scenes, ["main"]);
    assert_eq!(loaded.entity_count, 7);
    assert_eq!(ecs.query(&QuerySpec::default()).len(), 7);
    assert!(ecs.entity_for_gaia("env").is_some());
    assert!(ecs.entity_for_gaia("world_spawn").is_some());
    assert!(ecs.entity_for_gaia("lighthouse_tower").is_some());

    let transform = ecs.component_id("transform").unwrap();
    let mesh = ecs.component_id("mesh").unwrap();
    assert_eq!(
        ecs.query(&QuerySpec {
            all: vec![transform, mesh],
            ..Default::default()
        })
        .len(),
        5
    );
}
